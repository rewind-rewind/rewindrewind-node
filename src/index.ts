/**
 * @rewindrewind/node — server-side SDK for Node and Bun.
 *
 * Zero runtime dependencies: built entirely on the global `fetch` and standard
 * `process` hooks. Capture calls never throw into your application code.
 *
 * @example
 * ```ts
 * import { init, captureException } from "@rewindrewind/node";
 *
 * init({ projectKey: process.env.REWINDREWIND_PROJECT_KEY!, environment: "production" });
 *
 * try {
 *   risky();
 * } catch (err) {
 *   await captureException(err);
 * }
 * ```
 */

import { parseStackTrace, type StackFrame } from "./stacktrace.js";
import { post, type TransportResult } from "./transport.js";

export { parseStackTrace, isInApp } from "./stacktrace.js";
export type { StackFrame } from "./stacktrace.js";
export type { TransportResult } from "./transport.js";

const DEFAULT_ENDPOINT = "https://rewindrewind.com";
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_ENVIRONMENT_LENGTH = 64;

/**
 * Default denylist of object keys whose values are redacted before leaving the
 * process. Case-insensitive; matched against each key as a substring. Override
 * with {@link RewindConfig.sensitiveKeys}.
 */
const DEFAULT_SENSITIVE_KEYS =
  /password|passwd|secret|token|authorization|auth|api[-_]?key|access[-_]?key|client[-_]?secret|cookie|session|credential|card|cvv|ssn|private[-_]?key/i;

/** Replacement value substituted for any redacted field. */
const FILTERED = "[FILTERED]";

/**
 * Keys dropped wholesale while scrubbing — defense-in-depth so a malicious
 * `__proto__` / `constructor` / `prototype` key can't ride a captured payload
 * into the collector and pollute a prototype on the receiving end.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Cap on recursion depth so a self-referential structure can't blow the stack. */
const MAX_SCRUB_DEPTH = 12;

export type Platform = "node" | "bun" | "cloudflare" | "deno";

export interface RewindUser {
  id?: string;
  email?: string;
  [key: string]: unknown;
}

export interface RewindRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  query_string?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface RewindConfig {
  /** Public project ingestion key (`rrpub_…`). Required. */
  projectKey: string;
  /** Deployment environment, e.g. "production". Required, non-empty, ≤64 chars. */
  environment: string;
  /** API origin. Defaults to `REWINDREWIND_ENDPOINT` env or https://rewindrewind.com. */
  endpoint?: string;
  /** Release identifier (version / git sha). */
  release?: string;
  /** Per-request timeout in ms, enforced via AbortController. Default 2000. */
  timeoutMs?: number;
  /** Default user attached to every exception. */
  user?: RewindUser;
  /** Default tags merged into every exception. */
  tags?: Record<string, unknown>;
  /** Default extra context merged into every exception. */
  extra?: Record<string, unknown>;
  /** Log transport activity to console. Default false. */
  debug?: boolean;
  /**
   * Case-insensitive pattern matched against object keys in `tags`, `extra`,
   * `user`, and event `properties`; matching values are redacted to
   * `"[FILTERED]"` before the payload leaves the process. Note: `user.id` and
   * `user.email` are never scrubbed. Defaults to a built-in denylist covering
   * passwords, tokens, secrets, cookies, credentials, card/SSN data, etc.
   */
  sensitiveKeys?: RegExp;
  /**
   * Behavior of the {@link RewindClient.install} `uncaughtException` handler.
   * When `true` (the default) the process crashes after the exception is
   * captured and flushed — preserving Node's default fail-fast semantics so a
   * corrupted process never silently lingers. Set `false` to capture and keep
   * running (use with care). Unaffects `unhandledRejection`, which is always
   * captured non-fatally.
   */
  exitOnUncaught?: boolean;
}

export interface CaptureExceptionOptions {
  /** Override the derived message. */
  message?: string;
  /** Stable grouping key; overrides the server's culprit-based grouping. */
  fingerprint?: string | string[];
  /** Severity. Defaults to "error". */
  level?: string;
  user?: RewindUser;
  request?: RewindRequest;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/** Resolve the runtime platform once, at module load. */
export function detectPlatform(): Platform {
  const g = globalThis as {
    Bun?: unknown;
    Deno?: unknown;
    navigator?: { userAgent?: string };
    WebSocketPair?: unknown;
  };
  // Bun exposes a global `Bun` object and `process.versions.bun`.
  if (typeof g.Bun !== "undefined") return "bun";
  const versions = (globalThis as { process?: { versions?: Record<string, string> } })
    .process?.versions;
  if (versions && typeof versions.bun === "string") return "bun";
  // Cloudflare Workers (workerd) report a fixed navigator UA and expose the
  // Workers-only `WebSocketPair` global — checked before `node` because
  // `nodejs_compat` polyfills a partial `process`.
  if (g.navigator?.userAgent === "Cloudflare-Workers" || typeof g.WebSocketPair !== "undefined") {
    return "cloudflare";
  }
  // Deno exposes a global `Deno` namespace.
  if (typeof g.Deno !== "undefined") return "deno";
  return "node";
}

const PLATFORM: Platform = detectPlatform();

interface NormalizedError {
  type: string;
  value: string;
  message: string;
  stacktrace: StackFrame[];
}

/**
 * A configured RewindRewind client. Construct one per project key, or use the
 * module-level {@link init} / {@link captureException} convenience API.
 */
export class RewindClient {
  private readonly projectKey: string;
  private readonly endpoint: string;
  private readonly environment: string;
  private readonly release?: string;
  private readonly timeoutMs: number;
  private readonly defaultUser?: RewindUser;
  private readonly defaultTags?: Record<string, unknown>;
  private readonly defaultExtra?: Record<string, unknown>;
  private readonly debug: boolean;
  private readonly sensitiveKeys: RegExp;
  private readonly exitOnUncaught: boolean;

  /** In-flight requests, awaited by {@link flush}. */
  private pending = new Set<Promise<unknown>>();
  private uninstall?: () => void;

  constructor(config: RewindConfig) {
    const projectKey = (config.projectKey ?? "").trim();
    if (!projectKey) {
      throw new Error("RewindRewind: `projectKey` is required");
    }
    const environment = (config.environment ?? "").trim();
    if (!environment) {
      throw new Error("RewindRewind: `environment` is required and must be non-empty");
    }
    if (environment.length > MAX_ENVIRONMENT_LENGTH) {
      throw new Error(
        `RewindRewind: \`environment\` must be ≤${MAX_ENVIRONMENT_LENGTH} characters`,
      );
    }

    this.projectKey = projectKey;
    const endpoint = (
      config.endpoint ??
      readEnv("REWINDREWIND_ENDPOINT") ??
      DEFAULT_ENDPOINT
    ).replace(/\/+$/, "");
    this.endpoint = validateEndpoint(endpoint);
    this.environment = environment;
    this.release = config.release ?? readEnv("REWINDREWIND_RELEASE");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultUser = config.user;
    this.defaultTags = config.tags;
    this.defaultExtra = config.extra;
    this.debug = config.debug ?? false;
    this.sensitiveKeys = config.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
    this.exitOnUncaught = config.exitOnUncaught ?? true;
  }

  /** The runtime platform reported in exception payloads ("node" | "bun"). */
  get platform(): Platform {
    return PLATFORM;
  }

  /**
   * Report an exception. Resolves with the transport result; never throws —
   * transport and serialization errors are caught and (when `debug`) logged.
   */
  captureException(
    error: unknown,
    options: CaptureExceptionOptions = {},
  ): Promise<TransportResult> {
    try {
      const normalized = normalizeError(error);
      const payload: Record<string, unknown> = {
        timestamp: Date.now(),
        environment: this.environment,
        release: this.release,
        platform: PLATFORM,
        level: options.level ?? "error",
        message: options.message ?? normalized.message,
        exception: {
          type: normalized.type,
          value: normalized.value,
          stacktrace: normalized.stacktrace,
        },
        fingerprint: normalizeFingerprint(options.fingerprint),
        request: options.request,
        user: this.scrubUser(mergeUser(this.defaultUser, options.user)),
        tags: this.scrub(mergeRecords(this.defaultTags, options.tags)) as
          | Record<string, unknown>
          | undefined,
        extra: this.scrub(mergeRecords(this.defaultExtra, options.extra)) as
          | Record<string, unknown>
          | undefined,
      };
      return this.send("/v1/exceptions", prune(payload));
    } catch (err) {
      return this.swallow(err);
    }
  }

  /**
   * Report a product/analytics event. `type` is required.
   */
  captureEvent(
    type: string,
    properties: Record<string, unknown> = {},
    options: {
      distinctId?: string;
      anonymousId?: string;
      source?: string;
    } = {},
  ): Promise<TransportResult> {
    try {
      const payload: Record<string, unknown> = {
        type,
        environment: this.environment,
        release: this.release,
        distinct_id: options.distinctId ?? this.defaultUser?.id,
        anonymous_id: options.anonymousId,
        source: options.source ?? PLATFORM,
        properties: this.scrub(properties) as Record<string, unknown>,
      };
      return this.send("/v1/events", prune(payload));
    } catch (err) {
      return this.swallow(err);
    }
  }

  /**
   * Install global handlers for `uncaughtException` and `unhandledRejection`.
   *
   * `unhandledRejection` is captured non-fatally — the process continues.
   *
   * `uncaughtException` is captured and then, by default, the process is
   * **crashed** (flush → `process.exit(1)`): an uncaught exception leaves the
   * process in an undefined state, and silently swallowing it keeps a corrupted
   * process alive. To opt into capture-and-continue, construct the client with
   * `{ exitOnUncaught: false }` (use with care).
   *
   * Returns this client for chaining. Idempotent: a second call is a no-op
   * until {@link close}.
   */
  install(): this {
    if (this.uninstall) return this;
    const proc = (globalThis as { process?: NodeProcess }).process;
    if (!proc || typeof proc.on !== "function") {
      this.log("install: no `process` available; skipping global handlers");
      return this;
    }

    const onUncaught = (err: unknown): void => {
      const captured = this.captureException(err, {
        extra: { handler: "uncaughtException" },
      });
      if (!this.exitOnUncaught) {
        void captured;
        return;
      }
      // Preserve Node's default fail-fast behavior: flush the report, then
      // exit non-zero so a corrupted process never silently lingers.
      void captured
        .then(() => this.flush())
        .catch(() => {})
        .finally(() => {
          proc.exit?.(1);
        });
    };
    const onRejection = (reason: unknown): void => {
      void this.captureException(reason, { extra: { handler: "unhandledRejection" } });
    };

    proc.on("uncaughtException", onUncaught);
    proc.on("unhandledRejection", onRejection);

    this.uninstall = () => {
      proc.off?.("uncaughtException", onUncaught);
      proc.off?.("unhandledRejection", onRejection);
    };
    return this;
  }

  /** Remove any global handlers registered by {@link install}. */
  close(): void {
    this.uninstall?.();
    this.uninstall = undefined;
  }

  /** Await all in-flight captures. Resolves once the queue drains. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /**
   * Recursively redact sensitive values from an arbitrary structure before it
   * goes into a payload. Any object key matching {@link sensitiveKeys} has its
   * value replaced with `"[FILTERED]"`; nested objects and arrays are walked.
   * Prototype-pollution vectors (`__proto__`/`constructor`/`prototype`) are
   * dropped entirely. Returns `undefined` unchanged.
   */
  private scrub(value: unknown, depth = 0): unknown {
    if (value === null || typeof value !== "object") return value;
    if (depth >= MAX_SCRUB_DEPTH) return value;

    if (Array.isArray(value)) {
      return value.map((item) => this.scrub(item, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      if (this.sensitiveKeys.test(key)) {
        out[key] = FILTERED;
      } else {
        out[key] = this.scrub(val, depth + 1);
      }
    }
    return out;
  }

  /**
   * Scrub a user object like {@link scrub}, but always preserve `id` and
   * `email` — these are the identity fields the dashboard needs and are never
   * treated as secrets.
   */
  private scrubUser(user: RewindUser | undefined): RewindUser | undefined {
    if (!user) return undefined;
    const scrubbed = this.scrub(user) as Record<string, unknown>;
    if (user.id !== undefined) scrubbed.id = user.id;
    if (user.email !== undefined) scrubbed.email = user.email;
    return scrubbed as RewindUser;
  }

  private send(path: string, body: unknown): Promise<TransportResult> {
    const promise = post(path, body, {
      endpoint: this.endpoint,
      apiKey: this.projectKey,
      timeoutMs: this.timeoutMs,
      debug: this.debug,
    });
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
    return promise;
  }

  private swallow(err: unknown): Promise<TransportResult> {
    this.log("capture failed before send", err);
    return Promise.resolve({ ok: false, status: 0, error: errorMessage(err) });
  }

  private log(...args: unknown[]): void {
    if (this.debug && typeof console !== "undefined") {
      console.debug("[rewindrewind]", ...args);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level convenience API                                               */
/* -------------------------------------------------------------------------- */

let defaultClient: RewindClient | undefined;

/**
 * Initialize the default client used by the module-level
 * {@link captureException} / {@link captureEvent} / {@link flush} helpers.
 */
export function init(config: RewindConfig): RewindClient {
  defaultClient = new RewindClient(config);
  return defaultClient;
}

/** The default client created by {@link init}, if any. */
export function getClient(): RewindClient | undefined {
  return defaultClient;
}

function requireClient(): RewindClient {
  if (!defaultClient) {
    throw new Error("RewindRewind: call init(config) before using the default client");
  }
  return defaultClient;
}

export function captureException(
  error: unknown,
  options?: CaptureExceptionOptions,
): Promise<TransportResult> {
  return requireClient().captureException(error, options);
}

export function captureEvent(
  type: string,
  properties?: Record<string, unknown>,
  options?: { distinctId?: string; anonymousId?: string; source?: string },
): Promise<TransportResult> {
  return requireClient().captureEvent(type, properties, options);
}

export function flush(): Promise<void> {
  return requireClient().flush();
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

interface NodeProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  exit?(code?: number): never;
}

/**
 * Validate the configured ingest endpoint. Requires a well-formed absolute URL
 * over `https:`; plain `http:` is permitted only for loopback hosts
 * (localhost / 127.0.0.1 / ::1) so the Bearer project key is never transmitted
 * in cleartext to an arbitrary host. Throws in the constructor otherwise.
 */
function validateEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      `RewindRewind: \`endpoint\` must be an absolute URL (got ${JSON.stringify(endpoint)})`,
    );
  }

  if (url.protocol === "https:") return endpoint;

  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return endpoint;
    }
    throw new Error(
      "RewindRewind: `endpoint` must use https: — http: is allowed only for " +
        "localhost/127.0.0.1/::1 (refusing to send the project key in cleartext)",
    );
  }

  throw new Error(
    `RewindRewind: \`endpoint\` must use the https: scheme (got ${JSON.stringify(url.protocol)})`,
  );
}

/** Convert any thrown value into structured exception fields. */
function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      type: error.name || "Error",
      value: error.message,
      message: error.message || error.name || "Error",
      stacktrace: parseStackTrace(error.stack),
    };
  }

  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const value =
      typeof obj.message === "string" ? obj.message : safeStringify(error);
    const type = typeof obj.name === "string" ? obj.name : "Error";
    const stack = typeof obj.stack === "string" ? obj.stack : undefined;
    return { type, value, message: value, stacktrace: parseStackTrace(stack) };
  }

  const value = String(error);
  return { type: "Error", value, message: value, stacktrace: [] };
}

function normalizeFingerprint(
  fingerprint: string | string[] | undefined,
): string | undefined {
  if (fingerprint === undefined) return undefined;
  return Array.isArray(fingerprint) ? fingerprint.join(":") : fingerprint;
}

function mergeUser(
  base: RewindUser | undefined,
  override: RewindUser | undefined,
): RewindUser | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override };
}

function mergeRecords(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override };
}

/** Drop `undefined` top-level fields so we send a clean payload. */
function prune(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  const value = env?.[name];
  return value && value.length > 0 ? value : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

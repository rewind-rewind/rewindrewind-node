/**
 * HTTP transport for the RewindRewind server SDK.
 *
 * Built on the global `fetch` (Node 18+, Bun) so the package carries zero
 * runtime dependencies. The single guarantee callers rely on: capture must
 * never throw into application code, so every failure mode here resolves to a
 * structured {@link TransportResult} instead of rejecting.
 */

export interface TransportResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body when the response was JSON, otherwise undefined. */
  body?: unknown;
  /** Populated when the request failed before/without an HTTP response. */
  error?: string;
}

export interface TransportOptions {
  endpoint: string;
  apiKey: string;
  /** Per-request timeout in ms, enforced via AbortController. */
  timeoutMs: number;
  debug?: boolean;
}

/**
 * POST a JSON body to `path`, returning a {@link TransportResult}. Resolves for
 * every outcome — HTTP errors, network failures, and timeouts alike — and never
 * rejects.
 */
export async function post(
  path: string,
  body: unknown,
  options: TransportOptions,
): Promise<TransportResult> {
  const url = `${options.endpoint}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const parsed = await safeParseJson(res);
    const result: TransportResult = { ok: res.ok, status: res.status, body: parsed };
    if (options.debug) {
      // SECURITY: never log `options.apiKey`, the `Authorization` header, or the
      // request body — debug output must be safe to paste into a bug report. We
      // log only the path, status, and the server's response body.
      log(res.ok ? "sent" : "request failed", path, res.status, parsed);
    }
    return result;
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    const message = aborted
      ? `request timed out after ${options.timeoutMs}ms`
      : errorMessage(err);
    if (options.debug) log("transport error", path, message);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function safeParseJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function log(...args: unknown[]): void {
  if (typeof console !== "undefined") console.debug("[rewindrewind]", ...args);
}

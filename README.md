# @rewindrewind/node

Server-side [RewindRewind](https://rewindrewind.com) SDK for **Node** and **Bun**.
Capture exceptions and product events with **zero runtime dependencies** — it is
built entirely on the global `fetch` (Node 18+, Bun) and standard `process`
hooks. Capture calls **never throw** into your application code.

## Install

```sh
npm install @rewindrewind/node
# or: bun add @rewindrewind/node
```

## Quick start

```ts
import { init, captureException, captureEvent, flush } from "@rewindrewind/node";

init({
  projectKey: process.env.REWINDREWIND_PROJECT_KEY!, // rrpub_…
  environment: "production",
  release: process.env.GIT_SHA,
});

try {
  doRiskyThing();
} catch (err) {
  await captureException(err, { tags: { feature: "checkout" } });
}

await captureEvent("order.completed", { total: 42 }, { distinctId: "user_123" });

// Flush in-flight requests before a short-lived process exits.
await flush();
```

### Auto-capture uncaught errors

```ts
import { RewindClient } from "@rewindrewind/node";

const rewind = new RewindClient({
  projectKey: process.env.REWINDREWIND_PROJECT_KEY!,
  environment: "production",
}).install(); // hooks process.on('uncaughtException') + 'unhandledRejection'
```

By default `install()` preserves Node's fail-fast behavior: after capturing an
`uncaughtException` it **flushes the report and exits the process with code 1**,
because an uncaught exception leaves the process in an undefined state.
`unhandledRejection` is captured non-fatally and the process keeps running.

To capture an `uncaughtException` and continue running anyway (use with care),
pass `exitOnUncaught: false`:

```ts
new RewindClient({ projectKey, environment, exitOnUncaught: false }).install();
```

## Sensitive-data scrubbing

Before any payload leaves the process, the SDK recursively redacts values whose
**key** looks sensitive (passwords, tokens, secrets, API/access keys, cookies,
sessions, credentials, card/CVV/SSN, private keys) across `tags`, `extra`,
`user`, and event `properties`, replacing them with `"[FILTERED]"`. Nested
objects and arrays are walked, and prototype-pollution keys
(`__proto__`/`constructor`/`prototype`) are dropped. `user.id` and `user.email`
are always preserved. Override the denylist with `sensitiveKeys` (a `RegExp`).

```ts
new RewindClient({ projectKey, environment, sensitiveKeys: /password|my_custom_field/i });
```

## Node vs. Bun

The same code runs under both runtimes. The SDK detects the platform at runtime
(`globalThis.Bun` / `process.versions.bun`) and reports it as `platform: "node"`
or `platform: "bun"` on every exception — no configuration required.

```sh
node app.js   # platform: "node"
bun app.js    # platform: "bun"
```

## Configuration

| Option        | Type                      | Default                          | Notes                                              |
| ------------- | ------------------------- | -------------------------------- | -------------------------------------------------- |
| `projectKey`  | `string`                  | —                                | **Required.** Public project key (`rrpub_…`).      |
| `environment` | `string`                  | —                                | **Required**, non-empty, ≤64 chars.                |
| `endpoint`    | `string`                  | `$REWINDREWIND_ENDPOINT` or prod | API origin. Must be `https:` (or `http:` localhost). |
| `release`     | `string`                  | `$REWINDREWIND_RELEASE`          | Version / git sha.                                 |
| `timeoutMs`   | `number`                  | `2000`                           | Per-request timeout (AbortController).             |
| `user`        | `{ id?, email? }`         | —                                | Default user attached to exceptions.               |
| `tags`        | `Record<string, unknown>` | —                                | Default tags merged into exceptions.               |
| `extra`       | `Record<string, unknown>` | —                                | Default extra context.                             |
| `debug`       | `boolean`                 | `false`                          | Log transport activity (never the key) to `console.debug`. |
| `sensitiveKeys` | `RegExp`                | built-in denylist                | Keys whose values are redacted to `"[FILTERED]"`.  |
| `exitOnUncaught` | `boolean`              | `true`                           | Crash (flush + `exit(1)`) after an `uncaughtException`. |

## How grouping works (`in_app`)

RewindRewind derives an issue's **culprit** from the first `in_app: true` frame
in the stack (falling back to the last frame). This SDK parses the V8
`Error.stack` into structured frames and marks a frame as **not** `in_app` when
its filename:

- starts with `node:` or `bun:` (runtime builtins), or
- contains `node_modules` (installed dependencies), or
- is a native / anonymous frame with no source location.

Everything else is treated as application code. This keeps issues grouped by
*your* code rather than by framework internals.

## API

- `new RewindClient(config)` — `captureException`, `captureEvent`, `install`,
  `close`, `flush`, `.platform`.
- `init(config)` → default client; then module-level `captureException`,
  `captureEvent`, `flush`, `getClient`.

## License

MIT

# RewindRewind Node SDK

The server-side [RewindRewind](https://rewindrewind.com) SDK for Node.js and Bun.
It captures exceptions and product events with no runtime dependencies, using
the global `fetch` API and standard process hooks.

## Requirements

Node.js 18 or newer, or a current Bun release.

## Installation

The package is served from the RewindRewind npm-compatible registry. Configure
the `@rewindrewind` scope once in the project, then install it:

```sh
npm config set @rewindrewind:registry https://rewindrewind.com/npm --location=project
npm install @rewindrewind/node
```

Bun reads the same project `.npmrc` file:

```sh
bun add @rewindrewind/node
```

## Quick start

```ts
import { captureEvent, captureException, flush, init } from "@rewindrewind/node";

init({
  projectKey: process.env.REWINDREWIND_PROJECT_KEY!, // rrpub_xxx
  environment: "production",
  release: process.env.GIT_SHA,
});

try {
  doRiskyThing();
} catch (error) {
  await captureException(error, { tags: { feature: "checkout" } });
}

await captureEvent("order.completed", { total: 42 }, { identityId: "user_123" });

// Wait for in-flight requests before a short-lived process exits.
await flush();
```

Project keys start with `rrpub_` and are public ingestion credentials. Do not
put an admin key, which starts with `rr_`, in application code.

Call `init` before module-level capture functions. If initialization is missing,
they warn and return a `not_initialized` result instead of throwing. A
`RewindClient` instance can be used directly when an application needs multiple
clients.

## Automatic process handlers

```ts
import { RewindClient } from "@rewindrewind/node";

const rewind = new RewindClient({
  projectKey: process.env.REWINDREWIND_PROJECT_KEY!,
  environment: "production",
}).install();
```

`install()` adds handlers for `uncaughtException` and `unhandledRejection`. It
is idempotent until `close()` removes those handlers.

By default, an uncaught exception is captured and flushed before the process
exits with code 1. An unhandled rejection is captured without forcing an exit.
To keep running after an uncaught exception, set `exitOnUncaught: false`. Use
that option cautiously because Node.js may be in an undefined state.

## Configuration

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `projectKey` | `string` | Required | Public project key |
| `environment` | `string` | Required | Nonempty; values longer than 64 characters are truncated |
| `endpoint` | `string` | `REWINDREWIND_ENDPOINT`, then production | HTTPS required except for localhost |
| `release` | `string` | `REWINDREWIND_RELEASE` | Optional release or Git SHA |
| `timeoutMs` | `number` | `2000` | Per-request `AbortController` timeout |
| `identity` | `{ id?, email?, ... }` | Not set | Default exception identity; ID also becomes the default event `identity_id` |
| `tags` | `Record<string, unknown>` | Not set | Default exception tags |
| `extra` | `Record<string, unknown>` | Not set | Default exception context |
| `debug` | `boolean` | `false` | Logs transport activity without logging keys or request bodies |
| `sensitiveKeys` | `RegExp` | Built-in pattern | Matching keys are redacted |
| `exitOnUncaught` | `boolean` | `true` | Flush and exit after an uncaught exception |

Missing required fields or an invalid endpoint disable the client and produce a
warning instead of crashing the application. Capture methods then resolve to a
disabled `TransportResult`. Transport and serialization failures also resolve
to a result instead of rejecting.

## Capturing exceptions

```ts
const result = await rewind.captureException(error, {
  message: "checkout charge failed",
  level: "error",
  fingerprint: ["billing", "v2"],
  identity: { id: "u_1", email: "a@example.com" },
  request: { method: "POST", url: "/charge" },
  tags: { tenant: "acme" },
  extra: { invoiceId: 42 },
});

if (!result.ok) console.error(result.status, result.error);
```

## Capturing events

```ts
await rewind.captureEvent(
  "checkout.completed",
  { amountCents: 4200, currency: "usd" },
  { identityId: "user_1", anonymousId: "anon_abc", source: "backend" },
);
```

## Data safety

Before sending data, the SDK recursively redacts values under sensitive keys in
`tags`, `extra`, `identity`, and event `properties`. The default pattern covers
passwords, secrets, tokens, authorization data, API and access keys, cookies,
sessions, credentials, payment card data, SSNs, and private keys. Redacted
values become `"[FILTERED]"`.

Nested objects and arrays are inspected. Prototype-pollution keys are removed.
`identity.id` and `identity.email` are always preserved. Override the key pattern with
`sensitiveKeys`.

```ts
new RewindClient({
  projectKey,
  environment,
  sensitiveKeys: /password|my_custom_field/i,
});
```

The endpoint must use HTTPS. Plain HTTP is accepted only for `localhost`,
`127.0.0.1`, and `::1`.

## Runtime and stack frames

The SDK detects Node.js or Bun and reports the result in each exception payload.
It parses V8 stack traces and marks runtime built-ins, `node_modules`, native
frames, and anonymous frames as non-application code. RewindRewind uses the
first `in_app: true` frame as the issue culprit, falling back to the last frame.

## API

- `new RewindClient(config)` provides `captureException`, `captureEvent`,
  `install`, `close`, `flush`, and `platform`.
- `init(config)` creates the default client used by `captureException`,
  `captureEvent`, `flush`, and `getClient`.
- `parseStackTrace`, `isInApp`, and transport result types are also exported.

## Development

```sh
npm install
bin/test
```

## License

MIT

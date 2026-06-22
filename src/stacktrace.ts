/**
 * V8 stack-trace parsing for the RewindRewind server SDK.
 *
 * V8 (Node, Bun, Chrome) renders `Error.stack` as a header line followed by one
 * frame per line, each prefixed with `    at `. The two shapes we care about:
 *
 *   at functionName (/abs/path/file.js:10:5)
 *   at /abs/path/file.js:10:5            // no named function
 *
 * Function names can carry qualifiers V8 appends, e.g.:
 *
 *   at Object.<anonymous> (...)
 *   at async Foo.bar (...)
 *   at new Ctor (...)
 *   at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
 *
 * The location can also be `eval`/`<anonymous>` or a native frame with no path.
 */

/** A single structured stack frame as the RewindRewind ingest API consumes it. */
export interface StackFrame {
  filename: string;
  function?: string;
  /** 1-based line number. */
  line?: number;
  /** 1-based column number. */
  column?: number;
  /** Application code (true) vs. dependency / runtime internals (false). */
  in_app: boolean;
  /** Bare module name for dependency frames, e.g. `express` or `node:fs`. */
  module?: string;
}

const MAX_FRAMES = 50;

/**
 * Match a single V8 frame line. Capture groups:
 *   1: function descriptor (may be undefined for anonymous frames)
 *   2: location (path:line:col, or `native`, or `<anonymous>`)
 */
const FRAME_RE = /^\s*at (?:(.+?) \()?(?:(.+?))\)?$/;

/** A `path:line:column` (or `path:line`) tail of a frame location. */
const LOCATION_RE = /^(.*?):(\d+)(?::(\d+))?$/;

/**
 * Parse a V8 `Error.stack` string into structured frames.
 *
 * Frames are returned innermost-first (matching V8's order). Returns an empty
 * array for missing/empty/unparseable stacks — never throws.
 */
export function parseStackTrace(stack: string | undefined | null): StackFrame[] {
  if (!stack || typeof stack !== "string") return [];

  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trimEnd();
    // The header line (e.g. `Error: boom`) has no `    at ` prefix; skip it and
    // any blank lines.
    if (!/^\s*at /.test(line)) continue;

    const frame = parseFrameLine(line);
    if (frame) frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

function parseFrameLine(line: string): StackFrame | null {
  const match = FRAME_RE.exec(line);
  if (!match) return null;

  const fn = normalizeFunction(match[1]);
  const locationRaw = (match[2] ?? "").trim();
  const { filename, lineNo, columnNo } = parseLocation(locationRaw);

  return {
    filename,
    ...(fn ? { function: fn } : {}),
    ...(lineNo !== undefined ? { line: lineNo } : {}),
    ...(columnNo !== undefined ? { column: columnNo } : {}),
    in_app: isInApp(filename),
    ...(moduleName(filename) ? { module: moduleName(filename) } : {}),
  };
}

/**
 * Split a V8 frame location into filename + line + column.
 *
 * Handles plain paths, the `(eval at ...)` wrapper V8 emits for eval frames,
 * and locationless natives such as `native` or `<anonymous>`.
 */
function parseLocation(locationRaw: string): {
  filename: string;
  lineNo?: number;
  columnNo?: number;
} {
  // Top-level async/constructor frames with no `()` wrapper render the whole
  // thing in the location group, e.g. `async node:internal/.../loader:1:1`.
  // Strip the leading qualifier so the filename detection below sees `node:…`.
  const location = locationRaw.replace(/^(?:async|new) /, "");

  // `eval at <anonymous> (/abs/file.js:1:1)` — pull the innermost real location.
  if (location.startsWith("eval at ")) {
    const inner = location.match(/\((.+)\)$/);
    if (inner?.[1]) return parseLocation(inner[1]);
  }

  const loc = LOCATION_RE.exec(location);
  if (!loc) {
    // `native`, `<anonymous>`, or anything without a `:line:col` tail.
    return { filename: location || "<unknown>" };
  }

  const filename = loc[1] || "<unknown>";
  const lineNo = loc[2] ? Number(loc[2]) : undefined;
  const columnNo = loc[3] ? Number(loc[3]) : undefined;
  return {
    filename,
    ...(Number.isFinite(lineNo) ? { lineNo } : {}),
    ...(Number.isFinite(columnNo) ? { columnNo } : {}),
  };
}

/**
 * Clean up V8 function descriptors. Drops the noisy `async`/`new` prefixes and
 * collapses anonymous markers to `undefined` so we omit the field entirely.
 */
function normalizeFunction(fn: string | undefined): string | undefined {
  if (!fn) return undefined;
  let name = fn.trim();
  name = name.replace(/^async /, "").replace(/^new /, "");
  if (!name || name === "<anonymous>" || name === "Object.<anonymous>") {
    return undefined;
  }
  return name;
}

/**
 * The crux of issue grouping: the server derives the "culprit" from the first
 * `in_app: true` frame. A frame is application code unless it lives in a
 * dependency directory or the runtime's own internals.
 *
 * Non-app frames:
 *   - `node:internal/...`, `node:fs`        → Node builtin protocol
 *   - paths containing `node_modules`        → installed dependencies
 *   - `bun:...` / `[eval]` style internals   → Bun builtins
 *   - `native`, `<anonymous>`, `<unknown>`   → no real source location
 */
export function isInApp(filename: string): boolean {
  if (!filename) return false;
  if (filename === "native" || filename === "<anonymous>" || filename === "<unknown>") {
    return false;
  }
  if (filename.startsWith("node:") || filename.startsWith("bun:")) return false;
  // Bun reports some internals as `[native code]` / `[eval]`.
  if (filename.startsWith("[") && filename.endsWith("]")) return false;
  if (/(^|[/\\])node_modules([/\\]|$)/.test(filename)) return false;
  return true;
}

/**
 * Best-effort module name for non-app frames, used as the optional `module`
 * field. `node:fs` → `node:fs`; `.../node_modules/express/lib/x.js` → `express`
 * (or `@scope/pkg` for scoped packages).
 */
function moduleName(filename: string): string | undefined {
  if (filename.startsWith("node:") || filename.startsWith("bun:")) return filename;
  const idx = filename.lastIndexOf("node_modules");
  if (idx === -1) return undefined;
  const rest = filename.slice(idx + "node_modules".length).replace(/^[/\\]/, "");
  const parts = rest.split(/[/\\]/);
  if (parts.length === 0 || !parts[0]) return undefined;
  if (parts[0].startsWith("@") && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

// Minimal ambient declarations for the Node surface a handful of tests need.
// The project ships no @types/node on purpose: src/ targets the browser, and
// a project-wide Node global namespace would let a Node-only API slip into
// application code and still typecheck. Only the members actually used by
// tests are declared here, in the same spirit as src/core/fs-api.d.ts.

declare module 'node:v8' {
  /** Applies a V8 flag at runtime — used with 'gc' below to measure retained heap. */
  export function setFlagsFromString(flags: string): void
  const v8: { setFlagsFromString: typeof setFlagsFromString }
  export default v8
}

declare module 'node:vm' {
  /** Compiles and runs `code` in a fresh context — the standard way to reach V8's `gc` hook without an --expose-gc command line. */
  export function runInNewContext(code: string): unknown
  const vm: { runInNewContext: typeof runInNewContext }
  export default vm
}

declare const process: {
  memoryUsage(): { heapUsed: number }
}

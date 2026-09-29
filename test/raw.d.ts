// Vite's `?raw` suffix (supported by vitest) imports a file's text. Declared
// here because tsconfig has no vite/client types and the zero-dep constraint
// rules out @types/node for a plain readFileSync.
declare module '*?raw' {
  const text: string
  export default text
}

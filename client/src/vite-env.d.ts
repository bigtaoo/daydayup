// Ambient declarations for Vite's own import suffixes. The workspace tsconfigs set
// `"types": []` (tsconfig.base.json) and never pull in `vite/client`, so the one suffix
// this codebase uses has to be declared here.

/** `import source from './file.ts?raw'` — Vite hands back the file's text unparsed.
 * Used by textMetrics.test.ts to assert an entry point still calls a boot-order-critical
 * function, which importing the entry itself cannot check (importing it runs `boot()`). */
declare module '*?raw' {
  const contents: string;
  export default contents;
}

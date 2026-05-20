import { defineConfig, externalizeDepsPlugin } from "electron-vite"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      lib: {
        entry: "src/main/index.ts",
        formats: ["es"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: {
        entry: "src/preload/index.ts",
        // CommonJS, NOT ESM. The renderer runs with `sandbox: true`
        // (see `src/main/index.ts`), and a sandboxed Electron renderer
        // can only load a CommonJS preload — an ESM preload silently
        // fails to execute, leaving `window.desktop` undefined and every
        // `/api/...` fetch resolving against `file://` ("Failed to fetch").
        formats: ["cjs"],
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: "out/renderer",
    },
  },
})

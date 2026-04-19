import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/bin/uber.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist/bin",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
})

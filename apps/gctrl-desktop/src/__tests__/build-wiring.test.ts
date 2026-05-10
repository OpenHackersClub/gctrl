// Build-artifact wiring contract.
//
// Unit tests prove `parseApiBase`, `resolveUrl`, and `buildKernelArgs` work in
// isolation. They cannot prove main, preload, and renderer are still wired
// together after electron-vite + the SPA copy step run. That gap was what let
// the "renderer can't reach the kernel" regression ship: every unit passed
// while the integration was broken.
//
// These tests inspect the compiled artifacts under `out/` to catch regressions
// where someone removes `additionalArguments`, the preload drops `apiBase`, or
// the bundled SPA forgets to consult `window.desktop`. They require a prior
// build (`pnpm build && pnpm build:renderer-spa`) and silently skip otherwise
// — keeping `pnpm test` green for contributors who haven't built yet, while
// still catching breakage in CI where the build runs before tests.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const repoRoot = join(__dirname, "..", "..")
const outDir = join(repoRoot, "out")

const skipIfMissing = (path: string): string | null => {
  if (!existsSync(path)) return null
  return readFileSync(path, "utf8")
}

describe("build wiring contract", () => {
  it("main bundle injects --gctrl-api-base via additionalArguments", () => {
    const source = skipIfMissing(join(outDir, "main", "index.js"))
    if (source === null) {
      console.warn("[build-wiring] skipping — out/main/index.js not built")
      return
    }
    expect(source).toContain("additionalArguments")
    expect(source).toContain("--gctrl-api-base=")
  })

  it("preload bundle exposes apiBase from parsed argv", () => {
    const dir = join(outDir, "preload")
    if (!existsSync(dir)) {
      console.warn("[build-wiring] skipping — out/preload not built")
      return
    }
    const entry = readdirSync(dir).find(
      (f) => f.startsWith("index.") && (f.endsWith(".js") || f.endsWith(".mjs")),
    )
    if (!entry) {
      console.warn("[build-wiring] skipping — preload entry missing")
      return
    }
    const source = readFileSync(join(dir, entry), "utf8")
    expect(source).toContain("apiBase")
    expect(source).toContain("--gctrl-api-base=")
  })

  it("main bundle's preload path matches the actual preload entry filename", () => {
    // Regression guard: electron-vite emits `out/preload/index.mjs` (ES
    // module format). When `src/main/index.ts` referenced
    // `../preload/index.js` instead, Electron silently failed to load the
    // preload, `window.desktop` was never defined, the SPA's `resolveUrl()`
    // fell back to the document origin (`file://`), and every `/api/...`
    // fetch turned into "Failed to fetch". Symptom-only — no error logged.
    const mainSource = skipIfMissing(join(outDir, "main", "index.js"))
    const preloadDir = join(outDir, "preload")
    if (mainSource === null || !existsSync(preloadDir)) {
      console.warn("[build-wiring] skipping — main or preload not built")
      return
    }
    const preloadEntry = readdirSync(preloadDir).find(
      (f) => f.startsWith("index.") && (f.endsWith(".js") || f.endsWith(".mjs")),
    )
    if (!preloadEntry) {
      console.warn("[build-wiring] skipping — preload entry missing")
      return
    }
    expect(
      mainSource,
      `main bundle must reference ../preload/${preloadEntry} (the actual built filename)`,
    ).toContain(`../preload/${preloadEntry}`)
  })

  it("bundled renderer index.html uses relative asset paths so file:// can load it", () => {
    const indexPath = join(outDir, "renderer", "index.html")
    const html = skipIfMissing(indexPath)
    if (html === null) {
      console.warn("[build-wiring] skipping — out/renderer/index.html not built")
      return
    }
    // Under `file://`, an absolute `/assets/...` href resolves to
    // `file:///assets/...` and the SPA never loads. The desktop renderer
    // build must emit `./assets/...` (vite `base: './'`).
    const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
    const styleHrefs = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1])
    const assetRefs = [...scriptSrcs, ...styleHrefs]
    expect(assetRefs.length).toBeGreaterThan(0)
    for (const ref of assetRefs) {
      expect(ref, `asset ref must be relative (not /...) for file:// loading: ${ref}`).not.toMatch(/^\//)
    }
  })

  it("bundled renderer is the SPA, not the placeholder fallback", () => {
    // `pnpm build` writes `out/renderer/index.html` as a placeholder
    // ("Renderer not bundled."). The real SPA only lands when
    // `pnpm build:renderer-spa` runs after — it RM's `out/renderer/` and
    // copies `apps/gctrl-board/dist-web/` in. If someone packages with
    // just `pnpm build`, the asar ships the placeholder and users see
    // "Renderer not bundled" on launch instead of the dashboard.
    //
    // Hard-fail instead of skipping: if `out/renderer/` exists but is the
    // placeholder, packaging is broken and CI must see it.
    const indexPath = join(outDir, "renderer", "index.html")
    const indexHtml = skipIfMissing(indexPath)
    if (indexHtml === null) {
      console.warn("[build-wiring] skipping — out/renderer/index.html not built")
      return
    }
    expect(
      indexHtml,
      "out/renderer/index.html is the fallback placeholder — `pnpm build:renderer-spa` did not run",
    ).not.toContain("Renderer not bundled")
  })

  it("bundled renderer SPA reads window.desktop.apiBase before fetching", () => {
    const assetsDir = join(outDir, "renderer", "assets")
    if (!existsSync(assetsDir)) {
      console.warn("[build-wiring] skipping — out/renderer/assets not built")
      return
    }
    const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"))
    if (jsFiles.length === 0) {
      console.warn("[build-wiring] skipping — no renderer JS chunks")
      return
    }
    const combined = jsFiles
      .map((f) => readFileSync(join(assetsDir, f), "utf8"))
      .join("\n")
    // The minified bundle preserves identifier names for property accesses on
    // unknown objects (`globalThis.desktop`, `desktop.apiBase`). If those
    // strings vanish, the SPA has stopped consulting the bridge.
    expect(combined).toContain("desktop")
    expect(combined).toContain("apiBase")
    expect(combined).toContain("/api/board")
  })
})

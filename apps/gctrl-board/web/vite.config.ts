import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

export default defineConfig({
  root: path.resolve(__dirname),
  // Cloudflare Pages serves from the worker root (`/`), but the Electron
  // desktop loads index.html from `file://` where absolute `/assets/...`
  // hrefs resolve to a non-existent filesystem root. The desktop build
  // sets `VITE_BASE=./` so emitted asset refs are relative and load.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // shadcn/ui convention — `@/components/ui/...` etc.
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../dist-web"),
  },
  server: {
    port: 4200,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.GCTRL_KERNEL_PORT ?? "4318"}`,
        changeOrigin: true,
      },
    },
  },
  // SPA fallback — serve index.html for /projects/* routes in production builds
  appType: "spa",
})
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), tailwindcss()],
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
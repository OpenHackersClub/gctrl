import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { App } from "./App"
import { applyDesktopClass } from "./lib/desktop-env"

// Flag the document for Electron-specific layout (leaves room for the
// macOS traffic-light buttons and makes the header draggable). No-op on web.
applyDesktopClass(document.documentElement, globalThis as { desktop?: { apiBase?: string } })

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

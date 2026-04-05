/**
 * Chrome DevTools Protocol (CDP) observer for acceptance tests.
 *
 * Wraps a Playwright CDPSession to provide:
 *  - Network request/response capture and analysis
 *  - Console and runtime error monitoring
 *  - Performance metrics from the Performance domain
 *  - Memory/DOM health indicators
 *
 * Usage: instantiated by the test fixture via `page.context().newCDPSession(page)`.
 */
import type { CDPSession } from "@playwright/test"

// ── Types ──

export interface CapturedRequest {
  requestId: string
  url: string
  method: string
  timestamp: number
  responseStatus?: number
  responseHeaders?: Record<string, string>
  timing?: {
    requestTime: number
    receiveHeadersEnd: number
  }
}

export interface ConsoleEntry {
  type: string
  text: string
  timestamp: number
  level: "info" | "warn" | "error"
}

export interface ObservabilityReport {
  totalRequests: number
  apiRequests: number
  failedRequests: number
  consoleErrors: number
  apiPaths: string[]
}

// ── Observer ──

export class CDPObserver {
  private requests = new Map<string, CapturedRequest>()
  private consoleEntries: ConsoleEntry[] = []
  private active = false

  constructor(private readonly session: CDPSession) {}

  /** Enable Network, Runtime, and Performance CDP domains. */
  async enable(): Promise<void> {
    if (this.active) return
    this.active = true

    // ── Network domain ──
    await this.session.send("Network.enable")

    this.session.on("Network.requestWillBeSent", (params: any) => {
      this.requests.set(params.requestId, {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        timestamp: params.timestamp,
      })
    })

    this.session.on("Network.responseReceived", (params: any) => {
      const req = this.requests.get(params.requestId)
      if (req) {
        req.responseStatus = params.response.status
        req.responseHeaders = params.response.headers
        req.timing = params.response.timing
      }
    })

    // ── Runtime domain (console + exceptions) ──
    await this.session.send("Runtime.enable")

    this.session.on("Runtime.consoleAPICalled", (params: any) => {
      const text = params.args
        .map((arg: any) => arg.value ?? arg.description ?? "")
        .join(" ")
      this.consoleEntries.push({
        type: params.type,
        text,
        timestamp: params.timestamp,
        level:
          params.type === "error"
            ? "error"
            : params.type === "warning"
              ? "warn"
              : "info",
      })
    })

    this.session.on("Runtime.exceptionThrown", (params: any) => {
      this.consoleEntries.push({
        type: "exception",
        text:
          params.exceptionDetails.text ??
          params.exceptionDetails.exception?.description ??
          "Unknown exception",
        timestamp: params.timestamp,
        level: "error",
      })
    })

    // ── Performance domain ──
    await this.session.send("Performance.enable", {
      timeDomain: "timeTicks",
    })
  }

  /** Disable all CDP domains. */
  async disable(): Promise<void> {
    if (!this.active) return
    await this.session.send("Network.disable").catch(() => {})
    await this.session.send("Runtime.disable").catch(() => {})
    await this.session.send("Performance.disable").catch(() => {})
    this.active = false
  }

  // ── Network Analysis ──

  /** All captured requests. */
  getRequests(): CapturedRequest[] {
    return Array.from(this.requests.values())
  }

  /** Requests matching a URL regex. */
  getRequestsByPattern(pattern: RegExp): CapturedRequest[] {
    return this.getRequests().filter((r) => pattern.test(r.url))
  }

  /** Requests to /api/board/* paths (board API traffic, not Vite HMR). */
  getApiRequests(): CapturedRequest[] {
    return this.getRequests().filter((r) => {
      try {
        const url = new URL(r.url)
        return url.pathname.startsWith("/api/board/")
      } catch {
        return false
      }
    })
  }

  /** Requests that received a non-2xx response. */
  getFailedRequests(): CapturedRequest[] {
    return this.getRequests().filter(
      (r) =>
        r.responseStatus != null &&
        (r.responseStatus < 200 || r.responseStatus >= 300)
    )
  }

  /** Reset captured network data. */
  clearRequests(): void {
    this.requests.clear()
  }

  // ── Console Analysis ──

  /** All captured console entries. */
  getConsoleEntries(): ConsoleEntry[] {
    return [...this.consoleEntries]
  }

  /** Console errors and exceptions only. */
  getConsoleErrors(): ConsoleEntry[] {
    return this.consoleEntries.filter((e) => e.level === "error")
  }

  /** Reset captured console data. */
  clearConsole(): void {
    this.consoleEntries = []
  }

  // ── Performance Metrics ──

  /** Raw metrics from CDP Performance.getMetrics. */
  async getPerformanceMetrics(): Promise<Record<string, number>> {
    const { metrics } = await this.session.send("Performance.getMetrics")
    const result: Record<string, number> = {}
    for (const m of metrics as Array<{ name: string; value: number }>) {
      result[m.name] = m.value
    }
    return result
  }

  /** JS heap usage in MB. */
  async getJSHeapSizeMB(): Promise<number> {
    const metrics = await this.getPerformanceMetrics()
    return (metrics["JSHeapUsedSize"] ?? 0) / (1024 * 1024)
  }

  /** Active document count (helps detect DOM/iframe leaks). */
  async getDocumentCount(): Promise<number> {
    const metrics = await this.getPerformanceMetrics()
    return metrics["Documents"] ?? 0
  }

  /** Cumulative layout duration in seconds. */
  async getLayoutDuration(): Promise<number> {
    const metrics = await this.getPerformanceMetrics()
    return metrics["LayoutDuration"] ?? 0
  }

  /** Cumulative script duration in seconds. */
  async getScriptDuration(): Promise<number> {
    const metrics = await this.getPerformanceMetrics()
    return metrics["ScriptDuration"] ?? 0
  }

  // ── Summary ──

  /** Produce a summary report of the observation session. */
  report(): ObservabilityReport {
    const apiReqs = this.getApiRequests()
    return {
      totalRequests: this.requests.size,
      apiRequests: apiReqs.length,
      failedRequests: this.getFailedRequests().length,
      consoleErrors: this.getConsoleErrors().length,
      apiPaths: apiReqs.map((r) => {
        try {
          return new URL(r.url).pathname
        } catch {
          return r.url
        }
      }),
    }
  }
}

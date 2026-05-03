/**
 * Kernel-backed CDPObserver — same surface as `cdp.ts::CDPObserver` but
 * pulls observations from the kernel's recorder via HTTP instead of an
 * in-process Playwright `CDPSession`. Used when `BROWSER_BACKEND=kernel`.
 *
 * The kernel taps CDP frames at the WS proxy layer (`gctrl-browser`'s
 * `cdp_proxy::run_proxy`) and structures them into per-session
 * `recorder_*` records (`gctrl-recorder::CaptureSink`). This observer is
 * a thin fetch-and-shape layer over those records — designed to be a
 * drop-in for the in-process `CDPObserver` so test assertion code is
 * untouched during the PR5 parity gate.
 *
 * Spec: vault/specs/implementation/kernel/driver-browser.md §3, §9.
 */

import type { CapturedRequest, ConsoleEntry, ObservabilityReport } from "./cdp"

interface KernelRequest {
  requestId: string
  url: string
  method: string
  status: number | null
  startedAt: string
  finishedAt: string | null
  failed: boolean
}

interface KernelConsole {
  seq: number
  level: "log" | "info" | "warn" | "error" | "debug" | "exception"
  kind: string
  text: string
  ts: string
}

interface KernelMetric {
  name: string
  value: number
  ts: string
}

export class KernelCDPObserver {
  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string
  ) {}

  /** No-op: enabling/disabling happens implicitly when the kernel
   * acquires/releases the session. Kept for `CDPObserver` parity. */
  async enable(): Promise<void> {}
  async disable(): Promise<void> {}

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`)
    if (!res.ok) {
      throw new Error(
        `kernel recorder fetch ${path} → ${res.status} ${res.statusText}`
      )
    }
    return (await res.json()) as T
  }

  private async fetchRequests(): Promise<KernelRequest[]> {
    return this.fetchJson<KernelRequest[]>(
      `/api/browser/sessions/${encodeURIComponent(this.sessionId)}/network`
    )
  }

  private async fetchConsole(): Promise<KernelConsole[]> {
    return this.fetchJson<KernelConsole[]>(
      `/api/browser/sessions/${encodeURIComponent(this.sessionId)}/console`
    )
  }

  private async fetchMetrics(): Promise<KernelMetric[]> {
    return this.fetchJson<KernelMetric[]>(
      `/api/browser/sessions/${encodeURIComponent(this.sessionId)}/metrics`
    )
  }

  private toCaptured(r: KernelRequest): CapturedRequest {
    return {
      requestId: r.requestId,
      url: r.url,
      method: r.method,
      timestamp: Date.parse(r.startedAt) / 1000,
      responseStatus: r.status ?? undefined,
    }
  }

  private toConsole(e: KernelConsole): ConsoleEntry {
    const level: ConsoleEntry["level"] =
      e.level === "error" || e.level === "exception"
        ? "error"
        : e.level === "warn"
          ? "warn"
          : "info"
    return {
      type: e.kind,
      text: e.text,
      timestamp: Date.parse(e.ts) / 1000,
      level,
    }
  }

  // Note: these mirror the `CDPObserver` accessors but are async because
  // they go over HTTP. Tests on the kernel backend `await` them; tests
  // on the local backend get the sync versions. Cutover work in a
  // future PR will unify the call sites.

  async getRequests(): Promise<CapturedRequest[]> {
    const xs = await this.fetchRequests()
    return xs.map((r) => this.toCaptured(r))
  }

  async getRequestsByPattern(pattern: RegExp): Promise<CapturedRequest[]> {
    const xs = await this.getRequests()
    return xs.filter((r) => pattern.test(r.url))
  }

  async getApiRequests(): Promise<CapturedRequest[]> {
    const xs = await this.getRequests()
    return xs.filter((r) => {
      try {
        return new URL(r.url).pathname.startsWith("/api/board/")
      } catch {
        return false
      }
    })
  }

  async getFailedRequests(): Promise<CapturedRequest[]> {
    const xs = await this.fetchRequests()
    return xs
      .filter(
        (r) =>
          r.failed ||
          (r.status != null && (r.status < 200 || r.status >= 300))
      )
      .map((r) => this.toCaptured(r))
  }

  async getConsoleEntries(): Promise<ConsoleEntry[]> {
    const xs = await this.fetchConsole()
    return xs.map((e) => this.toConsole(e))
  }

  async getConsoleErrors(): Promise<ConsoleEntry[]> {
    const xs = await this.fetchConsole()
    return xs
      .filter((e) => e.level === "error" || e.level === "exception")
      .map((e) => this.toConsole(e))
  }

  async getPerformanceMetrics(): Promise<Record<string, number>> {
    const xs = await this.fetchMetrics()
    const out: Record<string, number> = {}
    for (const m of xs) out[m.name] = m.value
    return out
  }

  async getJSHeapSizeMB(): Promise<number> {
    const m = await this.getPerformanceMetrics()
    return (m["JSHeapUsedSize"] ?? 0) / (1024 * 1024)
  }

  async getDocumentCount(): Promise<number> {
    const m = await this.getPerformanceMetrics()
    return m["Documents"] ?? 0
  }

  async report(): Promise<ObservabilityReport> {
    const requests = await this.fetchRequests()
    const console = await this.fetchConsole()
    const apiPaths: string[] = []
    let apiCount = 0
    let failedCount = 0
    for (const r of requests) {
      try {
        const u = new URL(r.url)
        if (u.pathname.startsWith("/api/board/")) {
          apiCount++
          apiPaths.push(u.pathname)
        }
      } catch {
        // skip non-URL entries
      }
      if (r.failed || (r.status != null && (r.status < 200 || r.status >= 300))) {
        failedCount++
      }
    }
    const errorCount = console.filter(
      (e) => e.level === "error" || e.level === "exception"
    ).length
    return {
      totalRequests: requests.length,
      apiRequests: apiCount,
      failedRequests: failedCount,
      consoleErrors: errorCount,
      apiPaths,
    }
  }
}

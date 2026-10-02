/**
 * Kernel-backed CDPObserver — same surface as `cdp.ts::CDPObserver` but
 * pulls observations from the kernel's recorder via HTTP instead of an
 * in-process Playwright `CDPSession`. Used when `BROWSER_BACKEND=kernel`.
 *
 * The kernel taps CDP frames at the WS proxy layer (`gctrl-browser`'s
 * `scope::run_scoped_proxy`) and structures them into per-session
 * `recorder_*` records (`gctrl-recorder::CaptureSink`). This observer is
 * a thin fetch-and-shape layer over those records — designed to be a
 * drop-in for the in-process `CDPObserver` so test assertion code is
 * awaits either backend during the parity gate.
 *
 * Spec: vault/specs/implementation/kernel/driver-browser.md §3, §9.
 */

import type { CapturedRequest, ConsoleEntry, ObservabilityReport } from "./cdp"

import { Effect } from "effect"
import type { CDPSession } from "@playwright/test"
import { BrowserClient, type CapturedRequest as KernelRequest, type ConsoleEntry as KernelConsole } from "../../../../../shell/gctrl-shell/src/services/BrowserClient"
import { kernelBrowserLayer } from "./kernel-browser"

export class KernelCDPObserver {
  private consoleAfterSeq = -1
  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
    private readonly cdp: Pick<CDPSession, "send">,
  ) {}

  /** No-op: enabling/disabling happens implicitly when the kernel
   * acquires/releases the session. Kept for `CDPObserver` parity. */
  async enable(): Promise<void> {}
  async disable(): Promise<void> {}

  private fetchRequests() {
    return Effect.runPromise(Effect.flatMap(BrowserClient, browser => browser.network(this.sessionId)).pipe(
      Effect.provide(kernelBrowserLayer(this.baseUrl)),
    ))
  }

  private fetchConsole() {
    return Effect.runPromise(Effect.flatMap(BrowserClient, browser => browser.console(this.sessionId)).pipe(
      Effect.provide(kernelBrowserLayer(this.baseUrl)),
    )).then(entries => entries.filter(entry => entry.seq > this.consoleAfterSeq))
  }

  async clearConsole(): Promise<void> {
    const entries = await this.fetchConsole()
    this.consoleAfterSeq = entries.reduce((latest, entry) => Math.max(latest, entry.seq), this.consoleAfterSeq)
  }

  private toCaptured(r: KernelRequest): CapturedRequest {
    return {
      requestId: r.requestId,
      url: r.url,
      method: r.method,
      timestamp: Date.parse(r.startedAt) / 1000,
      responseStatus: r.status ?? undefined,
      responseHeaders: r.responseHeaders,
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

  // Both fixture paths await these accessors; kernel reads use validated
  // shell responses for the same identity that controls the page.

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
    // Performance samples are requested against this page's validated CDP
    // session; the kernel proxy also captures the response for its recorder.
    const { metrics } = await this.cdp.send("Performance.getMetrics")
    return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]))
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

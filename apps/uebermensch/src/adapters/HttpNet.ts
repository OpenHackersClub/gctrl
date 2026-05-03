// HttpNet.ts — kernel-backed adapter for NetService.
//
// Routes through:
//   - POST /api/search/web   — Brave Search (web). Already wired in
//     `gctrl-otel/src/receiver.rs` and backed by `gctrl-net::search`.
//     Requires `BRAVE_SEARCH_API_KEY` configured on the kernel; without it
//     the kernel returns HTTP 503 and the freshness probe degrades
//     gracefully (no probes ingested, report renders against existing
//     candidates).
//   - POST /api/net/fetch    — `gctrl-net` page fetch + readability +
//     min-word gate. Returns markdown directly; no separate accept toggle
//     is needed because the kernel always emits `markdown`.
//
// Both routes ship today; no new kernel work is required to enable the
// freshness probe at runtime.
//
// Connection-level failures (kernel down) → NetError::unavailable.
// Brave-key-missing (HTTP 503) → NetError::unavailable, logged so the
// operator can wire the key.
// gctrl-net quality gates (e.g. "page below word threshold") return
// HTTP 502; we surface them as NetError::not_found so the probe drops
// the URL and continues.

import { Effect, Layer } from "effect";
import { NetError } from "../errors.js";
import { isConnRefused, SERVICE_NAME, sessionIdFor } from "../lib/llm-shared.js";
import { NetService } from "../services/NetService.js";
import type { NetFetchResponse, NetSearchResponse } from "../services/NetService.js";

const kernelBase = (): string =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "");

const netErr = (kind: NetError["kind"], message: string, url?: string): NetError =>
  new NetError({ kind, message, url });

const classifyStatus = (status: number, path: string): NetError["kind"] => {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 401 || status === 403) return "invalid";
  // gctrl-net's quality gates (min_words, paywall) come back as 502.
  // Treat those as not_found so the probe drops the URL silently.
  if (status === 502 && path === "/api/net/fetch") return "not_found";
  if (status >= 500) return "unavailable";
  return "invalid";
};

// POST a JSON body to the kernel and return the parsed response body.
// Connection failures → NetError::unavailable.
// 4xx/5xx → classified NetError.
const postKernel = <T>(path: string, body: unknown): Effect.Effect<T, NetError> =>
  Effect.gen(function* () {
    const url = `${kernelBase()}${path}`;
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session-id": sessionIdFor(),
            "x-service-name": SERVICE_NAME,
          },
          body: JSON.stringify(body),
        }),
      catch: (e) => {
        if (isConnRefused(e)) {
          return netErr(
            "unavailable",
            `kernel ${path} not reachable at ${url} — start gctrld via 'gctrld serve --port 4318' or set GCTRL_KERNEL_URL`,
          );
        }
        return netErr("unavailable", `kernel ${path} fetch failed: ${String(e)}`);
      },
    });

    const raw = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) => netErr("unavailable", `kernel ${path} body read failed: ${String(e)}`),
    });

    if (!res.ok) {
      return yield* Effect.fail(
        netErr(
          classifyStatus(res.status, path),
          `kernel ${path} HTTP ${res.status}: ${raw.slice(0, 300)}`,
        ),
      );
    }

    return yield* Effect.try({
      try: () => JSON.parse(raw) as T,
      catch: (e) => netErr("invalid", `kernel ${path} JSON.parse failed: ${String(e)}`),
    });
  });

// Kernel /api/search/web response shape (gctrl_net::SearchResponse).
type KernelSearchResponse = {
  readonly query: string;
  readonly kind: string;
  readonly results: ReadonlyArray<{
    readonly title: string;
    readonly url: string;
    readonly description: string;
    readonly age?: string;
  }>;
};

// Kernel /api/net/fetch response shape (gctrl_net::PageContent).
// `markdown` is the post-readability rendered content; `status` is the
// upstream HTTP status; `title` is extracted from the page.
type KernelFetchResponse = {
  readonly url: string;
  readonly title: string;
  readonly markdown: string;
  readonly word_count: number;
  readonly status: number;
};

export const HttpNetLive = Layer.succeed(NetService, {
  search: (req) =>
    Effect.gen(function* () {
      const body = {
        q: req.query,
        count: req.maxResults ?? 5,
      };
      const resp = yield* postKernel<KernelSearchResponse>("/api/search/web", body);
      const response: NetSearchResponse = {
        query: resp.query,
        results: (resp.results ?? []).map((r) => ({
          url: r.url,
          title: r.title,
          // Brave returns `description`; NetService models it as `snippet`
          // because the field is meant for the agent prompt regardless of
          // upstream nomenclature.
          snippet: r.description,
        })),
      };
      return response;
    }),

  fetch: (req) =>
    Effect.gen(function* () {
      // gctrl-net always emits markdown via readability; the `accept` flag
      // on NetService is honored by readability=false when the caller
      // explicitly asks for raw HTML.
      const body = {
        url: req.url,
        readability: req.accept !== "html",
      };
      const resp = yield* postKernel<KernelFetchResponse>("/api/net/fetch", body);
      const response: NetFetchResponse = {
        url: resp.url,
        status: resp.status,
        content: resp.markdown,
        // gctrl-net returns markdown when readability=true, else HTML.
        contentType: req.accept === "html" ? "text/html" : "text/markdown",
      };
      return response;
    }),
});

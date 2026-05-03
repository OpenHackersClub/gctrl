// HttpNet.ts — kernel-backed adapter for NetService.
//
// Routes through POST /api/net/search and POST /api/net/fetch on the gctrld
// kernel (GCTRL_KERNEL_URL, default http://127.0.0.1:4318).
//
// NOTE: Routes assumed to exist; `gctrl-driver-net` LKM lands separately.
// The adapter codes against the spec'd HTTP shape; until the LKM is up,
// calls fail with NetError::unavailable, which FreshnessProbeService catches
// and skips gracefully.

import { Effect, Layer } from "effect";
import { NetError } from "../errors.js";
import { isConnRefused, SERVICE_NAME, sessionIdFor } from "../lib/llm-shared.js";
import { NetService } from "../services/NetService.js";
import type { NetFetchResponse, NetSearchResponse } from "../services/NetService.js";

const kernelBase = (): string =>
  (process.env.GCTRL_KERNEL_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "");

const netErr = (kind: NetError["kind"], message: string, url?: string): NetError =>
  new NetError({ kind, message, url });

const classifyStatus = (status: number): NetError["kind"] => {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 401 || status === 403) return "invalid";
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
            `kernel net route not reachable at ${url} — start gctrld or wait for gctrl-driver-net LKM`,
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
        netErr(classifyStatus(res.status), `kernel ${path} HTTP ${res.status}: ${raw.slice(0, 300)}`),
      );
    }

    return yield* Effect.try({
      try: () => JSON.parse(raw) as T,
      catch: (e) => netErr("invalid", `kernel ${path} JSON.parse failed: ${String(e)}`),
    });
  });

// Kernel /api/net/search response shape (matches driver-net spec).
type KernelSearchResponse = {
  readonly query: string;
  readonly results: ReadonlyArray<{
    readonly url: string;
    readonly title: string;
    readonly snippet: string;
  }>;
};

// Kernel /api/net/fetch response shape (matches driver-net spec).
type KernelFetchResponse = {
  readonly url: string;
  readonly status: number;
  readonly content: string;
  readonly content_type: string;
};

export const HttpNetLive = Layer.succeed(NetService, {
  search: (req) =>
    Effect.gen(function* () {
      const body = {
        query: req.query,
        max_results: req.maxResults ?? 5,
      };
      const resp = yield* postKernel<KernelSearchResponse>("/api/net/search", body);
      const response: NetSearchResponse = {
        query: resp.query,
        results: (resp.results ?? []).map((r) => ({
          url: r.url,
          title: r.title,
          snippet: r.snippet,
        })),
      };
      return response;
    }),

  fetch: (req) =>
    Effect.gen(function* () {
      const body = {
        url: req.url,
        accept: req.accept ?? "markdown",
      };
      const resp = yield* postKernel<KernelFetchResponse>("/api/net/fetch", body);
      const response: NetFetchResponse = {
        url: resp.url,
        status: resp.status,
        content: resp.content,
        contentType: resp.content_type,
      };
      return response;
    }),
});

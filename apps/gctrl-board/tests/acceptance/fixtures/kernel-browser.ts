import { Effect, Layer } from "effect"
import { FetchHttpClient } from "@effect/platform"
import { HttpKernelClientLive } from "../../../../../shell/gctrl-shell/src/adapters/HttpKernelClient"
import { HttpBrowserClientLive } from "../../../../../shell/gctrl-shell/src/adapters/HttpBrowserClient"
import { BrowserClient } from "../../../../../shell/gctrl-shell/src/services/BrowserClient"

/** Use the shell's validated browser transport for acceptance fixtures. */
export const kernelBrowserLayer = (baseUrl: string) =>
  HttpBrowserClientLive.pipe(
    Layer.provide(HttpKernelClientLive(baseUrl)),
    Layer.provide(FetchHttpClient.layer),
  )

export const acquireKernelSession = (baseUrl: string) =>
  Effect.runPromise(
    Effect.flatMap(BrowserClient, (browser) => browser.acquire({ ttlSeconds: 600 })).pipe(
      Effect.provide(kernelBrowserLayer(baseUrl)),
    ),
  )

export const releaseKernelSession = (baseUrl: string, id: string) =>
  Effect.runPromise(
    Effect.flatMap(BrowserClient, (browser) => browser.release(id)).pipe(
      Effect.provide(kernelBrowserLayer(baseUrl)),
    ),
  )

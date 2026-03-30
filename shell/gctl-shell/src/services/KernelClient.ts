/**
 * KernelClient — port interface for calling the gctl kernel HTTP API.
 *
 * The shell accesses the Rust kernel exclusively via HTTP on :4318.
 * This is the boundary: Effect-TS shell talks to the kernel via HTTP only.
 */
import { Context, Effect, Schema } from "effect"
import type { KernelError, KernelUnavailableError } from "../errors.js"

export class KernelClient extends Context.Tag("KernelClient")<
  KernelClient,
  {
    readonly get: <A, I, R>(
      path: string,
      schema: Schema.Schema<A, I, R>
    ) => Effect.Effect<A, KernelError | KernelUnavailableError>

    readonly post: <A, I, R>(
      path: string,
      body: unknown,
      schema: Schema.Schema<A, I, R>
    ) => Effect.Effect<A, KernelError | KernelUnavailableError>

    readonly delete: (
      path: string
    ) => Effect.Effect<void, KernelError | KernelUnavailableError>

    readonly health: () => Effect.Effect<boolean, KernelUnavailableError>
  }
>() {}

import { Context, type Effect } from "effect"
import type { DeliveryError } from "../errors.js"

export type DeliveryResult = {
  readonly channel: string
  readonly driver: string
  readonly externalIds: ReadonlyArray<string>
  readonly parts: number
}

export type DeliverInput = {
  readonly channel: string
  readonly driver: string
  readonly targetRef: string
  readonly silent: boolean
  readonly content: string
  readonly briefDate: string
}

export interface DelivererServiceShape {
  readonly send: (input: DeliverInput) => Effect.Effect<DeliveryResult, DeliveryError>
}

export class DelivererService extends Context.Tag("uebermensch/DelivererService")<
  DelivererService,
  DelivererServiceShape
>() {}

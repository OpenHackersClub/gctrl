// buildModeLayer — picks the LlmService and DelivererService Layers that
// match the resolved deployment Mode.
//
// Mode → adapter mapping (today):
//
//   local-kernel  → KernelLlm + HttpDeliverer
//                   (kernel daemon owns LLM + messaging proxy + secret injection)
//
//   local-direct  → AnthropicLlm | LMStudioLlm + DirectDeliverer
//                   (no daemon; tokens resolved via SecretsService at request time)
//
//   cloud-only    → AnthropicLlm + DirectDeliverer
//                   (Worker / hosted target; AnthropicLlm honors
//                    UBER_ANTHROPIC_BASE_URL so the operator can route through
//                    Cloudflare AI Gateway by setting that env)
//
// LLM provider selection in --mode=local-direct is by model id: claude-* →
// Anthropic, anything else → LMStudio. Set UBER_LLM_MODEL to switch.

import { Layer } from "effect"
import { AnthropicLlmLive } from "../adapters/AnthropicLlm.js"
import { DirectDelivererLive } from "../adapters/DirectDeliverer.js"
import { HttpDelivererLive } from "../adapters/HttpDeliverer.js"
import { KernelLlmLive } from "../adapters/KernelLlm.js"
import { LMStudioLlmLive } from "../adapters/LMStudioLlm.js"
import { DelivererService } from "../services/DelivererService.js"
import { LlmService } from "../services/LlmService.js"
import { SecretsService } from "../services/SecretsService.js"
import { type Mode } from "./mode.js"

const isAnthropicModel = (model: string): boolean => model.startsWith("claude-")

const modelHint = (): string => process.env.UBER_LLM_MODEL ?? ""

/**
 * Pick the LlmService Layer for `mode`. May require `SecretsService`
 * (Anthropic direct does; kernel + LMStudio do not — TypeScript widens the
 * R channel to the most-restrictive variant).
 *
 * `model` is an explicit override for the UBER_LLM_MODEL hint, useful in
 * tests so they don't have to mutate process.env.
 */
export const buildLlmLayer = (
  mode: Mode,
  model: string = modelHint(),
): Layer.Layer<LlmService, never, SecretsService> => {
  if (mode === "local-kernel") return KernelLlmLive
  // local-direct + cloud-only both bypass the kernel; pick provider by model.
  if (model === "" || isAnthropicModel(model)) return AnthropicLlmLive
  return LMStudioLlmLive
}

/**
 * Pick the DelivererService Layer for `mode`. Both adapters require
 * SecretsService at construction time (target_ref `env:` resolution).
 */
export const buildDelivererLayer = (
  mode: Mode,
): Layer.Layer<DelivererService, never, SecretsService> => {
  if (mode === "local-kernel") return HttpDelivererLive
  return DirectDelivererLive
}

/**
 * Convenience composition — both adapters merged. Caller still needs to
 * provide `SecretsService` (typically `EnvSecretsLive` today; future
 * KernelSecretsLive / LocalKeychainLive).
 */
export const buildModeLayer = (
  mode: Mode,
  model: string = modelHint(),
): Layer.Layer<LlmService | DelivererService, never, SecretsService> =>
  Layer.mergeAll(buildLlmLayer(mode, model), buildDelivererLayer(mode))

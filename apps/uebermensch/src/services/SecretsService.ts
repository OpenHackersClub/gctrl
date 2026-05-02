// SecretsService — read-only port for resolving channel tokens, API keys,
// signing secrets. Implementing adapters (EnvSecrets, KernelSecrets,
// LocalKeychain, WranglerSecrets) MUST NOT expose write operations;
// provisioning lives on a distinct port (SecretsProvisionService) so that
// runtime-immutable backends like Cloudflare Workers env bindings can
// faithfully implement read without pretending to support writes they cannot
// honor.
//
// Resolves blocker B1 from the ejection-plan team review: WranglerSecrets is
// physically read-only at runtime, so a unified read+write SecretsPort had an
// interface contract one of its own adapters could not satisfy.
//
// Absence is modeled as `Option.none`, not an error — a missing onboarding
// token is normal during the wizard's pending-confirmation window.
// Infrastructure failures (keychain unavailable, kernel unreachable, malformed
// key) flow through `SecretsError`.

import { Context, type Effect, type Option } from "effect";
import type { SecretsError } from "../errors.js";

export type SecretsServiceImpl = {
  /**
   * Read a secret by key. Returns `Option.none` if the key is unset or
   * expired (TTL semantics live in the storage adapter — see
   * `SecretsProvisionService` for how TTL is recorded). Fails with
   * `SecretsError` on backend errors only.
   */
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, SecretsError>;

  /**
   * Lightweight diagnostic — does the backend know about this key without
   * decrypting/exposing the value? Useful for `uber doctor` and the
   * onboarding wizard's status polling. Same `Option`/error semantics as
   * `get`.
   */
  readonly has: (key: string) => Effect.Effect<boolean, SecretsError>;
};

export class SecretsService extends Context.Tag("uebermensch/SecretsService")<
  SecretsService,
  SecretsServiceImpl
>() {}

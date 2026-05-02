// SecretsProvisionService — write port for onboarding flows that need to
// persist channel tokens, OAuth refresh tokens, signing keys. Distinct from
// SecretsService (read) so that read-only adapters (WranglerSecrets) cannot
// accidentally implement provisioning.
//
// Resolves blocker B12 from the ejection-plan team review: PR #144's
// "channel-onboarding token lifetime ≤10 min" requirement had no enforcement
// site. `ttlSeconds` is a first-class parameter on `set`; adapters that
// don't natively support TTL (filesystem, keychain) wrap the value in
// `{ value, expires_at }` and the matching read adapter checks expiry on
// `get`, returning `Option.none` past it.
//
// `scope` carries the active `identity.slug` so that a token provisioned for
// one profile cannot be read by another on the same machine — adapters that
// support namespacing (kernel secret store, future cloud KV) prefix keys
// with the scope; adapters without native scoping (env-only WranglerSecrets)
// simply do not implement this port.

import { Context, type Effect } from "effect";
import type { SecretsError } from "../errors.js";

export type SecretsSetOptions = {
  /**
   * Time-to-live in seconds. Onboarding tokens default to 600 (10 min) per
   * PR #144's lifetime cap. Long-lived credentials (post-confirmation
   * channel tokens, API keys) pass `undefined` for no expiry.
   */
  readonly ttlSeconds?: number;
  /**
   * Identity slug the secret belongs to. Adapters MUST scope storage by
   * this value so secrets do not leak across profiles on shared hosts.
   */
  readonly scope: string;
};

export type SecretsProvisionServiceImpl = {
  /**
   * Persist a secret. `ttlSeconds` is honored by the adapter — natively if
   * the backend supports TTL (Redis-style), via envelope+lazy-expiry
   * otherwise (filesystem, keychain).
   */
  readonly set: (
    key: string,
    value: string,
    opts: SecretsSetOptions,
  ) => Effect.Effect<void, SecretsError>;

  /**
   * Remove a secret. Idempotent — deleting an absent key succeeds without
   * error. Caller passes the same `scope` used at `set` time so the adapter
   * resolves the namespaced key.
   */
  readonly delete: (
    key: string,
    scope: string,
  ) => Effect.Effect<void, SecretsError>;
};

export class SecretsProvisionService extends Context.Tag(
  "uebermensch/SecretsProvisionService",
)<SecretsProvisionService, SecretsProvisionServiceImpl>() {}

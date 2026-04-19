import { Context, type Effect } from "effect"
import type { Schema } from "effect"
import type { ProfileError, VaultError } from "../errors.js"
import type { ProfileConfig, SourcesConfig, TopicsConfig } from "../schemas.js"

export type LoadedProfile = {
  readonly profile: Schema.Schema.Type<typeof ProfileConfig>
  readonly topics: Schema.Schema.Type<typeof TopicsConfig>
  readonly sources: Schema.Schema.Type<typeof SourcesConfig>
  readonly me: string
  readonly projects: string
  readonly avoid: string
}

export interface ProfileServiceShape {
  readonly load: () => Effect.Effect<LoadedProfile, VaultError | ProfileError>
  readonly validate: () => Effect.Effect<ReadonlyArray<string>, VaultError>
}

export class ProfileService extends Context.Tag("uebermensch/ProfileService")<
  ProfileService,
  ProfileServiceShape
>() {}

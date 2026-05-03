import { Context, type Effect } from "effect"
import type { VaultError, VaultSecretLeakError } from "../errors.js"

export type WikiPage = {
  readonly relPath: string
  readonly stem: string
  readonly frontmatter: Record<string, unknown>
  readonly body: string
  readonly mtime: Date
}

export type WrittenBrief = {
  readonly absPath: string
  readonly relPath: string
  readonly contentHash: string
}

export type WrittenSource = {
  readonly absPath: string
  readonly relPath: string
  readonly contentHash: string
  readonly existed: boolean
}

export type WrittenReport = {
  readonly absPath: string
  readonly relPath: string
  readonly contentHash: string
}

export type WrittenResearch = {
  readonly absPath: string
  readonly relPath: string
  readonly contentHash: string
}

export type ResearchInterest = {
  readonly slug: string
  readonly title: string
  readonly question: string | null
  readonly topics: ReadonlyArray<string>
  readonly sources: ReadonlyArray<string>
  readonly horizon: "short" | "long" | "both" | null
  readonly weight: number | null
  readonly fieldFamiliarity: "expert" | "novice"
  readonly notes: string
  readonly relPath: string
}

export interface VaultServiceShape {
  readonly root: () => string
  readonly listWikiPages: () => Effect.Effect<ReadonlyArray<WikiPage>, VaultError>
  readonly recentlyChanged: (
    sinceHours: number,
  ) => Effect.Effect<ReadonlyArray<WikiPage>, VaultError>
  readonly listSlugs: () => Effect.Effect<ReadonlySet<string>, VaultError>
  readonly listResearchInterests: () => Effect.Effect<
    ReadonlyArray<ResearchInterest>,
    VaultError
  >
  // Write methods may fail with VaultSecretLeakError when the underlying
  // VaultWriterPort is wrapped by `vaultSecretGuard` — content matching a known
  // credential pattern is rejected before persisting. Production layers
  // (FileSystemVaultLive) bundle the guard, so callers must handle both error
  // types in their error channel.
  readonly writeBrief: (
    date: string,
    content: string,
  ) => Effect.Effect<WrittenBrief, VaultError | VaultSecretLeakError>
  readonly writeSource: (
    slug: string,
    content: string,
    options?: { readonly overwrite?: boolean },
  ) => Effect.Effect<WrittenSource, VaultError | VaultSecretLeakError>
  readonly writeReport: (
    slug: string,
    content: string,
  ) => Effect.Effect<WrittenReport, VaultError | VaultSecretLeakError>
  readonly writeResearch: (
    slug: string,
    content: string,
  ) => Effect.Effect<WrittenResearch, VaultError | VaultSecretLeakError>
}

export class VaultService extends Context.Tag("uebermensch/VaultService")<
  VaultService,
  VaultServiceShape
>() {}

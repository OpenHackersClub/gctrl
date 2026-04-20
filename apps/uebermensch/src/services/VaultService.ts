import { Context, type Effect } from "effect"
import type { VaultError } from "../errors.js"

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

export interface VaultServiceShape {
  readonly root: () => string
  readonly listWikiPages: () => Effect.Effect<ReadonlyArray<WikiPage>, VaultError>
  readonly recentlyChanged: (
    sinceHours: number,
  ) => Effect.Effect<ReadonlyArray<WikiPage>, VaultError>
  readonly listSlugs: () => Effect.Effect<ReadonlySet<string>, VaultError>
  readonly writeBrief: (
    date: string,
    content: string,
  ) => Effect.Effect<WrittenBrief, VaultError>
}

export class VaultService extends Context.Tag("uebermensch/VaultService")<
  VaultService,
  VaultServiceShape
>() {}

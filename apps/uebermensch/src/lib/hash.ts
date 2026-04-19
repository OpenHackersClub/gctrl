import { createHash } from "node:crypto"

export const sha256 = (s: string): string =>
  `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`

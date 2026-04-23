export const SAFE_KEY_RE = /^[a-z0-9._-]+$/i

export type ListedObject = Readonly<{ key: string; uploaded: Date | null }>

export const listUnder = async (
  bucket: R2Bucket,
  prefix: string,
): Promise<ReadonlyArray<ListedObject>> => {
  const out: Array<{ key: string; uploaded: Date | null }> = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i += 1) {
    const page = await bucket.list({ prefix, cursor, limit: 500 })
    for (const obj of page.objects) {
      if (!obj.key.endsWith(".md")) continue
      out.push({ key: obj.key, uploaded: obj.uploaded ?? null })
    }
    if (!page.truncated) break
    cursor = page.cursor
  }
  out.sort((a, b) => {
    const at = a.uploaded ? a.uploaded.getTime() : 0
    const bt = b.uploaded ? b.uploaded.getTime() : 0
    if (bt !== at) return bt - at
    return b.key.localeCompare(a.key)
  })
  return out
}

export const stem = (key: string): string => {
  const slash = key.lastIndexOf("/")
  const base = slash >= 0 ? key.slice(slash + 1) : key
  return base.replace(/\.md$/, "")
}

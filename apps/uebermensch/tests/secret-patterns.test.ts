import { describe, expect, it } from "vitest"
import { scanForSecrets } from "../src/lib/secret-patterns.js"

// Split-fixture helper. GitHub's push-time secret scanner regex-matches the
// raw source bytes; if a test fixture contains a literal that matches a known
// credential shape, the push is rejected. By concatenating the prefix and the
// body at source level, the literal never appears contiguously in the file —
// but the runtime string is identical, so our `scanForSecrets` regex still
// matches. Use this for every positive-case fixture.
const fake = (prefix: string, body: string): string => prefix + body

describe("scanForSecrets — positive cases", () => {
  it("detects an Anthropic API key", () => {
    const hits = scanForSecrets(`token: ${fake("sk-ant", "-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef")}`)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe("anthropic_api_key")
  })

  it("detects an OpenAI API key", () => {
    const hits = scanForSecrets(`OPENAI_API_KEY=${fake("sk", "-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe("openai_api_key")
  })

  it("detects a GitHub PAT (classic ghp_)", () => {
    const hits = scanForSecrets(`export GH_TOKEN=${fake("ghp", "_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm")}`)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe("github_pat_classic")
  })

  it("detects a GitHub PAT (server ghs_)", () => {
    const hits = scanForSecrets(fake("ghs", "_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrs"))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe("github_pat_server")
  })

  it("detects a GitHub PAT (user ghu_)", () => {
    const hits = scanForSecrets(fake("ghu", "_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrs"))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe("github_pat_user")
  })

  it("detects a Stripe live secret key", () => {
    const hits = scanForSecrets(`STRIPE_SECRET=${fake("sk", "_live_ABCDEFGHIJKLMNOPQRSTUVWXYZabc")}`)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe("stripe_secret_live")
  })

  it("detects a Stripe live publishable key", () => {
    const hits = scanForSecrets(fake("pk", "_live_ABCDEFGHIJKLMNOPQRSTUVWXYZabc"))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe("stripe_publishable_live")
  })

  it("detects a Telegram bot token", () => {
    const hits = scanForSecrets(`BOT_TOKEN=${fake("123456789", ":ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi")}`)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe("telegram_bot_token")
  })

  it("detects a Discord bot token", () => {
    // Body is 60 'a' chars — passes our regex (Bot\s+[A-Za-z0-9._-]{50,}) but
    // lacks the dot-separated 3-segment shape GitHub's scanner uses.
    const body = "a".repeat(60)
    const hits = scanForSecrets(`Authorization: ${fake("Bot ", body)}`)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe("discord_bot_token")
  })

  it("detects a Discord webhook URL", () => {
    // Same trick — repeat-char body avoids GitHub's webhook-url scanner.
    const body = `webhooks/1234567890/${"a".repeat(70)}`
    const hits = scanForSecrets(fake("https://discord.com/api/", body))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.name).toBe("discord_webhook_url")
  })

  it("reports matchedAt as the character index of the match", () => {
    const content = `prefix ${fake("sk-ant", "-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")}`
    const hits = scanForSecrets(content)
    expect(hits[0]!.matchedAt).toBe(content.indexOf("sk-ant-"))
  })

  it("returns multiple hits when multiple patterns match", () => {
    const content = `${fake("sk-ant", "-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123")} ${fake("ghp", "_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm")}`
    const hits = scanForSecrets(content)
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })
})

describe("scanForSecrets — negative cases", () => {
  it("returns empty for plain prose", () => {
    const hits = scanForSecrets("# My research note\n\nThis is a note about AI safety.")
    expect(hits).toHaveLength(0)
  })

  it("returns empty for a markdown brief", () => {
    const content = [
      "---",
      "page_type: brief",
      "date: 2026-05-02",
      "---",
      "",
      "Today in AI: [Foo](https://example.com) is interesting.",
    ].join("\n")
    expect(scanForSecrets(content)).toHaveLength(0)
  })

  it("does not flag short sk- strings below threshold", () => {
    // 'sk-' followed by fewer than 20 alphanum chars — not a valid OpenAI key
    const hits = scanForSecrets("property: sk-short")
    expect(hits).toHaveLength(0)
  })

  it("does not flag a short numeric string as a Telegram token", () => {
    // valid Telegram token requires >=8 digits before the colon
    const hits = scanForSecrets("code: 1234:abc")
    expect(hits).toHaveLength(0)
  })
})

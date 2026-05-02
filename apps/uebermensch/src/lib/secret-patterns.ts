/**
 * Patterns used to detect secrets in vault content before writing.
 * Any match blocks the write with a VaultSecretLeakError (see adapters/VaultSecretGuard.ts).
 *
 * Add entries here when a new credential type enters the threat model.
 * Keep patterns conservative (low false-negative rate) — false positives on
 * test fixtures are acceptable; missed real secrets are not.
 */

export type SecretPattern = {
  readonly name: string
  readonly pattern: RegExp
}

export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  // Anthropic API key  (sk-ant-api03-…)
  { name: "anthropic_api_key", pattern: /sk-ant-[A-Za-z0-9_-]{10,}/ },

  // OpenAI API key  (sk-…)  — keep after Anthropic to avoid partial shadowing
  { name: "openai_api_key", pattern: /sk-[A-Za-z0-9]{20,}/ },

  // GitHub PAT flavors: classic (ghp_), server-to-server (ghs_), user-to-server (ghu_)
  { name: "github_pat_classic", pattern: /ghp_[A-Za-z0-9]{36,}/ },
  { name: "github_pat_server", pattern: /ghs_[A-Za-z0-9]{36,}/ },
  { name: "github_pat_user", pattern: /ghu_[A-Za-z0-9]{36,}/ },

  // Stripe live keys
  { name: "stripe_secret_live", pattern: /sk_live_[A-Za-z0-9]{24,}/ },
  { name: "stripe_publishable_live", pattern: /pk_live_[A-Za-z0-9]{24,}/ },

  // Telegram bot token  (\d{8,10}:<alphanum+_- 30+ chars>)
  { name: "telegram_bot_token", pattern: /\d{8,10}:[A-Za-z0-9_-]{30,}/ },

  // Discord bot token  ("Bot <base64-ish>")
  { name: "discord_bot_token", pattern: /Bot\s+[A-Za-z0-9._-]{50,}/ },

  // Discord incoming webhook URL
  {
    name: "discord_webhook_url",
    pattern: /https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{60,}/,
  },
]

export type SecretHit = {
  readonly name: string
  readonly matchedAt: number
}

/**
 * Scan `content` for known secret patterns.
 *
 * Returns every hit found (multiple patterns may match). Returns an empty
 * array when the content is clean. Callers should treat any non-empty result
 * as a hard error — the content must not be written to the vault.
 */
export const scanForSecrets = (content: string): ReadonlyArray<SecretHit> => {
  const hits: Array<SecretHit> = []
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(content)
    if (match !== null) {
      hits.push({ name, matchedAt: match.index })
    }
  }
  return hits
}

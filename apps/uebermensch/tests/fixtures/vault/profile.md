---
schema_version: 1

identity:
  name: "New User"
  slug: "new-user"
  tz: "UTC"
  lang: "en"

budgets:
  daily_usd: 1.00
  per_brief_usd: 0.25
  max_tokens_per_brief: 16000

delivery:
  brief:
    cron: "0 30 7 * * *"
    format: "long"
  channels:
    app:
      enabled: true
      driver: "app"
      target_ref: "default"
---

# Profile

Top-level config. Edit the frontmatter above. The body is free-form notes.

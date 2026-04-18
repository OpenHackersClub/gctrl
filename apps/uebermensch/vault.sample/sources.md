---
sources:
  - slug: "iaea-press"
    driver: "rss"
    url: "https://www.iaea.org/news/feed"
    cadence: "0 */30 * * * *"
    topics: ["iran-nuclear-program"]

  - slug: "reuters-world-middle-east"
    driver: "rss"
    url: "https://feeds.reuters.com/reuters/MiddleEastNews"
    cadence: "0 */15 * * * *"
    topics: ["iran-israel-escalation", "mena-oil-shipping"]

  - slug: "criticalthreats-iran-updates"
    driver: "rss"
    url: "https://www.criticalthreats.org/analysis.rss"
    cadence: "0 0 */2 * * *"
    topics: ["iran-israel-escalation"]

  - slug: "aljazeera-middle-east"
    driver: "rss"
    url: "https://www.aljazeera.com/xml/rss/all.xml"
    cadence: "0 */15 * * * *"
    topics: ["iran-israel-escalation"]

  - slug: "kalshi-geopolitics"
    driver: "markets"
    url: null
    cadence: "0 0 */2 * * *"
    topics: ["iran-israel-escalation"]
    config:
      venue: "kalshi"
      markets: ["IRANCF-26", "HORMUZ-26"]

  - slug: "manual-reading"
    driver: "manual"
    cadence: "@never"
    topics: ["iran-israel-escalation", "iran-nuclear-program", "mena-oil-shipping"]
---

# Sources

Feeds the daemon pulls from (RSS, markets, manual). Each source targets one or more `topics[]` slugs declared in [topics.md](topics.md). Edit the frontmatter above.

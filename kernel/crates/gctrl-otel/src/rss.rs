//! driver-rss — fetch RSS/Atom/JSON Feed sources, parse via `feed-rs`, and
//! materialise each new entry as a markdown file under
//! `<vault_dir>/input/raw/<YYYY-MM-DD>--<slug>.md` with YAML frontmatter.
//!
//! Scope of this PR: parsing + slugification + atomic vault write +
//! filesystem-level dedupe (skip if target file already exists). Scheduler
//! wiring, profile-driven feed lists, and SQLite index rows land in follow-up
//! PRs once the kb→kernel promotion (#104) defines the canonical vault
//! mount port.
//!
//! Spec: vault/specs/architecture/apps/uebermensch.md (M1 driver-rss row).

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use feed_rs::parser;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum RssError {
    #[error("feed parse: {0}")]
    Parse(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid vault dir: {0}")]
    InvalidVault(String),
}

/// One parsed feed entry, normalised for downstream consumers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RssEntry {
    pub guid: String,
    pub title: String,
    pub url: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub summary: Option<String>,
    pub content: Option<String>,
}

/// Result of writing one entry to the vault.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum WriteOutcome {
    Written(PathBuf),
    SkippedExisting(PathBuf),
}

pub fn parse_feed(bytes: &[u8]) -> Result<Vec<RssEntry>, RssError> {
    let feed = parser::parse(bytes).map_err(|e| RssError::Parse(e.to_string()))?;
    Ok(feed
        .entries
        .into_iter()
        .map(|e| {
            let title = e.title.map(|t| t.content).unwrap_or_else(|| e.id.clone());
            let url = e.links.first().map(|l| l.href.clone());
            let summary = e.summary.map(|s| s.content);
            let content = e.content.and_then(|c| c.body);
            RssEntry {
                guid: e.id,
                title,
                url,
                published_at: e.published.or(e.updated),
                summary,
                content,
            }
        })
        .collect())
}

/// Convert an arbitrary string to a kebab-case slug safe for filenames.
/// Lowercases, keeps `[a-z0-9]`, collapses everything else to single hyphens,
/// trims leading/trailing hyphens, and caps at 80 chars to keep paths sane.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_hyphen = true; // skip leading hyphens
    for ch in s.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_hyphen = false;
        } else if !prev_hyphen {
            out.push('-');
            prev_hyphen = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("untitled");
    }
    if out.len() > 80 {
        out.truncate(80);
        while out.ends_with('-') {
            out.pop();
        }
    }
    out
}

/// Stable file path: `<vault>/input/raw/<YYYY-MM-DD>--<slug>--<guid_hash8>.md`.
/// Including a short hash of the GUID prevents collisions when two entries
/// share a date + title (e.g. multi-feed re-syndication).
pub fn entry_path(vault_dir: &Path, entry: &RssEntry) -> PathBuf {
    let date = entry
        .published_at
        .unwrap_or_else(Utc::now)
        .format("%Y-%m-%d");
    let slug = slugify(&entry.title);
    let mut hasher = Sha256::new();
    hasher.update(entry.guid.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let short = &hash[..8];
    vault_dir
        .join("input")
        .join("raw")
        .join(format!("{date}--{slug}--{short}.md"))
}

/// Render frontmatter + body. Single source of truth for what a vault
/// source page looks like; downstream curators rely on this shape.
pub fn render_markdown(entry: &RssEntry, feed_url: &str) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("source: driver-rss\n");
    out.push_str(&format!("feed_url: {feed_url}\n"));
    if let Some(u) = &entry.url {
        out.push_str(&format!("entry_url: {u}\n"));
    }
    out.push_str(&format!("guid: {}\n", entry.guid));
    if let Some(t) = entry.published_at {
        out.push_str(&format!("published_at: {}\n", t.to_rfc3339()));
    }
    out.push_str(&format!(
        "title: {}\n",
        // YAML scalars containing colons / quotes get fenced; the raw title
        // is preserved in the H1 below for human reading.
        yaml_safe(&entry.title)
    ));
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", entry.title));
    if let Some(s) = &entry.summary {
        out.push_str(s);
        out.push_str("\n\n");
    }
    if let Some(c) = &entry.content {
        out.push_str(c);
        out.push('\n');
    }
    out
}

fn yaml_safe(s: &str) -> String {
    // Quote and escape doublequotes — sufficient for titles. Real YAML
    // multiline strings are out of scope here.
    let escaped = s.replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Write an entry to the vault, atomically and skip-if-existing.
/// Returns `SkippedExisting` if the target path is already present —
/// the dedupe contract for the M1 polling loop.
pub fn write_entry(
    vault_dir: &Path,
    entry: &RssEntry,
    feed_url: &str,
) -> Result<WriteOutcome, RssError> {
    if !vault_dir.exists() {
        return Err(RssError::InvalidVault(format!(
            "{} does not exist",
            vault_dir.display()
        )));
    }
    let path = entry_path(vault_dir, entry);
    if path.exists() {
        return Ok(WriteOutcome::SkippedExisting(path));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = render_markdown(entry, feed_url);
    // Atomic-ish: write to sibling tmp then rename.
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &path)?;
    Ok(WriteOutcome::Written(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const RSS_2_FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com</link>
    <description>Test</description>
    <item>
      <title>Hello, RSS</title>
      <link>https://example.com/posts/hello</link>
      <guid isPermaLink="false">post-1</guid>
      <pubDate>Wed, 01 May 2026 09:00:00 GMT</pubDate>
      <description>The first post.</description>
    </item>
    <item>
      <title>Second: with colons &amp; ampersands</title>
      <link>https://example.com/posts/second</link>
      <guid isPermaLink="false">post-2</guid>
      <pubDate>Wed, 01 May 2026 10:00:00 GMT</pubDate>
      <description>Second body.</description>
    </item>
  </channel>
</rss>"#;

    const ATOM_FIXTURE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <id>urn:uuid:60a76c80-d399-11d9-b93C-0003939e0af6</id>
  <updated>2026-05-01T12:00:00Z</updated>
  <entry>
    <title>Atom entry one</title>
    <id>urn:uuid:atom-1</id>
    <link href="https://atom.example.com/1"/>
    <updated>2026-05-01T12:00:00Z</updated>
    <summary>Summary one</summary>
  </entry>
</feed>"#;

    #[test]
    fn parses_rss_2_fixture() {
        let entries = parse_feed(RSS_2_FIXTURE.as_bytes()).expect("parse");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "Hello, RSS");
        assert_eq!(entries[0].guid, "post-1");
        assert_eq!(
            entries[0].url.as_deref(),
            Some("https://example.com/posts/hello")
        );
        assert!(entries[0].published_at.is_some());
        assert!(entries[0].summary.is_some());
    }

    #[test]
    fn parses_atom_fixture() {
        let entries = parse_feed(ATOM_FIXTURE.as_bytes()).expect("parse");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Atom entry one");
        assert_eq!(entries[0].guid, "urn:uuid:atom-1");
    }

    #[test]
    fn rejects_malformed_feed() {
        let result = parse_feed(b"<not-a-feed>").err();
        assert!(matches!(result, Some(RssError::Parse(_))));
    }

    #[test]
    fn slugify_handles_edge_cases() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("  --leading--trailing--  "), "leading-trailing");
        assert_eq!(slugify("中文 mixed 標題 123"), "mixed-123");
        assert_eq!(slugify(""), "untitled");
        assert_eq!(slugify("---"), "untitled");
        let long = "a".repeat(200);
        assert!(slugify(&long).len() <= 80);
    }

    #[test]
    fn entry_path_includes_date_slug_and_guid_hash() {
        let entry = RssEntry {
            guid: "some-guid-1".into(),
            title: "Hello, World!".into(),
            url: None,
            published_at: Some(
                DateTime::parse_from_rfc3339("2026-05-01T12:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
            summary: None,
            content: None,
        };
        let p = entry_path(Path::new("/v"), &entry);
        let s = p.to_string_lossy();
        assert!(s.contains("input/raw/2026-05-01--hello-world--"));
        assert!(s.ends_with(".md"));
    }

    #[test]
    fn entry_paths_disambiguate_same_date_same_title() {
        let mk = |guid: &str| RssEntry {
            guid: guid.into(),
            title: "Same Title".into(),
            url: None,
            published_at: Some(
                DateTime::parse_from_rfc3339("2026-05-01T12:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
            summary: None,
            content: None,
        };
        let p1 = entry_path(Path::new("/v"), &mk("a"));
        let p2 = entry_path(Path::new("/v"), &mk("b"));
        assert_ne!(p1, p2);
    }

    #[test]
    fn write_entry_writes_then_dedupes_on_second_write() {
        let dir = tempdir().unwrap();
        let entries = parse_feed(RSS_2_FIXTURE.as_bytes()).unwrap();

        let r1 = write_entry(dir.path(), &entries[0], "https://example.com/feed").unwrap();
        let path = match r1 {
            WriteOutcome::Written(p) => p,
            WriteOutcome::SkippedExisting(_) => panic!("first write should not skip"),
        };
        assert!(path.exists());

        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.starts_with("---\nsource: driver-rss\n"));
        assert!(body.contains("guid: post-1"));
        assert!(body.contains("# Hello, RSS"));

        let r2 = write_entry(dir.path(), &entries[0], "https://example.com/feed").unwrap();
        assert!(matches!(r2, WriteOutcome::SkippedExisting(_)));

        // No tmp file left behind.
        let tmp = path.with_extension("md.tmp");
        assert!(!tmp.exists());
    }

    #[test]
    fn write_entry_errors_when_vault_dir_missing() {
        let entries = parse_feed(RSS_2_FIXTURE.as_bytes()).unwrap();
        let err = write_entry(
            Path::new("/nonexistent/vault"),
            &entries[0],
            "https://example.com/feed",
        )
        .err();
        assert!(matches!(err, Some(RssError::InvalidVault(_))));
    }

    #[test]
    fn render_markdown_includes_frontmatter_and_title() {
        let entries = parse_feed(RSS_2_FIXTURE.as_bytes()).unwrap();
        let md = render_markdown(&entries[1], "https://example.com/feed");
        assert!(md.starts_with("---\n"));
        assert!(md.contains("title: \"Second: with colons & ampersands\""));
        assert!(md.contains("# Second: with colons & ampersands"));
    }
}

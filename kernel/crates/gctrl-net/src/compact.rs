//! Compact crawled pages into a single agent-optimized context file.
//!
//! Inspired by gitingest: produces a single markdown file with directory structure,
//! token estimate, and all pages concatenated with lightweight separators.

use crate::storage::SiteStore;
use crate::NetError;

/// Output format for compaction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CompactFormat {
    /// Single DOMAIN_CONTEXT.md file (gitingest-style). Default.
    Gitingest,
    /// Separate index + docs/ tree (legacy).
    Index,
}

/// Options for compaction.
#[derive(Debug, Clone)]
pub struct CompactOptions {
    pub format: CompactFormat,
    /// Output directory. If None, writes to stdout.
    pub output_dir: Option<std::path::PathBuf>,
}

impl Default for CompactOptions {
    fn default() -> Self {
        Self {
            format: CompactFormat::Gitingest,
            output_dir: None,
        }
    }
}

const SEPARATOR: &str = "================================================";

/// Compact all crawled pages for a domain into agent-optimized output.
///
/// Returns the compacted markdown string.
pub fn compact_site(
    domain: &str,
    store: &SiteStore,
    opts: &CompactOptions,
) -> Result<String, NetError> {
    let index = store
        .load_index(domain)
        .ok_or_else(|| NetError::DomainNotFound(domain.to_string()))?;

    let pages = store.read_all_pages(domain)?;

    match opts.format {
        CompactFormat::Gitingest => build_gitingest(&index.domain, &pages, index.total_words),
        CompactFormat::Index => build_index_format(&index.domain, &pages),
    }
}

fn build_gitingest(
    domain: &str,
    pages: &[(crate::storage::PageEntry, String)],
    total_words: usize,
) -> Result<String, NetError> {
    let mut out = String::new();

    // Header
    out.push_str(&format!("# {} — Agent Context\n\n", domain));
    let token_estimate = total_words * 4 / 3; // rough tokens ≈ words × 1.33
    out.push_str(&format!(
        "> {} pages | ~{} words | ~{} tokens (estimated)\n\n",
        pages.len(),
        total_words,
        token_estimate
    ));

    // Directory structure
    out.push_str("## Directory Structure\n\n```\n");
    for (entry, _) in pages {
        out.push_str(&format!("  {}\n", entry.file));
    }
    out.push_str("```\n\n");

    // Page contents
    out.push_str("## Pages\n\n");
    for (entry, content) in pages {
        out.push_str(SEPARATOR);
        out.push('\n');
        out.push_str(&format!("File: {}\n", entry.file));
        out.push_str(&format!("URL: {}\n", entry.url));
        out.push_str(SEPARATOR);
        out.push('\n');

        // Strip frontmatter from stored content
        let body = strip_frontmatter(content);
        out.push_str(body.trim());
        out.push_str("\n\n");
    }

    Ok(out)
}

fn build_index_format(
    domain: &str,
    pages: &[(crate::storage::PageEntry, String)],
) -> Result<String, NetError> {
    let mut out = String::new();
    out.push_str(&format!("# {} — Page Index\n\n", domain));
    out.push_str("| File | Title | Words |\n");
    out.push_str("|------|-------|-------|\n");
    for (entry, _) in pages {
        out.push_str(&format!(
            "| {} | {} | {} |\n",
            entry.file, entry.title, entry.word_count
        ));
    }
    Ok(out)
}

/// Strip YAML frontmatter (---...\n---) from markdown content.
fn strip_frontmatter(content: &str) -> &str {
    if !content.starts_with("---") {
        return content;
    }
    // Find the closing ---
    if let Some(end) = content[3..].find("\n---") {
        let after = end + 3 + 4; // skip past "\n---"
        if after < content.len() {
            return &content[after..];
        }
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SiteStore;
    use crate::PageContent;
    use tempfile::TempDir;

    fn setup_store() -> (TempDir, SiteStore) {
        let tmp = TempDir::new().unwrap();
        let store = SiteStore::new(tmp.path().to_path_buf());

        let pages = vec![
            PageContent {
                url: "https://example.com/".to_string(),
                title: "Home".to_string(),
                markdown: "Welcome to the documentation site for our project.".to_string(),
                word_count: 8,
                status: 200,
            },
            PageContent {
                url: "https://example.com/docs/guide".to_string(),
                title: "Guide".to_string(),
                markdown: "This is the getting started guide with detailed instructions.".to_string(),
                word_count: 10,
                status: 200,
            },
            PageContent {
                url: "https://example.com/docs/api".to_string(),
                title: "API Reference".to_string(),
                markdown: "API endpoints and their parameters are documented here for reference.".to_string(),
                word_count: 11,
                status: 200,
            },
        ];

        for page in &pages {
            store.save_page("example.com", page).unwrap();
        }

        (tmp, store)
    }

    #[test]
    fn test_compact_gitingest() {
        let (_tmp, store) = setup_store();
        let opts = CompactOptions::default();
        let result = compact_site("example.com", &store, &opts).unwrap();

        assert!(result.contains("# example.com — Agent Context"));
        assert!(result.contains("3 pages"));
        assert!(result.contains("Directory Structure"));
        assert!(result.contains("index.md"));
        assert!(result.contains("docs/guide.md"));
        assert!(result.contains(SEPARATOR));
    }

    #[test]
    fn test_compact_index_format() {
        let (_tmp, store) = setup_store();
        let opts = CompactOptions {
            format: CompactFormat::Index,
            ..Default::default()
        };
        let result = compact_site("example.com", &store, &opts).unwrap();

        assert!(result.contains("Page Index"));
        assert!(result.contains("| File |"));
        assert!(result.contains("docs/guide.md"));
    }

    #[test]
    fn test_compact_unknown_domain() {
        let (_tmp, store) = setup_store();
        let opts = CompactOptions::default();
        let result = compact_site("unknown.com", &store, &opts);
        assert!(result.is_err());
    }

    #[test]
    fn test_strip_frontmatter() {
        let content = "---\nurl: https://example.com\ntitle: Test\n---\n\n# Hello\n\nWorld";
        let body = strip_frontmatter(content);
        assert!(body.trim().starts_with("# Hello"));
    }

    #[test]
    fn test_strip_frontmatter_no_frontmatter() {
        let content = "# Just markdown\n\nNo frontmatter here.";
        assert_eq!(strip_frontmatter(content), content);
    }
}

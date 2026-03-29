//! Compact context entries into a single agent-optimized context file.
//!
//! Follows the gitingest pattern from gctl-net/compact.rs: header with stats,
//! directory structure, then concatenated content with lightweight separators.

use gctl_core::context::ContextEntry;

const SEPARATOR: &str = "================================================";

/// Compact a set of context entries into a single LLM-ready markdown document.
pub fn compact_context(entries: &[(ContextEntry, String)]) -> String {
    if entries.is_empty() {
        return "# Context — Empty\n\n> No context entries found.\n".to_string();
    }

    let total_words: usize = entries.iter().map(|(e, _)| e.word_count).sum();
    let token_estimate = total_words * 4 / 3;

    let mut out = String::new();

    // Header
    out.push_str("# Agent Context\n\n");
    out.push_str(&format!(
        "> {} entries | ~{} words | ~{} tokens (estimated)\n\n",
        entries.len(),
        total_words,
        token_estimate
    ));

    // Directory structure
    out.push_str("## Structure\n\n```\n");
    for (entry, _) in entries {
        out.push_str(&format!("  {}/{}\n", entry.kind.as_str(), entry.path));
    }
    out.push_str("```\n\n");

    // Entry contents
    out.push_str("## Entries\n\n");
    for (entry, content) in entries {
        out.push_str(SEPARATOR);
        out.push('\n');
        out.push_str(&format!("Path: {}/{}\n", entry.kind.as_str(), entry.path));
        out.push_str(&format!("Title: {}\n", entry.title));
        if !entry.tags.is_empty() {
            out.push_str(&format!("Tags: {}\n", entry.tags.join(", ")));
        }
        out.push_str(SEPARATOR);
        out.push('\n');
        out.push_str(content.trim());
        out.push_str("\n\n");
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use gctl_core::context::*;

    fn make_entry(path: &str, title: &str, words: usize) -> ContextEntry {
        ContextEntry {
            id: ContextEntryId(format!("ctx-{}", path)),
            kind: ContextKind::Document,
            path: path.to_string(),
            title: title.to_string(),
            source: ContextSource::Human,
            word_count: words,
            content_hash: "hash".into(),
            tags: vec!["test".into()],
            created_at: Utc::now(),
            updated_at: Utc::now(),
            synced: false,
        }
    }

    #[test]
    fn test_compact_empty() {
        let result = compact_context(&[]);
        assert!(result.contains("Empty"));
        assert!(result.contains("No context entries"));
    }

    #[test]
    fn test_compact_multiple_entries() {
        let entries = vec![
            (make_entry("intro.md", "Introduction", 100), "Welcome to the project.".to_string()),
            (make_entry("guide.md", "Guide", 200), "Step 1: Install dependencies.".to_string()),
        ];
        let result = compact_context(&entries);

        assert!(result.contains("# Agent Context"));
        assert!(result.contains("2 entries"));
        assert!(result.contains("~300 words"));
        assert!(result.contains("Structure"));
        assert!(result.contains("document/intro.md"));
        assert!(result.contains("document/guide.md"));
        assert!(result.contains(SEPARATOR));
        assert!(result.contains("Welcome to the project."));
        assert!(result.contains("Step 1: Install dependencies."));
    }

    #[test]
    fn test_compact_includes_tags() {
        let entries = vec![
            (make_entry("tagged.md", "Tagged", 50), "Content with tags.".to_string()),
        ];
        let result = compact_context(&entries);
        assert!(result.contains("Tags: test"));
    }
}

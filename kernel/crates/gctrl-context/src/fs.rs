//! Filesystem storage for context entries. One subdirectory per kind, markdown files with frontmatter.
//!
//! Layout:
//!   {data_dir}/context/
//!     config/
//!       CLAUDE.md
//!       runbooks/deploy.md
//!     snapshots/
//!       issues-2026-03-22.md
//!     documents/
//!       decisions/adr-001.md

use crate::ContextError;
use gctrl_core::context::{ContextEntry, ContextKind};
use std::path::PathBuf;

/// Manages context content on the filesystem.
#[derive(Debug, Clone)]
pub struct ContentStore {
    base_dir: PathBuf,
}

impl ContentStore {
    /// Create a store at the default data directory.
    pub fn default_store() -> Result<Self, ContextError> {
        let base = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("gctrl")
            .join("context");
        Ok(Self { base_dir: base })
    }

    /// Create a store at a custom path.
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Root directory for a kind's content.
    fn kind_dir(&self, kind: &ContextKind) -> PathBuf {
        self.base_dir.join(kind.dir_name())
    }

    /// Full filesystem path for an entry.
    fn entry_path(&self, kind: &ContextKind, rel_path: &str) -> PathBuf {
        self.kind_dir(kind).join(rel_path)
    }

    /// Save content to the filesystem with YAML frontmatter.
    pub fn save_content(
        &self,
        entry: &ContextEntry,
        content: &str,
    ) -> Result<(), ContextError> {
        let file_path = self.entry_path(&entry.kind, &entry.path);

        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let tags_str = entry.tags.join(", ");
        let frontmatter = format!(
            "---\nid: {}\ntitle: {}\nkind: {}\nsource: {}\ntags: [{}]\ncreated_at: {}\nupdated_at: {}\n---\n\n",
            entry.id.0,
            entry.title,
            entry.kind.as_str(),
            entry.source.source_type(),
            tags_str,
            entry.created_at.to_rfc3339(),
            entry.updated_at.to_rfc3339(),
        );

        let full_content = format!("{}{}", frontmatter, content);
        std::fs::write(&file_path, &full_content)?;

        Ok(())
    }

    /// Read content from the filesystem, stripping YAML frontmatter.
    pub fn read_content(
        &self,
        kind: &ContextKind,
        rel_path: &str,
    ) -> Result<String, ContextError> {
        let file_path = self.entry_path(kind, rel_path);
        let raw = std::fs::read_to_string(&file_path)?;
        Ok(strip_frontmatter(&raw).to_string())
    }

    /// Read raw content including frontmatter.
    pub fn read_raw(
        &self,
        kind: &ContextKind,
        rel_path: &str,
    ) -> Result<String, ContextError> {
        let file_path = self.entry_path(kind, rel_path);
        Ok(std::fs::read_to_string(&file_path)?)
    }

    /// Remove content from the filesystem.
    pub fn remove_content(
        &self,
        kind: &ContextKind,
        rel_path: &str,
    ) -> Result<(), ContextError> {
        let file_path = self.entry_path(kind, rel_path);
        if file_path.exists() {
            std::fs::remove_file(&file_path)?;
        }
        Ok(())
    }

    /// Check if content exists on the filesystem.
    pub fn exists(&self, kind: &ContextKind, rel_path: &str) -> bool {
        self.entry_path(kind, rel_path).exists()
    }
}

/// Strip YAML frontmatter (---...\n---) from markdown content.
fn strip_frontmatter(content: &str) -> &str {
    if !content.starts_with("---") {
        return content;
    }
    if let Some(end) = content[3..].find("\n---") {
        let after = end + 3 + 4; // skip past "\n---"
        if after < content.len() {
            return content[after..].trim_start_matches('\n');
        }
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use gctrl_core::context::{ContextEntryId, ContextSource};
    use tempfile::TempDir;

    fn make_entry(path: &str, kind: ContextKind) -> ContextEntry {
        ContextEntry {
            id: ContextEntryId("ctx-test".into()),
            kind,
            path: path.to_string(),
            title: "Test Entry".into(),
            source: ContextSource::Human,
            word_count: 10,
            content_hash: "abc123".into(),
            tags: vec!["test".into()],
            created_at: Utc::now(),
            updated_at: Utc::now(),
            synced: false,
        }
    }

    #[test]
    fn test_save_and_read_content() {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::new(tmp.path().to_path_buf());

        let entry = make_entry("notes/test.md", ContextKind::Document);
        store.save_content(&entry, "Hello, world!").unwrap();

        let content = store.read_content(&ContextKind::Document, "notes/test.md").unwrap();
        assert_eq!(content, "Hello, world!");
    }

    #[test]
    fn test_read_raw_includes_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::new(tmp.path().to_path_buf());

        let entry = make_entry("test.md", ContextKind::Config);
        store.save_content(&entry, "Content here").unwrap();

        let raw = store.read_raw(&ContextKind::Config, "test.md").unwrap();
        assert!(raw.starts_with("---"));
        assert!(raw.contains("title: Test Entry"));
        assert!(raw.contains("Content here"));
    }

    #[test]
    fn test_remove_content() {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::new(tmp.path().to_path_buf());

        let entry = make_entry("to-delete.md", ContextKind::Document);
        store.save_content(&entry, "Temporary content").unwrap();
        assert!(store.exists(&ContextKind::Document, "to-delete.md"));

        store.remove_content(&ContextKind::Document, "to-delete.md").unwrap();
        assert!(!store.exists(&ContextKind::Document, "to-delete.md"));
    }

    #[test]
    fn test_nested_paths() {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::new(tmp.path().to_path_buf());

        let entry = make_entry("deep/nested/path/doc.md", ContextKind::Document);
        store.save_content(&entry, "Deep content").unwrap();

        let content = store.read_content(&ContextKind::Document, "deep/nested/path/doc.md").unwrap();
        assert_eq!(content, "Deep content");
    }

    #[test]
    fn test_strip_frontmatter() {
        let with_fm = "---\ntitle: Test\nkind: config\n---\n\n# Hello\n\nWorld";
        assert_eq!(strip_frontmatter(with_fm), "# Hello\n\nWorld");

        let without_fm = "# Just markdown\n\nNo frontmatter.";
        assert_eq!(strip_frontmatter(without_fm), without_fm);
    }
}

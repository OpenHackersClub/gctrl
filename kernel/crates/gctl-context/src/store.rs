//! ContextManager — hybrid DuckDB metadata + filesystem content store.
//!
//! DuckDB stores metadata (id, kind, path, tags, word_count, content_hash) for
//! fast querying and filtering. The filesystem stores actual markdown content.

use crate::compact::compact_context;
use crate::fs::ContentStore;
use crate::ContextError;
use chrono::Utc;
use duckdb::Connection;
use gctl_core::context::*;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;

/// Central context manager combining DuckDB metadata with filesystem content.
pub struct ContextManager {
    conn: Mutex<Connection>,
    content_store: ContentStore,
}

impl ContextManager {
    /// Open a context manager with DuckDB at `db_path` and content at `content_dir`.
    pub fn open(db_path: &str, content_dir: Option<PathBuf>) -> Result<Self, ContextError> {
        let conn = Connection::open(db_path)
            .map_err(|e| ContextError::Database(e.to_string()))?;

        // Run migrations — DDL inlined to avoid gctl-storage dependency
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS context_entries (
                id              VARCHAR PRIMARY KEY,
                kind            VARCHAR NOT NULL,
                path            VARCHAR NOT NULL UNIQUE,
                title           VARCHAR NOT NULL,
                source_type     VARCHAR NOT NULL,
                source_ref      VARCHAR,
                word_count      INTEGER DEFAULT 0,
                content_hash    VARCHAR NOT NULL,
                tags            JSON DEFAULT '[]',
                created_at      VARCHAR NOT NULL,
                updated_at      VARCHAR NOT NULL,
                synced          BOOLEAN DEFAULT FALSE
            )"
        ).map_err(|e| ContextError::Database(e.to_string()))?;

        // Create indexes
        let index_stmts = [
            "CREATE INDEX IF NOT EXISTS idx_context_kind ON context_entries(kind)",
            "CREATE INDEX IF NOT EXISTS idx_context_source ON context_entries(source_type)",
            "CREATE INDEX IF NOT EXISTS idx_context_path ON context_entries(path)",
            "CREATE INDEX IF NOT EXISTS idx_context_synced ON context_entries(synced)",
        ];
        for stmt in &index_stmts {
            conn.execute_batch(stmt)
                .map_err(|e| ContextError::Database(e.to_string()))?;
        }

        let content_store = match content_dir {
            Some(dir) => ContentStore::new(dir),
            None => ContentStore::default_store()?,
        };

        Ok(Self {
            conn: Mutex::new(conn),
            content_store,
        })
    }

    /// Add or update a context entry (metadata + content).
    /// Upserts by `path` — if an entry with the same path exists, it is updated.
    pub fn upsert(&self, kind: &ContextKind, path: &str, title: &str, content: &str, source: &ContextSource, tags: &[String]) -> Result<ContextEntry, ContextError> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now();
        let word_count = content.split_whitespace().count();
        let content_hash = compute_hash(content);

        // Check if entry exists by path
        let existing_id: Option<String> = conn
            .query_row(
                "SELECT id FROM context_entries WHERE path = ?1",
                [path],
                |row| row.get(0),
            )
            .ok();

        let id = existing_id.unwrap_or_else(|| format!("ctx-{}", uuid::Uuid::new_v4()));
        let tags_json = serde_json::to_string(tags)?;

        conn.execute(
            r#"INSERT INTO context_entries (id, kind, path, title, source_type, source_ref, word_count, content_hash, tags, created_at, updated_at, synced)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, FALSE)
               ON CONFLICT(path) DO UPDATE SET
                 title = excluded.title,
                 kind = excluded.kind,
                 source_type = excluded.source_type,
                 source_ref = excluded.source_ref,
                 word_count = excluded.word_count,
                 content_hash = excluded.content_hash,
                 tags = excluded.tags,
                 updated_at = excluded.updated_at,
                 synced = FALSE"#,
            duckdb::params![
                id,
                kind.as_str(),
                path,
                title,
                source.source_type(),
                source.source_ref().unwrap_or(""),
                word_count as i32,
                content_hash,
                tags_json,
                now.to_rfc3339(),
                now.to_rfc3339(),
            ],
        )?;

        let entry = ContextEntry {
            id: ContextEntryId(id),
            kind: kind.clone(),
            path: path.to_string(),
            title: title.to_string(),
            source: source.clone(),
            word_count,
            content_hash,
            tags: tags.to_vec(),
            created_at: now,
            updated_at: now,
            synced: false,
        };

        // Write content to filesystem
        self.content_store.save_content(&entry, content)?;

        Ok(entry)
    }

    /// Get a context entry's metadata by ID.
    pub fn get(&self, id: &str) -> Result<ContextEntry, ContextError> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, path, title, source_type, source_ref, word_count, content_hash, tags, created_at, updated_at, synced FROM context_entries WHERE id = ?1",
            [id],
            row_to_entry,
        ).map_err(|_| ContextError::NotFound(id.to_string()))
    }

    /// Get a context entry by its relative path.
    pub fn get_by_path(&self, path: &str) -> Result<ContextEntry, ContextError> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, path, title, source_type, source_ref, word_count, content_hash, tags, created_at, updated_at, synced FROM context_entries WHERE path = ?1",
            [path],
            row_to_entry,
        ).map_err(|_| ContextError::NotFound(path.to_string()))
    }

    /// Read a context entry's content from the filesystem.
    pub fn read_content(&self, id: &str) -> Result<String, ContextError> {
        let entry = self.get(id)?;
        self.content_store.read_content(&entry.kind, &entry.path)
    }

    /// Read content by path.
    pub fn read_content_by_path(&self, path: &str) -> Result<String, ContextError> {
        let entry = self.get_by_path(path)?;
        self.content_store.read_content(&entry.kind, &entry.path)
    }

    /// List/filter context entries.
    pub fn list(&self, filter: &ContextFilter) -> Result<Vec<ContextEntry>, ContextError> {
        let conn = self.conn.lock().unwrap();

        let mut sql = String::from(
            "SELECT id, kind, path, title, source_type, source_ref, word_count, content_hash, tags, created_at, updated_at, synced FROM context_entries WHERE 1=1"
        );
        let mut params: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
        let mut param_idx = 1;

        if let Some(ref kind) = filter.kind {
            sql.push_str(&format!(" AND kind = ?{}", param_idx));
            params.push(Box::new(kind.as_str().to_string()));
            param_idx += 1;
        }

        if let Some(ref source) = filter.source {
            sql.push_str(&format!(" AND source_type = ?{}", param_idx));
            params.push(Box::new(source.clone()));
            param_idx += 1;
        }

        if let Some(ref search) = filter.search {
            sql.push_str(&format!(" AND (title LIKE ?{0} OR path LIKE ?{0})", param_idx));
            params.push(Box::new(format!("%{}%", search)));
            param_idx += 1;
        }

        sql.push_str(" ORDER BY updated_at DESC");

        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT ?{}", param_idx));
            params.push(Box::new(limit as i64));
        }

        let param_refs: Vec<&dyn duckdb::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let entries = stmt
            .query_map(param_refs.as_slice(), row_to_entry)?
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();

        // Post-filter by tag (DuckDB JSON array filtering is simpler in Rust)
        let entries = if let Some(ref tag) = filter.tag {
            entries.into_iter().filter(|e| e.tags.contains(tag)).collect()
        } else {
            entries
        };

        Ok(entries)
    }

    /// Remove a context entry by ID.
    pub fn remove(&self, id: &str) -> Result<(), ContextError> {
        let entry = self.get(id)?;
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM context_entries WHERE id = ?1", [id])?;
        drop(conn);
        self.content_store.remove_content(&entry.kind, &entry.path)?;
        Ok(())
    }

    /// Remove a context entry by path.
    pub fn remove_by_path(&self, path: &str) -> Result<(), ContextError> {
        let entry = self.get_by_path(path)?;
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM context_entries WHERE path = ?1", [path])?;
        drop(conn);
        self.content_store.remove_content(&entry.kind, &entry.path)?;
        Ok(())
    }

    /// Get stats about the context store.
    pub fn stats(&self) -> Result<ContextStats, ContextError> {
        let conn = self.conn.lock().unwrap();

        let total_entries: u64 = conn
            .query_row("SELECT COUNT(*) FROM context_entries", [], |row| row.get(0))
            .unwrap_or(0);

        let total_words: u64 = conn
            .query_row(
                "SELECT COALESCE(SUM(word_count), 0) FROM context_entries",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let mut by_kind = Vec::new();
        {
            let mut stmt = conn.prepare("SELECT kind, COUNT(*) FROM context_entries GROUP BY kind ORDER BY kind")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })?;
            for row in rows {
                if let Ok(r) = row {
                    by_kind.push(r);
                }
            }
        }

        let mut by_source = Vec::new();
        {
            let mut stmt = conn.prepare("SELECT source_type, COUNT(*) FROM context_entries GROUP BY source_type ORDER BY source_type")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })?;
            for row in rows {
                if let Ok(r) = row {
                    by_source.push(r);
                }
            }
        }

        Ok(ContextStats {
            total_entries,
            total_words,
            by_kind,
            by_source,
        })
    }

    /// Compact filtered entries into a single LLM-ready document.
    pub fn compact(&self, filter: &ContextFilter) -> Result<String, ContextError> {
        let entries = self.list(filter)?;
        let mut entries_with_content = Vec::new();

        for entry in entries {
            match self.content_store.read_content(&entry.kind, &entry.path) {
                Ok(content) => entries_with_content.push((entry, content)),
                Err(e) => tracing::warn!(path = %entry.path, error = %e, "skipped unreadable entry"),
            }
        }

        Ok(compact_context(&entries_with_content))
    }
}

/// Convert a DuckDB row to a ContextEntry.
fn row_to_entry(row: &duckdb::Row) -> duckdb::Result<ContextEntry> {
    let id: String = row.get(0)?;
    let kind_str: String = row.get(1)?;
    let path: String = row.get(2)?;
    let title: String = row.get(3)?;
    let source_type: String = row.get(4)?;
    let source_ref: Option<String> = row.get(5)?;
    let word_count: i32 = row.get(6)?;
    let content_hash: String = row.get(7)?;
    let tags_json: String = row.get(8)?;
    let created_at: String = row.get(9)?;
    let updated_at: String = row.get(10)?;
    let synced: bool = row.get(11)?;

    let kind = ContextKind::from_str(&kind_str).unwrap_or(ContextKind::Document);
    let source = ContextSource::from_parts(&source_type, source_ref.as_deref());
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    let created_at = chrono::DateTime::parse_from_rfc3339(&created_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    let updated_at = chrono::DateTime::parse_from_rfc3339(&updated_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());

    Ok(ContextEntry {
        id: ContextEntryId(id),
        kind,
        path,
        title,
        source,
        word_count: word_count as usize,
        content_hash,
        tags,
        created_at,
        updated_at,
        synced,
    })
}

/// Compute SHA-256 hash of content.
fn compute_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, ContextManager) {
        let tmp = TempDir::new().unwrap();
        let mgr = ContextManager::open(":memory:", Some(tmp.path().to_path_buf())).unwrap();
        (tmp, mgr)
    }

    #[test]
    fn test_upsert_and_get() {
        let (_tmp, mgr) = setup();

        let entry = mgr
            .upsert(
                &ContextKind::Document,
                "notes/test.md",
                "Test Note",
                "Hello, world!",
                &ContextSource::Human,
                &["test".to_string()],
            )
            .unwrap();

        assert_eq!(entry.path, "notes/test.md");
        assert_eq!(entry.title, "Test Note");
        assert_eq!(entry.word_count, 2);
        assert!(!entry.content_hash.is_empty());

        let fetched = mgr.get(&entry.id.0).unwrap();
        assert_eq!(fetched.path, "notes/test.md");
    }

    #[test]
    fn test_upsert_same_path_updates() {
        let (_tmp, mgr) = setup();

        let entry1 = mgr
            .upsert(&ContextKind::Config, "CLAUDE.md", "Claude Config v1", "version 1", &ContextSource::Human, &[])
            .unwrap();

        let entry2 = mgr
            .upsert(&ContextKind::Config, "CLAUDE.md", "Claude Config v2", "version 2 updated", &ContextSource::Human, &[])
            .unwrap();

        // Same ID because same path
        assert_eq!(entry1.id.0, entry2.id.0);
        assert_eq!(entry2.title, "Claude Config v2");
        assert_eq!(entry2.word_count, 3);

        // Content updated on filesystem
        let content = mgr.read_content(&entry2.id.0).unwrap();
        assert_eq!(content, "version 2 updated");
    }

    #[test]
    fn test_get_by_path() {
        let (_tmp, mgr) = setup();

        mgr.upsert(&ContextKind::Document, "spec.md", "Spec", "Architecture spec content.", &ContextSource::Human, &[]).unwrap();

        let entry = mgr.get_by_path("spec.md").unwrap();
        assert_eq!(entry.title, "Spec");
    }

    #[test]
    fn test_read_content() {
        let (_tmp, mgr) = setup();

        let entry = mgr
            .upsert(&ContextKind::Document, "readme.md", "Readme", "# Project\n\nDescription here.", &ContextSource::Human, &[])
            .unwrap();

        let content = mgr.read_content(&entry.id.0).unwrap();
        assert_eq!(content, "# Project\n\nDescription here.");
    }

    #[test]
    fn test_list_all() {
        let (_tmp, mgr) = setup();

        mgr.upsert(&ContextKind::Document, "a.md", "A", "aaa", &ContextSource::Human, &[]).unwrap();
        mgr.upsert(&ContextKind::Config, "b.md", "B", "bbb", &ContextSource::Human, &[]).unwrap();
        mgr.upsert(&ContextKind::Snapshot, "c.md", "C", "ccc", &ContextSource::System { subsystem: "board".into() }, &[]).unwrap();

        let all = mgr.list(&ContextFilter::default()).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn test_list_filter_by_kind() {
        let (_tmp, mgr) = setup();

        mgr.upsert(&ContextKind::Document, "doc.md", "Doc", "content", &ContextSource::Human, &[]).unwrap();
        mgr.upsert(&ContextKind::Config, "cfg.md", "Cfg", "config", &ContextSource::Human, &[]).unwrap();

        let filter = ContextFilter {
            kind: Some(ContextKind::Config),
            ..Default::default()
        };
        let results = mgr.list(&filter).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].kind, ContextKind::Config);
    }

    #[test]
    fn test_list_filter_by_tag() {
        let (_tmp, mgr) = setup();

        mgr.upsert(&ContextKind::Document, "tagged.md", "Tagged", "content", &ContextSource::Human, &["important".into()]).unwrap();
        mgr.upsert(&ContextKind::Document, "untagged.md", "Untagged", "other", &ContextSource::Human, &[]).unwrap();

        let filter = ContextFilter {
            tag: Some("important".into()),
            ..Default::default()
        };
        let results = mgr.list(&filter).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "tagged.md");
    }

    #[test]
    fn test_list_filter_by_search() {
        let (_tmp, mgr) = setup();

        mgr.upsert(&ContextKind::Document, "deploy-guide.md", "Deploy Guide", "steps", &ContextSource::Human, &[]).unwrap();
        mgr.upsert(&ContextKind::Document, "api-spec.md", "API Spec", "endpoints", &ContextSource::Human, &[]).unwrap();

        let filter = ContextFilter {
            search: Some("deploy".into()),
            ..Default::default()
        };
        let results = mgr.list(&filter).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "deploy-guide.md");
    }

    #[test]
    fn test_remove() {
        let (_tmp, mgr) = setup();

        let entry = mgr
            .upsert(&ContextKind::Document, "delete-me.md", "Delete", "gone soon", &ContextSource::Human, &[])
            .unwrap();

        mgr.remove(&entry.id.0).unwrap();

        assert!(mgr.get(&entry.id.0).is_err());
    }

    #[test]
    fn test_remove_by_path() {
        let (_tmp, mgr) = setup();

        mgr.upsert(&ContextKind::Config, "old.md", "Old", "outdated", &ContextSource::Human, &[]).unwrap();
        mgr.remove_by_path("old.md").unwrap();

        assert!(mgr.get_by_path("old.md").is_err());
    }

    #[test]
    fn test_stats() {
        let (_tmp, mgr) = setup();

        mgr.upsert(&ContextKind::Document, "a.md", "A", "one two three", &ContextSource::Human, &[]).unwrap();
        mgr.upsert(&ContextKind::Config, "b.md", "B", "four five", &ContextSource::System { subsystem: "test".into() }, &[]).unwrap();

        let stats = mgr.stats().unwrap();
        assert_eq!(stats.total_entries, 2);
        assert_eq!(stats.total_words, 5);
        assert_eq!(stats.by_kind.len(), 2);
        assert_eq!(stats.by_source.len(), 2);
    }

    #[test]
    fn test_compact() {
        let (_tmp, mgr) = setup();

        mgr.upsert(&ContextKind::Document, "intro.md", "Intro", "Welcome to the project.", &ContextSource::Human, &[]).unwrap();
        mgr.upsert(&ContextKind::Config, "config.md", "Config", "Configuration details here.", &ContextSource::Human, &[]).unwrap();

        let result = mgr.compact(&ContextFilter::default()).unwrap();
        assert!(result.contains("# Agent Context"));
        assert!(result.contains("2 entries"));
        assert!(result.contains("Welcome to the project."));
        assert!(result.contains("Configuration details here."));
    }

    #[test]
    fn test_content_hash_changes_on_update() {
        let (_tmp, mgr) = setup();

        let e1 = mgr.upsert(&ContextKind::Document, "hash-test.md", "Hash", "version 1", &ContextSource::Human, &[]).unwrap();
        let e2 = mgr.upsert(&ContextKind::Document, "hash-test.md", "Hash", "version 2", &ContextSource::Human, &[]).unwrap();

        assert_ne!(e1.content_hash, e2.content_hash);
    }

    #[test]
    fn test_agent_source() {
        let (_tmp, mgr) = setup();

        let entry = mgr
            .upsert(
                &ContextKind::Document,
                "agent-note.md",
                "Agent Note",
                "Agent produced this context.",
                &ContextSource::Agent { session_id: "sess-123".into() },
                &["agent-output".into()],
            )
            .unwrap();

        let fetched = mgr.get(&entry.id.0).unwrap();
        assert_eq!(fetched.source.source_type(), "agent");
    }
}

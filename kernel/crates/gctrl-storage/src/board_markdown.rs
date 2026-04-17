//! Bidirectional sync between markdown issue files and DuckDB board_issues.
//!
//! Each issue is a markdown file with YAML frontmatter:
//! ```markdown
//! ---
//! id: BACK-1
//! project: BACK
//! status: in_progress
//! priority: high
//! assignee: claude-code
//! assignee_type: agent
//! labels: [auth, security]
//! created_by: debuggingfuture
//! ---
//!
//! # Fix auth middleware
//!
//! Description body here...
//! ```

use std::collections::HashMap;
use std::path::Path;

use gctrl_core::{BoardIssue, BoardProject, GctlError, IssueStatus, Result};
use sha2::{Digest, Sha256};

/// Parsed markdown issue — frontmatter fields + body.
#[derive(Debug, Clone)]
pub struct ParsedIssueMarkdown {
    pub id: Option<String>,
    pub project_key: Option<String>,
    pub title: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assignee: Option<String>,
    pub assignee_type: Option<String>,
    pub labels: Vec<String>,
    pub created_by: Option<String>,
    pub created_by_type: Option<String>,
    pub parent_id: Option<String>,
    pub body: String,
    pub content_hash: String,
}

/// Compute SHA-256 hash of content.
pub fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Parse a markdown file with YAML frontmatter into structured fields.
pub fn parse_issue_markdown(content: &str) -> Result<ParsedIssueMarkdown> {
    let content_hash = sha256_hex(content);

    let (frontmatter, body) = split_frontmatter(content)?;
    let yaml: HashMap<String, serde_json::Value> = parse_yaml_frontmatter(&frontmatter)?;

    let get_str = |key: &str| -> Option<String> {
        yaml.get(key).and_then(|v| v.as_str().map(String::from))
    };

    let labels = yaml
        .get("labels")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Title: from frontmatter, or first H1, or filename
    let title = get_str("title").or_else(|| extract_h1_title(&body));

    Ok(ParsedIssueMarkdown {
        id: get_str("id"),
        project_key: get_str("project"),
        title,
        status: get_str("status"),
        priority: get_str("priority"),
        assignee: get_str("assignee"),
        assignee_type: get_str("assignee_type"),
        labels,
        created_by: get_str("created_by"),
        created_by_type: get_str("created_by_type"),
        parent_id: get_str("parent_id"),
        body: body.trim().to_string(),
        content_hash,
    })
}

/// Convert a BoardIssue to markdown with YAML frontmatter.
pub fn issue_to_markdown(issue: &BoardIssue, project_key: &str) -> String {
    let mut lines = vec!["---".to_string()];
    lines.push(format!("id: {}", issue.id));
    lines.push(format!("project: {}", project_key));
    lines.push(format!("status: {}", issue.status.as_str()));
    lines.push(format!("priority: {}", issue.priority));

    if let Some(ref name) = issue.assignee_name {
        lines.push(format!("assignee: {}", name));
    }
    if let Some(ref atype) = issue.assignee_type {
        lines.push(format!("assignee_type: {}", atype));
    }
    if !issue.labels.is_empty() {
        lines.push(format!(
            "labels: [{}]",
            issue.labels.join(", ")
        ));
    }
    lines.push(format!("created_by: {}", issue.created_by_name));
    if issue.created_by_type != "human" {
        lines.push(format!("created_by_type: {}", issue.created_by_type));
    }
    if let Some(ref pid) = issue.parent_id {
        lines.push(format!("parent_id: {}", pid));
    }
    lines.push("---".to_string());
    lines.push(String::new());
    lines.push(format!("# {}", issue.title));
    lines.push(String::new());
    if let Some(ref desc) = issue.description {
        lines.push(desc.clone());
    }
    lines.push(String::new());

    lines.join("\n")
}

/// Import markdown files from a directory into board issues.
/// Returns a list of issues ready for upsert, resolved against known projects.
pub fn import_markdown_dir(
    dir: &Path,
    projects: &[BoardProject],
) -> Result<Vec<(BoardIssue, String)>> {
    let project_by_key: HashMap<&str, &BoardProject> =
        projects.iter().map(|p| (p.key.as_str(), p)).collect();

    let mut results = Vec::new();

    let entries = std::fs::read_dir(dir)
        .map_err(|e| GctlError::Storage(format!("read dir: {e}")))?;

    for entry in entries {
        let entry = entry.map_err(|e| GctlError::Storage(format!("read entry: {e}")))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let content = std::fs::read_to_string(&path)
            .map_err(|e| GctlError::Storage(format!("read {}: {e}", path.display())))?;

        let parsed = parse_issue_markdown(&content)?;

        let project_key = parsed.project_key.as_deref().ok_or_else(|| {
            GctlError::InvalidInput(format!(
                "{}: missing 'project' in frontmatter",
                path.display()
            ))
        })?;

        let project = project_by_key.get(project_key).ok_or_else(|| {
            GctlError::InvalidInput(format!(
                "{}: project '{}' not found",
                path.display(),
                project_key
            ))
        })?;

        let id = parsed.id.ok_or_else(|| {
            GctlError::InvalidInput(format!(
                "{}: missing 'id' in frontmatter",
                path.display()
            ))
        })?;

        let title = parsed.title.unwrap_or_else(|| id.clone());

        // Strip the H1 title from body to get pure description
        let description = strip_h1_title(&parsed.body);

        let now = chrono::Utc::now();
        let status = parsed
            .status
            .as_deref()
            .and_then(IssueStatus::from_str)
            .unwrap_or(IssueStatus::Backlog);

        let issue = BoardIssue {
            id: id.clone(),
            project_id: project.id.clone(),
            title,
            description: if description.is_empty() {
                None
            } else {
                Some(description)
            },
            status,
            priority: parsed.priority.unwrap_or_else(|| "none".into()),
            assignee_id: parsed.assignee.clone(),
            assignee_name: parsed.assignee,
            assignee_type: parsed.assignee_type,
            labels: parsed.labels,
            parent_id: parsed.parent_id,
            created_at: now,
            updated_at: now,
            created_by_id: parsed
                .created_by
                .clone()
                .unwrap_or_else(|| "unknown".into()),
            created_by_name: parsed.created_by.unwrap_or_else(|| "unknown".into()),
            created_by_type: parsed.created_by_type.unwrap_or_else(|| "human".into()),
            blocked_by: vec![],
            blocking: vec![],
            session_ids: vec![],
            total_cost_usd: 0.0,
            total_tokens: 0,
            pr_numbers: vec![],
            content_hash: Some(parsed.content_hash),
            source_path: Some(path.to_string_lossy().into_owned()),
            github_issue_number: None,
            github_url: None,
        };

        results.push((issue, id));
    }

    Ok(results)
}

/// Export issues to markdown files in a directory.
pub fn export_markdown_dir(
    dir: &Path,
    issues: &[BoardIssue],
    projects: &[BoardProject],
) -> Result<Vec<String>> {
    let project_by_id: HashMap<&str, &BoardProject> =
        projects.iter().map(|p| (p.id.as_str(), p)).collect();

    std::fs::create_dir_all(dir)
        .map_err(|e| GctlError::Storage(format!("create dir: {e}")))?;

    let mut written = Vec::new();
    for issue in issues {
        let project_key = project_by_id
            .get(issue.project_id.as_str())
            .map(|p| p.key.as_str())
            .unwrap_or("UNKNOWN");

        let md = issue_to_markdown(issue, project_key);
        let filename = format!("{}.md", issue.id);
        let path = dir.join(&filename);
        std::fs::write(&path, &md)
            .map_err(|e| GctlError::Storage(format!("write {}: {e}", path.display())))?;
        written.push(filename);
    }

    Ok(written)
}

// ── Internal helpers ──

fn split_frontmatter(content: &str) -> Result<(String, String)> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return Ok((String::new(), content.to_string()));
    }

    let after_first = &trimmed[3..];
    let end = after_first.find("\n---").ok_or_else(|| {
        GctlError::InvalidInput("unterminated YAML frontmatter (missing closing ---)".into())
    })?;

    let frontmatter = after_first[..end].trim().to_string();
    let body = after_first[end + 4..].to_string();
    Ok((frontmatter, body))
}

fn parse_yaml_frontmatter(yaml_str: &str) -> Result<HashMap<String, serde_json::Value>> {
    if yaml_str.is_empty() {
        return Ok(HashMap::new());
    }

    // Simple YAML parser — handles key: value, key: [a, b, c]
    let mut map = HashMap::new();
    for line in yaml_str.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(colon_pos) = line.find(':') {
            let key = line[..colon_pos].trim().to_string();
            let value_str = line[colon_pos + 1..].trim();

            let value = if value_str.starts_with('[') && value_str.ends_with(']') {
                // Array: [a, b, c]
                let inner = &value_str[1..value_str.len() - 1];
                let items: Vec<serde_json::Value> = inner
                    .split(',')
                    .map(|s| serde_json::Value::String(s.trim().to_string()))
                    .collect();
                serde_json::Value::Array(items)
            } else {
                serde_json::Value::String(value_str.to_string())
            };

            map.insert(key, value);
        }
    }
    Ok(map)
}

fn extract_h1_title(body: &str) -> Option<String> {
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix("# ") {
            return Some(title.trim().to_string());
        }
    }
    None
}

fn strip_h1_title(body: &str) -> String {
    let mut lines: Vec<&str> = body.lines().collect();
    // Remove leading empty lines
    while lines.first().map_or(false, |l| l.trim().is_empty()) {
        lines.remove(0);
    }
    // Remove H1 title line if present
    if lines
        .first()
        .map_or(false, |l| l.trim().starts_with("# "))
    {
        lines.remove(0);
    }
    // Remove leading empty lines after title
    while lines.first().map_or(false, |l| l.trim().is_empty()) {
        lines.remove(0);
    }
    lines.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_frontmatter() {
        let md = r#"---
id: BACK-1
project: BACK
status: in_progress
priority: high
assignee: claude-code
assignee_type: agent
labels: [auth, security]
created_by: debuggingfuture
---

# Fix auth middleware

The rate limiting middleware stores tokens in plaintext.
"#;
        let parsed = parse_issue_markdown(md).unwrap();
        assert_eq!(parsed.id.as_deref(), Some("BACK-1"));
        assert_eq!(parsed.project_key.as_deref(), Some("BACK"));
        assert_eq!(parsed.status.as_deref(), Some("in_progress"));
        assert_eq!(parsed.priority.as_deref(), Some("high"));
        assert_eq!(parsed.assignee.as_deref(), Some("claude-code"));
        assert_eq!(parsed.assignee_type.as_deref(), Some("agent"));
        assert_eq!(parsed.labels, vec!["auth", "security"]);
        assert_eq!(parsed.title.as_deref(), Some("Fix auth middleware"));
        assert!(parsed.body.contains("rate limiting"));
        assert!(!parsed.content_hash.is_empty());
    }

    #[test]
    fn test_parse_no_frontmatter() {
        let md = "# Just a title\n\nSome body text.\n";
        let parsed = parse_issue_markdown(md).unwrap();
        assert_eq!(parsed.id, None);
        assert_eq!(parsed.title.as_deref(), Some("Just a title"));
        assert!(parsed.body.contains("Some body text"));
    }

    #[test]
    fn test_issue_to_markdown_roundtrip() {
        let issue = BoardIssue {
            id: "BACK-42".into(),
            project_id: "p1".into(),
            title: "Fix auth middleware".into(),
            description: Some("Encrypt tokens at rest.".into()),
            status: IssueStatus::InProgress,
            priority: "high".into(),
            assignee_id: Some("claude-code".into()),
            assignee_name: Some("claude-code".into()),
            assignee_type: Some("agent".into()),
            labels: vec!["auth".into(), "security".into()],
            parent_id: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            created_by_id: "user1".into(),
            created_by_name: "debuggingfuture".into(),
            created_by_type: "human".into(),
            blocked_by: vec![],
            blocking: vec![],
            session_ids: vec![],
            total_cost_usd: 0.0,
            total_tokens: 0,
            pr_numbers: vec![],
            content_hash: None,
            source_path: None,
            github_issue_number: None,
            github_url: None,
        };

        let md = issue_to_markdown(&issue, "BACK");
        let parsed = parse_issue_markdown(&md).unwrap();

        assert_eq!(parsed.id.as_deref(), Some("BACK-42"));
        assert_eq!(parsed.project_key.as_deref(), Some("BACK"));
        assert_eq!(parsed.status.as_deref(), Some("in_progress"));
        assert_eq!(parsed.priority.as_deref(), Some("high"));
        assert_eq!(parsed.title.as_deref(), Some("Fix auth middleware"));
        assert_eq!(parsed.labels, vec!["auth", "security"]);
    }

    #[test]
    fn test_content_hash_changes_on_edit() {
        let md1 = "---\nid: X-1\nproject: X\n---\n\n# Title\n\nBody v1\n";
        let md2 = "---\nid: X-1\nproject: X\n---\n\n# Title\n\nBody v2\n";

        let h1 = parse_issue_markdown(md1).unwrap().content_hash;
        let h2 = parse_issue_markdown(md2).unwrap().content_hash;
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_export_import_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let projects = vec![BoardProject {
            id: "p1".into(),
            name: "Backend".into(),
            key: "BACK".into(),
            counter: 1,
            github_repo: None,
        }];

        let issues = vec![BoardIssue {
            id: "BACK-1".into(),
            project_id: "p1".into(),
            title: "Test roundtrip".into(),
            description: Some("Description here.".into()),
            status: IssueStatus::Todo,
            priority: "medium".into(),
            assignee_id: None,
            assignee_name: None,
            assignee_type: None,
            labels: vec!["test".into()],
            parent_id: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            created_by_id: "user1".into(),
            created_by_name: "Alice".into(),
            created_by_type: "human".into(),
            blocked_by: vec![],
            blocking: vec![],
            session_ids: vec![],
            total_cost_usd: 0.0,
            total_tokens: 0,
            pr_numbers: vec![],
            content_hash: None,
            source_path: None,
            github_issue_number: None,
            github_url: None,
        }];

        // Export
        let written = export_markdown_dir(dir.path(), &issues, &projects).unwrap();
        assert_eq!(written, vec!["BACK-1.md"]);

        // Import
        let imported = import_markdown_dir(dir.path(), &projects).unwrap();
        assert_eq!(imported.len(), 1);

        let (reimported, id) = &imported[0];
        assert_eq!(id, "BACK-1");
        assert_eq!(reimported.title, "Test roundtrip");
        assert_eq!(reimported.status, IssueStatus::Todo);
        assert_eq!(reimported.priority, "medium");
        assert_eq!(reimported.labels, vec!["test"]);
        assert_eq!(reimported.description.as_deref(), Some("Description here."));
        assert!(reimported.content_hash.is_some());
    }
}

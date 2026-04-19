//! Markdown ↔ Persona import.
//!
//! Vault layout (mirrors how `board_markdown` handles board issues):
//!
//!   gctrl/personas/
//!     <id>.md            ← one PersonaDefinition per file
//!     rules/
//!       <pr-type>.md     ← one PersonaReviewRule per file
//!
//! Each file's YAML frontmatter holds the structured fields; the body is a
//! free-form note for human readers (the body of a persona file is also used
//! as the `prompt_prefix` if the frontmatter does not provide one).
//!
//! Format kept deliberately flat to match the hand-rolled YAML parser shared
//! with `board_markdown` (no nested lists of objects).

use std::collections::HashMap;
use std::path::Path;

use gctrl_core::{GctlError, PersonaDefinition, PersonaReviewRule, Result};

use crate::board_markdown::{parse_yaml_frontmatter, split_frontmatter};

/// Result of importing a persona vault directory.
#[derive(Debug, Default)]
pub struct PersonaImport {
    pub personas: Vec<PersonaDefinition>,
    pub review_rules: Vec<PersonaReviewRule>,
}

/// Parse a single persona markdown file (frontmatter + body → PersonaDefinition).
pub fn parse_persona_markdown(content: &str) -> Result<PersonaDefinition> {
    let (fm_str, body) = split_frontmatter(content)?;
    if fm_str.is_empty() {
        return Err(GctlError::InvalidInput(
            "persona markdown missing YAML frontmatter".into(),
        ));
    }
    let fm = parse_yaml_frontmatter(&fm_str)?;

    let id = require_string(&fm, "id")?;
    let name = require_string(&fm, "name")?;
    let focus = require_string(&fm, "focus")?;
    let owns = require_string(&fm, "owns")?;
    let review_focus = require_string(&fm, "review_focus")?;
    let pushes_back = require_string(&fm, "pushes_back")?;

    let tools = optional_string_array(&fm, "tools");
    let key_specs = optional_string_array(&fm, "key_specs");

    let prompt_prefix = optional_string(&fm, "prompt_prefix")
        .unwrap_or_else(|| body.trim().to_string());
    if prompt_prefix.is_empty() {
        return Err(GctlError::InvalidInput(format!(
            "persona '{id}' has no prompt_prefix (frontmatter or body)"
        )));
    }

    Ok(PersonaDefinition {
        id,
        name,
        focus,
        prompt_prefix,
        owns,
        review_focus,
        pushes_back,
        tools,
        key_specs,
        source_hash: None,
    })
}

/// Parse a review-rule markdown file. The frontmatter must contain
/// `pr_type` and `persona_ids: [...]`. Rule `id` is derived from `pr_type`
/// so re-imports update in place.
pub fn parse_review_rule_markdown(content: &str) -> Result<PersonaReviewRule> {
    let (fm_str, _body) = split_frontmatter(content)?;
    if fm_str.is_empty() {
        return Err(GctlError::InvalidInput(
            "review-rule markdown missing YAML frontmatter".into(),
        ));
    }
    let fm = parse_yaml_frontmatter(&fm_str)?;

    let pr_type = require_string(&fm, "pr_type")?;
    let persona_ids = optional_string_array(&fm, "persona_ids");
    if persona_ids.is_empty() {
        return Err(GctlError::InvalidInput(format!(
            "review rule '{pr_type}' has empty persona_ids"
        )));
    }

    Ok(PersonaReviewRule {
        id: format!("rule:{pr_type}"),
        pr_type,
        persona_ids,
    })
}

/// Walk `dir` for persona files (`*.md` at the top level) and review-rule
/// files (`rules/*.md`). Returns a `PersonaImport` with parsed entries.
///
/// Files starting with `_` and the `rules/` directory itself are skipped at
/// the top level; the `rules/` subdir is read separately.
pub fn import_persona_dir(dir: &Path) -> Result<PersonaImport> {
    if !dir.is_dir() {
        return Err(GctlError::InvalidInput(format!(
            "persona dir not found: {}",
            dir.display()
        )));
    }

    let mut out = PersonaImport::default();

    for entry in std::fs::read_dir(dir).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        let path = entry.path();
        if path.is_file() && is_md(&path) && !is_hidden(&path) {
            let content = std::fs::read_to_string(&path).map_err(io_err)?;
            let persona = parse_persona_markdown(&content).map_err(|e| {
                GctlError::InvalidInput(format!("{}: {e}", path.display()))
            })?;
            out.personas.push(persona);
        }
    }

    let rules_dir = dir.join("rules");
    if rules_dir.is_dir() {
        for entry in std::fs::read_dir(&rules_dir).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            if path.is_file() && is_md(&path) && !is_hidden(&path) {
                let content = std::fs::read_to_string(&path).map_err(io_err)?;
                let rule = parse_review_rule_markdown(&content).map_err(|e| {
                    GctlError::InvalidInput(format!("{}: {e}", path.display()))
                })?;
                out.review_rules.push(rule);
            }
        }
    }

    Ok(out)
}

// --- helpers ---

fn is_md(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("md")
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('_') || n.starts_with('.'))
}

fn io_err(e: std::io::Error) -> GctlError {
    GctlError::InvalidInput(e.to_string())
}

fn require_string(fm: &HashMap<String, serde_json::Value>, key: &str) -> Result<String> {
    optional_string(fm, key).ok_or_else(|| {
        GctlError::InvalidInput(format!("persona frontmatter missing required field '{key}'"))
    })
}

fn optional_string(fm: &HashMap<String, serde_json::Value>, key: &str) -> Option<String> {
    fm.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn optional_string_array(fm: &HashMap<String, serde_json::Value>, key: &str) -> Vec<String> {
    fm.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const ENGINEER_MD: &str = r#"---
id: engineer
name: Principal Fullstack Engineer
focus: Architecture, code quality, cross-layer integration
owns: kernel crates, shell, Effect-TS apps
review_focus: Hexagonal boundaries respected, no leaky abstractions
pushes_back: Adapters depend on each other instead of ports
tools: [cargo build, cargo test, pnpm run test]
key_specs: [specs/architecture/, specs/principles.md]
---

You are a Principal Fullstack Engineer. You own the entire stack.
"#;

    const RULE_MD: &str = r#"---
pr_type: new-kernel-primitive
persona_ids: [engineer, security, tech-lead]
---

Requires engineer ownership and security sign-off.
"#;

    #[test]
    fn parses_persona_with_body_as_prompt() {
        let p = parse_persona_markdown(ENGINEER_MD).unwrap();
        assert_eq!(p.id, "engineer");
        assert_eq!(p.name, "Principal Fullstack Engineer");
        assert!(p.prompt_prefix.starts_with("You are a Principal"));
        assert_eq!(p.tools.len(), 3);
        assert_eq!(p.key_specs.len(), 2);
    }

    #[test]
    fn rejects_persona_without_frontmatter() {
        let err = parse_persona_markdown("just body, no fm").unwrap_err();
        assert!(err.to_string().contains("missing YAML frontmatter"));
    }

    #[test]
    fn rejects_persona_missing_required_field() {
        let md = "---\nid: x\n---\nbody";
        let err = parse_persona_markdown(md).unwrap_err();
        assert!(err.to_string().contains("missing required field"));
    }

    #[test]
    fn parses_review_rule() {
        let r = parse_review_rule_markdown(RULE_MD).unwrap();
        assert_eq!(r.pr_type, "new-kernel-primitive");
        assert_eq!(r.id, "rule:new-kernel-primitive");
        assert_eq!(r.persona_ids, vec!["engineer", "security", "tech-lead"]);
    }

    #[test]
    fn rejects_review_rule_with_empty_persona_ids() {
        let md = "---\npr_type: foo\npersona_ids: []\n---";
        let err = parse_review_rule_markdown(md).unwrap_err();
        assert!(err.to_string().contains("empty persona_ids"));
    }

    #[test]
    fn imports_full_dir_with_personas_and_rules() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("engineer.md"), ENGINEER_MD).unwrap();
        std::fs::write(dir.path().join("_skipped.md"), "---\nid: x\n---\n").unwrap();
        let rules_dir = dir.path().join("rules");
        std::fs::create_dir(&rules_dir).unwrap();
        std::fs::write(rules_dir.join("new-kernel-primitive.md"), RULE_MD).unwrap();

        let imported = import_persona_dir(dir.path()).unwrap();
        assert_eq!(imported.personas.len(), 1, "underscore prefix should be skipped");
        assert_eq!(imported.review_rules.len(), 1);
        assert_eq!(imported.personas[0].id, "engineer");
        assert_eq!(imported.review_rules[0].pr_type, "new-kernel-primitive");
    }
}

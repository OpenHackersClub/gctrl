use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceKind {
    Shell,
    Test,
    Http,
}

impl AcceptanceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Test => "test",
            Self::Http => "http",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "shell" => Some(Self::Shell),
            "test" => Some(Self::Test),
            "http" => Some(Self::Http),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceStatus {
    Pending,
    Running,
    Pass,
    Fail,
}

impl AcceptanceStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Pass => "pass",
            Self::Fail => "fail",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "running" => Some(Self::Running),
            "pass" => Some(Self::Pass),
            "fail" => Some(Self::Fail),
            _ => None,
        }
    }
}

/// A check parsed from an issue's `acceptance_criteria` markdown. No DB state
/// yet — see `AcceptanceCheckRow` for the persisted form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcceptanceCheck {
    pub idx: usize,
    pub kind: AcceptanceKind,
    pub command: String,
}

/// A row in `board_acceptance_checks`. `check_idx` pairs with `issue_id` as
/// the natural key — agents call back with `(issue_id, check_idx)` to report
/// results.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptanceCheckRow {
    pub id: String,
    pub issue_id: String,
    pub check_idx: i64,
    pub kind: AcceptanceKind,
    pub command: String,
    pub status: AcceptanceStatus,
    pub last_session_id: Option<String>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub output: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Response shape for `GET /api/board/issues/:id/acceptance`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AcceptanceRollup {
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
    pub pending: u64,
    pub running: u64,
    pub checks: Vec<AcceptanceCheckRow>,
}

/// Parse an `acceptance_criteria` markdown body into structured checks.
///
/// Recognized: `- [ ] kind: command` (or `[x]`, `* [ ]`, `+ [ ]`) where `kind`
/// is `shell` | `test` | `http`. Checkbox state on the line is ignored — the
/// authoritative status is the row in `board_acceptance_checks`. Unrecognized
/// lines (prose, headings, unknown kinds, empty commands) are silently skipped
/// so issue authors can mix free-form context with their checklist.
pub fn parse_acceptance_criteria(input: &str) -> Vec<AcceptanceCheck> {
    let mut checks = Vec::new();
    for line in input.lines() {
        let Some(after_box) = strip_checkbox_prefix(line.trim_start()) else {
            continue;
        };
        let Some((kind_str, command)) = after_box.split_once(':') else {
            continue;
        };
        let Some(kind) = AcceptanceKind::from_str(kind_str.trim()) else {
            continue;
        };
        let command = command.trim().to_string();
        if command.is_empty() {
            continue;
        }
        checks.push(AcceptanceCheck {
            idx: checks.len(),
            kind,
            command,
        });
    }
    checks
}

/// Strip `- [ ]`, `* [x]`, `+ [X]` and similar prefixes. Returns the rest of
/// the line or None if the line isn't a checklist item.
fn strip_checkbox_prefix(s: &str) -> Option<&str> {
    let rest = s
        .strip_prefix('-')
        .or_else(|| s.strip_prefix('*'))
        .or_else(|| s.strip_prefix('+'))?;
    let rest = rest.trim_start().strip_prefix('[')?;
    let mut chars = rest.chars();
    let marker = chars.next()?;
    if !matches!(marker, ' ' | 'x' | 'X') {
        return None;
    }
    let rest = chars.as_str().strip_prefix(']')?;
    Some(rest.trim_start())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_empty_input() {
        assert!(parse_acceptance_criteria("").is_empty());
        assert!(parse_acceptance_criteria("   \n\n   ").is_empty());
    }

    #[test]
    fn parses_single_shell_check() {
        let out = parse_acceptance_criteria("- [ ] shell: `curl :8080/health` → 200");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].idx, 0);
        assert_eq!(out[0].kind, AcceptanceKind::Shell);
        assert_eq!(out[0].command, "`curl :8080/health` → 200");
    }

    #[test]
    fn parses_mixed_kinds_and_assigns_sequential_indexes() {
        let md = "\
- [ ] shell: curl :8080/health
- [ ] test: pnpm test foo.test.ts
- [ ] http: GET /api/sessions
";
        let out = parse_acceptance_criteria(md);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].idx, 0);
        assert_eq!(out[0].kind, AcceptanceKind::Shell);
        assert_eq!(out[1].idx, 1);
        assert_eq!(out[1].kind, AcceptanceKind::Test);
        assert_eq!(out[2].idx, 2);
        assert_eq!(out[2].kind, AcceptanceKind::Http);
    }

    #[test]
    fn ignores_non_checklist_lines() {
        let md = "\
# Acceptance Tests

Some prose line with colons: like this.

- [ ] shell: echo hi

More prose.
";
        let out = parse_acceptance_criteria(md);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].command, "echo hi");
    }

    #[test]
    fn ignores_unknown_kinds() {
        let md = "- [ ] weird: some command\n- [ ] shell: echo ok";
        let out = parse_acceptance_criteria(md);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, AcceptanceKind::Shell);
        assert_eq!(out[0].idx, 0);
    }

    #[test]
    fn ignores_empty_commands() {
        let md = "- [ ] shell: \n- [ ] test: pnpm test";
        let out = parse_acceptance_criteria(md);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, AcceptanceKind::Test);
    }

    #[test]
    fn accepts_checked_box() {
        let md = "- [x] shell: echo hi\n- [X] test: pnpm test";
        let out = parse_acceptance_criteria(md);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].command, "echo hi");
        assert_eq!(out[1].kind, AcceptanceKind::Test);
    }

    #[test]
    fn preserves_colons_inside_commands() {
        let md = "- [ ] shell: curl http://foo:8080/x → 200";
        let out = parse_acceptance_criteria(md);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].command, "curl http://foo:8080/x → 200");
    }

    #[test]
    fn accepts_asterisk_and_plus_bullets() {
        let md = "* [ ] shell: one\n+ [ ] test: two";
        let out = parse_acceptance_criteria(md);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].kind, AcceptanceKind::Shell);
        assert_eq!(out[1].kind, AcceptanceKind::Test);
    }

    #[test]
    fn kind_from_str_roundtrip() {
        for k in [
            AcceptanceKind::Shell,
            AcceptanceKind::Test,
            AcceptanceKind::Http,
        ] {
            assert_eq!(AcceptanceKind::from_str(k.as_str()), Some(k.clone()));
        }
        assert_eq!(AcceptanceKind::from_str("bogus"), None);
    }

    #[test]
    fn status_from_str_roundtrip() {
        for s in [
            AcceptanceStatus::Pending,
            AcceptanceStatus::Running,
            AcceptanceStatus::Pass,
            AcceptanceStatus::Fail,
        ] {
            assert_eq!(AcceptanceStatus::from_str(s.as_str()), Some(s.clone()));
        }
        assert_eq!(AcceptanceStatus::from_str("bogus"), None);
    }
}

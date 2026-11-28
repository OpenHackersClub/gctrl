//! A Claude Code session's map, read from its transcript. This is the
//! fallback source; the session-map mod's own store ([`crate::map_store`])
//! comes first when it holds the session.
//!
//! Three transcript records carry the map:
//!
//! 1. The tool call (`assistant` → `tool_use`, name ending in
//!    `session-map__update`). Its input is a delta: any of `goal`, `status`,
//!    `summary`, `name`, and `steps` (the whole list).
//! 2. The tool result (`user` → `tool_result`). It prints the whole map:
//!    `Session <name> [<repo> · <branch>]`, `Goal: …`,
//!    `Status: <status> — <summary>`, `Hand-offs:` rows
//!    (`\N who [Type] action — why`, `→ who [Type] …`), `Steps:` lines
//!    (`- [x]` done, `- [>]` in progress, `- [ ]` pending) and `GitHub:`
//!    lines. A result follows its call, so the printed map wins.
//! 3. `/goal` (`attachment` of type `goal_status` with `condition`).

use crate::model::{MapHandoff, MapRef, MapStep, Progress, SessionMap};
use crate::text::clip;
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TranscriptMap {
    pub map: SessionMap,
    seen: bool,
    snapshot: bool,
}

fn meaningful(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty() && !matches!(t, "-" | "—" | "(none)" | "none" | "(not set)"))
        .then(|| clip(t, 300))
}

fn step(text: &str, status: &str) -> MapStep {
    MapStep {
        text: clip(text, 200),
        status: status.to_string(),
    }
}

/// `\1 operator [Ops] action — why` or `→ codex [Task] action — why`.
fn handoff_line(line: &str) -> Option<MapHandoff> {
    let line = line.trim();
    let (n, rest) = if let Some(r) = line.strip_prefix('→') {
        (None, r.trim_start())
    } else {
        let r = line.strip_prefix('\\')?;
        let digits: String = r.chars().take_while(char::is_ascii_digit).collect();
        (digits.parse().ok(), r[digits.len()..].trim_start())
    };
    let open = rest.find(" [")?;
    let close = rest[open..].find("] ")? + open;
    let who = rest[..open].trim().to_string();
    let kind = rest[open + 2..close].to_ascii_lowercase();
    if !matches!(kind.as_str(), "signoff" | "ops" | "task") || who.is_empty() {
        return None;
    }
    let body = &rest[close + 2..];
    let (action, why) = match body.split_once(" — ") {
        Some((a, w)) => (a, Some(w)),
        None => (body, None),
    };
    Some(MapHandoff {
        who,
        kind,
        action: clip(action, 300),
        why: why.and_then(meaningful),
        n,
        pinned: false,
    })
}

/// `- PR acme/api#12 (OPEN) created, merged`.
fn ref_line(line: &str) -> Option<MapRef> {
    let rest = line.trim().strip_prefix("- ")?;
    let (kind, rest) = if let Some(r) = rest.strip_prefix("PR ") {
        ("pr", r)
    } else {
        ("issue", rest.strip_prefix("Issue ")?)
    };
    let (id, tail) = rest.split_once(' ').unwrap_or((rest, ""));
    let (repo, num) = id.split_once('#')?;
    let number: u64 = num.parse().ok()?;
    let (state, roles) = match tail.strip_prefix('(').and_then(|t| t.split_once(") ")) {
        Some((st, r)) => (Some(st.to_string()), r),
        None => (None, tail),
    };
    let roles = roles.split(" — ").next().unwrap_or("");
    Some(MapRef {
        kind: kind.into(),
        repo: repo.to_string(),
        number,
        url: format!(
            "https://github.com/{repo}/{}/{number}",
            if kind == "pr" { "pull" } else { "issues" }
        ),
        roles: roles
            .split(", ")
            .filter(|r| !r.is_empty())
            .map(str::to_string)
            .collect(),
        title: None,
        state,
    })
}

impl TranscriptMap {
    /// Whether any session-map record was seen.
    pub fn seen(&self) -> bool {
        self.seen
    }

    /// Whether a printed map (the whole state) was applied.
    pub fn has_snapshot(&self) -> bool {
        self.snapshot
    }

    pub fn progress(&self) -> Option<Progress> {
        self.seen.then(|| self.map.progress())
    }

    /// Fold in a tool call's input.
    pub fn apply_input(&mut self, input: &Value) {
        self.seen = true;
        self.map.source = "transcript".into();
        let s = |k: &str| input.get(k).and_then(Value::as_str).and_then(meaningful);
        if let Some(g) = s("goal") {
            if !self.map.goal_pinned {
                self.map.goal = Some(g);
            }
        }
        if let Some(st) = s("status") {
            self.map.status = Some(st);
        }
        if let Some(sum) = s("summary") {
            self.map.summary = Some(sum);
        }
        if let Some(steps) = input.get("steps").and_then(Value::as_array) {
            self.map.steps = steps
                .iter()
                .filter_map(|st| {
                    let text = st.get("text").and_then(Value::as_str)?;
                    let status = st
                        .get("status")
                        .and_then(Value::as_str)
                        .filter(|s| matches!(*s, "completed" | "in_progress"))
                        .unwrap_or("pending");
                    Some(step(text, status))
                })
                .collect();
        }
        if input.get("clearHandoffs").and_then(Value::as_bool) == Some(true) {
            self.map.handoffs.retain(|h| h.pinned);
        }
    }

    /// Fold in a tool result's printed map. Returns false when `text` is
    /// not a session-map result.
    pub fn apply_result(&mut self, text: &str) -> bool {
        if !text.starts_with("Session ")
            || (!text.contains("\nGoal: ") && !text.contains("\nStatus: "))
        {
            return false;
        }
        self.seen = true;
        self.snapshot = true;
        let mut next = SessionMap {
            source: "transcript".into(),
            ..SessionMap::default()
        };
        if let Some(first) = text.lines().next().and_then(|l| l.strip_prefix("Session ")) {
            let (name, place) = match first.split_once(" [") {
                Some((n, p)) => (n.trim(), Some(p.trim_end_matches(']'))),
                None => (first.trim(), None),
            };
            // A session with no name prints its id, which says less than its title.
            let id_like = name.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
            if !name.is_empty() && !id_like && !name.contains(char::is_whitespace) {
                next.name = Some(name.to_string());
            }
            if let Some((repo, branch)) = place.and_then(|p| p.split_once(" · ")) {
                next.repo = meaningful(repo);
                next.branch = meaningful(branch);
            }
        }
        #[derive(PartialEq)]
        enum Section {
            None,
            Handoffs,
            Steps,
            GitHub,
        }
        let mut section = Section::None;
        for line in text.lines().skip(1) {
            if let Some(g) = line.strip_prefix("Goal: ") {
                next.goal = meaningful(g);
                section = Section::None;
            } else if let Some(st) = line.strip_prefix("Status: ") {
                let (status, summary) = match st.split_once(" — ") {
                    Some((a, b)) => (a, Some(b)),
                    None => (st, None),
                };
                next.status = meaningful(status);
                next.summary = summary.and_then(meaningful);
                section = Section::None;
            } else if line.starts_with("Hand-offs:") {
                section = Section::Handoffs;
            } else if line.starts_with("Steps:") {
                section = Section::Steps;
            } else if line.starts_with("GitHub:") {
                section = Section::GitHub;
            } else if line.ends_with(':') && !line.starts_with(' ') {
                section = Section::None;
            } else {
                match section {
                    Section::Handoffs => next.handoffs.extend(handoff_line(line)),
                    Section::Steps => {
                        let item = line.trim_start();
                        if let Some(r) = item.strip_prefix("- [x] ") {
                            next.steps.push(step(r, "completed"));
                        } else if let Some(r) = item.strip_prefix("- [>] ") {
                            next.steps.push(step(r, "in_progress"));
                        } else if let Some(r) = item.strip_prefix("- [ ] ") {
                            next.steps.push(step(r, "pending"));
                        }
                    }
                    Section::GitHub => next.refs.extend(ref_line(line)),
                    Section::None => {}
                }
            }
        }
        next.goal_pinned = self.map.goal_pinned;
        self.map = next;
        true
    }
}

/// Whether a raw transcript line may carry a printed map.
pub fn is_snapshot_line(raw: &[u8]) -> bool {
    memchr::memmem::find(raw, br#""type":"user""#).is_some()
        && (memchr::memmem::find(raw, b"\\nGoal: ").is_some()
            || memchr::memmem::find(raw, b"\\nStatus: ").is_some())
}

/// The text of a `tool_result` block: a string, or its text parts joined.
pub fn tool_result_text(block: &Value) -> Option<String> {
    match block.get("content")? {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const RESULT: &str = "Session s-agent-control-panel [acme/api · main]\n\
Goal: Agent panel supports any harness\n\
Status: active — Codex run 2 in progress\n\
Hand-offs:\n\
\\1 operator [Ops] Re-grant Accessibility — Reset by the binary swap\n\
→ codex [Task] Fix the lipo step\n\
Steps:\n\
- [x] Harness adapters\n\
- [x] Build and install\n\
- [>] Codex: review + squash-merge #243\n\
- [ ] Follow-up\n\
GitHub:\n\
- PR acme/api#243 (MERGED) created, merged\n\
- Issue acme/api#246 created";

    #[test]
    fn parses_printed_map() {
        let mut m = TranscriptMap::default();
        assert!(m.apply_result(RESULT));
        let map = &m.map;
        assert_eq!(map.name.as_deref(), Some("s-agent-control-panel"));
        assert_eq!(
            (map.repo.as_deref(), map.branch.as_deref()),
            (Some("acme/api"), Some("main"))
        );
        assert_eq!(
            map.goal.as_deref(),
            Some("Agent panel supports any harness")
        );
        assert_eq!(map.handoffs.len(), 2);
        assert_eq!(map.handoffs[0].n, Some(1));
        assert_eq!(map.handoffs[0].kind, "ops");
        assert_eq!(
            map.handoffs[0].why.as_deref(),
            Some("Reset by the binary swap")
        );
        assert_eq!(
            (map.handoffs[1].who.as_str(), map.handoffs[1].n),
            ("codex", None)
        );
        assert_eq!(map.refs.len(), 2);
        assert_eq!(map.refs[0].url, "https://github.com/acme/api/pull/243");
        assert_eq!(map.refs[0].roles, vec!["created", "merged"]);
        assert_eq!(map.refs[1].kind, "issue");
        let p = m.progress().unwrap();
        assert_eq!(
            p.current_step.as_deref(),
            Some("Codex: review + squash-merge #243")
        );
        assert_eq!((p.steps_done, p.steps_total), (2, 4));
        assert!(!m.apply_result("plain tool output"));
    }

    #[test]
    fn folds_input_deltas() {
        let mut m = TranscriptMap::default();
        m.apply_input(&json!({"goal": "Ship the parser", "status": "active"}));
        m.apply_input(&json!({"summary": "tests green", "steps": [
            {"text": "write tests", "status": "completed"},
            {"text": "refactor", "status": "pending"}
        ]}));
        assert_eq!(m.map.goal.as_deref(), Some("Ship the parser"));
        let p = m.progress().unwrap();
        assert_eq!(p.summary.as_deref(), Some("tests green"));
        assert_eq!(p.current_step.as_deref(), Some("refactor"));
        assert_eq!((p.steps_done, p.steps_total), (1, 2));
    }

    #[test]
    fn ignores_an_id_printed_as_the_session_name() {
        let mut m = TranscriptMap::default();
        assert!(m.apply_result("Session f741d06b-46e6-4778-942c-13b0aa11bb22 [r · main]\nGoal: x"));
        assert_eq!(m.map.name, None);
        assert_eq!(m.map.goal.as_deref(), Some("x"));
    }

    #[test]
    fn status_without_summary_and_empty_goal() {
        let mut m = TranscriptMap::default();
        assert!(m.apply_result("Session s-x [r · main]\nGoal: (not set)\nStatus: blocked"));
        assert_eq!(m.map.goal, None);
        let p = m.progress().unwrap();
        assert_eq!(p.status.as_deref(), Some("blocked"));
        assert_eq!(p.summary, None);
        assert_eq!(p.steps_total, 0);
    }
}

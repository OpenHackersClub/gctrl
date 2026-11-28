//! Goal and progress a Claude Code session reports through the session-map
//! tool (`mcp__session-map__update`) and `/goal`.
//!
//! Three transcript records carry them:
//!
//! 1. The tool call (`assistant` → `tool_use`, name ending in
//!    `session-map__update`). Its input is a delta: any of `goal`, `status`,
//!    `summary`, and `steps` (the whole list).
//! 2. The tool result (`user` → `tool_result`). It prints the whole map:
//!    `Session <name> [<repo> · <branch>]`, `Goal: …`, `Status: <status> — <summary>`, and `Steps:` lines
//!    `- [x]` done, `- [>]` in progress, `- [ ]` pending. A result follows
//!    its call, so the snapshot wins.
//! 3. `/goal` (`attachment` of type `goal_status` with `condition`).

use crate::model::Progress;
use crate::text::clip;
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionMap {
    /// The session's `s-<id>` name from the result's first line.
    pub name: Option<String>,
    pub goal: Option<String>,
    pub progress: Progress,
    seen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum StepState {
    Done,
    Doing,
    Todo,
}

fn meaningful(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty() && !matches!(t, "-" | "—" | "(none)" | "none")).then(|| clip(t, 160))
}

impl SessionMap {
    /// Whether any session-map record was seen.
    pub fn seen(&self) -> bool {
        self.seen
    }

    fn set_steps(&mut self, steps: &[(StepState, String)]) {
        let p = &mut self.progress;
        p.steps_total = steps.len() as u32;
        p.steps_done = steps.iter().filter(|(s, _)| *s == StepState::Done).count() as u32;
        p.current_step = steps
            .iter()
            .find(|(s, _)| *s == StepState::Doing)
            .or_else(|| steps.iter().find(|(s, _)| *s == StepState::Todo))
            .map(|(_, t)| clip(t, 160));
    }

    /// Fold in a tool call's input.
    pub fn apply_input(&mut self, input: &Value) {
        self.seen = true;
        let s = |k: &str| input.get(k).and_then(Value::as_str).and_then(meaningful);
        if let Some(g) = s("goal") {
            self.goal = Some(g);
        }
        if let Some(st) = s("status") {
            self.progress.status = Some(st);
        }
        if let Some(sum) = s("summary") {
            self.progress.summary = Some(sum);
        }
        if let Some(steps) = input.get("steps").and_then(Value::as_array) {
            let parsed: Vec<_> = steps
                .iter()
                .filter_map(|st| {
                    let text = st.get("text").and_then(Value::as_str)?.to_string();
                    let state = match st.get("status").and_then(Value::as_str) {
                        Some("completed") => StepState::Done,
                        Some("in_progress") => StepState::Doing,
                        _ => StepState::Todo,
                    };
                    Some((state, text))
                })
                .collect();
            self.set_steps(&parsed);
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
        if let Some(first) = text.lines().next().and_then(|l| l.strip_prefix("Session ")) {
            let name = first.split(" [").next().unwrap_or("").trim();
            if !name.is_empty() && !name.contains(char::is_whitespace) {
                self.name = Some(name.to_string());
            }
        }
        let mut steps = Vec::new();
        let mut in_steps = false;
        for line in text.lines() {
            if let Some(g) = line.strip_prefix("Goal: ") {
                self.goal = meaningful(g);
                in_steps = false;
            } else if let Some(st) = line.strip_prefix("Status: ") {
                let (status, summary) = match st.split_once(" — ") {
                    Some((a, b)) => (a, Some(b)),
                    None => (st, None),
                };
                self.progress.status = meaningful(status);
                self.progress.summary = summary.and_then(meaningful);
                in_steps = false;
            } else if line.starts_with("Steps:") {
                in_steps = true;
            } else if in_steps {
                let item = line.trim_start();
                let (state, rest) = if let Some(r) = item.strip_prefix("- [x] ") {
                    (StepState::Done, r)
                } else if let Some(r) = item.strip_prefix("- [>] ") {
                    (StepState::Doing, r)
                } else if let Some(r) = item.strip_prefix("- [ ] ") {
                    (StepState::Todo, r)
                } else {
                    in_steps = false;
                    continue;
                };
                steps.push((state, rest.to_string()));
            } else if line.ends_with(':') {
                in_steps = false;
            }
        }
        self.set_steps(&steps);
        true
    }
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
\\1 operator [Ops] Re-grant Accessibility\n\
Steps:\n\
- [x] Harness adapters\n\
- [x] Build and install\n\
- [>] Codex: review + squash-merge #243\n\
- [ ] Follow-up";

    #[test]
    fn parses_printed_map() {
        let mut m = SessionMap::default();
        assert!(m.apply_result(RESULT));
        assert_eq!(m.name.as_deref(), Some("s-agent-control-panel"));
        assert_eq!(m.goal.as_deref(), Some("Agent panel supports any harness"));
        assert_eq!(m.progress.status.as_deref(), Some("active"));
        assert_eq!(
            m.progress.summary.as_deref(),
            Some("Codex run 2 in progress")
        );
        assert_eq!(
            m.progress.current_step.as_deref(),
            Some("Codex: review + squash-merge #243")
        );
        assert_eq!((m.progress.steps_done, m.progress.steps_total), (2, 4));
        assert!(!m.apply_result("plain tool output"));
    }

    #[test]
    fn folds_input_deltas() {
        let mut m = SessionMap::default();
        m.apply_input(&json!({"goal": "Ship the parser", "status": "active"}));
        m.apply_input(&json!({"summary": "tests green", "steps": [
            {"text": "write tests", "status": "completed"},
            {"text": "refactor", "status": "pending"}
        ]}));
        assert_eq!(m.goal.as_deref(), Some("Ship the parser"));
        assert_eq!(m.progress.summary.as_deref(), Some("tests green"));
        assert_eq!(m.progress.current_step.as_deref(), Some("refactor"));
        assert_eq!((m.progress.steps_done, m.progress.steps_total), (1, 2));
        assert!(m.seen());
    }

    #[test]
    fn status_without_summary_and_empty_goal() {
        let mut m = SessionMap::default();
        assert!(m.apply_result("Session s-x [r · main]\nGoal: (none)\nStatus: blocked"));
        assert_eq!(m.goal, None);
        assert_eq!(m.progress.status.as_deref(), Some("blocked"));
        assert_eq!(m.progress.summary, None);
        assert_eq!(m.progress.steps_total, 0);
    }
}

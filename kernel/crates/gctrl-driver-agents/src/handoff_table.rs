//! The hand-off table of an agent's final reply, in the harness convention
//! the session-map mod reads:
//!
//! ```text
//! | \ | Who | Type | Action | Why |
//! | --- | --- | --- | --- | --- |
//! | \1 | 🙋🏻‍♂️ operator | ✍️ [SignOff] | Approve the migration | Blocks the deploy |
//! | → | 🤖 codex | 📋 [Task] | Fix the lipo step | Release build fails |
//! ```
//!
//! The last such table outside a code fence is the reply's table. A row
//! without a known type or an action is skipped.

use crate::model::MapHandoff;
use crate::text::clip;

/// Cells of one table row; `\|` is a literal pipe.
fn cells(line: &str) -> Option<Vec<String>> {
    let t = line.trim();
    let inner = t.strip_prefix('|')?;
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                cur.push('|');
                chars.next();
            }
            '|' => out.push(std::mem::take(&mut cur).trim().to_string()),
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    Some(out)
}

fn is_header(c: &[String]) -> bool {
    let names: Vec<String> = c.iter().map(|x| x.to_ascii_lowercase()).collect();
    names.len() >= 4
        && names[1] == "who"
        && names[2] == "type"
        && names[3] == "action"
        && matches!(names[0].as_str(), "\\" | "" | "#")
}

fn is_separator(c: &[String]) -> bool {
    !c.is_empty()
        && c.iter()
            .all(|x| !x.is_empty() && x.chars().all(|ch| matches!(ch, '-' | ':' | ' ')))
}

fn kind(cell: &str) -> Option<&'static str> {
    let l = cell.to_ascii_lowercase();
    if l.contains("signoff") || l.contains("sign-off") || l.contains("sign off") {
        Some("signoff")
    } else if l.contains("[ops]") || l.split_whitespace().any(|w| w == "ops") {
        Some("ops")
    } else if l.contains("[task]") || l.split_whitespace().any(|w| w == "task") {
        Some("task")
    } else {
        None
    }
}

/// `operator` from `🙋🏻‍♂️ operator`, `s-deploy` from `🤖 s-deploy`.
fn who(cell: &str) -> String {
    cell.trim_start_matches(|c: char| !c.is_alphanumeric())
        .trim_end_matches(|c: char| c == '`' || c.is_whitespace())
        .to_string()
}

fn row(c: &[String]) -> Option<MapHandoff> {
    let action = c.get(3).map(|a| clip(a, 300)).filter(|a| !a.is_empty())?;
    let who = who(c.get(1)?);
    if who.is_empty() {
        return None;
    }
    Some(MapHandoff {
        n: c[0].strip_prefix('\\').and_then(|n| n.parse().ok()),
        kind: kind(c.get(2)?)?.into(),
        who: clip(&who, 80),
        action,
        why: c.get(4).map(|w| clip(w, 300)).filter(|w| !w.is_empty()),
        pinned: false,
    })
}

/// The rows of the last hand-off table in `reply`, or `None` when the reply
/// has no hand-off table.
pub fn parse(reply: &str) -> Option<Vec<MapHandoff>> {
    let mut last = None;
    let mut fenced = false;
    let mut lines = reply.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced || !cells(line).is_some_and(|c| is_header(&c)) {
            continue;
        }
        if !lines
            .peek()
            .and_then(|l| cells(l))
            .is_some_and(|c| is_separator(&c))
        {
            continue;
        }
        lines.next();
        let mut rows = Vec::new();
        while let Some(c) = lines.peek().and_then(|l| cells(l)) {
            lines.next();
            rows.extend(row(&c));
        }
        last = Some(rows);
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPLY: &str = "Done.\n\n### 📄 Deliverables\n- PR\n\n\
| \\ | Who | Type | Action | Why |\n\
| --- | --- | --- | --- | --- |\n\
| \\1 | 🙋🏻‍♂️ operator | 🔧 [Ops] | Re-grant Accessibility | Each swap resets it |\n\
| \\2 | 🙋🏻‍♂️ operator | ✍️ [SignOff] | Approve `a \\| b` | |\n\
| → | 🤖 codex | 📋 [Task] | Fix `lipo` | Release build fails |\n\
| → | 🤖 codex | 🎲 [Chat] | dropped | unknown type |\n\
\nTrailing text.";

    #[test]
    fn reads_the_reply_table() {
        let rows = parse(REPLY).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            (rows[0].n, rows[0].who.as_str(), rows[0].kind.as_str()),
            (Some(1), "operator", "ops")
        );
        assert_eq!(rows[0].why.as_deref(), Some("Each swap resets it"));
        assert_eq!(rows[1].action, "Approve `a | b`");
        assert_eq!(rows[1].why, None);
        assert_eq!(
            (rows[2].n, rows[2].who.as_str(), rows[2].kind.as_str()),
            (None, "codex", "task")
        );
    }

    #[test]
    fn last_table_wins_and_fences_are_skipped() {
        let reply = format!(
            "{REPLY}\n\n```md\n| \\ | Who | Type | Action | Why |\n| --- | --- | --- | --- | --- |\n| \\1 | x | [Ops] | example | |\n```\n\n\
| \\ | Who | Type | Action | Why |\n|---|---|---|---|---|\n| \\1 | 🙋🏻‍♂️ operator | ✍️ [SignOff] | Merge #247 | |\n"
        );
        let rows = parse(&reply).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].action, "Merge #247");
    }

    #[test]
    fn no_table_is_none() {
        assert_eq!(parse("All done, nothing left."), None);
        assert_eq!(parse("| a | b |\n| --- | --- |\n| 1 | 2 |"), None);
        let empty = "| \\ | Who | Type | Action | Why |\n| --- | --- | --- | --- | --- |\n";
        assert_eq!(parse(empty), Some(vec![]));
    }
}

//! Small text helpers shared by the harness readers.

use regex::Regex;
use std::sync::OnceLock;

/// Cut `s` to at most `max` characters, appending `…` when cut. Newlines
/// collapse to spaces so a card line stays one line.
pub fn clip(s: &str, max: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

pub fn is_uuid(s: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
            .expect("valid regex")
    })
    .is_match(s)
}

/// First uuid-shaped token in `s`, if any.
pub fn find_uuid(s: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
            .expect("valid regex")
    })
    .find(s)
    .map(|m| m.as_str().to_ascii_lowercase())
}

/// A user message worth showing: not empty, and not harness-injected
/// context (`<command-name>`, `<environment_context>`, AGENTS.md preamble,
/// messages relayed from another agent session).
pub fn is_human_prompt(s: &str) -> bool {
    let t = s.trim_start();
    !t.is_empty()
        && !t.starts_with('<')
        && !t.starts_with("# AGENTS.md instructions")
        && !t.starts_with("Another Claude session sent a message")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_short_text() {
        assert_eq!(clip("fix  the\nbug", 20), "fix the bug");
    }

    #[test]
    fn clip_cuts_long_text_with_ellipsis() {
        assert_eq!(clip("abcdefghij", 5), "abcd…");
    }

    #[test]
    fn uuid_checks() {
        assert!(is_uuid("26e3373e-8358-416b-83f3-355a59325193"));
        assert!(!is_uuid("26e3373e-8358-416b-83f3"));
        assert_eq!(
            find_uuid("codex --no-daemon resume 01A04C15-4628-7913-BD1D-21ED78284C55 x"),
            Some("01a04c15-4628-7913-bd1d-21ed78284c55".into())
        );
        assert_eq!(find_uuid("codex"), None);
    }

    #[test]
    fn human_prompt_filter() {
        assert!(is_human_prompt("fix the bug"));
        assert!(!is_human_prompt("<command-name>/clear</command-name>"));
        assert!(!is_human_prompt("  <environment_context>"));
        assert!(!is_human_prompt("# AGENTS.md instructions\n..."));
        assert!(!is_human_prompt("   "));
        assert!(!is_human_prompt("Another Claude session sent a message: <x>"));
    }
}

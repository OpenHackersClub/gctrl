//! Trailer-inference utilities for the Contributions tab.
//!
//! Operators don't want a new write path between agents and the kernel
//! for "this commit came from session X" — instead, agents append a
//! `Session-Id:` trailer to commits they author, and the Contributions
//! route extracts it at query time. See
//! `specs/architecture/apps/gctrl-analytics.md` Kernel Dependencies §4.

/// Extract the first `Session-Id: <uuid>` trailer from a commit
/// message body. Matches case-insensitively (git trailers are
/// canonically Title-Case but humans paste them lowercase). Trailer
/// matching is *line-anchored*: only lines that start with
/// `session-id:` (after optional leading whitespace) are considered, so
/// a session URL pasted in prose doesn't match.
///
/// Returns `None` when:
///   - no trailer is present
///   - the value is not a syntactically valid uuid v4-style hex (we
///     accept any 36-char hyphenated form to stay loss-tolerant; the
///     downstream join is the source of truth for "valid session")
///
/// Loss-tolerant by design — a malformed trailer surfaces as
/// "unattributed" upstream, never as an error. See spec §4.
pub fn parse_session_trailer(message: &str) -> Option<String> {
    for line in message.lines() {
        let trimmed = line.trim_start();
        // Trailer prefix is `Session-Id:` (case-insensitive).
        let lower = trimmed.to_ascii_lowercase();
        let Some(rest) = lower.strip_prefix("session-id:") else {
            continue;
        };
        // Use the *original* slice for the value so we preserve case.
        // `prefix_len` is byte-equal because `to_ascii_lowercase` only
        // shifts ASCII letters and the prefix is pure ASCII.
        let prefix_len = trimmed.len() - rest.len();
        let value = trimmed[prefix_len..].trim();
        if looks_like_uuid(value) {
            return Some(value.to_string());
        }
    }
    None
}

/// Lightweight uuid shape check: 36 chars, hyphens at the canonical
/// positions, all other chars hex. We don't care about the variant or
/// version bits — any uuid-shaped string is good enough; the kernel
/// session lookup decides if it actually exists.
fn looks_like_uuid(s: &str) -> bool {
    if s.len() != 36 {
        return false;
    }
    s.chars().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => c == '-',
        _ => c.is_ascii_hexdigit(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_UUID: &str = "11111111-2222-3333-4444-555555555555";

    #[test]
    fn extracts_canonical_trailer() {
        let msg = format!(
            "feat: add thing\n\nLong body here.\n\nSession-Id: {VALID_UUID}\nCo-Authored-By: noone\n",
        );
        assert_eq!(parse_session_trailer(&msg), Some(VALID_UUID.into()));
    }

    #[test]
    fn case_insensitive_prefix() {
        let msg = format!("subject\n\nsession-id: {VALID_UUID}\n");
        assert_eq!(parse_session_trailer(&msg), Some(VALID_UUID.into()));
    }

    #[test]
    fn no_trailer_returns_none() {
        let msg = "subject\n\nbody without any trailer\n";
        assert_eq!(parse_session_trailer(msg), None);
    }

    #[test]
    fn malformed_uuid_skipped() {
        let msg = "subject\n\nSession-Id: not-a-uuid\n";
        assert_eq!(parse_session_trailer(msg), None);
    }

    #[test]
    fn url_in_prose_does_not_match() {
        // Operator pastes a session URL inline; not a trailer.
        let msg = format!("subject\n\nsee https://example.com/sessions/{VALID_UUID} for context\n");
        assert_eq!(parse_session_trailer(&msg), None);
    }

    #[test]
    fn first_trailer_wins() {
        // If two trailers exist, prefer the first — matches the
        // ordering convention `git interpret-trailers` uses.
        let other = "99999999-8888-7777-6666-555555555555";
        let msg = format!(
            "subject\n\nSession-Id: {VALID_UUID}\nSession-Id: {other}\n",
        );
        assert_eq!(parse_session_trailer(&msg), Some(VALID_UUID.into()));
    }

    #[test]
    fn leading_whitespace_tolerated() {
        let msg = format!("subject\n\n   Session-Id: {VALID_UUID}\n");
        assert_eq!(parse_session_trailer(&msg), Some(VALID_UUID.into()));
    }
}

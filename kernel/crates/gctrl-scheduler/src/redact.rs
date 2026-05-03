//! Output redaction for `last_response` / `last_error` row caches and
//! `scheduler_runs.{response_preview, error_preview}` history rows.
//!
//! `target_kind: exec` schedules can have child stderr that includes
//! secret-shaped output if a misconfigured process echoes a token. We cap
//! the byte length elsewhere; this module is the *content* layer of
//! defence: pattern-match common credential shapes and replace the value
//! half with `[redacted]` before persisting.
//!
//! Spec: vault/specs/architecture/apps/gctrl-schedule.md § 5.1
//! and vault/specs/architecture/kernel/scheduler.md § Output Redaction.
//!
//! Best-effort, NOT a primary control. The primary control is "don't
//! echo secrets on child stderr". This catches the common shapes:
//!
//!   token=abc123      → token=[redacted]
//!   secret: foo       → secret: [redacted]
//!   webhook=https://… → webhook=[redacted]
//!   api-key=…         → api-key=[redacted]   (matches `key`)
//!
//! Idempotent: running twice produces the same string.

use once_cell::sync::Lazy;
use regex::Regex;

/// Match the common `keyword<sep>value` shape used in env / log lines /
/// command-line flags. The keyword is one of a fixed set; the separator is
/// `=` or `:` (with optional surrounding whitespace); the value is one
/// non-whitespace run.
///
/// Group 1 captures the keyword + separator (preserved); group 2 captures
/// the value (replaced).
static SECRET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(token|secret|key|password|webhook)(\s*[=:]\s*)(\S+)")
        .expect("static SECRET_RE pattern compiles")
});

/// Replace value half of `keyword=...` / `keyword: ...` matches with
/// `[redacted]`. Idempotent: a string that already contains `[redacted]`
/// where the value would be is left as-is on subsequent passes (the regex
/// would just match the `[redacted]` literal — fine, the result is
/// stable).
pub fn redact_secrets(s: &str) -> String {
    SECRET_RE.replace_all(s, "$1$2[redacted]").into_owned()
}

/// Redact AND truncate to `max_bytes` (UTF-8-safe). Keeps a marker so
/// operators see truncation happened. Used at storage write sites to keep
/// the row width bounded even when the redactor preserves length.
pub fn redact_and_truncate(s: &str, max_bytes: usize) -> String {
    let r = redact_secrets(s);
    if r.len() <= max_bytes {
        return r;
    }
    let mut end = max_bytes;
    while end > 0 && !r.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated {} bytes]", &r[..end], r.len() - end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_token_equals() {
        assert_eq!(redact_secrets("token=abc123"), "token=[redacted]");
    }

    #[test]
    fn redacts_token_colon_with_spaces() {
        assert_eq!(redact_secrets("token : abc123"), "token : [redacted]");
    }

    #[test]
    fn redacts_secret_colon() {
        assert_eq!(redact_secrets("secret: foo-bar-42"), "secret: [redacted]");
    }

    #[test]
    fn redacts_password_uppercase() {
        // Case-insensitive on the keyword.
        assert_eq!(redact_secrets("PASSWORD=hunter2"), "PASSWORD=[redacted]");
    }

    #[test]
    fn redacts_webhook_url() {
        assert_eq!(
            redact_secrets("webhook=https://hooks.slack.com/services/T00/B00/abc"),
            "webhook=[redacted]"
        );
    }

    #[test]
    fn redacts_api_key_via_key_keyword() {
        // The pattern matches `key` as a whole word. `api-key` is two
        // tokens separated by `-`; the second token IS `key`. The leading
        // `\b` anchors at the boundary between `-` and `key`.
        assert_eq!(redact_secrets("api-key=xyz"), "api-key=[redacted]");
    }

    #[test]
    fn does_not_match_unrelated_keywords() {
        assert_eq!(
            redact_secrets("user=alice host=example.com"),
            "user=alice host=example.com"
        );
    }

    #[test]
    fn redacts_multiple_in_one_string() {
        assert_eq!(
            redact_secrets("token=aaa secret=bbb other=keep"),
            "token=[redacted] secret=[redacted] other=keep"
        );
    }

    #[test]
    fn idempotent_on_already_redacted() {
        let once = redact_secrets("token=abc");
        let twice = redact_secrets(&once);
        // The regex re-matches `[redacted]` because `[redacted]` is one
        // non-whitespace run (it starts with `[` but `\S+` consumes it).
        // Substituting `[redacted]` → `[redacted]` leaves the string
        // unchanged. We assert the stable fixed point, not "no change".
        assert_eq!(once, twice);
    }

    #[test]
    fn empty_input_produces_empty() {
        assert_eq!(redact_secrets(""), "");
    }

    #[test]
    fn truncate_short_passthrough() {
        assert_eq!(redact_and_truncate("abc", 100), "abc");
    }

    #[test]
    fn truncate_long_appends_marker() {
        let s = "x".repeat(50);
        let t = redact_and_truncate(&s, 10);
        assert!(t.starts_with("xxxxxxxxxx"));
        assert!(t.contains("truncated"));
    }

    #[test]
    fn truncate_preserves_redaction() {
        // Long string with a secret; redaction MUST happen before
        // truncation so the secret isn't preserved past the cap. Real
        // child stderr always has a word-boundary before the keyword
        // (whitespace, punctuation, line start) — match that shape.
        let s = format!("{} token=secret_value", "x".repeat(100));
        let t = redact_and_truncate(&s, 1024);
        assert!(t.contains("[redacted]"), "{t}");
        assert!(!t.contains("secret_value"), "{t}");
    }

    #[test]
    fn redacts_value_with_special_chars() {
        // Slashes, equals, colons inside the value are part of the
        // non-whitespace run and are all redacted together.
        assert_eq!(
            redact_secrets("token=Bearer=abc:def/ghi"),
            "token=[redacted]"
        );
    }
}

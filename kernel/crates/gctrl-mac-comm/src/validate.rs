//! Per-field allowlist validators for `context.terminal` and `FocusRequest`
//! payloads.
//!
//! Single canonical validator. Called from BOTH:
//! - the comm endpoint handler (`/api/comm/focus`)
//! - the inbox-message intake handler (when accepting `context.terminal`)
//!
//! No field validated here is allowed to flow into an `osascript` invocation
//! before passing the corresponding regex. The intent is defense-in-depth
//! against AppleScript injection — even a hypothetical bug in the URL handler
//! or the inbox intake cannot reach the adapters with a hostile string.

use crate::error::CommError;
use crate::model::{FocusRequest, TerminalApp, TerminalContext};
use regex::Regex;
use std::sync::OnceLock;

macro_rules! lazy_regex {
    ($name:ident, $pattern:expr) => {
        fn $name() -> &'static Regex {
            static CACHED: OnceLock<Regex> = OnceLock::new();
            CACHED.get_or_init(|| Regex::new($pattern).expect("compile-time-valid regex"))
        }
    };
}

// iTerm2 session IDs come in the form `w<window>t<tab>p<pane>:<UUIDv4>`.
// All three index positions are present; the UUID has the canonical
// `8-4-4-4-12` hex grouping. Constraining to this exact shape (rather than
// a generic alnum allowlist) shrinks the attack surface to zero printable
// characters that AppleScript treats as syntactically meaningful.
lazy_regex!(
    re_iterm2_session,
    r"^w[0-9]{1,4}t[0-9]{1,4}p[0-9]{1,4}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
);

// Other terminals get a looser but still strict allowlist. Excludes
// quotes, backslashes, whitespace, and AppleScript metacharacters.
lazy_regex!(re_generic_session, r"^[A-Za-z0-9_:.-]{1,64}$");

// Apple Terminal window/tab indices.
lazy_regex!(re_index, r"^[0-9]{1,4}$");

// `tty(1)` output: /dev/ttysNN or /dev/ptyXX
lazy_regex!(re_tty, r"^/dev/(tty|pty)[a-z0-9]{1,8}$");

// Absolute POSIX path. Conservative allowlist of characters real-world
// agent working directories actually contain (letters, digits, common
// separators, parens, brackets, plus a handful of safe punctuation).
// Excludes shell metacharacters (`"`, `'`, `\`, `;`, `$`, backtick, `*`,
// `?`) and AppleScript string-literal terminators. The rare path containing
// these would still reach the kernel as a 400 — a deliberate trade for
// defense-in-depth even when adapters parameterize correctly. Length
// capped at 512 to bound osascript argv size.
lazy_regex!(
    re_cwd,
    r"^/[A-Za-z0-9._/() \[\]+,&@!~=#:-]{0,512}$"
);

// Bundle ID: reverse-DNS. Real-world Apple bundle IDs do contain mixed case
// (e.g. `com.apple.Terminal`, `com.microsoft.VSCode`, `dev.warp.Warp-Stable`),
// so the second-and-after characters allow upper-case.
lazy_regex!(re_bundle_id, r"^[a-z][a-zA-Z0-9.-]{2,63}$");

// term_program / term_program_version: short alnum-with-spaces label.
lazy_regex!(re_term_program, r"^[A-Za-z0-9 ._-]{1,64}$");

/// Validate a session ID against the discriminator-specific regex.
pub fn session_id(target: TerminalApp, value: &str) -> Result<(), CommError> {
    let (re, pattern): (&Regex, &'static str) = match target {
        TerminalApp::Iterm2 => (
            re_iterm2_session(),
            r"w[0-9]+t[0-9]+p[0-9]+:<UUIDv4>",
        ),
        TerminalApp::Unknown => {
            return Err(CommError::Validation {
                field: "session_id",
                pattern: "(no validator for unknown target)",
            });
        }
        _ => (re_generic_session(), r"[A-Za-z0-9_:.-]{1,64}"),
    };
    if re.is_match(value) {
        Ok(())
    } else {
        Err(CommError::Validation {
            field: "session_id",
            pattern,
        })
    }
}

pub fn window_or_tab_index(field: &'static str, value: &str) -> Result<(), CommError> {
    if re_index().is_match(value) {
        Ok(())
    } else {
        Err(CommError::Validation {
            field,
            pattern: r"[0-9]{1,4}",
        })
    }
}

pub fn tty(value: &str) -> Result<(), CommError> {
    if re_tty().is_match(value) {
        Ok(())
    } else {
        Err(CommError::Validation {
            field: "tty",
            pattern: r"/dev/(tty|pty)[a-z0-9]{1,8}",
        })
    }
}

pub fn cwd(value: &str) -> Result<(), CommError> {
    if re_cwd().is_match(value) {
        Ok(())
    } else {
        Err(CommError::Validation {
            field: "cwd",
            pattern: r"/[A-Za-z0-9._/() \[\]+,&@!~=#:-]{0,512}",
        })
    }
}

pub fn bundle_id(value: &str) -> Result<(), CommError> {
    if re_bundle_id().is_match(value) {
        Ok(())
    } else {
        Err(CommError::Validation {
            field: "bundle_id",
            pattern: r"[a-z][a-zA-Z0-9.-]{2,63}",
        })
    }
}

pub fn term_program(field: &'static str, value: &str) -> Result<(), CommError> {
    if re_term_program().is_match(value) {
        Ok(())
    } else {
        Err(CommError::Validation {
            field,
            pattern: r"[A-Za-z0-9 ._-]{1,64}",
        })
    }
}

/// Validate a complete `FocusRequest`. Order matters — fields with broader
/// reach are checked first so the error tells the caller the most fundamental
/// problem.
pub fn focus_request(req: &FocusRequest) -> Result<(), CommError> {
    if matches!(req.target, TerminalApp::Unknown) {
        return Err(CommError::UnknownTarget("unknown".into()));
    }
    if let Some(sid) = req.session_id.as_deref() {
        session_id(req.target, sid)?;
    }
    if let Some(w) = req.window_id.as_deref() {
        window_or_tab_index("window_id", w)?;
    }
    if let Some(t) = req.tab_id.as_deref() {
        window_or_tab_index("tab_id", t)?;
    }
    if let Some(c) = req.cwd.as_deref() {
        cwd(c)?;
    }
    Ok(())
}

/// Validate a complete `TerminalContext`. Used by the inbox intake handler
/// when accepting messages with `context.terminal`. Returns the first error
/// encountered.
pub fn terminal_context(ctx: &TerminalContext) -> Result<(), CommError> {
    if let Some(b) = ctx.bundle_id.as_deref() {
        bundle_id(b)?;
    }
    if let Some(sid) = ctx.session_id.as_deref() {
        session_id(ctx.app, sid)?;
    }
    if let Some(w) = ctx.window_id.as_deref() {
        window_or_tab_index("window_id", w)?;
    }
    if let Some(t) = ctx.tab_id.as_deref() {
        window_or_tab_index("tab_id", t)?;
    }
    if let Some(t) = ctx.tty.as_deref() {
        tty(t)?;
    }
    if let Some(c) = ctx.cwd.as_deref() {
        cwd(c)?;
    }
    if let Some(s) = ctx.term_program.as_deref() {
        term_program("term_program", s)?;
    }
    if let Some(s) = ctx.term_program_version.as_deref() {
        term_program("term_program_version", s)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iterm2_session_id_accepts_real_shape() {
        assert!(session_id(
            TerminalApp::Iterm2,
            "w0t0p0:6F3D8E7C-1234-4ABC-9876-FEDCBA098765"
        )
        .is_ok());
    }

    #[test]
    fn iterm2_session_id_rejects_quote_injection() {
        let evil = r#"w0t0p0:X" & do shell script "rm -rf /""#;
        assert!(session_id(TerminalApp::Iterm2, evil).is_err());
    }

    #[test]
    fn iterm2_session_id_rejects_newline() {
        assert!(session_id(TerminalApp::Iterm2, "w0t0p0:abc\nXYZ").is_err());
    }

    #[test]
    fn cwd_rejects_quote() {
        assert!(cwd(r#"/foo"; do shell script "evil""#).is_err());
    }

    #[test]
    fn cwd_rejects_newline() {
        assert!(cwd("/foo\nbar").is_err());
    }

    #[test]
    fn cwd_accepts_normal_path() {
        assert!(cwd("/Users/v/workspaces/ohc/gctrl").is_ok());
    }

    #[test]
    fn cwd_rejects_relative() {
        assert!(cwd("Users/v/workspaces").is_err());
    }

    #[test]
    fn cwd_rejects_too_long() {
        let long = format!("/{}", "a".repeat(513));
        assert!(cwd(&long).is_err());
    }

    #[test]
    fn tty_accepts_ttys() {
        assert!(tty("/dev/ttys003").is_ok());
        assert!(tty("/dev/ttys123").is_ok());
    }

    #[test]
    fn tty_rejects_absolute_other_path() {
        assert!(tty("/etc/passwd").is_err());
    }

    #[test]
    fn window_index_accepts_small() {
        assert!(window_or_tab_index("window_id", "1").is_ok());
        assert!(window_or_tab_index("window_id", "9999").is_ok());
    }

    #[test]
    fn window_index_rejects_letters() {
        assert!(window_or_tab_index("window_id", "1a").is_err());
    }

    #[test]
    fn focus_request_unknown_target_rejected() {
        let req = FocusRequest {
            target: TerminalApp::Unknown,
            session_id: None,
            window_id: None,
            tab_id: None,
            cwd: None,
            origin_remote: false,
        };
        assert!(matches!(
            focus_request(&req),
            Err(CommError::UnknownTarget(_))
        ));
    }

    #[test]
    fn focus_request_iterm2_happy_path() {
        let req = FocusRequest {
            target: TerminalApp::Iterm2,
            session_id: Some("w0t0p0:6F3D8E7C-1234-4ABC-9876-FEDCBA098765".into()),
            window_id: None,
            tab_id: None,
            cwd: Some("/Users/v/code".into()),
            origin_remote: false,
        };
        assert!(focus_request(&req).is_ok());
    }

    #[test]
    fn focus_request_terminal_indices() {
        let req = FocusRequest {
            target: TerminalApp::Terminal,
            session_id: None,
            window_id: Some("1".into()),
            tab_id: Some("3".into()),
            cwd: None,
            origin_remote: false,
        };
        assert!(focus_request(&req).is_ok());
    }

    #[test]
    fn bundle_id_accepts_real_world_ids() {
        assert!(bundle_id("com.googlecode.iterm2").is_ok());
        assert!(bundle_id("com.apple.Terminal").is_ok());
        assert!(bundle_id("com.microsoft.VSCode").is_ok());
        assert!(bundle_id("dev.warp.Warp-Stable").is_ok());
    }

    #[test]
    fn bundle_id_rejects_evil() {
        assert!(bundle_id("com.apple.Terminal'; do shell script \"evil\"").is_err());
        assert!(bundle_id("Com.apple.Terminal").is_err()); // must start lowercase
        assert!(bundle_id("ab").is_err()); // too short
    }

    #[test]
    fn term_program_accepts_real_values() {
        assert!(term_program("term_program", "iTerm.app").is_ok());
        assert!(term_program("term_program", "Apple_Terminal").is_ok());
        assert!(term_program("term_program_version", "3.5.0").is_ok());
    }
}

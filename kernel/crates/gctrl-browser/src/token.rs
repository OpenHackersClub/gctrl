use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// Per-session bearer token for the CDP attach WebSocket. Stored in-memory
/// only — never persisted to DuckDB. Treated as opaque; clients pass it
/// either as `?token=...` on the URL or as `Authorization: Bearer ...`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Token(pub String);

impl Token {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Mint a fresh URL-safe token: 32 random bytes from the OS CSPRNG,
/// base64url-no-pad encoded (43 chars).
pub fn mint_token() -> Token {
    let mut bytes = [0u8; 32];
    // Failure here means the OS CSPRNG is unavailable — the kernel can't
    // do anything useful anyway, so panic is the honest outcome.
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable");
    Token(URL_SAFE_NO_PAD.encode(bytes))
}

/// Constant-time-ish equality. The token check happens once per WS
/// upgrade, so timing matters less than for password verification, but
/// we still avoid early-return on first byte mismatch.
pub fn verify(actual: &str, expected: &str) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (a, b) in actual.bytes().zip(expected.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_and_url_safe() {
        let a = mint_token();
        let b = mint_token();
        assert_ne!(a, b);
        assert_eq!(a.as_str().len(), 43);
        assert!(a
            .as_str()
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn verify_detects_match_and_mismatch() {
        let t = mint_token();
        assert!(verify(t.as_str(), t.as_str()));
        assert!(!verify(t.as_str(), &format!("{}x", t.as_str())));
        assert!(!verify("", t.as_str()));
    }
}

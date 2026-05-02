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

/// Mint a fresh URL-safe token. Uses UUIDv4 in PR1; PR2 will replace this
/// with 32 bytes from `getrandom` encoded as URL-safe base64. The kind is
/// captured in this single function so the upgrade is one edit.
pub fn mint_token() -> Token {
    Token(uuid::Uuid::new_v4().simple().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique() {
        let a = mint_token();
        let b = mint_token();
        assert_ne!(a, b);
        assert!(!a.as_str().is_empty());
    }
}

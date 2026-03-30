use thiserror::Error;

#[derive(Debug, Error)]
pub enum GctlError {
    #[error("storage error: {0}")]
    Storage(String),

    #[error("config error: {0}")]
    Config(String),

    #[error("otel receiver error: {0}")]
    OtelReceiver(String),

    #[error("proxy error: {0}")]
    Proxy(String),

    #[error("guardrail violation: {0}")]
    GuardrailViolation(String),

    #[error("sync error: {0}")]
    Sync(String),

    #[error("context error: {0}")]
    Context(String),

    #[error("query error: {0}")]
    Query(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type Result<T> = std::result::Result<T, GctlError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display() {
        let err = GctlError::Storage("disk full".into());
        assert_eq!(err.to_string(), "storage error: disk full");
    }

    #[test]
    fn error_not_found() {
        let err = GctlError::NotFound("session abc".into());
        assert!(err.to_string().contains("not found"));
    }
}

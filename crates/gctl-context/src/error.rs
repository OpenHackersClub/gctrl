use thiserror::Error;

#[derive(Debug, Error)]
pub enum ContextError {
    #[error("entry not found: {0}")]
    NotFound(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("database error: {0}")]
    Database(String),

    #[error("invalid kind: {0}")]
    InvalidKind(String),

    #[error("serialization error: {0}")]
    Serialization(String),
}

impl From<duckdb::Error> for ContextError {
    fn from(e: duckdb::Error) -> Self {
        ContextError::Database(e.to_string())
    }
}

impl From<serde_json::Error> for ContextError {
    fn from(e: serde_json::Error) -> Self {
        ContextError::Serialization(e.to_string())
    }
}

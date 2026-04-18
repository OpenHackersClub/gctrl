#[derive(Debug, thiserror::Error)]
pub enum NetError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("URL parse error: {0}")]
    UrlParse(#[from] url::ParseError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("no content extracted from {url}")]
    EmptyContent { url: String },

    #[error("page below word threshold ({word_count} < {min_words}): {url}")]
    BelowThreshold {
        url: String,
        word_count: usize,
        min_words: usize,
    },

    #[error("domain not found in store: {0}")]
    DomainNotFound(String),

    #[error("missing API key for {provider}")]
    MissingApiKey { provider: &'static str },

    #[error("{provider} backend error ({status}): {body}")]
    BackendError {
        provider: &'static str,
        status: u16,
        body: String,
    },

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

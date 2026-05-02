use thiserror::Error;

#[derive(Debug, Error)]
pub enum GcalError {
    #[error("missing credential: {0}")]
    MissingCredential(&'static str),

    #[error("oauth refresh failed: {0}")]
    OauthRefresh(String),

    #[error("calendar api error ({status}): {body}")]
    Api { status: u16, body: String },

    #[error("http transport error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("response parse error: {0}")]
    Parse(String),
}

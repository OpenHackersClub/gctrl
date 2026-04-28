//! gctrl-proxy — agent-traffic capture for the kernel.
//!
//! Two complementary capture surfaces share this crate:
//!
//! - **MITM proxy** (`mod ca`, `mod handler`, `mod redact`, [`run`]) —
//!   intercepts arbitrary HTTP/HTTPS traffic via `hudsucker` + a self-signed
//!   CA, and persists each completed request as a `TrafficRecord` in the
//!   kernel `traffic` table. Engine-only; lifecycle (`gctrld serve --proxy`)
//!   lives in `gctrl-cli`.
//!
//! - **LLM relay** (`mod relay`, `mod capture`) — single-route HTTP
//!   forward proxy for OpenAI-compat `/v1/chat/completions`. Captures
//!   request + response bodies into `prompt_bodies` and emits an OTLP
//!   span to the kernel's own `/v1/traces` endpoint. Used today by the
//!   opencode + LMStudio path; agnostic to any specific client.
//!
//! Spec: vault/specs/implementation/opencode-integration.md (LLM relay).

mod ca;
mod handler;
mod redact;

pub mod capture;
pub mod relay;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use gctrl_core::ProxyConfig;
use gctrl_storage::DuckDbStore;
use hudsucker::{
    certificate_authority::RcgenAuthority,
    rcgen::{Issuer, KeyPair},
    rustls::crypto::aws_lc_rs,
    Proxy,
};

pub use ca::{ensure_ca_cert, CaPaths};
pub use capture::{Capture, CaptureConfig, CapturedTurn};
pub use handler::TrafficLogger;
pub use redact::redact_url;
pub use relay::{LlmRelay, RelayConfig};

/// Run the MITM proxy until shutdown.
///
/// Binds `config.listen_host:config.listen_port`. Defaults to `127.0.0.1:8080`.
/// Captured requests are written into `store`'s `traffic` table.
pub async fn run(store: Arc<DuckDbStore>, config: ProxyConfig) -> Result<()> {
    let CaPaths {
        cert_path,
        key_path,
    } = ensure_ca_cert(&ProxyConfig::ca_dir())?;

    let key_pem = std::fs::read_to_string(&key_path)
        .with_context(|| format!("read CA key {}", key_path.display()))?;
    let cert_pem = std::fs::read_to_string(&cert_path)
        .with_context(|| format!("read CA cert {}", cert_path.display()))?;

    let key_pair = KeyPair::from_pem(&key_pem).context("parse CA key")?;
    let issuer = Issuer::from_ca_cert_pem(&cert_pem, key_pair).context("parse CA cert")?;

    let authority = RcgenAuthority::new(issuer, 1_000, aws_lc_rs::default_provider());

    let host: std::net::IpAddr = config
        .listen_host
        .parse()
        .with_context(|| format!("parse proxy host {}", config.listen_host))?;
    let addr = SocketAddr::from((host, config.listen_port));

    let handler = TrafficLogger::new(store, config.redact_query_params.clone());

    let proxy = Proxy::builder()
        .with_addr(addr)
        .with_ca(authority)
        .with_rustls_connector(aws_lc_rs::default_provider())
        .with_http_handler(handler)
        .build()
        .context("build proxy")?;

    tracing::info!("gctrl proxy listening on http://{addr}");
    tracing::info!("CA cert: {}", cert_path.display());

    proxy.start().await.context("proxy start")?;
    Ok(())
}

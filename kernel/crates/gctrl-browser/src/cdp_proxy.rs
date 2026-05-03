//! WebSocket proxy: client ⇆ kernel ⇆ Chromium.
//!
//! The kernel does not parse CDP frames — it just relays text/binary
//! frames bidirectionally and taps each text frame into a `broadcast`
//! channel that the recorder (PR3) subscribes to. The broadcast channel
//! is bounded; when the recorder lags, oldest frames are dropped via
//! tokio's built-in `RecvError::Lagged`.

use axum::extract::ws::{Message as AxumMsg, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message as TungMsg;
use tracing::{debug, warn};

use crate::error::BrowserError;

/// One CDP message as it crosses the proxy. `direction` lets the recorder
/// distinguish client→browser commands from browser→client events.
#[derive(Debug, Clone)]
pub struct CdpFrame {
    pub direction: FrameDirection,
    /// JSON text payload. Binary CDP frames are not fanned out (rare in
    /// CDP — usually screenshots when explicitly enabled, fetched via
    /// dedicated routes by the recorder).
    pub payload: String,
    pub ts: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameDirection {
    ClientToBrowser,
    BrowserToClient,
}

/// Capacity of the per-session frame broadcast channel.
pub const FRAME_TAP_CAPACITY: usize = 1024;

/// Run the bidirectional proxy until either side closes. Tap each text
/// frame onto `tap`. The proxy never blocks on `tap.send` — broadcast
/// channels drop oldest frames automatically when full and surface that
/// to subscribers via `RecvError::Lagged`.
pub async fn run_proxy(
    client: WebSocket,
    upstream_url: String,
    tap: broadcast::Sender<CdpFrame>,
) -> Result<(), BrowserError> {
    let (upstream_ws, _) = tokio_tungstenite::connect_async(&upstream_url)
        .await
        .map_err(|e| BrowserError::Cdp(format!("connect upstream: {e}")))?;

    let (mut client_tx, mut client_rx) = client.split();
    let (mut up_tx, mut up_rx) = upstream_ws.split();

    loop {
        tokio::select! {
            // Client → Browser
            msg = client_rx.next() => match msg {
                Some(Ok(AxumMsg::Text(text))) => {
                    let s = text.to_string();
                    if let Err(e) = up_tx.send(TungMsg::Text(s.clone().into())).await {
                        warn!(error=%e, "proxy: upstream send failed");
                        break;
                    }
                    let _ = tap.send(CdpFrame {
                        direction: FrameDirection::ClientToBrowser,
                        payload: s,
                        ts: chrono::Utc::now(),
                    });
                }
                Some(Ok(AxumMsg::Binary(bin))) => {
                    if let Err(e) = up_tx.send(TungMsg::Binary(bin.into())).await {
                        warn!(error=%e, "proxy: upstream send failed");
                        break;
                    }
                }
                Some(Ok(AxumMsg::Ping(p))) => {
                    let _ = up_tx.send(TungMsg::Ping(p.into())).await;
                }
                Some(Ok(AxumMsg::Pong(_))) => {}
                Some(Ok(AxumMsg::Close(_))) | None => {
                    debug!("proxy: client closed");
                    let _ = up_tx.send(TungMsg::Close(None)).await;
                    break;
                }
                Some(Err(e)) => {
                    warn!(error=%e, "proxy: client recv error");
                    break;
                }
            },
            // Browser → Client
            msg = up_rx.next() => match msg {
                Some(Ok(TungMsg::Text(text))) => {
                    let s = text.to_string();
                    if let Err(e) = client_tx.send(AxumMsg::Text(s.clone().into())).await {
                        warn!(error=%e, "proxy: client send failed");
                        break;
                    }
                    let _ = tap.send(CdpFrame {
                        direction: FrameDirection::BrowserToClient,
                        payload: s,
                        ts: chrono::Utc::now(),
                    });
                }
                Some(Ok(TungMsg::Binary(bin))) => {
                    if let Err(e) = client_tx.send(AxumMsg::Binary(bin.into())).await {
                        warn!(error=%e, "proxy: client send failed");
                        break;
                    }
                }
                Some(Ok(TungMsg::Ping(p))) => {
                    let _ = client_tx.send(AxumMsg::Ping(p.into())).await;
                }
                Some(Ok(TungMsg::Pong(_))) | Some(Ok(TungMsg::Frame(_))) => {}
                Some(Ok(TungMsg::Close(_))) | None => {
                    debug!("proxy: upstream closed");
                    let _ = client_tx.send(AxumMsg::Close(None)).await;
                    break;
                }
                Some(Err(e)) => {
                    warn!(error=%e, "proxy: upstream recv error");
                    break;
                }
            },
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::net::SocketAddr;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    /// Spawn a tiny echo WebSocket server. Returns its `ws://` URL and a
    /// JoinHandle that can be aborted to shut it down. Used to test the
    /// proxy without a real Chromium.
    pub async fn spawn_echo_ws() -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let url = format!("ws://{addr}/echo");
        let handle = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Ok(ws) = accept_async(stream).await else {
                        return;
                    };
                    let (mut tx, mut rx) = ws.split();
                    while let Some(Ok(msg)) = rx.next().await {
                        match msg {
                            TungMsg::Text(t) => {
                                let _ = tx.send(TungMsg::Text(t)).await;
                            }
                            TungMsg::Close(_) => break,
                            _ => {}
                        }
                    }
                });
            }
        });
        (url, handle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_direction_compiles() {
        let _ = FrameDirection::ClientToBrowser;
        assert_eq!(FRAME_TAP_CAPACITY, 1024);
    }
}

//! Live acceptance gate: run with GCTRL_BROWSER_CHROMIUM_PATH and --ignored.
use axum::{routing::get, Router};
use futures_util::{SinkExt, StreamExt};
use gctrl_browser::{BrowserConfig, Launcher, Pool, RealLauncher, SessionOptions};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

struct OverrideGuard;
impl Drop for OverrideGuard {
    fn drop(&mut self) {
        gctrl_otel::browser_routes::clear_test_state();
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn command(
    ws: &mut Socket,
    id: u64,
    method: &str,
    params: Value,
    session: Option<&str>,
) -> Value {
    let mut request = json!({"id":id,"method":method,"params":params});
    if let Some(session) = session {
        request["sessionId"] = json!(session);
    }
    ws.send(Message::Text(request.to_string())).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let frame = ws.next().await.unwrap().unwrap();
            if let Message::Text(text) = frame {
                let reply: Value = serde_json::from_str(&text).unwrap();
                if reply["id"] == id {
                    assert!(reply.get("error").is_none(), "{reply}");
                    return reply["result"].clone();
                }
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "requires a real Chromium; mandatory computer-use live acceptance gate"]
async fn separate_browser_identities_do_not_share_cookies_or_storage() {
    let cfg = Arc::new(BrowserConfig {
        recycle_idle_seconds: 0,
        ..BrowserConfig::default().with_env_overrides()
    });
    let launcher = Arc::new(RealLauncher::new(cfg.chromium_path.clone(), false).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let pool = Arc::new(Pool::new(cfg, launcher.clone(), format!("ws://{addr}")));
    gctrl_otel::browser_routes::install_test_state(Arc::clone(&pool));
    let _override_guard = OverrideGuard;
    let app = Router::new()
        .route(
            "/identity",
            get(|| async { axum::response::Html("<html>identity</html>") }),
        )
        .merge(gctrl_otel::browser_routes::router::<()>())
        .merge(gctrl_otel::recorder_routes::router::<()>());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let a = pool.acquire(SessionOptions::default()).await.unwrap();
    let b = pool.acquire(SessionOptions::default()).await.unwrap();
    assert_ne!(a.browser_context_id, b.browser_context_id);
    let (mut wa, _) = connect_async(&a.cdp_endpoint).await.unwrap();
    let (mut wb, _) = connect_async(&b.cdp_endpoint).await.unwrap();
    let url = format!("http://{addr}/identity");
    let ta = command(&mut wa, 1, "Target.createTarget", json!({"url":url}), None).await;
    let tb = command(&mut wb, 1, "Target.createTarget", json!({"url":url}), None).await;
    let sa = command(
        &mut wa,
        2,
        "Target.attachToTarget",
        json!({"targetId":ta["targetId"],"flatten":true}),
        None,
    )
    .await;
    let sb = command(
        &mut wb,
        2,
        "Target.attachToTarget",
        json!({"targetId":tb["targetId"],"flatten":true}),
        None,
    )
    .await;
    command(
        &mut wa,
        3,
        "Page.enable",
        json!({}),
        sa["sessionId"].as_str(),
    )
    .await;
    command(
        &mut wb,
        3,
        "Page.enable",
        json!({}),
        sb["sessionId"].as_str(),
    )
    .await;
    command(
        &mut wa,
        4,
        "Page.navigate",
        json!({"url":url}),
        sa["sessionId"].as_str(),
    )
    .await;
    command(
        &mut wb,
        4,
        "Page.navigate",
        json!({"url":url}),
        sb["sessionId"].as_str(),
    )
    .await;
    // Await a real committed document rather than a fixed sleep.
    for (ws, s) in [
        (&mut wa, sa["sessionId"].as_str().unwrap()),
        (&mut wb, sb["sessionId"].as_str().unwrap()),
    ] {
        for id in 5..100 {
            let r = command(
                ws,
                id,
                "Runtime.evaluate",
                json!({"expression":"location.href","returnByValue":true}),
                Some(s),
            )
            .await;
            if r["result"]["value"] == url {
                break;
            }
            tokio::task::yield_now().await;
            assert!(id < 99, "page did not commit");
        }
    }
    command(&mut wa,100,"Runtime.evaluate",json!({"expression":"document.cookie='identity=alice;path=/';localStorage.setItem('identity','alice')"}),sa["sessionId"].as_str()).await;
    let seen=command(&mut wb,100,"Runtime.evaluate",json!({"expression":"JSON.stringify({cookie:document.cookie,storage:localStorage.getItem('identity')})","returnByValue":true}),sb["sessionId"].as_str()).await;
    let seen: Value = serde_json::from_str(seen["result"]["value"].as_str().unwrap()).unwrap();
    // Discovery cannot reveal the other identity's targets.
    let targets = command(&mut wb, 101, "Target.getTargets", json!({}), None).await;
    assert!(targets["targetInfos"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["targetId"] != ta["targetId"]));
    wb.send(Message::Text(json!({"id":102,"method":"Target.attachToTarget","params":{"targetId":ta["targetId"],"flatten":true}}).to_string())).await.unwrap();
    let refused = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Message::Text(text) = wb.next().await.unwrap().unwrap() {
                let reply: Value = serde_json::from_str(&text).unwrap();
                if reply["id"] == 102 {
                    break reply;
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(
        refused.get("error").is_some(),
        "cross-identity attach succeeded: {refused}"
    );
    pool.release(&a.id).await.unwrap();
    // Release fences existing CDP sockets, not only new token checks.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match wa.next().await {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                _ => {}
            }
        }
    })
    .await
    .expect("release left an active CDP connection");
    // The sibling's context remains usable after the first is disposed.
    let still = command(
        &mut wb,
        103,
        "Runtime.evaluate",
        json!({"expression":"localStorage.getItem('identity')","returnByValue":true}),
        sb["sessionId"].as_str(),
    )
    .await;
    assert_eq!(still["result"]["value"], Value::Null);
    pool.release(&b.id).await.unwrap();
    let node = std::env::var("GCTRL_LIVE_NODE").unwrap_or_else(|_| "node".into());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::process::Command::new(node)
            .arg("kernel/crates/gctrl-otel/tests/fixtures/browser_identity.mjs")
            .current_dir(root)
            .env("GCTRL_LIVE_BROWSER_URL", format!("http://{addr}"))
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("Playwright timed out")
    .unwrap();
    assert!(
        output.status.success(),
        "Playwright failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert_eq!(pool.active_count().await, 0);
    let upstream = launcher.launch().await.unwrap();
    launcher.kill(&upstream.id).await.unwrap();
    launcher.kill(&upstream.id).await.unwrap();
    assert!(
        connect_async(&upstream.browser_ws_url).await.is_err(),
        "confirmed exit left the CDP server alive"
    );
    assert_eq!(pool.sweep().await.killed, 1);
    assert_eq!(pool.chromium_count().await, 0);
    server.abort();
    assert_eq!(
        seen,
        json!({"cookie":"","storage":null}),
        "browser sessions leaked identity state"
    );
}

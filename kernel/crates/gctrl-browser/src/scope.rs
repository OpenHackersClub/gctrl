//! A browser session owns one real storage context. CDP is confined to that
//! context, including flattened target sessions, events, and recorder frames.
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use axum::extract::ws::{CloseFrame, Message as ClientMessage, WebSocket};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch};
use tokio_tungstenite::tungstenite::Message;

use crate::{BrowserError, CdpFrame, FrameDirection};

#[derive(Debug, Clone)]
pub(crate) struct ContextScope {
    pub(crate) context_id: String,
    pub(crate) alive: Arc<AtomicBool>,
    pub(crate) revoke: watch::Sender<bool>,
}
impl ContextScope {
    pub(crate) fn new(context_id: String) -> Self {
        Self {
            context_id,
            alive: Arc::new(AtomicBool::new(true)),
            revoke: watch::channel(false).0,
        }
    }
}

/// Validated kernel-side attachment. The upstream URL never goes to clients.
#[derive(Debug)]
pub struct ScopedAttachment {
    pub(crate) endpoint: String,
    pub(crate) scope: ContextScope,
    pub(crate) tap: broadcast::Sender<CdpFrame>,
    pub(crate) revoked: watch::Receiver<bool>,
    pub(crate) expires_at: DateTime<Utc>,
}

struct Pending {
    method: String,
}
struct ProtocolScope {
    context: ContextScope,
    targets: HashSet<String>,
    sessions: HashSet<String>,
    browser_sessions: HashSet<String>,
    windows: HashSet<u64>,
    pending: HashMap<u64, Pending>,
    context_claimed: bool,
}

enum Request {
    Forward(Value),
    Reply(Value),
}
impl ProtocolScope {
    fn new(context: ContextScope) -> Self {
        Self {
            context,
            targets: HashSet::new(),
            sessions: HashSet::new(),
            browser_sessions: HashSet::new(),
            windows: HashSet::new(),
            pending: HashMap::new(),
            context_claimed: false,
        }
    }
    fn error(id: Value, message: &str) -> Request {
        Request::Reply(json!({"id":id,"error":{"code":-32000,"message":message}}))
    }
    fn request(&mut self, request: Value) -> Request {
        let session = request.get("sessionId").cloned();
        match self.request_inner(request) {
            Request::Reply(mut reply) => {
                if let Some(session) = session {
                    reply["sessionId"] = session;
                }
                Request::Reply(reply)
            }
            forward => forward,
        }
    }
    fn request_inner(&mut self, mut request: Value) -> Request {
        let id = request["id"].clone();
        let Some(number) = id.as_u64() else {
            return Self::error(id, "CDP request id must be a nonnegative integer");
        };
        if self.pending.contains_key(&number) {
            return Self::error(id, "CDP request id is already in flight");
        }
        let Some(method) = request["method"].as_str().map(str::to_owned) else {
            return Self::error(id, "CDP method is required");
        };
        let nested = request.get("sessionId").is_some();
        let page_scoped = request["sessionId"]
            .as_str()
            .is_some_and(|s| self.sessions.contains(s));
        if nested
            && !request["sessionId"]
                .as_str()
                .is_some_and(|s| self.sessions.contains(s) || self.browser_sessions.contains(s))
        {
            return Self::error(id, "CDP target session is outside this browser identity");
        }
        if request.get("params").is_none() {
            request["params"] = json!({});
        }
        if !request["params"].is_object() {
            return Self::error(id, "CDP params must be an object");
        }
        let params = &mut request["params"];
        if let Some(context) = params.get("browserContextId").and_then(Value::as_str) {
            if context != self.context.context_id {
                return Self::error(id, "browser context is outside this identity");
            }
        }
        match method.as_str() {
            // Playwright's page CDPSessions use an additional browser-level
            // transport session. It gets the root allowlist, never page powers.
            "Target.attachToBrowserTarget" if !page_scoped => {}
            "Target.createBrowserContext" => {
                // One gctrl identity is one context. Expose the managed context
                // to CDP clients (including browser.newContext()), never allocate
                // an untracked context or impersonate the shared default profile.
                if self.context_claimed {
                    return Self::error(
                        id,
                        "acquire another gctrl browser session for another context",
                    );
                }
                if params
                    .as_object()
                    .is_some_and(|p| p.keys().any(|k| k != "disposeOnDetach"))
                {
                    return Self::error(
                        id,
                        "context proxy/security options must be configured by the kernel",
                    );
                }
                self.context_claimed = true;
                return Request::Reply(
                    json!({"id":id,"result":{"browserContextId":self.context.context_id}}),
                );
            }
            "Target.getBrowserContexts" => {
                return Request::Reply(
                    json!({"id":id,"result":{"browserContextIds":[self.context.context_id]}}),
                )
            }
            "Target.getTargetInfo" if !page_scoped && params.get("targetId").is_none() => {
                return Request::Reply(
                    json!({"id":id,"result":{"targetInfo":{"targetId":format!("gctrl:{}",self.context.context_id),
                    "type":"browser","title":"gctrl browser identity","url":"","attached":true}}}),
                );
            }
            "Target.createTarget"
            | "Target.disposeBrowserContext"
            | "Browser.grantPermissions"
            | "Browser.resetPermissions"
            | "Browser.setPermission"
            | "Browser.setDownloadBehavior"
            | "Storage.getCookies"
            | "Storage.setCookies"
            | "Storage.clearCookies" => {
                params["browserContextId"] = json!(self.context.context_id);
            }
            "Target.attachToTarget"
            | "Target.closeTarget"
            | "Target.activateTarget"
            | "Target.getTargetInfo"
            | "Target.autoAttachRelated"
            | "Browser.getWindowForTarget" => {
                if page_scoped
                    && params.get("targetId").is_none()
                    && matches!(
                        method.as_str(),
                        "Browser.getWindowForTarget" | "Target.getTargetInfo"
                    )
                {
                    // Chromium resolves the omitted target from the validated
                    // flattened session; Playwright uses this for viewport setup.
                } else if !params["targetId"]
                    .as_str()
                    .is_some_and(|t| self.targets.contains(t))
                {
                    return Self::error(
                        id,
                        "target is outside this browser identity; discover its targets first",
                    );
                }
            }
            "Target.detachFromTarget" => {
                if !params["sessionId"]
                    .as_str()
                    .is_some_and(|s| self.sessions.contains(s) || self.browser_sessions.contains(s))
                {
                    return Self::error(id, "target session is outside this browser identity");
                }
            }
            "Browser.getWindowBounds" | "Browser.setWindowBounds" => {
                if !params["windowId"]
                    .as_u64()
                    .is_some_and(|w| self.windows.contains(&w))
                {
                    return Self::error(id, "window is outside this browser identity");
                }
            }
            "Target.setAutoAttach" => {
                if params["flatten"] != true {
                    return Self::error(id, "only flattened CDP target sessions are supported");
                }
                // Browser-level auto-attach sees other contexts. Never pause their
                // pages; their events and sessions are rejected below. Nested
                // auto-attach is confined to an already-owned page/worker.
                if !page_scoped {
                    params["waitForDebuggerOnStart"] = json!(false);
                }
            }
            "Target.getTargets" | "Target.setDiscoverTargets" | "Browser.getVersion" => {}
            _ => {
                let domain = method.split('.').next().unwrap_or("");
                if !page_scoped
                    || !matches!(
                        domain,
                        "Page"
                            | "Runtime"
                            | "DOM"
                            | "DOMSnapshot"
                            | "Accessibility"
                            | "Input"
                            | "Network"
                            | "Fetch"
                            | "Emulation"
                            | "Performance"
                            | "Log"
                            | "CSS"
                            | "Debugger"
                            | "Profiler"
                            | "HeapProfiler"
                            | "Animation"
                            | "Overlay"
                            | "Audits"
                            | "Security"
                    )
                {
                    return Self::error(
                        id,
                        "browser-wide or unscoped CDP command is not permitted",
                    );
                }
            }
        }
        self.pending.insert(number, Pending { method });
        Request::Forward(request)
    }
    fn owns_info(&self, info: &Value) -> bool {
        info["browserContextId"].as_str() == Some(&self.context.context_id)
    }
    fn incoming(&mut self, mut frame: Value) -> Option<Value> {
        if let Some(id) = frame["id"].as_u64() {
            let pending = self.pending.remove(&id)?;
            if frame.get("error").is_some() {
                return Some(frame);
            }
            let result = &mut frame["result"];
            match pending.method.as_str() {
                "Target.getTargets" => {
                    let infos = result["targetInfos"]
                        .as_array()?
                        .iter()
                        .filter(|i| self.owns_info(i))
                        .cloned()
                        .collect::<Vec<_>>();
                    for info in &infos {
                        if let Some(t) = info["targetId"].as_str() {
                            self.targets.insert(t.into());
                        }
                    }
                    result["targetInfos"] = json!(infos);
                }
                "Target.createTarget" => {
                    if let Some(t) = result["targetId"].as_str() {
                        self.targets.insert(t.into());
                    }
                }
                "Target.attachToBrowserTarget" => {
                    if let Some(s) = result["sessionId"].as_str() {
                        self.browser_sessions.insert(s.into());
                    }
                }
                "Target.attachToTarget" => {
                    if let Some(s) = result["sessionId"].as_str() {
                        self.sessions.insert(s.into());
                    }
                }
                "Browser.getWindowForTarget" => {
                    if let Some(w) = result["windowId"].as_u64() {
                        self.windows.insert(w);
                    }
                }
                "Target.disposeBrowserContext" => {
                    self.context.alive.store(false, Ordering::SeqCst);
                    self.context.revoke.send_replace(true);
                }
                _ => {}
            }
            return Some(frame);
        }
        let nested = frame.get("sessionId").is_some();
        let parent_owned = frame["sessionId"]
            .as_str()
            .is_some_and(|s| self.sessions.contains(s));
        let parent_browser = frame["sessionId"]
            .as_str()
            .is_some_and(|s| self.browser_sessions.contains(s));
        if nested && !parent_owned && !parent_browser {
            return None;
        }
        match frame["method"].as_str()? {
            "Target.attachedToTarget" => {
                let info = &frame["params"]["targetInfo"];
                if info.get("browserContextId").is_some() {
                    if !self.owns_info(info) {
                        return None;
                    }
                } else if !parent_owned {
                    // Only a child of an owned page can inherit its context
                    // when Chromium omits that field (e.g. a worker target).
                    return None;
                }
                if let Some(s) = frame["params"]["sessionId"].as_str() {
                    self.sessions.insert(s.into());
                }
                if let Some(t) = info["targetId"].as_str() {
                    self.targets.insert(t.into());
                }
            }
            "Target.targetCreated" | "Target.targetInfoChanged" => {
                let info = &frame["params"]["targetInfo"];
                if info.get("browserContextId").is_some() {
                    if !self.owns_info(info) {
                        return None;
                    }
                } else if !parent_owned {
                    // Only a child of an owned page can inherit its context
                    // when Chromium omits that field (e.g. a worker target).
                    return None;
                }
                if let Some(t) = info["targetId"].as_str() {
                    self.targets.insert(t.into());
                }
            }
            "Target.targetDestroyed" | "Target.targetCrashed" => {
                let target = frame["params"]["targetId"].as_str()?;
                if !self.targets.remove(target) {
                    return None;
                }
            }
            "Target.detachedFromTarget" => {
                let session = frame["params"]["sessionId"].as_str()?;
                if !self.sessions.remove(session) && !self.browser_sessions.remove(session) {
                    return None;
                }
            }
            _ if !parent_owned => return None,
            _ => {}
        }
        Some(frame)
    }
}

/// Relay CDP only within the identity's context and lifetime. Revocation closes
/// existing sockets as well as rejecting new attachments; recorder taps receive
/// only validated commands and filtered replies/events for this identity.
pub async fn run_scoped_proxy(
    client: WebSocket,
    mut attachment: ScopedAttachment,
) -> Result<(), BrowserError> {
    let (upstream, _) = tokio_tungstenite::connect_async(&attachment.endpoint)
        .await
        .map_err(|e| BrowserError::Cdp(format!("connect scoped upstream: {e}")))?;
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    let duration = (attachment.expires_at - Utc::now())
        .to_std()
        .unwrap_or_default();
    let expiry = tokio::time::sleep(duration);
    tokio::pin!(expiry);
    let mut protocol = ProtocolScope::new(attachment.scope.clone());
    loop {
        if *attachment.revoked.borrow() || !attachment.scope.alive.load(Ordering::SeqCst) {
            break;
        }
        tokio::select! {
            biased;
            _=attachment.revoked.changed()=>break,
            _=&mut expiry=>break,
            frame=client_rx.next()=> match frame {
                Some(Ok(ClientMessage::Text(text)))=> {
                    if *attachment.revoked.borrow() || !attachment.scope.alive.load(Ordering::SeqCst) { break; }
                    let request:Value=serde_json::from_str(&text).map_err(|_| BrowserError::Cdp("invalid CDP JSON".into()))?;
                    match protocol.request(request) {
                        Request::Reply(reply)=> { client_tx.send(ClientMessage::Text(reply.to_string().into())).await
                            .map_err(|e| BrowserError::Cdp(format!("send scoped error: {e}")))?; }
                        Request::Forward(request)=> {
                            let payload=request.to_string();
                            upstream_tx.send(Message::Text(payload.clone())).await.map_err(|e| BrowserError::Cdp(format!("send scoped request: {e}")))?;
                            let _=attachment.tap.send(CdpFrame {direction:FrameDirection::ClientToBrowser,payload,ts:Utc::now()});
                        }
                    }
                }
                Some(Ok(ClientMessage::Ping(p)))=> { let _=client_tx.send(ClientMessage::Pong(p)).await; }
                Some(Ok(ClientMessage::Pong(_)))=>{}
                // CDP is JSON text. Opaque binary payloads cannot bypass scope.
                Some(Ok(ClientMessage::Binary(_)))=>break,
                _=>break,
            },
            frame=upstream_rx.next()=> match frame {
                Some(Ok(Message::Text(text)))=> {
                    let frame:Value=serde_json::from_str(&text).map_err(|_| BrowserError::Cdp("invalid upstream CDP JSON".into()))?;
                    if let Some(frame)=protocol.incoming(frame) {
                        let payload=frame.to_string();
                        client_tx.send(ClientMessage::Text(payload.clone().into())).await.map_err(|e| BrowserError::Cdp(format!("send scoped frame: {e}")))?;
                        let _=attachment.tap.send(CdpFrame {direction:FrameDirection::BrowserToClient,payload,ts:Utc::now()});
                    }
                }
                Some(Ok(Message::Ping(p)))=> { let _=upstream_tx.send(Message::Pong(p)).await; }
                Some(Ok(Message::Pong(_)))=>{}
                _=>break,
            }
        }
    }
    let _ = client_tx
        .send(ClientMessage::Close(Some(CloseFrame {
            code: 4001,
            reason: "browser_session_ended".into(),
        })))
        .await;
    let _ = upstream_tx.send(Message::Close(None)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope() -> ProtocolScope {
        ProtocolScope::new(ContextScope::new("owned".into()))
    }
    fn forwarded(r: Request) -> Value {
        match r {
            Request::Forward(v) => v,
            Request::Reply(v) => panic!("unexpected reply: {v}"),
        }
    }
    fn rejected(r: Request) {
        match r {
            Request::Reply(v) => assert!(v.get("error").is_some(), "{v}"),
            Request::Forward(v) => panic!("unscoped command forwarded: {v}"),
        }
    }

    #[test]
    fn create_target_and_storage_are_bound_to_owned_context() {
        let mut s = scope();
        let request = forwarded(s.request(
            json!({"id":1,"method":"Target.createTarget","params":{"url":"about:blank"}}),
        ));
        assert_eq!(request["params"]["browserContextId"], "owned");
        rejected(s.request(
            json!({"id":2,"method":"Storage.getCookies","params":{"browserContextId":"foreign"}}),
        ));
    }
    #[test]
    fn foreign_targets_sessions_and_browser_wide_commands_are_rejected() {
        let mut s = scope();
        for request in [
            json!({"id":1,"method":"Target.attachToTarget","params":{"targetId":"foreign"}}),
            json!({"id":2,"method":"Runtime.evaluate","sessionId":"foreign","params":{"expression":"document.cookie"}}),
            json!({"id":3,"method":"Browser.close"}),
            json!({"id":4,"method":"Tracing.start"}),
            json!({"id":5,"method":"Target.sendMessageToTarget"}),
            json!({"id":6,"method":"Runtime.evaluate"}),
        ] {
            rejected(s.request(request));
        }
    }
    #[test]
    fn discovery_and_recording_drop_foreign_identity_metadata() {
        let mut s = scope();
        forwarded(s.request(json!({"id":1,"method":"Target.getTargets"})));
        let result=s.incoming(json!({"id":1,"result":{"targetInfos":[
            {"targetId":"a","browserContextId":"owned"},{"targetId":"b","browserContextId":"foreign","url":"private"}]}})).unwrap();
        assert_eq!(result["result"]["targetInfos"].as_array().unwrap().len(), 1);
        assert!(s.incoming(json!({"method":"Target.attachedToTarget","params":{"sessionId":"foreign-session","targetInfo":{"targetId":"b","browserContextId":"foreign"}}})).is_none());
        assert!(s.incoming(json!({"method":"Runtime.consoleAPICalled","sessionId":"foreign-session","params":{"text":"private"}})).is_none());
    }
    #[test]
    fn flattened_session_ownership_is_established_before_page_commands() {
        let mut s = scope();
        assert!(s.incoming(json!({"method":"Target.attachedToTarget","params":{"sessionId":"mine","targetInfo":{"targetId":"a","browserContextId":"owned"}}})).is_some());
        forwarded(s.request(json!({"id":1,"method":"Runtime.evaluate","sessionId":"mine","params":{"expression":"document.title"}})));
        rejected(s.request(json!({"id":2,"method":"Browser.close","sessionId":"mine"})));
    }
    #[test]
    fn root_auto_attach_cannot_pause_other_identities() {
        let mut s = scope();
        let request=forwarded(s.request(json!({"id":1,"method":"Target.setAutoAttach","params":{"autoAttach":true,"flatten":true,"waitForDebuggerOnStart":true}})));
        assert_eq!(request["params"]["waitForDebuggerOnStart"], false);
    }
    #[test]
    fn clients_cannot_create_untracked_contexts_or_reuse_inflight_ids() {
        let mut s = scope();
        if let Request::Reply(v)=s.request(json!({"id":1,"method":"Target.createBrowserContext","params":{"disposeOnDetach":true}})) {
            assert_eq!(v["result"]["browserContextId"],"owned");
        } else { panic!("unmanaged context allocation"); }
        rejected(s.request(json!({"id":2,"method":"Target.createBrowserContext"})));
        forwarded(s.request(json!({"id":3,"method":"Browser.getVersion"})));
        rejected(s.request(json!({"id":3,"method":"Browser.getVersion"})));
    }
    #[test]
    fn nested_errors_preserve_routing_and_implicit_target_is_session_scoped() {
        let mut s = scope();
        s.incoming(json!({"method":"Target.attachedToTarget","params":{"sessionId":"mine","targetInfo":{"targetId":"a","browserContextId":"owned"}}}));
        forwarded(
            s.request(json!({"id":1,"method":"Browser.getWindowForTarget","sessionId":"mine"})),
        );
        match s.request(json!({"id":2,"method":"Browser.close","sessionId":"mine"})) {
            Request::Reply(r) => {
                assert_eq!(r["sessionId"], "mine");
                assert!(r.get("error").is_some());
            }
            Request::Forward(_) => panic!("unscoped browser.close"),
        }
    }
    #[test]
    fn browser_level_attachments_remain_confined_to_the_identity() {
        let mut s = scope();
        forwarded(s.request(json!({"id":1,"method":"Target.attachToBrowserTarget"})));
        assert!(s
            .incoming(json!({"id":1,"result":{"sessionId":"browser-root"}}))
            .is_some());
        rejected(s.request(json!({"id":2,"method":"Browser.close","sessionId":"browser-root"})));
        rejected(s.request(json!({"id":3,"method":"Runtime.evaluate","sessionId":"browser-root"})));
        forwarded(
            s.request(json!({"id":4,"method":"Target.getTargets","sessionId":"browser-root"})),
        );
        let reply = s.incoming(json!({"id":4,"sessionId":"browser-root","result":{"targetInfos":[
            {"targetId":"mine","browserContextId":"owned"}, {"targetId":"foreign","browserContextId":"other"}]}})).unwrap();
        assert_eq!(reply["result"]["targetInfos"].as_array().unwrap().len(), 1);
        rejected(s.request(json!({"id":5,"method":"Target.attachToTarget","sessionId":"browser-root","params":{"targetId":"foreign","flatten":true}})));
        forwarded(s.request(json!({"id":6,"method":"Target.attachToTarget","sessionId":"browser-root","params":{"targetId":"mine","flatten":true}})));
        assert!(s.incoming(json!({"method":"Target.attachedToTarget","sessionId":"browser-root","params":{"sessionId":"mine-session","targetInfo":{"targetId":"mine","browserContextId":"owned"}}})).is_some());
        assert!(s.incoming(json!({"method":"Target.attachedToTarget","sessionId":"browser-root","params":{"sessionId":"foreign-session","targetInfo":{"targetId":"foreign","browserContextId":"other"}}})).is_none());
        assert!(s
            .incoming(json!({"method":"Runtime.consoleAPICalled","sessionId":"foreign-session"}))
            .is_none());
    }
    #[test]
    fn owned_parent_session_does_not_override_an_explicit_foreign_context() {
        let mut s = scope();
        s.sessions.insert("owned-parent".into());
        assert!(s.incoming(json!({"method":"Target.attachedToTarget","sessionId":"owned-parent","params":{
            "sessionId":"foreign-child","targetInfo":{"targetId":"foreign","browserContextId":"other"}}})).is_none());
        rejected(
            s.request(json!({"id":1,"method":"Runtime.evaluate","sessionId":"foreign-child"})),
        );
    }
}

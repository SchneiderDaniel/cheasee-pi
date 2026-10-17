//! Server-side relay: one pi child, many browser connections.
//!
//! [`Session`] owns the shared [`RpcClient`] and, per connection, [`relay`]
//! races the browser's commands with pi's event broadcast:
//!
//! * **Subscribe before send (AC1).** The broadcast receiver is created before
//!   any command is forwarded, so a completion that lands the instant the
//!   command is written is never missed (`docs/rpc.md`).
//! * **Translation.** A [`ClientMessage`] becomes a pi [`Command`]; the response
//!   is answered on the same connection as a [`ServerMessage::CommandResponse`].
//!   The browser's correlation id is *not* pi's `req_N` — the client stamps it.
//! * **Lag accounting.** [`tokio::sync::broadcast`] lag is lossy but not fatal:
//!   `RecvError::Lagged(n)` is surfaced as [`ServerMessage::Lagged`] and the
//!   receiver keeps going, rather than the read loop dying on the first drop.
//!
//! `Session` owns no pipes and no broadcast — [`RpcClient`] does. A second owner
//! would desync the id map.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::{broadcast, broadcast::error::RecvError, mpsc};

use crate::bridge::{ClientMessage, ServerMessage};
use crate::extension_ui::is_blocking;
use crate::protocol::{Command, Event, ExtensionUiRequest, ExtensionUiResponse, Response, ExtensionUI};
use crate::rpc::{ProtocolMessage, RpcClient, RpcError, RpcReplaySource};
use crate::sessions_store::{FileReplaySource, SessionsStore};
use crate::subscribe::{self, NoCursorStore, ReplayError};

/// The browser connection surface the relay drives.
///
/// `recv` yields the next client command (`None` = closed); `send_text` writes
/// one server frame. The transport half is `main::WsSink` (over the axum
/// WebSocket); a fake in tests drives both directions from channels.
pub trait ClientSink {
    fn send_text(
        &mut self,
        text: String,
    ) -> impl std::future::Future<Output = Result<(), ()>> + Send + '_;

    /// The next client frame: `Ok` a decoded command, `Err` a malformed frame
    /// the relay must surface to the browser, `None` a closed connection.
    fn recv(
        &mut self,
    ) -> impl std::future::Future<Output = Option<Result<ClientMessage, String>>> + Send + '_;
}

/// State shared by every connection bound to one pi session. Cheap to clone
/// behind an `Arc`; `client` is `None` for a child-less (file-replay) session
/// created after a `ui` restart (AC4).
pub struct Session {
    client: Option<Arc<RpcClient>>,
    /// The bootstrap child used for the local commands (`resume`/`switch_session`,
    /// `stop`) even when this connection's replay source is the file (AC4's
    /// child-less resume). For a live session it is the same as `client`.
    command_client: Option<Arc<RpcClient>>,
    /// The single blocking dialog currently awaiting an answer (AC2/AC3).
    /// Shared across browser connections so a reconnect re-shows it, and
    /// cleared when the answer is relayed.
    pending: Arc<Mutex<Option<ExtensionUiRequest>>>,
    /// Server-side session store. `None` in tests that exercise only the
    /// forwarding path; harness commands then surface as an error rather than a
    /// silent drop.
    store: Option<Arc<SessionsStore>>,
    /// pi's session id when known; the registry key for the live child.
    pi_session_id: String,
    /// The registry a connection consults to resolve `Subscribe`. `None` in
    /// tests that drive a single child directly.
    registry: Option<Arc<SessionRegistry>>,
    /// The live session this one was derived from, for a child-less replay
    /// binding. `None` for the live session itself.
    live: Option<Arc<Session>>,
}

impl Session {
    pub fn new(client: Arc<RpcClient>) -> Self {
        Self::with_store(client, None)
    }

    /// Build a relay that also handles the local session-harness commands
    /// (list/resume/stop) through `store`.
    pub fn with_store(client: Arc<RpcClient>, store: Option<Arc<SessionsStore>>) -> Self {
        Self {
            command_client: Some(Arc::clone(&client)),
            client: Some(client),
            pending: Arc::new(Mutex::new(None)),
            store,
            pi_session_id: String::new(),
            registry: None,
            live: None,
        }
    }

    /// The full server constructor: a live child, its pi session id, and the
    /// shared registry (AC1).
    pub fn live(
        client: Arc<RpcClient>,
        store: Arc<SessionsStore>,
        pi_session_id: String,
        registry: Arc<SessionRegistry>,
    ) -> Self {
        Self {
            command_client: Some(Arc::clone(&client)),
            client: Some(client),
            pending: Arc::new(Mutex::new(None)),
            store: Some(store),
            pi_session_id,
            registry: Some(registry),
            live: None,
        }
    }

    /// A child-less session: replay straight from the JSONL (AC4).
    pub fn detached(store: Arc<SessionsStore>, pi_session_id: String) -> Self {
        Self {
            client: None,
            command_client: None,
            pending: Arc::new(Mutex::new(None)),
            store: Some(store),
            pi_session_id,
            registry: None,
            live: None,
        }
    }

    /// Attach the registry a connection consults to resolve `Subscribe`.
    pub fn with_registry(mut self, registry: Arc<SessionRegistry>) -> Self {
        self.registry = Some(registry);
        self
    }

    /// The blocking request awaiting an answer, if any. `Some` survives
    /// unrelated events so a reconnect can re-show it (AC3).
    pub fn pending_dialog(&self) -> Option<ExtensionUiRequest> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Relay until the browser connection or the pi child goes away.
    pub async fn relay(self: &Arc<Self>, sink: impl ClientSink) {
        relay_session(self.clone(), sink).await;
    }
}

/// One live session: its pi session id, the synthetic marker used by
/// [`crate::pi_process::PidRegistry`], the shared [`Session`], and the child pid
/// the relay must never touch (AC5).
pub struct SessionHandle {
    pub pi_session_id: String,
    pub marker_id: String,
    pub session: Arc<Session>,
    pub child_pid: Option<u32>,
}

/// The per-session registry (AC1): pi session id → shared [`Session`]. Every
/// connection to a session shares one child and one pending dialog.
#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Arc<SessionHandle>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a session. Re-registering the same pi id replaces the handle;
    /// the caller owns any child lifecycle (this never kills).
    pub fn insert(&self, handle: Arc<SessionHandle>) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(handle.pi_session_id.clone(), handle);
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<SessionHandle>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned()
    }

    /// The pid of the child backing `session_id`, if any. Unchanged across a
    /// subscribe/unsubscribe/subscribe cycle (AC5).
    pub fn pid(&self, session_id: &str) -> Option<u32> {
        self.get(session_id).and_then(|handle| handle.child_pid)
    }

    pub fn len(&self) -> usize {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Any registered session, for a connection that has not subscribed yet.
    pub fn first(&self) -> Option<Arc<SessionHandle>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .next()
            .cloned()
    }

    /// Re-key the handle backing `session` under a new pi session id. Used after
    /// a successful `resume`/`switch_session`: the same child now owns the
    /// resumed session, so a subscribe with the resumed id must find it (AC1).
    /// Does nothing when no handle points at `session`.
    pub fn rekey(&self, session: &Arc<Session>, to_id: &str) {
        let mut map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let existing = map
            .values()
            .find(|handle| Arc::ptr_eq(&handle.session, session))
            .cloned();
        if let Some(handle) = existing {
            map.insert(
                to_id.to_string(),
                Arc::new(SessionHandle {
                    pi_session_id: to_id.to_string(),
                    marker_id: handle.marker_id.clone(),
                    session: Arc::clone(&handle.session),
                    child_pid: handle.child_pid,
                }),
            );
        }
    }
}

/// Relay `session` to one browser connection.
pub async fn relay(session: Arc<Session>, sink: impl ClientSink) {
    relay_session(session, sink).await;
}

/// One live-frame outcome, so the select arm stays flat.
enum EventOutcome {
    Message(ProtocolMessage),
    Lagged(u64),
    Closed,
}

/// Cap on the replay-boundary spool. It is a small reconciliation window, not a
/// queue: beyond it the durable log is the only safe recovery, so the spool is
/// dropped and the client is told to resync (ponytail: fixed cap, raise if a
/// legitimate replay window ever exceeds it).
const SPOOL_LIMIT: usize = 4096;

async fn next_event(events: &mut Option<broadcast::Receiver<ProtocolMessage>>) -> EventOutcome {
    match events
        .as_mut()
        .expect("guarded by the select precondition")
        .recv()
        .await
    {
        Ok(protocol) => EventOutcome::Message(protocol),
        Err(RecvError::Lagged(skipped)) => EventOutcome::Lagged(skipped),
        Err(RecvError::Closed) => EventOutcome::Closed,
    }
}

/// Resolve a subscribe target: a registered session (live), else a child-less
/// file-replay session (AC4), else an error the caller surfaces.
///
/// A detached target keeps the bootstrap child as its *command* client so a
/// following `ResumeSession` on the same connection still reaches pi (the
/// selected session can be resumed), and remembers the live session it was
/// derived from so the registry can be re-keyed after a successful switch.
fn resolve_subscription(active: &Arc<Session>, session_id: &str) -> Result<Arc<Session>, String> {
    if let Some(registry) = &active.registry {
        if let Some(handle) = registry.get(session_id) {
            return Ok(handle.session.clone());
        }
    }
    if active.pi_session_id == session_id {
        return Ok(active.clone());
    }
    if let Some(store) = &active.store {
        // Unknown ids still resolve to a detached source; its first replay
        // returns `NotFound`, surfaced by the caller as an error frame.
        let live = active
            .live
            .clone()
            .or_else(|| active.client.is_some().then(|| Arc::clone(active)));
        let mut detached = Session::detached(store.clone(), session_id.to_string());
        detached.registry = active.registry.clone();
        detached.command_client = active.command_client.clone();
        detached.live = live;
        return Ok(Arc::new(detached));
    }
    Err(format!("unknown session {session_id}"))
}

/// A completed subscribe computation, delivered back to the relay loop.
struct SubscribeResult {
    id: Option<String>,
    session_id: String,
    outcome: Result<subscribe::SubscribeOutcome, String>,
    pending: Option<ExtensionUiRequest>,
}

/// Run the subscribe use case for `session` — no sink, so it can run on its own
/// task while the relay keeps draining the live broadcast (AC2's boundary).
async fn compute_subscribe(
    session: &Arc<Session>,
    session_id: &str,
    since: Option<String>,
) -> Result<subscribe::SubscribeOutcome, String> {
    let no_cursor = NoCursorStore;
    let result = match (&session.client, &session.store) {
        (Some(client), Some(store)) => {
            let source = RpcReplaySource::new(client.clone());
            subscribe::subscribe(&source, store.as_ref(), session_id, since).await
        }
        (Some(client), None) => {
            let source = RpcReplaySource::new(client.clone());
            subscribe::subscribe(&source, &no_cursor, session_id, since).await
        }
        (None, Some(store)) => {
            let file = FileReplaySource::new(store.clone(), session_id);
            subscribe::subscribe(&file, &file, session_id, since).await
        }
        (None, None) => Err(ReplayError::Failed(format!(
            "session {session_id} has no replay source"
        ))),
    };
    result.map_err(|err| err.to_string())
}

/// A stable key for a replayed entry's message body, used to drop a live
/// `message_end` that the durable log already carried. Live pi events carry no
/// entry id, so the message content is the only stable key available.
fn message_fingerprint(message: &Value) -> Option<String> {
    serde_json::to_string(message).ok()
}

/// Whether a spooled live frame duplicates an entry already in the replay.
fn duplicates_replay(protocol: &ProtocolMessage, replayed: &HashSet<String>) -> bool {
    if replayed.is_empty() {
        return false;
    }
    match protocol {
        ProtocolMessage::Session(Event::MessageEnd { message }) => {
            message_fingerprint(message).is_some_and(|fp| replayed.contains(&fp))
        }
        _ => false,
    }
}

/// Emit the `SessionState` header and replay chunks for a completed subscribe,
/// then reconcile the frames spooled while the replay was in flight.
///
/// The header goes first, then `done:true` closes the boundary, and only then
/// does the spooled live tail drain — deduplicated against the replay (AC2).
async fn emit_replay(
    sink: &mut impl ClientSink,
    result: &SubscribeResult,
    pending: &Mutex<Option<ExtensionUiRequest>>,
    spool: &mut Vec<ProtocolMessage>,
) -> Result<(), ()> {
    let outcome = match &result.outcome {
        Ok(outcome) => outcome,
        Err(message) => {
            return send(
                sink,
                &ServerMessage::Error {
                    message: message.clone(),
                },
            )
            .await
        }
    };

    let header = ServerMessage::SessionState {
        id: result.id.clone(),
        session_id: result.session_id.clone(),
        live: outcome.live,
        leaf_id: outcome.leaf_id.clone(),
        state: outcome.state.clone(),
        pending: result.pending.clone(),
        last_assistant_text: outcome.last_assistant_text.clone(),
        cursor_invalid: outcome.cursor_invalid,
    };
    send(sink, &header).await?;

    for chunk in subscribe::chunk_replay(&outcome.entries) {
        let frame = ServerMessage::SessionReplay {
            id: result.id.clone(),
            session_id: result.session_id.clone(),
            entries: chunk.entries,
            done: chunk.done,
        };
        send(sink, &frame).await?;
    }

    if let Some(error) = &outcome.cursor_error {
        send(
            sink,
            &ServerMessage::Error {
                message: error.clone(),
            },
        )
        .await?;
    }

    let replayed: HashSet<String> = outcome
        .entries
        .iter()
        .filter_map(|entry| entry.get("message").and_then(message_fingerprint))
        .collect();
    for protocol in std::mem::take(spool) {
        if duplicates_replay(&protocol, &replayed) {
            continue;
        }
        if let Some(message) = to_server_message(protocol, pending) {
            send(sink, &message).await?;
        }
    }
    Ok(())
}

include!("session_part2.rs");
include!("session_part3.rs");
include!("session_part4.rs");

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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::{broadcast, broadcast::error::RecvError, mpsc};

use crate::bridge::{ClientMessage, ServerMessage};
use crate::extension_ui::is_blocking;
use crate::protocol::{Command, ExtensionUiRequest, ExtensionUiResponse, Response, ExtensionUI};
use crate::rpc::{ProtocolMessage, RpcClient, RpcError, RpcReplaySource};
use crate::sessions_store::{FileReplaySource, SessionsStore};
use crate::subscribe::{self, NoCursorStore};

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
}

impl Session {
    pub fn new(client: Arc<RpcClient>) -> Self {
        Self::with_store(client, None)
    }

    /// Build a relay that also handles the local session-harness commands
    /// (list/resume/stop) through `store`.
    pub fn with_store(client: Arc<RpcClient>, store: Option<Arc<SessionsStore>>) -> Self {
        Self {
            client: Some(client),
            pending: Arc::new(Mutex::new(None)),
            store,
            pi_session_id: String::new(),
            registry: None,
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
            client: Some(client),
            pending: Arc::new(Mutex::new(None)),
            store: Some(store),
            pi_session_id,
            registry: Some(registry),
        }
    }

    /// A child-less session: replay straight from the JSONL (AC4).
    pub fn detached(store: Arc<SessionsStore>, pi_session_id: String) -> Self {
        Self {
            client: None,
            pending: Arc::new(Mutex::new(None)),
            store: Some(store),
            pi_session_id,
            registry: None,
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
        let mut detached = Session::detached(store.clone(), session_id.to_string());
        detached.registry = active.registry.clone();
        return Ok(Arc::new(detached));
    }
    Err(format!("unknown session {session_id}"))
}

/// Run the subscribe use case and emit `SessionState` + replay chunks.
async fn run_subscribe(
    active: &Arc<Session>,
    session_id: &str,
    since: Option<String>,
    id: Option<String>,
    sink: &mut impl ClientSink,
) -> Result<(), String> {
    let no_cursor = NoCursorStore;
    let outcome = match (&active.client, &active.store) {
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
        (None, None) => return Err(format!("session {session_id} has no replay source")),
    }
    .map_err(|err| err.to_string())?;

    let header = ServerMessage::SessionState {
        id: id.clone(),
        session_id: session_id.to_string(),
        live: outcome.live,
        leaf_id: outcome.leaf_id,
        state: outcome.state,
        pending: active.pending_dialog(),
        last_assistant_text: outcome.last_assistant_text,
        cursor_invalid: outcome.cursor_invalid,
    };
    send(sink, &header).await.map_err(|_| "connection closed".to_string())?;

    for chunk in subscribe::chunk_replay(&outcome.entries) {
        let frame = ServerMessage::SessionReplay {
            id: id.clone(),
            session_id: session_id.to_string(),
            entries: chunk.entries,
            done: chunk.done,
        };
        send(sink, &frame)
            .await
            .map_err(|_| "connection closed".to_string())?;
    }
    Ok(())
}

async fn relay_session(session: Arc<Session>, mut sink: impl ClientSink) {
    let mut active = session;
    // AC1: subscribe to pi events *before* writing any command.
    let mut events = active.client.as_ref().map(|client| client.events());
    // Unsubscribe silences the live tail for this connection without dropping
    // the socket or touching the child (AC5).
    let mut subscribed = true;
    // Responses to forwarded commands are produced on spawned tasks and funnelled
    // back here, so a slow pi response never blocks the event stream.
    let (out_tx, mut out_rx) = mpsc::channel::<ServerMessage>(64);

    loop {
        tokio::select! {
            biased;
            command = sink.recv() => match command {
                Some(Ok(ClientMessage::Subscribe { id, session_id, since })) => {
                    match resolve_subscription(&active, &session_id) {
                        Ok(target) => {
                            if !Arc::ptr_eq(&active, &target) {
                                // Rebind the live tail *before* any replay so no
                                // event is lost between subscribe and replay (AC2).
                                events = target.client.as_ref().map(|client| client.events());
                            }
                            active = target;
                            subscribed = true;
                            if let Err(message) =
                                run_subscribe(&active, &session_id, since, id, &mut sink).await
                            {
                                if send(&mut sink, &ServerMessage::Error { message }).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(message) => {
                            let _ = out_tx.send(ServerMessage::Error { message }).await;
                        }
                    }
                }
                Some(Ok(ClientMessage::Unsubscribe { .. })) => subscribed = false,
                Some(Ok(ClientMessage::ExtensionUiResponse { id, value, confirmed, cancelled })) => {
                    respond_extension_ui(&active, &out_tx, id, value, confirmed, cancelled).await;
                }
                Some(Ok(command)) => {
                    if is_local_session_command(&command) {
                        match &active.store {
                            Some(store) => {
                                handle_local_session(store, active.client.as_ref(), &out_tx, command)
                                    .await
                            }
                            None => {
                                // The relay was built without a store (test
                                // harness); surface the miss, never drop it.
                                let _ = out_tx.send(ServerMessage::Error {
                                    message: "session store is not available".to_string(),
                                }).await;
                            }
                        }
                    } else if let Some(client) = &active.client {
                        forward(client, command, &out_tx);
                    } else {
                        let _ = out_tx.send(ServerMessage::Error {
                            message: "no pi child is running for this session".to_string(),
                        }).await;
                    }
                }
                // A frame the client could not have intended to be ignored: a
                // client-side encoding/version error must be visible, not a
                // silently dropped command.
                Some(Err(error)) => {
                    let message = ServerMessage::Error {
                        message: format!("malformed client frame: {error}"),
                    };
                    if send(&mut sink, &message).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            Some(message) = out_rx.recv() => {
                if send(&mut sink, &message).await.is_err() {
                    break;
                }
            }
            event = next_event(&mut events), if events.is_some() => match event {
                EventOutcome::Message(protocol) => {
                    if subscribed {
                        if let Some(message) = to_server_message(protocol, &active.pending) {
                            if send(&mut sink, &message).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                EventOutcome::Lagged(skipped) => {
                    if subscribed {
                        // Lossy, not fatal: the durable log heals the gap when
                        // the client re-subscribes with its last seen id (AC2).
                        let message = ServerMessage::Lagged { skipped, resync_required: true };
                        if send(&mut sink, &message).await.is_err() {
                            break;
                        }
                    }
                }
                EventOutcome::Closed => events = None,
            },
        }
    }
}

async fn send(sink: &mut impl ClientSink, message: &ServerMessage) -> Result<(), ()> {
    let text = serde_json::to_string(message).map_err(|_| ())?;
    sink.send_text(text).await
}

/// Whether `message` is handled by the local session store instead of being
/// forwarded to pi.
fn is_local_session_command(message: &ClientMessage) -> bool {
    matches!(
        message,
        ClientMessage::ListSessions { .. }
            | ClientMessage::ResumeSession { .. }
            | ClientMessage::StopSession { .. }
    )
}

/// Turn a browser resume request into the pi command to send. Resume resolves
/// and validates the session server-side; fork/clone branch non-destructively
/// (they need no guard).
async fn action_command(
    store: &SessionsStore,
    session_id: &str,
    mode: Option<&str>,
    entry_id: Option<String>,
) -> Result<Command, String> {
    match mode.unwrap_or("resume") {
        "resume" => store.resume(session_id).await,
        "fork" => entry_id
            .map(|entry_id| Command::Fork {
                id: None,
                entry_id,
            })
            .ok_or_else(|| "fork requires an entryId".to_string()),
        "clone" => Ok(Command::Clone { id: None }),
        other => Err(format!("unknown resume mode {other:?}")),
    }
}

/// Run one local session command and answer on the same connection. Never
/// forwards to pi: `ListSessions`/`StopSession` are pure harness commands, and
/// `ResumeSession` resolves the caller's id to a server-owned in-dir path first.
async fn handle_local_session(
    store: &SessionsStore,
    client: Option<&Arc<RpcClient>>,
    out: &mpsc::Sender<ServerMessage>,
    message: ClientMessage,
) {
    match message {
        ClientMessage::ListSessions { id } => {
            let sessions: Vec<crate::bridge::SessionRow> = match store.list().await {
                Ok(entries) => entries.iter().map(|entry| entry.to_row()).collect(),
                Err(message) => {
                    let _ = out.send(ServerMessage::Error { message }).await;
                    return;
                }
            };
            let _ = out.send(ServerMessage::SessionList { id, sessions }).await;
        }
        ClientMessage::ResumeSession {
            id,
            session_id,
            mode,
            entry_id,
        } => {
            let (success, error) =
                match action_command(store, &session_id, mode.as_deref(), entry_id).await {
                    Ok(command) => match client {
                        Some(client) => match client.send(&command).await {
                            Ok(()) => (true, None),
                            Err(err) => (false, Some(err.to_string())),
                        },
                        None => (false, Some("no pi child is running".to_string())),
                    },
                    Err(error) => (false, Some(error)),
                };
            let _ = out
                .send(ServerMessage::SessionAction {
                    id,
                    session_id,
                    success,
                    error,
                })
                .await;
        }
        ClientMessage::StopSession { id, session_id } => {
            // AC3 ordering: abort the running turn, then marker-kill the exact
            // child. The registry kill is scoped to this session id, so sibling
            // children survive.
            let abort = match client {
                Some(client) => client.send(&Command::Abort { id: None }).await,
                None => Err(RpcError::ChildGone),
            };
            let killed = store.registry().kill_one(&session_id);
            let (success, error) = match (abort, killed) {
                (Err(err), _) => (false, Some(err.to_string())),
                (Ok(()), true) => (true, None),
                (Ok(()), false) => (
                    false,
                    Some(format!("no live child for session {session_id}")),
                ),
            };
            let _ = out
                .send(ServerMessage::SessionAction {
                    id,
                    session_id,
                    success,
                    error,
                })
                .await;
        }
        // `is_local_session_command` only routes the three arms above.
        _ => {}
    }
}

/// Forward one browser command to pi and report its response back. The request
/// is spawned so a pending response never stalls the event stream.
fn forward(client: &Arc<RpcClient>, message: ClientMessage, out: &mpsc::Sender<ServerMessage>) {
    let Some(routed) = to_command(message) else {
        return;
    };
    let client = Arc::clone(client);
    let out = out.clone();
    tokio::spawn(async move {
        let response = match routed.wire_request(&client).await {
            Ok(response) => response,
            Err(err) => {
                let _ = out.send(ServerMessage::Error { message: err.to_string() }).await;
                return;
            }
        };
        let body = response.body();
        let _ = out
            .send(ServerMessage::CommandResponse {
                // The browser's correlation id, *not* pi's generated `req_N`:
                // the two id spaces stay decoupled, so a client that stamps an
                // id can correlate this response even with concurrent commands.
                id: routed.browser_id.clone(),
                command: routed.name.to_string(),
                success: body.map(|b| b.success).unwrap_or(false),
                error: body.and_then(|b| b.error.clone()),
                // `prompt` responses carry `data.disposition`
                // (`handled` | `queued` | `started`).
                disposition: body
                    .and_then(|b| b.data.as_ref())
                    .and_then(|d| d.get("disposition"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                // Pass the payload through untouched: the model list, thinking
                // levels, stats, and `clear_queue`'s text all travel here.
                data: body.and_then(|b| b.data.clone()),
            })
            .await;
    });
}

/// Relay an answer to the pending dialog back to pi, and clear the slot.
///
/// An answer whose id is not the pending one (already answered, replaced,
/// never pending — e.g. a `notify` uuid) is dropped with no frame and no
/// error: pi discards a late answer too, and the client must not invent a
/// second one (AC2/AC3). The response produces no command response.
async fn respond_extension_ui(
    session: &Session,
    out: &mpsc::Sender<ServerMessage>,
    id: String,
    value: Option<String>,
    confirmed: Option<bool>,
    cancelled: Option<bool>,
) {
    let matched = {
        let mut slot = session.pending.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|request| request.id == id) {
            *slot = None;
            true
        } else {
            false
        }
    };
    if !matched {
        return;
    }
    let Some(client) = &session.client else {
        // A dialog answer for a child-less session has nowhere to go; surface
        // it rather than pretending it was delivered.
        let _ = out
            .send(ServerMessage::Error {
                message: "no pi child is running for this session".to_string(),
            })
            .await;
        return;
    };
    let response = ExtensionUI::ExtensionUiResponse(ExtensionUiResponse {
        id,
        value,
        confirmed,
        cancelled,
    });
    if let Err(err) = client.send(&response).await {
        // A failed write to a live child must be visible, not a silent drop.
        let _ = out
            .send(ServerMessage::Error {
                message: err.to_string(),
            })
            .await;
    }
}

/// A translated browser command plus how its response correlates back.
struct Routed {
    command: Command,
    /// The `command` name pi answers with.
    name: &'static str,
    /// The browser's correlation id, echoed on the response.
    browser_id: Option<String>,
    /// The browser id is also the wire correlation key (bash), so the request
    /// is registered under it rather than a minted `req_N`.
    preserve_id: bool,
}

impl Routed {
    /// A command whose pi-side id is minted by the client; only the response
    /// is correlated with the browser's id.
    fn browser(command: Command, name: &'static str, browser_id: Option<String>) -> Self {
        Self {
            command,
            name,
            browser_id,
            preserve_id: false,
        }
    }

    async fn wire_request(&self, client: &RpcClient) -> Result<Response, RpcError> {
        match (&self.browser_id, self.preserve_id) {
            (Some(id), true) => client.request_with_id(id, &self.command).await,
            _ => client.request(&self.command).await,
        }
    }
}

/// Translate a browser command into pi's vocabulary.
fn to_command(message: ClientMessage) -> Option<Routed> {
    match message {
        ClientMessage::Prompt {
            id,
            message,
            streaming_behavior,
        } => Some(Routed::browser(
            Command::Prompt {
                id: None,
                message,
                images: None,
                streaming_behavior: streaming_behavior.map(|b| b.as_wire().to_string()),
            },
            "prompt",
            id,
        )),
        ClientMessage::Steer { id, message } => Some(Routed::browser(
            Command::Steer {
                id: None,
                message,
                images: None,
            },
            "steer",
            id,
        )),
        ClientMessage::FollowUp { id, message } => Some(Routed::browser(
            Command::FollowUp {
                id: None,
                message,
                images: None,
            },
            "follow_up",
            id,
        )),
        ClientMessage::Abort { id } => Some(Routed::browser(Command::Abort { id: None }, "abort", id)),
        ClientMessage::ClearQueue { id } => Some(Routed::browser(
            Command::ClearQueue { id: None },
            "clear_queue",
            id,
        )),
        ClientMessage::GetState { id } => {
            Some(Routed::browser(Command::GetState { id: None }, "get_state", id))
        }
        ClientMessage::GetAvailableModels { id } => Some(Routed::browser(
            Command::GetAvailableModels { id: None },
            "get_available_models",
            id,
        )),
        ClientMessage::SetModel {
            id,
            provider,
            model_id,
        } => Some(Routed::browser(
            Command::SetModel {
                id: None,
                provider,
                model_id,
            },
            "set_model",
            id,
        )),
        ClientMessage::CycleModel { id } => Some(Routed::browser(
            Command::CycleModel { id: None },
            "cycle_model",
            id,
        )),
        ClientMessage::GetAvailableThinkingLevels { id } => Some(Routed::browser(
            Command::GetAvailableThinkingLevels { id: None },
            "get_available_thinking_levels",
            id,
        )),
        ClientMessage::SetThinkingLevel { id, level } => Some(Routed::browser(
            Command::SetThinkingLevel { id: None, level },
            "set_thinking_level",
            id,
        )),
        ClientMessage::CycleThinkingLevel { id } => Some(Routed::browser(
            Command::CycleThinkingLevel { id: None },
            "cycle_thinking_level",
            id,
        )),
        ClientMessage::GetSessionStats { id } => Some(Routed::browser(
            Command::GetSessionStats { id: None },
            "get_session_stats",
            id,
        )),
        ClientMessage::Compact {
            id,
            custom_instructions,
        } => Some(Routed::browser(
            Command::Compact {
                id: None,
                custom_instructions,
            },
            "compact",
            id,
        )),
        ClientMessage::SetAutoCompaction { id, enabled } => Some(Routed::browser(
            Command::SetAutoCompaction { id: None, enabled },
            "set_auto_compaction",
            id,
        )),
        ClientMessage::SetAutoRetry { id, enabled } => Some(Routed::browser(
            Command::SetAutoRetry { id: None, enabled },
            "set_auto_retry",
            id,
        )),
        ClientMessage::AbortRetry { id } => Some(Routed::browser(
            Command::AbortRetry { id: None },
            "abort_retry",
            id,
        )),
        ClientMessage::Bash {
            id,
            command,
            exclude_from_context,
        } => Some(Routed {
            command: Command::Bash {
                id: None,
                command,
                exclude_from_context,
            },
            name: "bash",
            browser_id: Some(id),
            preserve_id: true,
        }),
        ClientMessage::AbortBash { id } => Some(Routed::browser(
            Command::AbortBash { id: None },
            "abort_bash",
            id,
        )),
        // Handled by `respond_extension_ui` directly: it never maps to a pi
        // command and never produces a command response.
        ClientMessage::ExtensionUiResponse { .. } => None,
        // Handled by the store (`handle_local_session`), never forwarded.
        ClientMessage::ListSessions { .. }
        | ClientMessage::ResumeSession { .. }
        | ClientMessage::StopSession { .. } => None,
        // Handled by the relay's binding state machine, never forwarded to pi.
        ClientMessage::Subscribe { .. } | ClientMessage::Unsubscribe { .. } => None,
        ClientMessage::Unknown => None,
    }
}

/// Map a pi record to what the browser should see. A blocking extension UI
/// request also occupies the session's single pending slot (AC2).
fn to_server_message(
    message: ProtocolMessage,
    pending: &Mutex<Option<ExtensionUiRequest>>,
) -> Option<ServerMessage> {
    match message {
        ProtocolMessage::Session(event) => Some(ServerMessage::Event { event }),
        ProtocolMessage::Frame(err) => Some(ServerMessage::Error {
            message: err.to_string(),
        }),
        ProtocolMessage::ParseError { raw, error } => Some(ServerMessage::Notice {
            kind: "parse_error".to_string(),
            detail: format!("{error} (raw: {raw})"),
        }),
        ProtocolMessage::ExtensionUi(ExtensionUI::ExtensionUiRequest(request)) => {
            if is_blocking(&request.method) {
                // Newest wins: pi defines no queue, so the slot is replaced.
                *pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(request.clone());
            }
            Some(ServerMessage::ExtensionUi { request })
        }
        // An `extension_ui_response` from pi is not ours to render, and an
        // unmodelled record carries nothing this slice renders.
        ProtocolMessage::ExtensionUi(_) | ProtocolMessage::Unknown(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use crate::bridge::StreamingBehavior;
    use crate::protocol::Event;
    use crate::rpc::framing::{encode_record, JsonlReader};
    use tokio::io::{AsyncWriteExt, BufReader, DuplexStream};

    const BOUND: Duration = Duration::from_secs(2);

    type Frames = JsonlReader<BufReader<DuplexStream>>;

    struct FakeSink {
        commands: mpsc::UnboundedReceiver<Result<ClientMessage, String>>,
        sent: mpsc::UnboundedSender<ServerMessage>,
    }

    impl ClientSink for FakeSink {
        async fn send_text(&mut self, text: String) -> Result<(), ()> {
            let message: ServerMessage = serde_json::from_str(&text).map_err(|_| ())?;
            let _ = self.sent.send(message);
            Ok(())
        }

        async fn recv(&mut self) -> Option<Result<ClientMessage, String>> {
            self.commands.recv().await
        }
    }

    /// A fake browser wired to two channels: commands in, frames out.
    fn fake() -> (
        mpsc::UnboundedSender<Result<ClientMessage, String>>,
        mpsc::UnboundedReceiver<ServerMessage>,
        FakeSink,
    ) {
        let (command_tx, commands) = mpsc::unbounded_channel();
        let (sent, received) = mpsc::unbounded_channel();
        (command_tx, received, FakeSink { commands, sent })
    }

    fn harness() -> (Arc<RpcClient>, DuplexStream, Frames) {
        let (stdout_tx, stdout_rx) = tokio::io::duplex(1 << 20);
        let (stdin_tx, from_child) = tokio::io::duplex(1 << 20);
        let client = Arc::new(RpcClient::new(Box::new(stdout_rx), Box::new(stdin_tx)));
        (client, stdout_tx, JsonlReader::new(BufReader::new(from_child)))
    }

    async fn write_record(to_child: &mut DuplexStream, value: Value) {
        to_child
            .write_all(&encode_record(&value).unwrap())
            .await
            .unwrap();
        to_child.flush().await.unwrap();
    }

    async fn next_command(frames: &mut Frames) -> Value {
        let raw = tokio::time::timeout(BOUND, frames.next_record_str())
            .await
            .expect("command written within 2s")
            .expect("frame read")
            .expect("frame present");
        serde_json::from_str(&raw).expect("command frame is JSON")
    }

    async fn next_message(received: &mut mpsc::UnboundedReceiver<ServerMessage>) -> ServerMessage {
        tokio::time::timeout(BOUND, received.recv())
            .await
            .expect("a server message within 2s")
            .expect("browser channel open")
    }

    /// AC1 + AC5: a prompt is forwarded as a pi `prompt` command and both its
    /// response and the pi events around it reach the browser.
    #[tokio::test]
    async fn relay_forwards_events_and_command_responses() {
        let (client, mut to_child, mut frames) = harness();
        let (command_tx, mut received, sink) = fake();
        let session = Arc::new(Session::new(Arc::clone(&client)));
        let relay = tokio::spawn(async move { session.relay(sink).await });

        command_tx
            .send(Ok(ClientMessage::Prompt {
                id: None,
                message: "hi".into(),
                streaming_behavior: Some(StreamingBehavior::Steer),
            }))
            .unwrap();

        let frame = next_command(&mut frames).await;
        assert_eq!(frame["type"], "prompt");
        assert_eq!(frame["message"], "hi");
        assert_eq!(frame["streamingBehavior"], "steer");
        let id = frame["id"].as_str().unwrap().to_string();

        // A pi event emitted while the prompt is in flight is relayed.
        write_record(&mut to_child, serde_json::json!({"type": "agent_start"})).await;
        match next_message(&mut received).await {
            ServerMessage::Event { event } => assert!(matches!(event, Event::AgentStart)),
            other => panic!("expected an event, got {other:?}"),
        }

        write_record(
            &mut to_child,
            serde_json::json!({"type": "response", "command": "prompt", "success": true, "id": id, "data": {"disposition": "started"}}),
        )
        .await;
        match next_message(&mut received).await {
            ServerMessage::CommandResponse {
                success,
                command,
                disposition,
                ..
            } => {
                assert!(success);
                assert_eq!(command, "prompt");
                assert_eq!(disposition.as_deref(), Some("started"));
            }
            other => panic!("expected a command response, got {other:?}"),
        }

        drop(command_tx);
        let _ = relay.await;
    }

    /// AC5: `success:false` is relayed, not swallowed.
    #[tokio::test]
    async fn relay_surfaces_a_rejected_command() {
        let (client, mut to_child, mut frames) = harness();
        let (command_tx, mut received, sink) = fake();
        let session = Arc::new(Session::new(Arc::clone(&client)));
        let relay = tokio::spawn(async move { session.relay(sink).await });

        command_tx.send(Ok(ClientMessage::Abort { id: None })).unwrap();
        let frame = next_command(&mut frames).await;
        let id = frame["id"].as_str().unwrap().to_string();
        write_record(
            &mut to_child,
            serde_json::json!({"type": "response", "command": "abort", "success": false, "error": "nope", "id": id}),
        )
        .await;

        match next_message(&mut received).await {
            ServerMessage::CommandResponse { success, error, .. } => {
                assert!(!success);
                assert_eq!(error.as_deref(), Some("nope"));
            }
            other => panic!("expected a rejection, got {other:?}"),
        }

        drop(command_tx);
        let _ = relay.await;
    }

    /// The `Unknown` client envelope is ignored rather than forwarded.
    #[test]
    fn unknown_client_messages_are_dropped() {
        assert!(to_command(ClientMessage::Unknown).is_none());
    }

    /// AC1–AC5: every control maps to exactly one pi command variant and wire
    /// `type`; the browser vocabulary is curated, never a raw passthrough.
    #[test]
    fn to_command_maps_every_control_to_its_pi_vocabulary() {
        let cases: Vec<(ClientMessage, &str)> = vec![
            (ClientMessage::ClearQueue { id: None }, "clear_queue"),
            (ClientMessage::GetState { id: None }, "get_state"),
            (
                ClientMessage::GetAvailableModels { id: None },
                "get_available_models",
            ),
            (
                ClientMessage::SetModel {
                    id: None,
                    provider: "anthropic".into(),
                    model_id: "claude".into(),
                },
                "set_model",
            ),
            (ClientMessage::CycleModel { id: None }, "cycle_model"),
            (
                ClientMessage::GetAvailableThinkingLevels { id: None },
                "get_available_thinking_levels",
            ),
            (
                ClientMessage::SetThinkingLevel {
                    id: None,
                    level: "high".into(),
                },
                "set_thinking_level",
            ),
            (
                ClientMessage::CycleThinkingLevel { id: None },
                "cycle_thinking_level",
            ),
            (
                ClientMessage::GetSessionStats { id: None },
                "get_session_stats",
            ),
            (
                ClientMessage::Compact {
                    id: None,
                    custom_instructions: None,
                },
                "compact",
            ),
            (
                ClientMessage::SetAutoCompaction {
                    id: None,
                    enabled: true,
                },
                "set_auto_compaction",
            ),
            (
                ClientMessage::SetAutoRetry {
                    id: None,
                    enabled: false,
                },
                "set_auto_retry",
            ),
            (ClientMessage::AbortRetry { id: None }, "abort_retry"),
            (
                ClientMessage::Bash {
                    id: "b1".into(),
                    command: "echo hi".into(),
                    exclude_from_context: None,
                },
                "bash",
            ),
            (ClientMessage::AbortBash { id: None }, "abort_bash"),
        ];
        for (message, expected) in cases {
            let routed = to_command(message).expect("control is routable");
            assert_eq!(routed.name, expected);
            let value = serde_json::to_value(&routed.command).unwrap();
            assert_eq!(value["type"], expected, "{expected} wire type");
        }
    }

    /// AC2: `set_model` / `set_thinking_level` carry their payload in pi's
    /// camelCase field names.
    #[test]
    fn to_command_carries_control_payloads() {
        let routed = to_command(ClientMessage::SetModel {
            id: None,
            provider: "anthropic".into(),
            model_id: "claude".into(),
        })
        .unwrap();
        let value = serde_json::to_value(&routed.command).unwrap();
        assert_eq!(value["provider"], "anthropic");
        assert_eq!(value["modelId"], "claude");

        let routed = to_command(ClientMessage::SetThinkingLevel {
            id: None,
            level: "high".into(),
        })
        .unwrap();
        let value = serde_json::to_value(&routed.command).unwrap();
        assert_eq!(value["level"], "high");

        let routed = to_command(ClientMessage::Compact {
            id: Some("c1".into()),
            custom_instructions: Some("be brief".into()),
        })
        .unwrap();
        let value = serde_json::to_value(&routed.command).unwrap();
        assert_eq!(value["customInstructions"], "be brief");
        assert_eq!(routed.browser_id.as_deref(), Some("c1"));
    }

    /// AC4: bash is the one control whose browser id is also the wire id, so
    /// `bash_execution_update` ids can be matched to it.
    #[test]
    fn to_command_routes_bash_through_the_browser_id() {
        let routed = to_command(ClientMessage::Bash {
            id: "b1".into(),
            command: "echo hi".into(),
            exclude_from_context: Some(true),
        })
        .unwrap();
        assert_eq!(routed.name, "bash");
        assert!(routed.preserve_id, "bash must keep the browser id on the wire");
        assert_eq!(routed.browser_id.as_deref(), Some("b1"));
        let value = serde_json::to_value(&routed.command).unwrap();
        assert_eq!(value["excludeFromContext"], true);
    }

    /// Only bash preserves the caller id; an ordinary command still lets the
    /// client mint `req_N` (asserted end-to-end by
    /// `relay_echoes_the_browser_command_id`).
    #[test]
    fn to_command_does_not_preserve_ids_for_non_bash_controls() {
        let routed = to_command(ClientMessage::ClearQueue {
            id: Some("c1".into()),
        })
        .unwrap();
        assert!(!routed.preserve_id);
    }

    /// The relay echoes the *browser's* correlation id, not pi's generated
    /// `req_N`, so a client with concurrent commands can still correlate.
    #[tokio::test]
    async fn relay_echoes_the_browser_command_id() {
        let (client, mut to_child, mut frames) = harness();
        let (command_tx, mut received, sink) = fake();
        let session = Arc::new(Session::new(Arc::clone(&client)));
        let relay = tokio::spawn(async move { session.relay(sink).await });

        command_tx
            .send(Ok(ClientMessage::Prompt {
                id: Some("browser-1".into()),
                message: "hi".into(),
                streaming_behavior: None,
            }))
            .unwrap();
        let frame = next_command(&mut frames).await;
        let pi_id = frame["id"].as_str().unwrap().to_string();
        assert_ne!(pi_id, "browser-1", "pi stamps its own id");
        write_record(
            &mut to_child,
            serde_json::json!({"type": "response", "command": "prompt", "success": true, "id": pi_id}),
        )
        .await;

        match next_message(&mut received).await {
            ServerMessage::CommandResponse { id, .. } => {
                assert_eq!(id.as_deref(), Some("browser-1"));
            }
            other => panic!("expected a command response, got {other:?}"),
        }

        drop(command_tx);
        let _ = relay.await;
    }

    /// A malformed client frame is surfaced to the browser, not silently
    /// dropped.
    #[tokio::test]
    async fn relay_surfaces_a_malformed_client_frame() {
        let (client, _to_child, _frames) = harness();
        let (command_tx, mut received, sink) = fake();
        let session = Arc::new(Session::new(Arc::clone(&client)));
        let relay = tokio::spawn(async move { session.relay(sink).await });

        command_tx.send(Err("expected value".into())).unwrap();
        match next_message(&mut received).await {
            ServerMessage::Error { message } => {
                assert!(message.contains("malformed client frame"), "{message}");
            }
            other => panic!("expected an error frame, got {other:?}"),
        }

        drop(command_tx);
        let _ = relay.await;
    }

    /// A framing fault on the child pipe reaches the browser as an error.
    #[test]
    fn frame_errors_become_server_errors() {
        let message = to_server_message(
            ProtocolMessage::Frame(crate::rpc::framing::FramingError::NotUtf8),
            &Mutex::new(None),
        );
        assert!(matches!(message, Some(ServerMessage::Error { .. })));
    }
}


use super::*;

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

pub(super) async fn relay_session(session: Arc<Session>, mut sink: impl ClientSink) {
    let mut active = session;
    // AC1: subscribe to pi events *before* writing any command, so a completion
    // that lands the instant a command is written is never missed.
    let mut events = active.client.as_ref().map(|client| client.events());
    // A connection is *unbound* until it subscribes: a freshly opened socket
    // must not receive a default session's stream (binding protocol).
    let mut subscribed = false;
    // While a replay is being computed the live broadcast is spooled: never
    // delivered (it would interleave with the replay) and never dropped (it
    // would lose the tail) — the replay boundary of AC2.
    let mut replaying = false;
    let mut spool: Vec<ProtocolMessage> = Vec::new();
    let mut spool_lagged: Option<u64> = None;
    // Responses to forwarded commands are produced on spawned tasks and funnelled
    // back here, so a slow pi response never blocks the event stream.
    let (out_tx, mut out_rx) = mpsc::channel::<ServerMessage>(64);
    // Completed subscribe computations, produced on their own tasks.
    let (replay_tx, mut replay_rx) = mpsc::channel::<SubscribeResult>(4);

    loop {
        tokio::select! {
            biased;
            command = sink.recv() => match command {
                Some(Ok(ClientMessage::Subscribe { id, session_id, since })) => {
                    match resolve_subscription(&active, &session_id) {
                        Ok(target) => {
                            // Rebind the live tail *before* the replay is
                            // computed so no event between subscribe and replay
                            // is missed (AC2).
                            events = target.client.as_ref().map(|client| client.events());
                            active = target;
                            subscribed = false;
                            replaying = true;
                            spool.clear();
                            spool_lagged = None;
                            let session = Arc::clone(&active);
                            let sid = session_id.clone();
                            let tx = replay_tx.clone();
                            tokio::spawn(async move {
                                let outcome = compute_subscribe(&session, &sid, since).await;
                                let pending = session.pending_dialog();
                                let _ = tx
                                    .send(SubscribeResult {
                                        id,
                                        session_id: sid,
                                        outcome,
                                        pending,
                                    })
                                    .await;
                            });
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
                        match active.store.clone() {
                            Some(store) => {
                                if let Some(hop) =
                                    handle_local_session(&store, &active, &out_tx, command).await
                                {
                                    // The switch succeeded: follow the resumed
                                    // session on this same child (AC1).
                                    events = hop.client.as_ref().map(|client| client.events());
                                    active = hop;
                                    subscribed = true;
                                }
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
            Some(result) = replay_rx.recv() => {
                let bound = result.outcome.is_ok();
                if emit_replay(&mut sink, &result, &active.pending, &mut spool)
                    .await
                    .is_err()
                {
                    break;
                }
                if let Some(skipped) = spool_lagged.take() {
                    // The spool was lossy; ask the client to resync from the
                    // durable log rather than claim a gap-free tail.
                    let message = ServerMessage::Lagged {
                        skipped,
                        resync_required: true,
                    };
                    if send(&mut sink, &message).await.is_err() {
                        break;
                    }
                }
                replaying = false;
                // A failed replay leaves the connection unbound: it got an
                // error frame, not a header, so it must not stream yet.
                subscribed = bound;
            }
            Some(message) = out_rx.recv() => {
                if send(&mut sink, &message).await.is_err() {
                    break;
                }
            }
            event = next_event(&mut events), if events.is_some() => match event {
                EventOutcome::Message(protocol) => {
                    if replaying {
                        if spool.len() >= SPOOL_LIMIT {
                            // Overflow: the durable log heals this, the spool cannot.
                            spool_lagged =
                                Some(spool_lagged.unwrap_or(0) + spool.len() as u64);
                            spool.clear();
                        }
                        spool.push(protocol);
                    } else if subscribed {
                        if let Some(message) = to_server_message(protocol, &active.pending) {
                            if send(&mut sink, &message).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                EventOutcome::Lagged(skipped) => {
                    if replaying {
                        // The spool itself is now lossy: drop it and tell the
                        // client to resync from the durable log.
                        spool.clear();
                        spool_lagged = Some(spool_lagged.unwrap_or(0) + skipped);
                    } else if subscribed {
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
///
/// Returns the live session to follow when a `resume`/`switch_session`
/// succeeded, so the relay can re-bind and the registry can be re-keyed (AC1).
async fn handle_local_session(
    store: &SessionsStore,
    session: &Arc<Session>,
    out: &mpsc::Sender<ServerMessage>,
    message: ClientMessage,
) -> Option<Arc<Session>> {
    match message {
        ClientMessage::ListSessions { id } => {
            let sessions: Vec<crate::bridge::SessionRow> = match store.list().await {
                Ok(entries) => entries.iter().map(|entry| entry.to_row()).collect(),
                Err(message) => {
                    let _ = out.send(ServerMessage::Error { message }).await;
                    return None;
                }
            };
            let _ = out.send(ServerMessage::SessionList { id, sessions }).await;
            None
        }
        ClientMessage::ResumeSession {
            id,
            session_id,
            mode,
            entry_id,
        } => {
            // The *command* client is the bootstrap child even when this
            // connection is replaying another session from the file, so a
            // selected on-disk session can still be resumed.
            let (success, error) =
                match action_command(store, &session_id, mode.as_deref(), entry_id).await {
                    Ok(command) => match &session.command_client {
                        Some(client) => match client.send(&command).await {
                            Ok(()) => (true, None),
                            Err(err) => (false, Some(err.to_string())),
                        },
                        None => (false, Some("no pi child is running".to_string())),
                    },
                    Err(error) => (false, Some(error)),
                };
            let mut hop = None;
            if success {
                // The same child now owns the resumed session: re-key the
                // registry and follow it on this connection.
                if let (Some(registry), Some(live)) = (&session.registry, &session.live) {
                    registry.rekey(live, &session_id);
                    hop = Some(Arc::clone(live));
                }
            }
            let _ = out
                .send(ServerMessage::SessionAction {
                    id,
                    session_id,
                    success,
                    error,
                })
                .await;
            hop
        }
        ClientMessage::StopSession { id, session_id } => {
            // AC3 ordering: abort the running turn, then marker-kill the exact
            // child. The registry kill is scoped to this session id, so sibling
            // children survive.
            let abort = match &session.command_client {
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
            None
        }
        // `is_local_session_command` only routes the three arms above.
        _ => None,
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
pub(super) struct Routed {
    pub(super) command: Command,
    /// The `command` name pi answers with.
    pub(super) name: &'static str,
    /// The browser's correlation id, echoed on the response.
    pub(super) browser_id: Option<String>,
    /// The browser id is also the wire correlation key (bash), so the request
    /// is registered under it rather than a minted `req_N`.
    pub(super) preserve_id: bool,
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
pub(super) fn to_command(message: ClientMessage) -> Option<Routed> {
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
pub(super) fn to_server_message(
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

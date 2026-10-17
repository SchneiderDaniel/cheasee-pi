async fn relay_session(session: Arc<Session>, mut sink: impl ClientSink) {
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


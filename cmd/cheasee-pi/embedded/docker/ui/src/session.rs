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

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{broadcast::error::RecvError, mpsc};

use crate::bridge::{ClientMessage, ServerMessage};
use crate::protocol::Command;
use crate::rpc::{ProtocolMessage, RpcClient};

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

/// Shared, per-child relay state. Cheap to clone behind an `Arc`.
pub struct Session {
    client: Arc<RpcClient>,
}

impl Session {
    pub fn new(client: Arc<RpcClient>) -> Self {
        Self { client }
    }

    /// Relay until the browser connection or the pi child goes away.
    pub async fn relay(&self, sink: impl ClientSink) {
        relay_with_client(&self.client, sink).await;
    }
}

/// Relay `session`'s pi child to one browser connection.
pub async fn relay(session: Arc<Session>, sink: impl ClientSink) {
    session.relay(sink).await;
}

async fn relay_with_client(client: &Arc<RpcClient>, mut sink: impl ClientSink) {
    // AC1: subscribe to pi events *before* writing any command.
    let mut events = client.events();
    // Responses to forwarded commands are produced on spawned tasks and funnelled
    // back here, so a slow pi response never blocks the event stream.
    let (out_tx, mut out_rx) = mpsc::channel::<ServerMessage>(64);

    loop {
        tokio::select! {
            biased;
            command = sink.recv() => match command {
                Some(Ok(command)) => forward(client, command, &out_tx),
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
            event = events.recv() => match event {
                Ok(protocol) => {
                    if let Some(message) = to_server_message(protocol) {
                        if send(&mut sink, &message).await.is_err() {
                            break;
                        }
                    }
                }
                Err(RecvError::Lagged(skipped)) => {
                    // Lossy, not fatal: surface the drop and keep the receiver.
                    let message = ServerMessage::Lagged { skipped };
                    if send(&mut sink, &message).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Closed) => break,
            },
        }
    }
}

async fn send(sink: &mut impl ClientSink, message: &ServerMessage) -> Result<(), ()> {
    let text = serde_json::to_string(message).map_err(|_| ())?;
    sink.send_text(text).await
}

/// Forward one browser command to pi and report its response back. The request
/// is spawned so a pending response never stalls the event stream.
fn forward(client: &Arc<RpcClient>, message: ClientMessage, out: &mpsc::Sender<ServerMessage>) {
    let Some((command, name, browser_id)) = to_command(message) else {
        return;
    };
    let client = Arc::clone(client);
    let out = out.clone();
    tokio::spawn(async move {
        let response = match client.request(&command).await {
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
                id: browser_id,
                command: name.to_string(),
                success: body.map(|b| b.success).unwrap_or(false),
                error: body.and_then(|b| b.error.clone()),
                // `prompt` responses carry `data.disposition`
                // (`handled` | `queued` | `started`).
                disposition: body
                    .and_then(|b| b.data.as_ref())
                    .and_then(|d| d.get("disposition"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
            .await;
    });
}

/// Translate a browser command into pi's vocabulary. Returns the command, the
/// response `command` name it will be answered with, and the browser's
/// correlation id to echo back (pi gets its own generated id).
fn to_command(message: ClientMessage) -> Option<(Command, &'static str, Option<String>)> {
    match message {
        ClientMessage::Prompt {
            id,
            message,
            streaming_behavior,
        } => Some((
            Command::Prompt {
                id: None,
                message,
                images: None,
                streaming_behavior: streaming_behavior.map(|b| b.as_wire().to_string()),
            },
            "prompt",
            id,
        )),
        ClientMessage::Steer { id, message } => Some((
            Command::Steer {
                id: None,
                message,
                images: None,
            },
            "steer",
            id,
        )),
        ClientMessage::FollowUp { id, message } => Some((
            Command::FollowUp {
                id: None,
                message,
                images: None,
            },
            "follow_up",
            id,
        )),
        ClientMessage::Abort { id } => Some((Command::Abort { id: None }, "abort", id)),
        ClientMessage::Unknown => None,
    }
}

/// Map a pi record to what the browser should see. Extension UI and unmodelled
/// records carry nothing this slice renders.
fn to_server_message(message: ProtocolMessage) -> Option<ServerMessage> {
    match message {
        ProtocolMessage::Session(event) => Some(ServerMessage::Event { event }),
        ProtocolMessage::Frame(err) => Some(ServerMessage::Error {
            message: err.to_string(),
        }),
        ProtocolMessage::ParseError { raw, error } => Some(ServerMessage::Notice {
            kind: "parse_error".to_string(),
            detail: format!("{error} (raw: {raw})"),
        }),
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
        let message = to_server_message(ProtocolMessage::Frame(
            crate::rpc::framing::FramingError::NotUtf8,
        ));
        assert!(matches!(message, Some(ServerMessage::Error { .. })));
    }
}


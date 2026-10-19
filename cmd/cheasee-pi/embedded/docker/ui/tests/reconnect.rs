//! Reconnect integration tests (slice 9): fan-out, durable-log replay,
//! child-less restart, and the AC5 child-PID invariant.
//!
//! A headless client drives the same [`Session::relay`] the `ssr` server runs,
//! over a duplex "pi" child (no real `pi` binary), with `FakeSink` mpsc channels
//! for multi-subscriber fan-out. Every test is `reconnect_`-prefixed so the
//! crate's filter reaches it.

#![cfg(feature = "ssr")]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use cheasee_pi_ui::bridge::{ClientMessage, ServerMessage};
use cheasee_pi_ui::pi_process::PidRegistry;
use cheasee_pi_ui::protocol::Event;
use cheasee_pi_ui::rpc::framing::{encode_record, JsonlReader};
use cheasee_pi_ui::rpc::RpcClient;
use cheasee_pi_ui::session::{ClientSink, Session, SessionHandle, SessionRegistry};
use cheasee_pi_ui::sessions_store::SessionsStore;
use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::mpsc;

const BOUND: Duration = Duration::from_secs(2);
/// How long "nothing arrived" is proven for.
const QUIET: Duration = Duration::from_millis(200);

type Frames = JsonlReader<BufReader<DuplexStream>>;

/// A fake browser wired to two channels: commands in, frames out.
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

fn fake() -> (
    mpsc::UnboundedSender<Result<ClientMessage, String>>,
    mpsc::UnboundedReceiver<ServerMessage>,
    FakeSink,
) {
    let (command_tx, commands) = mpsc::unbounded_channel();
    let (sent, received) = mpsc::unbounded_channel();
    (command_tx, received, FakeSink { commands, sent })
}

/// A real [`RpcClient`] over a duplex "pi" child: `to_child` is the child's
/// stdout, `frames` is the child's stdin.
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

fn temp_session_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cheasee-pi-ui-reconnect-{tag}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn store(dir: &PathBuf) -> Arc<SessionsStore> {
    Arc::new(SessionsStore::new(
        dir,
        dir.join(".cheasee-inuse"),
        Arc::new(PidRegistry::new()),
    ))
}

/// Register a live session under its pi session id and return its relay handle.
fn register_live(
    registry: &Arc<SessionRegistry>,
    client: Arc<RpcClient>,
    store: Arc<SessionsStore>,
    session_id: &str,
    child_pid: Option<u32>,
) -> Arc<Session> {
    let session = Arc::new(Session::live(
        client,
        store,
        session_id.to_string(),
        Arc::clone(registry),
    ));
    registry.insert(Arc::new(SessionHandle {
        pi_session_id: session_id.to_string(),
        marker_id: format!("marker-{session_id}"),
        session: Arc::clone(&session),
        child_pid,
    }));
    session
}

/// Answer the three replay requests `subscribe` issues, in order.
async fn serve_replay(
    frames: &mut Frames,
    to_child: &mut DuplexStream,
    expected_since: Option<&str>,
    entries: Value,
    leaf: &str,
    state: Value,
    text: Option<&str>,
) {
    for _ in 0..3 {
        let command = next_command(frames).await;
        let id = command["id"].as_str().unwrap().to_string();
        let response = match command["type"].as_str().unwrap() {
            "get_entries" => {
                if let Some(expected) = expected_since {
                    assert_eq!(
                        command["since"].as_str(),
                        Some(expected),
                        "the cursor must go on the wire verbatim"
                    );
                }
                json!({
                    "type": "response", "command": "get_entries", "success": true, "id": id,
                    "data": {"entries": entries, "leafId": leaf},
                })
            }
            "get_state" => json!({
                "type": "response", "command": "get_state", "success": true, "id": id,
                "data": state,
            }),
            "get_last_assistant_text" => json!({
                "type": "response", "command": "get_last_assistant_text", "success": true,
                "id": id, "data": {"text": text},
            }),
            other => panic!("unexpected replay request {other}"),
        };
        write_record(to_child, response).await;
    }
}

fn subscribe(session_id: &str, since: Option<&str>) -> ClientMessage {
    ClientMessage::Subscribe {
        id: None,
        session_id: session_id.to_string(),
        since: since.map(str::to_string),
    }
}

/// Drain the header + terminal replay frame a subscribe emits (an empty replay
/// is still one `done: true` chunk).
async fn drain_subscribe(received: &mut mpsc::UnboundedReceiver<ServerMessage>) {
    match next_message(received).await {
        ServerMessage::SessionState { .. } => {}
        other => panic!("expected a state header, got {other:?}"),
    }
    match next_message(received).await {
        ServerMessage::SessionReplay { done, .. } => assert!(done, "terminal replay frame"),
        other => panic!("expected a replay chunk, got {other:?}"),
    }
}

/// Subscribe `tx` to `session_id`, answer the three replay requests with an
/// empty history, and drain the header + replay. Leaves the connection bound
/// and live (AC1's binding protocol).
async fn bind(
    tx: &mpsc::UnboundedSender<Result<ClientMessage, String>>,
    received: &mut mpsc::UnboundedReceiver<ServerMessage>,
    frames: &mut Frames,
    to_child: &mut DuplexStream,
    session_id: &str,
    since: Option<&str>,
) {
    tx.send(Ok(subscribe(session_id, since))).unwrap();
    serve_replay(frames, to_child, since, json!([]), "leaf", json!({}), None).await;
    drain_subscribe(received).await;
}

fn entry_ids(entries: &[Value]) -> Vec<String> {
    entries
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// AC1: two subscribers to one session each receive the same broadcast event.
#[tokio::test]
async fn reconnect_fanout_two_subscribers_receive_every_event() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("fanout");
    let session = register_live(&registry, client, store(&dir), "sess-1", Some(111));

    let sub_a = Arc::clone(&session);
    let sub_b = Arc::clone(&session);
    let (tx_a, mut rx_a, sink_a) = fake();
    let (tx_b, mut rx_b, sink_b) = fake();
    let task_a = tokio::spawn(async move { sub_a.relay(sink_a).await });
    let task_b = tokio::spawn(async move { sub_b.relay(sink_b).await });

    // Both connections must bind before any event is delivered (the relay
    // starts unbound).
    bind(&tx_a, &mut rx_a, &mut frames, &mut to_child, "sess-1", None).await;
    bind(&tx_b, &mut rx_b, &mut frames, &mut to_child, "sess-1", None).await;

    write_record(&mut to_child, json!({"type": "agent_start"})).await;

    for rx in [&mut rx_a, &mut rx_b] {
        match next_message(rx).await {
            ServerMessage::Event { .. } => {}
            other => panic!("expected a fan-out event, got {other:?}"),
        }
    }

    drop(tx_a);
    drop(tx_b);
    let _ = task_a.await;
    let _ = task_b.await;
}

/// AC2: a `Subscribe { since }` replays the missed entries exactly once, after
/// the header, and the entry id is forwarded on the wire (never `since: null`).
#[tokio::test]
async fn reconnect_subscribe_replays_without_duplicates() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("replay");
    let session = register_live(&registry, client, store(&dir), "sess-2", Some(222));

    let sub = Arc::clone(&session);
    let (tx, mut rx, sink) = fake();
    let task = tokio::spawn(async move { sub.relay(sink).await });

    tx.send(Ok(subscribe("sess-2", Some("a")))).unwrap();
    serve_replay(
        &mut frames,
        &mut to_child,
        Some("a"),
        json!([{"id": "c", "parentId": "b"}]),
        "c",
        json!({"isStreaming": false}),
        None,
    )
    .await;

    match next_message(&mut rx).await {
        ServerMessage::SessionState {
            live,
            leaf_id,
            cursor_invalid,
            ..
        } => {
            assert!(live);
            assert_eq!(leaf_id.as_deref(), Some("c"));
            assert!(!cursor_invalid);
        }
        other => panic!("expected a state header first, got {other:?}"),
    }
    match next_message(&mut rx).await {
        ServerMessage::SessionReplay { entries, done, .. } => {
            assert_eq!(entry_ids(&entries), vec!["c"], "exactly the missed entry");
            assert!(done, "the terminal replay frame closes the boundary");
        }
        other => panic!("expected a replay chunk, got {other:?}"),
    }

    drop(tx);
    let _ = task.await;
}

/// AC3: the header restores in-flight metadata: streaming state, the pending
/// dialog, and the in-flight assistant text.
#[tokio::test]
async fn reconnect_header_restores_in_flight_metadata() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("metadata");
    let session = register_live(&registry, client, store(&dir), "sess-3", Some(333));

    let sub = Arc::clone(&session);
    let (tx, mut rx, sink) = fake();
    let task = tokio::spawn(async move { sub.relay(sink).await });

    // Bind first so the dialog is captured in the shared pending slot.
    bind(&tx, &mut rx, &mut frames, &mut to_child, "sess-3", None).await;

    // A blocking dialog becomes pending.
    write_record(
        &mut to_child,
        json!({"type": "extension_ui_request", "id": "uuid-1", "method": "confirm", "message": "?"}),
    )
    .await;
    match next_message(&mut rx).await {
        ServerMessage::ExtensionUi { request } => assert_eq!(request.id, "uuid-1"),
        other => panic!("expected the dialog, got {other:?}"),
    }

    // Reconnect: the header restores the pending dialog and in-flight metadata.
    tx.send(Ok(subscribe("sess-3", None))).unwrap();
    serve_replay(
        &mut frames,
        &mut to_child,
        None,
        json!([]),
        "leaf-3",
        json!({"isStreaming": true, "isCompacting": false, "autoCompactionEnabled": true}),
        Some("half a sentence"),
    )
    .await;

    match next_message(&mut rx).await {
        ServerMessage::SessionState {
            state,
            pending,
            last_assistant_text,
            ..
        } => {
            assert_eq!(state.unwrap()["isStreaming"], true);
            assert_eq!(pending.unwrap().id, "uuid-1");
            assert_eq!(last_assistant_text.as_deref(), Some("half a sentence"));
        }
        other => panic!("expected the state header, got {other:?}"),
    }

    drop(tx);
    let _ = task.await;
}

/// AC5: a subscribe/unsubscribe/subscribe cycle never touches the child. A real
/// OS process stands in for the pi child so the assertion proves the process is
/// still alive — a constant `child_pid` field alone would pass even if a kill
/// path ran.
#[tokio::test]
async fn reconnect_subscribe_cycle_leaves_the_child_pid_untouched() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("pid");
    let mut child = std::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .expect("sleep must be spawnable");
    let pid = child.id();
    let session = register_live(&registry, client, store(&dir), "sess-4", Some(pid));

    let sub = Arc::clone(&session);
    let (tx, mut rx, sink) = fake();
    let task = tokio::spawn(async move { sub.relay(sink).await });

    bind(&tx, &mut rx, &mut frames, &mut to_child, "sess-4", None).await;

    tx.send(Ok(ClientMessage::Unsubscribe {
        id: None,
        session_id: "sess-4".into(),
    }))
    .unwrap();

    bind(&tx, &mut rx, &mut frames, &mut to_child, "sess-4", None).await;

    assert_eq!(registry.pid("sess-4"), Some(pid), "the child pid is unchanged");
    assert_eq!(registry.len(), 1, "no second child was created");
    // The OS process itself is still running: the cycle never invoked a kill.
    assert!(
        child.try_wait().unwrap().is_none(),
        "the child process must still be alive after the cycle"
    );

    drop(tx);
    let _ = task.await;
    let _ = child.kill();
    let _ = child.wait();
}

mod journey;

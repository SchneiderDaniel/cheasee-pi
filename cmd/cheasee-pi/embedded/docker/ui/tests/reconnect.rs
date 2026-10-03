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
use cheasee_pi_ui::rpc::framing::{encode_record, JsonlReader};
use cheasee_pi_ui::rpc::RpcClient;
use cheasee_pi_ui::session::{ClientSink, Session, SessionHandle, SessionRegistry};
use cheasee_pi_ui::sessions_store::SessionsStore;
use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::mpsc;

const BOUND: Duration = Duration::from_secs(2);

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

/// Let freshly spawned relay tasks reach their first poll, so their broadcast
/// receivers exist before the fake child emits anything (a broadcast with no
/// receiver drops the value).
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
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

fn entry_ids(entries: &[Value]) -> Vec<String> {
    entries
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// AC1: two subscribers to one session each receive the same broadcast event.
#[tokio::test]
async fn reconnect_fanout_two_subscribers_receive_every_event() {
    let (client, mut to_child, _frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("fanout");
    let session = register_live(&registry, client, store(&dir), "sess-1", Some(111));

    let sub_a = Arc::clone(&session);
    let sub_b = Arc::clone(&session);
    let (tx_a, mut rx_a, sink_a) = fake();
    let (tx_b, mut rx_b, sink_b) = fake();
    let task_a = tokio::spawn(async move { sub_a.relay(sink_a).await });
    let task_b = tokio::spawn(async move { sub_b.relay(sink_b).await });

    settle().await;
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

    // A blocking dialog is pending before the reconnect.
    settle().await;
    write_record(
        &mut to_child,
        json!({"type": "extension_ui_request", "id": "uuid-1", "method": "confirm", "message": "?"}),
    )
    .await;
    match next_message(&mut rx).await {
        ServerMessage::ExtensionUi { request } => assert_eq!(request.id, "uuid-1"),
        other => panic!("expected the dialog, got {other:?}"),
    }

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

/// AC5: a subscribe/unsubscribe/subscribe cycle never touches the child; the
/// pid is unchanged and no second child is registered.
#[tokio::test]
async fn reconnect_subscribe_cycle_leaves_the_child_pid_untouched() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("pid");
    let session = register_live(&registry, client, store(&dir), "sess-4", Some(4242));

    let sub = Arc::clone(&session);
    let (tx, mut rx, sink) = fake();
    let task = tokio::spawn(async move { sub.relay(sink).await });

    tx.send(Ok(subscribe("sess-4", None))).unwrap();
    serve_replay(&mut frames, &mut to_child, None, json!([]), "leaf", json!({}), None).await;
    let _ = next_message(&mut rx).await; // SessionState
    let _ = next_message(&mut rx).await; // SessionReplay

    tx.send(Ok(ClientMessage::Unsubscribe {
        id: None,
        session_id: "sess-4".into(),
    }))
    .unwrap();

    tx.send(Ok(subscribe("sess-4", None))).unwrap();
    serve_replay(&mut frames, &mut to_child, None, json!([]), "leaf", json!({}), None).await;
    let _ = next_message(&mut rx).await;
    let _ = next_message(&mut rx).await;

    assert_eq!(registry.pid("sess-4"), Some(4242), "the child pid is unchanged");
    assert_eq!(registry.len(), 1, "no second child was created");

    drop(tx);
    let _ = task.await;
}

/// AC5 / Phase 4: `Unsubscribe` silences only that connection.
#[tokio::test]
async fn reconnect_unsubscribe_stops_only_that_sink() {
    let (client, mut to_child, _frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("unsub");
    let session = register_live(&registry, client, store(&dir), "sess-5", Some(555));

    let sub_a = Arc::clone(&session);
    let sub_b = Arc::clone(&session);
    let (tx_a, mut rx_a, sink_a) = fake();
    let (tx_b, mut rx_b, sink_b) = fake();
    let task_a = tokio::spawn(async move { sub_a.relay(sink_a).await });
    let task_b = tokio::spawn(async move { sub_b.relay(sink_b).await });

    tx_a.send(Ok(ClientMessage::Unsubscribe {
        id: None,
        session_id: "sess-5".into(),
    }))
    .unwrap();
    // Let A process the unsubscribe before the event is emitted.
    tokio::time::sleep(Duration::from_millis(50)).await;

    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    match next_message(&mut rx_b).await {
        ServerMessage::Event { .. } => {}
        other => panic!("B must still stream, got {other:?}"),
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(200), rx_a.recv())
            .await
            .is_err(),
        "an unsubscribed connection receives no further events"
    );

    drop(tx_a);
    drop(tx_b);
    let _ = task_a.await;
    let _ = task_b.await;
}

/// Phase 4: a `Subscribe` for an id neither the registry nor the store knows
/// surfaces an error — no silent drop, no spawned child.
#[tokio::test]
async fn reconnect_unknown_session_surfaces_an_error() {
    let dir = temp_session_dir("unknown");
    let orphan = Arc::new(Session::detached(store(&dir), String::new()));
    let (tx, mut rx, sink) = fake();
    let task = tokio::spawn(async move { orphan.relay(sink).await });

    tx.send(Ok(subscribe("ghost", None))).unwrap();
    match next_message(&mut rx).await {
        ServerMessage::Error { message } => {
            assert!(message.contains("ghost"), "message = {message}")
        }
        other => panic!("expected an error, got {other:?}"),
    }

    drop(tx);
    let _ = task.await;
}

/// Phase 4: subscribing a second connection neither spawns a child nor sends a
/// `new_session`/`switch_session` command.
#[tokio::test]
async fn reconnect_second_subscriber_creates_no_child() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("second");
    let session = register_live(&registry, client, store(&dir), "sess-6", Some(666));

    for _ in 0..2 {
        let sub = Arc::clone(&session);
        let (tx, mut rx, sink) = fake();
        let task = tokio::spawn(async move { sub.relay(sink).await });
        tx.send(Ok(subscribe("sess-6", None))).unwrap();
        serve_replay(&mut frames, &mut to_child, None, json!([]), "leaf", json!({}), None).await;
        let _ = next_message(&mut rx).await;
        let _ = next_message(&mut rx).await;
        assert_eq!(registry.len(), 1, "one child for the session id");
        drop(tx);
        let _ = task.await;
    }

    // No `new_session`/`switch_session` was written while two subscribers bound.
    assert!(
        tokio::time::timeout(Duration::from_millis(200), frames.next_record_str())
            .await
            .is_err(),
        "binding a subscriber must not send a session command"
    );
}

/// AC4: after a `ui` restart there is no child; `Subscribe` replays history
/// from the JSONL with `live: false` and persists the cursor.
#[tokio::test]
async fn reconnect_childless_restart_replays_history_from_disk() {
    let dir = temp_session_dir("childless");
    let body = "{\"type\":\"session\",\"id\":\"disk1\",\"cwd\":\"/\"}\n\
{\"type\":\"message\",\"id\":\"a\",\"parentId\":null}\n\
{\"type\":\"message\",\"id\":\"b\",\"parentId\":\"a\"}\n";
    std::fs::write(dir.join("disk1_disk1.jsonl"), body).unwrap();

    let registry = Arc::new(SessionRegistry::new());
    let store = store(&dir);
    let session = Arc::new(
        Session::detached(store, "nochild".into()).with_registry(Arc::clone(&registry)),
    );
    let (tx, mut rx, sink) = fake();
    let task = tokio::spawn(async move { session.relay(sink).await });

    tx.send(Ok(subscribe("disk1", None))).unwrap();

    match next_message(&mut rx).await {
        ServerMessage::SessionState {
            live, leaf_id, state, ..
        } => {
            assert!(!live, "no child after a restart");
            assert_eq!(leaf_id.as_deref(), Some("b"));
            assert!(state.is_none());
        }
        other => panic!("expected a childless state header, got {other:?}"),
    }
    match next_message(&mut rx).await {
        ServerMessage::SessionReplay { entries, done, .. } => {
            assert_eq!(entry_ids(&entries), vec!["a", "b"]);
            assert!(done);
        }
        other => panic!("expected a replay chunk, got {other:?}"),
    }

    drop(tx);
    let _ = task.await;
}

/// Phase 7 user journey: the operator closes the laptop lid and resumes.
/// A disconnects mid-run, B stays, A reconnects with its last-seen id and sees
/// the header, the missed entries exactly once, then the live tail; the child
/// pid is unchanged throughout.
#[tokio::test]
async fn reconnect_journey_operator_resumes_after_disconnect() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("journey");
    let session = register_live(&registry, client, store(&dir), "sess-9", Some(999));

    // B is the stable subscriber that stays open.
    let sub_b = Arc::clone(&session);
    let (tx_b, mut rx_b, sink_b) = fake();
    let task_b = tokio::spawn(async move { sub_b.relay(sink_b).await });
    let _ = tx_b;

    // A connects and replays from the start.
    let sub_a = Arc::clone(&session);
    let (tx_a, mut rx_a, sink_a) = fake();
    let task_a = tokio::spawn(async move { sub_a.relay(sink_a).await });
    tx_a.send(Ok(subscribe("sess-9", None))).unwrap();
    serve_replay(
        &mut frames,
        &mut to_child,
        None,
        json!([{"id": "a", "parentId": null}]),
        "a",
        json!({"isStreaming": true}),
        Some("typing"),
    )
    .await;
    match next_message(&mut rx_a).await {
        ServerMessage::SessionState { live, .. } => assert!(live),
        other => panic!("expected the header, got {other:?}"),
    }
    match next_message(&mut rx_a).await {
        ServerMessage::SessionReplay { entries, .. } => {
            assert_eq!(entry_ids(&entries), vec!["a"])
        }
        other => panic!("expected replay, got {other:?}"),
    }

    // The lid closes: A's socket dies. B keeps streaming.
    drop(tx_a);
    let _ = task_a.await;

    // A dialog becomes pending and new history is written while A is away.
    write_record(
        &mut to_child,
        json!({"type": "extension_ui_request", "id": "uuid-9", "method": "confirm", "message": "?"}),
    )
    .await;
    match next_message(&mut rx_b).await {
        ServerMessage::ExtensionUi { .. } => {}
        other => panic!("B must see the dialog, got {other:?}"),
    }

    // A reconnects with the last-seen id and catches up.
    let sub_a2 = Arc::clone(&session);
    let (tx_a2, mut rx_a2, sink_a2) = fake();
    let task_a2 = tokio::spawn(async move { sub_a2.relay(sink_a2).await });
    tx_a2.send(Ok(subscribe("sess-9", Some("a")))).unwrap();
    serve_replay(
        &mut frames,
        &mut to_child,
        Some("a"),
        json!([{"id": "b", "parentId": "a"}]),
        "b",
        json!({"isStreaming": true}),
        Some("typing"),
    )
    .await;

    match next_message(&mut rx_a2).await {
        ServerMessage::SessionState {
            pending,
            last_assistant_text,
            ..
        } => {
            assert_eq!(pending.unwrap().id, "uuid-9");
            assert_eq!(last_assistant_text.as_deref(), Some("typing"));
        }
        other => panic!("expected the reconnect header, got {other:?}"),
    }
    match next_message(&mut rx_a2).await {
        ServerMessage::SessionReplay { entries, done, .. } => {
            assert_eq!(entry_ids(&entries), vec!["b"], "no gap, no duplicate");
            assert!(done);
        }
        other => panic!("expected the missed-entry replay, got {other:?}"),
    }

    // The live tail resumes on A.
    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    for rx in [&mut rx_a2, &mut rx_b] {
        match next_message(rx).await {
            ServerMessage::Event { .. } => {}
            other => panic!("expected the resumed live tail, got {other:?}"),
        }
    }

    assert_eq!(registry.pid("sess-9"), Some(999));

    drop(tx_a2);
    drop(tx_b);
    let _ = task_a2.await;
    let _ = task_b.await;
}

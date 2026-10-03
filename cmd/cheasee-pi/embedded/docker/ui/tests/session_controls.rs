//! Control surface over the real relay: browser envelopes -> pi commands ->
//! responses/events -> [`ControlsState`].
//!
//! Tier: user-journey. A headless operator drives the same [`Session::relay`]
//! the `ssr` server runs, over a duplex "pi" child, and asserts the state the
//! three control components would render. Every test is `controls_journey_`
//! or `controls_relay_`-prefixed so the crate's filter reaches it.
//!
//! There is no browser here (this crate has no e2e harness), so the DOM itself
//! is not asserted — the components are thin renderers over `ControlsState`
//! and `BashLog`, which *is* asserted.

#![cfg(feature = "ssr")]

use std::sync::Arc;
use std::time::Duration;

use cheasee_pi_ui::bridge::{ClientMessage, ServerMessage};
use cheasee_pi_ui::controls::ControlsState;
use cheasee_pi_ui::rpc::framing::{encode_record, JsonlReader};
use cheasee_pi_ui::rpc::RpcClient;
use cheasee_pi_ui::session::{ClientSink, Session};
use leptos::prelude::{Get, Owner};
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
        .expect("pi command written within 2s")
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

/// A reactive owner that outlives the test's signals.
fn controls() -> ControlsState {
    let owner = Owner::new();
    owner.set();
    std::mem::forget(owner);
    ControlsState::new()
}

/// Spawn the real relay and return its driver handles.
fn spawn_relay(
    client: &Arc<RpcClient>,
) -> (
    mpsc::UnboundedSender<Result<ClientMessage, String>>,
    mpsc::UnboundedReceiver<ServerMessage>,
    tokio::task::JoinHandle<()>,
) {
    let (command_tx, received, sink) = fake();
    let session = Arc::new(Session::new(Arc::clone(client)));
    let relay = tokio::spawn(async move { session.relay(sink).await });
    (command_tx, received, relay)
}

/// AC1: two queued prompts show in the panel, clear-queue empties it and hands
/// the removed text back to the editor, and abort is a separate control.
#[tokio::test]
async fn controls_journey_queue_clear_and_abort() {
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay) = spawn_relay(&client);
    let controls = controls();

    // A run is streaming.
    command_tx
        .send(Ok(ClientMessage::Prompt {
            id: None,
            message: "long".into(),
            streaming_behavior: None,
        }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "prompt");
    let prompt_id = frame["id"].as_str().unwrap().to_string();
    write_record(
        &mut to_child,
        json!({"type":"response","command":"prompt","success":true,"id":prompt_id,"data":{"disposition":"started"}}),
    )
    .await;
    let _ = next_message(&mut received).await;

    // Two mid-run prompts are queued as follow-ups.
    for text in ["first", "second"] {
        command_tx
            .send(Ok(ClientMessage::FollowUp {
                id: None,
                message: text.into(),
            }))
            .unwrap();
        let frame = next_command(&mut frames).await;
        assert_eq!(frame["type"], "follow_up");
        write_record(
            &mut to_child,
            json!({"type":"response","command":"follow_up","success":true,"id":frame["id"].as_str().unwrap(),"data":{"disposition":"queued"}}),
        )
        .await;
        let _ = next_message(&mut received).await;
    }

    // pi pushes the complete queue.
    write_record(
        &mut to_child,
        json!({"type":"queue_update","steering":[],"followUp":["first","second"]}),
    )
    .await;
    controls.apply(&next_message(&mut received).await);
    assert_eq!(controls.queue.get().follow_up.len(), 2, "both prompts queued");

    // Clear queue: the removed text goes back to the editor.
    command_tx
        .send(Ok(ClientMessage::ClearQueue { id: None }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "clear_queue");
    write_record(
        &mut to_child,
        json!({"type":"response","command":"clear_queue","success":true,"id":frame["id"].as_str().unwrap(),"data":{"steering":[],"followUp":["first","second"]}}),
    )
    .await;
    controls.apply(&next_message(&mut received).await);
    assert!(controls.queue.get().is_empty(), "cleared queue is empty");
    assert_eq!(controls.draft.get(), "first\nsecond");

    // Stop is its own control: `abort` does not clear the queue.
    command_tx.send(Ok(ClientMessage::Abort { id: None })).unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "abort");
    write_record(
        &mut to_child,
        json!({"type":"response","command":"abort","success":true,"id":frame["id"].as_str().unwrap()}),
    )
    .await;
    let _ = next_message(&mut received).await;

    drop(command_tx);
    let _ = relay.await;
}

/// AC1: a pre-0.84.4 runtime rejects `clear_queue`; the failure is surfaced,
/// never a silent no-op.
#[tokio::test]
async fn controls_relay_surfaces_a_rejected_clear_queue() {
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay) = spawn_relay(&client);
    let controls = controls();

    command_tx
        .send(Ok(ClientMessage::ClearQueue { id: None }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    write_record(
        &mut to_child,
        json!({"type":"response","command":"clear_queue","success":false,"id":frame["id"].as_str().unwrap(),"error":"Unknown command: clear_queue"}),
    )
    .await;
    let message = next_message(&mut received).await;
    match &message {
        ServerMessage::CommandResponse {
            success, data, ..
        } => {
            assert!(!success);
            assert!(data.is_none());
        }
        other => panic!("expected a command response, got {other:?}"),
    }
    controls.apply(&message);
    assert!(controls
        .notice
        .get()
        .unwrap()
        .contains("Unknown command: clear_queue"));

    drop(command_tx);
    let _ = relay.await;
}

/// AC2: the model picker lists pi's models and reflects the echoed selection;
/// an exhausted scoped cycle is tolerated.
#[tokio::test]
async fn controls_journey_model_picker() {
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay) = spawn_relay(&client);
    let controls = controls();

    command_tx
        .send(Ok(ClientMessage::GetAvailableModels { id: None }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "get_available_models");
    write_record(
        &mut to_child,
        json!({"type":"response","command":"get_available_models","success":true,"id":frame["id"].as_str().unwrap(),"data":{"models":[{"id":"claude","name":"Claude","provider":"anthropic","reasoning":true}]}}),
    )
    .await;
    controls.apply(&next_message(&mut received).await);
    assert_eq!(controls.models.get().len(), 1);

    command_tx
        .send(Ok(ClientMessage::SetModel {
            id: None,
            provider: "anthropic".into(),
            model_id: "claude".into(),
        }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "set_model");
    assert_eq!(frame["provider"], "anthropic");
    assert_eq!(frame["modelId"], "claude");
    write_record(
        &mut to_child,
        json!({"type":"response","command":"set_model","success":true,"id":frame["id"].as_str().unwrap(),"data":{"id":"claude","name":"Claude","provider":"anthropic","reasoning":true}}),
    )
    .await;
    controls.apply(&next_message(&mut received).await);
    assert_eq!(controls.model.get().unwrap().id, "claude");

    // Quick toggle: an exhausted scoped cycle returns null and changes nothing.
    command_tx
        .send(Ok(ClientMessage::CycleModel { id: None }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "cycle_model");
    write_record(
        &mut to_child,
        json!({"type":"response","command":"cycle_model","success":true,"id":frame["id"].as_str().unwrap(),"data":null}),
    )
    .await;
    controls.apply(&next_message(&mut received).await);
    assert_eq!(controls.model.get().unwrap().id, "claude");
    assert!(controls.notice.get().is_none());

    drop(command_tx);
    let _ = relay.await;
}

/// AC4: the bash frame carries the browser id; execution updates for that id
/// assemble into whole lines; concurrent commands do not cross streams.
#[tokio::test]
async fn controls_journey_inline_shell_streams_by_id() {
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay) = spawn_relay(&client);
    let controls = controls();

    for id in ["b1", "b2"] {
        command_tx
            .send(Ok(ClientMessage::Bash {
                id: id.into(),
                command: format!("echo {id}"),
                exclude_from_context: None,
            }))
            .unwrap();
    }
    // Two concurrent bash commands: both ids land on the wire verbatim.
    let mut seen = Vec::new();
    for _ in 0..2 {
        let frame = next_command(&mut frames).await;
        assert_eq!(frame["type"], "bash");
        seen.push(frame["id"].as_str().unwrap().to_string());
    }
    seen.sort();
    assert_eq!(seen, ["b1", "b2"]);

    // Chunks arrive out of order across ids but assemble per id.
    write_record(
        &mut to_child,
        json!({"type":"bash_execution_update","id":"b1","delta":"hel"}),
    )
    .await;
    write_record(
        &mut to_child,
        json!({"type":"bash_execution_update","id":"b2","delta":"two\n"}),
    )
    .await;
    write_record(
        &mut to_child,
        json!({"type":"bash_execution_update","id":"b1","delta":"lo\n"}),
    )
    .await;
    for _ in 0..3 {
        controls.apply(&next_message(&mut received).await);
    }
    let logs = controls.bash.get();
    assert_eq!(logs.get("b1").unwrap().lines(), &["hello"]);
    assert_eq!(logs.get("b2").unwrap().lines(), &["two"]);

    // Stop is global in pi; the frame still carries the browser id.
    command_tx
        .send(Ok(ClientMessage::AbortBash { id: None }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "abort_bash");

    drop(command_tx);
    let _ = relay.await;
}

/// AC3/AC5: stats after a settle, and the retry banner driven by events.
#[tokio::test]
async fn controls_journey_stats_and_retry_banner() {
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay) = spawn_relay(&client);
    let controls = controls();

    // Handshake first: the relay subscribes to pi events when it starts, so a
    // write before that would race the subscription and be lost.
    command_tx
        .send(Ok(ClientMessage::GetState { id: None }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    write_record(
        &mut to_child,
        json!({"type":"response","command":"get_state","success":true,"id":frame["id"].as_str().unwrap()}),
    )
    .await;
    let _ = next_message(&mut received).await;

    write_record(&mut to_child, json!({"type":"agent_settled"})).await;
    assert!(matches!(
        next_message(&mut received).await,
        ServerMessage::Event { .. }
    ));

    command_tx
        .send(Ok(ClientMessage::GetSessionStats { id: None }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "get_session_stats");
    write_record(
        &mut to_child,
        json!({
            "type":"response","command":"get_session_stats","success":true,
            "id":frame["id"].as_str().unwrap(),
            "data":{
                "sessionId":"s","totalMessages":4,"toolCalls":3,
                "tokens":{"input":10,"output":2,"total":12},"cost":0.45,
                "contextUsage":{"tokens":100,"contextWindow":200000,"percent":0.05}
            }
        }),
    )
    .await;
    controls.apply(&next_message(&mut received).await);
    let stats = controls.stats.get().unwrap();
    assert_eq!(stats.tokens.total, 12);
    assert_eq!(stats.cost, 0.45);
    assert_eq!(stats.context_usage.unwrap().percent, Some(0.05));

    write_record(
        &mut to_child,
        json!({"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529"}),
    )
    .await;
    controls.apply(&next_message(&mut received).await);
    assert_eq!(controls.retry.get().unwrap().max_attempts, 3);

    write_record(
        &mut to_child,
        json!({"type":"auto_retry_end","success":true,"attempt":2}),
    )
    .await;
    controls.apply(&next_message(&mut received).await);
    assert!(controls.retry.get().is_none());

    drop(command_tx);
    let _ = relay.await;
}

/// AC1/AC2/AC3 journey: the relay answers harness commands locally — list scans
/// the shared dir, resume resolves a validated in-dir path, a claim refuses the
/// attach, and stop aborts then marker-kills the exact child.
#[tokio::test]
async fn controls_journey_session_list_resume_and_stop() {
    use cheasee_pi_ui::pi_process::PidRegistry;
    use cheasee_pi_ui::sessions_store::SessionsStore;

    let (client, mut to_child, mut frames) = harness();
    let dir = std::env::temp_dir().join(format!(
        "cheasee-pi-ui-controls-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let cwd = dir.to_string_lossy().into_owned();
    std::fs::write(
        dir.join("aaaa.jsonl"),
        format!("{{\"type\":\"session\",\"id\":\"aaaa\",\"cwd\":{cwd:?}}}\n"),
    )
    .unwrap();
    let registry = Arc::new(PidRegistry::new());
    let store = Arc::new(SessionsStore::new(
        dir.as_path(),
        dir.join(".cheasee-inuse"),
        Arc::clone(&registry),
    ));

    let (command_tx, mut received, sink) = fake();
    let session = Arc::new(Session::with_store(Arc::clone(&client), Some(store)));
    let relay = tokio::spawn(async move { session.relay(sink).await });

    // List: answered locally, never forwarded to pi.
    command_tx
        .send(Ok(ClientMessage::ListSessions {
            id: Some("c1".into()),
        }))
        .unwrap();
    match next_message(&mut received).await {
        ServerMessage::SessionList { id, sessions } => {
            assert_eq!(id.as_deref(), Some("c1"));
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].id, "aaaa");
            assert!(!sessions[0].in_use);
        }
        other => panic!("expected a session list, got {other:?}"),
    }

    // Resume: the store resolves the path and sends switch_session to pi.
    command_tx
        .send(Ok(ClientMessage::ResumeSession {
            id: None,
            session_id: "aaaa".into(),
            mode: Some("resume".into()),
            entry_id: None,
        }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "switch_session");
    assert_eq!(
        frame["sessionPath"].as_str().unwrap(),
        dir.join("aaaa.jsonl").to_string_lossy()
    );
    match next_message(&mut received).await {
        ServerMessage::SessionAction {
            success,
            session_id,
            ..
        } => {
            assert!(success);
            assert_eq!(session_id, "aaaa");
        }
        other => panic!("expected a session action, got {other:?}"),
    }

    // A terminal claim refuses the attach.
    std::fs::create_dir_all(dir.join(".cheasee-inuse")).unwrap();
    std::fs::write(dir.join(".cheasee-inuse").join("aaaa"), b"{}").unwrap();
    command_tx
        .send(Ok(ClientMessage::ResumeSession {
            id: None,
            session_id: "aaaa".into(),
            mode: Some("resume".into()),
            entry_id: None,
        }))
        .unwrap();
    match next_message(&mut received).await {
        ServerMessage::SessionAction {
            success, error, ..
        } => {
            assert!(!success);
            assert!(error.unwrap().contains("in use"));
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    std::fs::remove_file(dir.join(".cheasee-inuse").join("aaaa")).unwrap();

    // Stop with no registered child: abort is sent, and the miss is surfaced.
    command_tx
        .send(Ok(ClientMessage::StopSession {
            id: None,
            session_id: "aaaa".into(),
        }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "abort");
    match next_message(&mut received).await {
        ServerMessage::SessionAction { success, error, .. } => {
            assert!(!success);
            assert!(error.unwrap().contains("no live child"));
        }
        other => panic!("expected a stop action, got {other:?}"),
    }

    drop(command_tx);
    let _ = relay.await;
}

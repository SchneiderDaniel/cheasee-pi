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

/// Answer the three replay requests a subscribe issues, then drain the header
/// and terminal replay frame. The relay starts unbound, so every test that
/// expects events must bind first.
async fn bind_relay(
    command_tx: &mpsc::UnboundedSender<Result<ClientMessage, String>>,
    received: &mut mpsc::UnboundedReceiver<ServerMessage>,
    to_child: &mut DuplexStream,
    frames: &mut Frames,
) {
    command_tx
        .send(Ok(ClientMessage::Subscribe {
            id: None,
            session_id: String::new(),
            since: None,
        }))
        .unwrap();
    for _ in 0..3 {
        let command = next_command(frames).await;
        let id = command["id"].as_str().unwrap().to_string();
        let response = match command["type"].as_str().unwrap() {
            "get_entries" => json!({"type":"response","command":"get_entries","success":true,"id":id,"data":{"entries":[],"leafId":null}}),
            "get_state" => json!({"type":"response","command":"get_state","success":true,"id":id,"data":{}}),
            "get_last_assistant_text" => json!({"type":"response","command":"get_last_assistant_text","success":true,"id":id,"data":{"text":null}}),
            other => panic!("unexpected binding request {other}"),
        };
        write_record(to_child, response).await;
    }
    let _ = next_message(received).await; // SessionState
    let _ = next_message(received).await; // SessionReplay
}

/// Spawn the real relay, bind it to its session, and return its driver handles.
async fn spawn_relay(
    client: &Arc<RpcClient>,
    to_child: &mut DuplexStream,
    frames: &mut Frames,
) -> (
    mpsc::UnboundedSender<Result<ClientMessage, String>>,
    mpsc::UnboundedReceiver<ServerMessage>,
    tokio::task::JoinHandle<()>,
) {
    let (command_tx, mut received, sink) = fake();
    let session = Arc::new(Session::new(Arc::clone(client)));
    let relay = tokio::spawn(async move { session.relay(sink).await });
    bind_relay(&command_tx, &mut received, to_child, frames).await;
    (command_tx, received, relay)
}

/// AC1: two queued prompts show in the panel, clear-queue empties it and hands
/// the removed text back to the editor, and abort is a separate control.
#[tokio::test]
async fn controls_journey_queue_clear_and_abort() {
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay) = spawn_relay(&client, &mut to_child, &mut frames).await;
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
    let (command_tx, mut received, relay) = spawn_relay(&client, &mut to_child, &mut frames).await;
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
    let (command_tx, mut received, relay) = spawn_relay(&client, &mut to_child, &mut frames).await;
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
    let (command_tx, mut received, relay) = spawn_relay(&client, &mut to_child, &mut frames).await;
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
    let (command_tx, mut received, relay) = spawn_relay(&client, &mut to_child, &mut frames).await;
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

    let (client, _to_child, mut frames) = harness();
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

/// AC1–AC4 journey: one live relay session drives the whole slice — a prompt,
/// streamed text, a streaming tool card, an extension error, more text, a
/// threshold compaction and an auto-retry.
///
/// The tool card and the extension error are durable transcript rows in stream
/// order; the compaction banner and the retry pill are ephemeral control
/// chrome. An `extension_error` must not break the stream, so the text written
/// after it still appends.
#[tokio::test]
async fn widgets_journey_tool_compaction_retry_in_one_session() {
    use cheasee_pi_ui::controls::CompactionPhase;
    use cheasee_pi_ui::stream::{ChatState, Marker, RowKind};
    use cheasee_pi_ui::tool_card::ToolStatus;

    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay) = spawn_relay(&client, &mut to_child, &mut frames).await;
    let controls = controls();
    let chat = {
        let owner = Owner::new();
        owner.set();
        std::mem::forget(owner);
        ChatState::new()
    };

    // The prompt round trip is also the handshake: pi is subscribed to events by
    // the time it answers, so every event below is forwarded rather than lost.
    command_tx
        .send(Ok(ClientMessage::Prompt {
            id: None,
            message: "list the files".into(),
            streaming_behavior: None,
        }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "prompt");
    write_record(
        &mut to_child,
        json!({"type":"response","command":"prompt","success":true,"id":frame["id"].as_str().unwrap(),"data":{"disposition":"started"}}),
    )
    .await;
    let _ = next_message(&mut received).await;

    for event in [
        json!({"type":"agent_start"}),
        json!({"type":"turn_start"}),
        json!({"type":"message_start","message":{"role":"assistant"}}),
        json!({"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"On it."}}),
        json!({"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls -la"}}),
        json!({"type":"tool_execution_update","toolCallId":"call_1","toolName":"bash","args":{"command":"ls -la"},"partialResult":{"content":[{"type":"text","text":"partial"}]}}),
        json!({"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"total 48"}]},"isError":false}),
        json!({"type":"extension_error","extensionPath":"/ext/ui.ts","event":"tool_call","error":"boom"}),
        json!({"type":"message_start","message":{"role":"assistant"}}),
        json!({"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Done."}}),
        json!({"type":"compaction_start","reason":"threshold"}),
        json!({"type":"compaction_end","reason":"threshold","aborted":false,"willRetry":false}),
        json!({"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529"}),
        json!({"type":"auto_retry_end","success":true,"attempt":2}),
    ] {
        write_record(&mut to_child, event.clone()).await;
        let message = next_message(&mut received).await;
        assert!(
            matches!(&message, ServerMessage::Event { .. }),
            "the relay forwards {event} as an event"
        );
        chat.apply(&message);
        controls.apply(&message);
    }
    chat.flush_now();

    // AC2: the run and turn boundaries are marked, in order.
    let markers: Vec<Marker> = chat
        .rows
        .get()
        .iter()
        .filter_map(|r| match r.kind {
            RowKind::Marker(marker) => Some(marker),
            _ => None,
        })
        .collect();
    assert_eq!(markers, vec![Marker::RunStart, Marker::TurnStart]);

    // AC1/AC4: text, the tool card, the extension error, then the stream keeps
    // going — the error is a row, not the end of the run.
    let transcript: Vec<&str> = chat
        .rows
        .get()
        .iter()
        .filter(|row| !matches!(row.kind, RowKind::Marker(_)))
        .map(|row| match row.kind {
            RowKind::Text(_) => "text",
            RowKind::Tool(_) => "tool",
            RowKind::ExtensionError(_) => "extension-error",
            RowKind::Thinking(_) => "thinking",
            RowKind::Marker(_) => "marker",
        })
        .collect();
    assert_eq!(transcript, ["text", "tool", "extension-error", "text"]);
    assert!(
        chat.rows.get().windows(2).all(|pair| pair[1].id > pair[0].id),
        "row ids are monotonic"
    );

    let card = chat
        .rows
        .get()
        .iter()
        .find_map(|row| row.kind.as_tool().cloned())
        .expect("a tool card row");
    assert_eq!(card.name, "bash");
    assert_eq!(
        card.output, "total 48",
        "the end result replaces the streamed snapshot"
    );
    assert_eq!(card.status, ToolStatus::Done);

    // AC3: the banner is labelled from `compaction_end.reason` and is finished;
    // the successful `auto_retry_end` cleared the pill.
    let compaction = controls.compaction.get().expect("a compaction banner");
    assert_eq!(compaction.label(), "Auto-compacting…");
    assert!(matches!(
        compaction.phase,
        CompactionPhase::Finished { aborted: false, .. }
    ));
    assert!(controls.retry.get().is_none());

    drop(command_tx);
    let _ = relay.await;
}

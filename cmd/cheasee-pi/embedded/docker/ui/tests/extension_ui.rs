//! Extension UI sub-protocol over the real relay: pi's `extension_ui_request`
//! reaches the browser, the browser's answer round-trips with pi's uuid, and
//! the client chrome state reduces every method (AC1–AC5).
//!
//! Tier: large. There is no browser/wasm harness in this crate (zero
//! `wasm-bindgen-test` occurrences repo-wide), so the assertions target the
//! public relay + client-state contract; `components/dialog.rs` and
//! `components/status.rs` are thin renderers over that state and are validated
//! manually (the issue's human-tester steps 1–5).
//!
//! Matches `tests/session_controls.rs` exactly: native `#[tokio::test]`,
//! `ssr` feature, no new dev-dependency.

#![cfg(feature = "ssr")]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use cheasee_pi_ui::bridge::{ClientMessage, ServerMessage};
use cheasee_pi_ui::controls::ControlsState;
use cheasee_pi_ui::extension_ui::{ExtensionUiState, PendingDialog};
use cheasee_pi_ui::protocol::{ExtensionUI, ExtensionUiRequest};
use cheasee_pi_ui::rpc::framing::{encode_record, JsonlReader};
use cheasee_pi_ui::rpc::RpcClient;
use cheasee_pi_ui::session::{ClientSink, Session};
use leptos::prelude::{Get, Owner};
use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::mpsc;

const BOUND: Duration = Duration::from_secs(2);
/// How long "nothing arrived" is proven for. Kept under the 2s success bound,
/// over the relay's scheduling latency.
const QUIET: Duration = Duration::from_millis(150);

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
/// stdout, the returned frames reader is the child's stdin.
fn harness() -> (Arc<RpcClient>, DuplexStream, Frames) {
    let (stdout_tx, stdout_rx) = tokio::io::duplex(1 << 20);
    let (stdin_tx, from_child) = tokio::io::duplex(1 << 20);
    let client = Arc::new(RpcClient::new(Box::new(stdout_rx), Box::new(stdin_tx)));
    (client, stdout_tx, JsonlReader::new(BufReader::new(from_child)))
}

async fn write_record(to_child: &mut DuplexStream, value: Value) {
    // Let the relay task reach its first poll (and subscribe to the event
    // broadcast) before a record can land in the child's stdout. Without this
    // the broadcast would deliver to no receiver yet and the frame is lost.
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
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

/// Assert no child frame arrives: a non-pending answer and a fire-and-forget
/// request must write nothing.
async fn assert_no_command(frames: &mut Frames) {
    assert!(
        tokio::time::timeout(QUIET, frames.next_record_str()).await.is_err(),
        "an unexpected frame was written to pi"
    );
}

async fn next_message(received: &mut mpsc::UnboundedReceiver<ServerMessage>) -> ServerMessage {
    tokio::time::timeout(BOUND, received.recv())
        .await
        .expect("a server message within 2s")
        .expect("browser channel open")
}

/// Assert no server frame arrives (e.g. no `CommandResponse` for an answer).
async fn assert_no_message(received: &mut mpsc::UnboundedReceiver<ServerMessage>) {
    assert!(
        tokio::time::timeout(QUIET, received.recv()).await.is_err(),
        "an unexpected server message was relayed"
    );
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
    Arc<Session>,
) {
    let (command_tx, mut received, sink) = fake();
    let session = Arc::new(Session::new(Arc::clone(client)));
    let session_for_test = Arc::clone(&session);
    let relay = tokio::spawn(async move { session.relay(sink).await });
    bind_relay(&command_tx, &mut received, to_child, frames).await;
    (command_tx, received, relay, session_for_test)
}

/// A reactive owner that outlives the test's signals.
fn owner() -> Owner {
    let owner = Owner::new();
    owner.set();
    owner
}

fn controls() -> ControlsState {
    ControlsState::new()
}

fn state_with_draft() -> (ControlsState, ExtensionUiState) {
    let controls = controls();
    let state = ExtensionUiState::new(controls.draft);
    (controls, state)
}

fn fixture_values(name: &str) -> Vec<Value> {
    let raw = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name),
    )
    .expect("fixture is readable");
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("fixture line is JSON"))
        .collect()
}

fn request(id: &str, method: &str, extra: Value) -> Value {
    let mut value = json!({"type": "extension_ui_request", "id": id, "method": method});
    if let (Some(map), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
        for (key, entry) in extra {
            map.insert(key.clone(), entry.clone());
        }
    }
    value
}

fn response(id: &str, value: Option<&str>, confirmed: Option<bool>, cancelled: Option<bool>) -> ClientMessage {
    ClientMessage::ExtensionUiResponse {
        id: id.into(),
        value: value.map(str::to_string),
        confirmed,
        cancelled,
    }
}

// ── Phase 1: wire envelopes decode and re-encode losslessly ─────────────────

#[test]
fn extension_ui_server_message_round_trips() {
    let raw = json!({
        "type": "extension_ui",
        "request": {
            "type": "extension_ui_request",
            "id": "uuid-1",
            "method": "select",
            "title": "Allow dangerous command?",
            "options": ["Allow", "Block"],
            "timeout": 10000
        }
    });
    // pi's record and the browser envelope share the inner shape; decode the
    // inner request first, then wrap it.
    let request: ExtensionUiRequest =
        serde_json::from_value(raw["request"].clone()).expect("request decodes");
    assert_eq!(request.id, "uuid-1");
    assert_eq!(request.method, "select");
    assert_eq!(request.params["options"][1], "Block");

    let message = ServerMessage::ExtensionUi { request };
    let encoded = serde_json::to_value(&message).unwrap();
    assert_eq!(encoded["type"], "extension_ui");
    assert_eq!(encoded["request"]["id"], "uuid-1");
    assert_eq!(encoded["request"]["method"], "select");
    assert_eq!(encoded["request"]["options"][1], "Block");
    assert_eq!(encoded["request"]["timeout"], 10000);

    let text = serde_json::to_string(&message).unwrap();
    let decoded: ServerMessage = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{text}: {e}"));
    assert_eq!(decoded, message);
}

#[test]
fn extension_ui_unknown_server_message_decodes_as_unknown() {
    let message: ServerMessage =
        serde_json::from_value(json!({"type": "a_future_envelope"})).unwrap();
    assert_eq!(message, ServerMessage::Unknown);
}

#[test]
fn extension_ui_response_shapes_serialize_with_exactly_one_key() {
    let value = serde_json::to_value(response("uuid-1", Some("Allow"), None, None)).unwrap();
    assert_eq!(value["type"], "extension_ui_response");
    assert_eq!(value["id"], "uuid-1");
    assert_eq!(value["value"], "Allow");
    assert!(value.get("confirmed").is_none(), "{value}");
    assert!(value.get("cancelled").is_none(), "{value}");

    let value = serde_json::to_value(response("uuid-2", None, Some(true), None)).unwrap();
    assert_eq!(value["confirmed"], true);
    assert!(value.get("value").is_none(), "{value}");
    assert!(value.get("cancelled").is_none(), "{value}");

    let value = serde_json::to_value(response("uuid-3", None, None, Some(true))).unwrap();
    assert_eq!(value["cancelled"], true);
    assert!(value.get("value").is_none(), "{value}");
    assert!(value.get("confirmed").is_none(), "{value}");
}

// ── Phase 2: relay forwards requests to the browser ─────────────────────────

#[tokio::test]
async fn extension_ui_relay_forwards_each_method_unmutated() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, _session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    let requests: Vec<ExtensionUiRequest> = fixture_values("extension_ui.jsonl")
        .into_iter()
        .filter(|v| v["type"] == "extension_ui_request")
        .map(|v| match serde_json::from_value::<ExtensionUI>(v.clone()) {
            Ok(ExtensionUI::ExtensionUiRequest(request)) => request,
            other => panic!("fixture is not a request: {other:?}"),
        })
        .collect();
    assert_eq!(requests.len(), 9, "captured method corpus changed");

    for expected in requests {
        // Re-attach the envelope tag the fixture line carries; `ExtensionUiRequest`
        // itself only serializes the payload (`id`, `method`, flattened params).
        let mut raw = serde_json::to_value(&expected).unwrap();
        raw.as_object_mut()
            .unwrap()
            .insert("type".into(), json!("extension_ui_request"));
        write_record(&mut to_child, raw).await;
        match next_message(&mut received).await {
            ServerMessage::ExtensionUi { request } => {
                assert_eq!(request, expected, "request was mutated in transit");
            }
            other => panic!("expected an extension UI request, got {other:?}"),
        }
    }

    drop(command_tx);
    let _ = relay.await;
}

// ── Phase 3: answer round-trip and pending state ────────────────────────────

#[tokio::test]
async fn extension_ui_answer_writes_response_and_no_command_response() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(
        &mut to_child,
        request("uuid-1", "select", json!({"title": "x", "options": ["Allow", "Block"], "timeout": 1000})),
    )
    .await;
    let _ = next_message(&mut received).await;
    assert_eq!(session.pending_dialog().unwrap().id, "uuid-1");

    command_tx
        .send(Ok(response("uuid-1", Some("Block"), None, None)))
        .unwrap();

    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "extension_ui_response");
    assert_eq!(frame["id"], "uuid-1");
    assert_eq!(frame["value"], "Block", "select answers with the option string");
    assert!(frame.get("confirmed").is_none(), "{frame}");

    assert!(session.pending_dialog().is_none(), "the slot clears on answer");
    assert_no_message(&mut received).await;

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_confirm_shapes_reach_pi() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, _session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(&mut to_child, request("c1", "confirm", json!({"title": "Go?"}))).await;
    let _ = next_message(&mut received).await;
    command_tx.send(Ok(response("c1", None, Some(true), None))).unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "extension_ui_response");
    assert_eq!(frame["id"], "c1");
    assert_eq!(frame["confirmed"], true);
    assert!(frame.get("value").is_none(), "{frame}");

    write_record(&mut to_child, request("c2", "confirm", json!({"title": "Go?"}))).await;
    let _ = next_message(&mut received).await;
    command_tx.send(Ok(response("c2", None, None, Some(true)))).unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["cancelled"], true);
    assert!(frame.get("value").is_none(), "{frame}");
    assert!(frame.get("confirmed").is_none(), "{frame}");

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_newest_blocking_replaces_pending() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(&mut to_child, request("first", "input", json!({"title": "a"}))).await;
    let _ = next_message(&mut received).await;
    write_record(&mut to_child, request("second", "select", json!({"options": ["a"]}))).await;
    let _ = next_message(&mut received).await;

    assert_eq!(
        session.pending_dialog().map(|r| r.id),
        Some("second".to_string()),
        "the newest blocking request occupies the single slot"
    );

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_non_pending_answer_writes_nothing() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    // An answer for a request that never occupied the slot (a `notify` id).
    write_record(
        &mut to_child,
        request("toast", "notify", json!({"message": "hi", "notifyType": "info"})),
    )
    .await;
    let _ = next_message(&mut received).await;
    assert!(session.pending_dialog().is_none());

    command_tx.send(Ok(response("toast", Some("Allow"), None, None))).unwrap();
    assert_no_command(&mut frames).await;
    assert_no_message(&mut received).await;

    // The relay keeps serving: a following event still arrives.
    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    match next_message(&mut received).await {
        ServerMessage::Event { .. } => {}
        other => panic!("relay stopped serving after a non-pending answer: {other:?}"),
    }

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_timeout_decodes_and_editor_has_none() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(&mut to_child, request("s", "select", json!({"options": ["a"], "timeout": 2500}))).await;
    let _ = next_message(&mut received).await;
    let pending = PendingDialog::from(&session.pending_dialog().unwrap());
    assert_eq!(pending.timeout(), Some(2500));

    write_record(&mut to_child, request("e", "editor", json!({"title": "edit"}))).await;
    let _ = next_message(&mut received).await;
    let pending = PendingDialog::from(&session.pending_dialog().unwrap());
    assert_eq!(pending.id, "e");
    assert_eq!(pending.timeout(), None, "editor never carries a timeout");

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_notify_never_occupies_the_pending_slot() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(
        &mut to_child,
        request("toast", "notify", json!({"message": "blocked"})),
    )
    .await;
    let _ = next_message(&mut received).await;
    assert!(session.pending_dialog().is_none(), "notify is fire-and-forget");

    write_record(&mut to_child, request("dialog", "confirm", json!({"title": "Go?"}))).await;
    let _ = next_message(&mut received).await;
    assert_eq!(session.pending_dialog().map(|r| r.id), Some("dialog".to_string()));

    drop(command_tx);
    let _ = relay.await;
}

// ── Phase 4: client chrome state ────────────────────────────────────────────

#[test]
fn extension_ui_notify_appends_toast_and_defaults_type() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    assert!(state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("t1", "notify", json!({"message": "blocked", "notifyType": "warning"}))).unwrap()
    }));
    assert!(state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("t2", "notify", json!({"message": "plain"}))).unwrap()
    }));

    let toasts = state.toasts.get();
    assert_eq!(toasts.len(), 2);
    assert_eq!(toasts[0].message, "blocked");
    assert_eq!(toasts[0].notify_type, "warning");
    assert_eq!(toasts[1].notify_type, "info", "a missing notifyType defaults to info");
}

#[test]
fn extension_ui_dismiss_toast_removes_only_that_toast() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    for (id, message) in [("t1", "one"), ("t2", "two")] {
        state.apply(&ServerMessage::ExtensionUi {
            request: serde_json::from_value(request(id, "notify", json!({"message": message}))).unwrap(),
        });
    }
    state.dismiss_toast("t1");
    let toasts = state.toasts.get();
    assert_eq!(toasts.len(), 1);
    assert_eq!(toasts[0].id, "t2");
}

#[test]
fn extension_ui_set_status_replaces_same_key() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("s1", "setStatus", json!({"statusKey": "my-ext", "statusText": "Turn 3 running..."}))).unwrap(),
    });
    assert_eq!(state.statuses.get().get("my-ext").map(String::as_str), Some("Turn 3 running..."));

    state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("s2", "setStatus", json!({"statusKey": "my-ext", "statusText": "idle"}))).unwrap(),
    });
    assert_eq!(state.statuses.get().get("my-ext").map(String::as_str), Some("idle"));
}

#[test]
fn extension_ui_set_widget_stores_lines_and_placement() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("w1", "setWidget", json!({"widgetKey": "w", "widgetLines": ["a"], "widgetPlacement": "aboveEditor"}))).unwrap(),
    });
    let widgets = state.widgets.get();
    let widget = widgets.get("w").expect("widget stored");
    assert_eq!(widget.lines, vec!["a".to_string()]);
    assert_eq!(widget.placement, "aboveEditor");
}

#[test]
fn extension_ui_set_title_stores_title() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("title", "setTitle", json!({"title": "New title"}))).unwrap(),
    });
    assert_eq!(state.title.get(), Some("New title".to_string()));
}

#[test]
fn extension_ui_set_editor_text_writes_draft_and_is_case_sensitive() {
    let _owner = owner();
    let (controls, state) = state_with_draft();

    state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("d1", "set_editor_text", json!({"text": "draft"}))).unwrap(),
    });
    assert_eq!(controls.draft.get(), "draft");

    // Wrong case: exact-match dispatch must ignore it, leaving the draft alone.
    state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("d2", "setEditorText", json!({"text": "clobbered"}))).unwrap(),
    });
    assert_eq!(controls.draft.get(), "draft");
}

#[test]
fn extension_ui_tui_only_methods_are_ignored() {
    let _owner = owner();
    let (controls, state) = state_with_draft();

    for method in ["custom", "setFooter", "setHeader"] {
        let changed = state.apply(&ServerMessage::ExtensionUi {
            request: serde_json::from_value(request("x", method, json!({"text": "ignored"}))).unwrap(),
        });
        assert!(!changed, "{method} must be a no-op");
    }
    assert!(state.dialog.get().is_none());
    assert!(state.toasts.get().is_empty());
    assert!(state.statuses.get().is_empty());
    assert!(state.widgets.get().is_empty());
    assert!(state.title.get().is_none());
    assert_eq!(controls.draft.get(), "");
}

#[test]
fn extension_ui_ingest_frame_decodes_and_ignores_malformed() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    assert!(state.ingest_frame(
        r#"{"type":"extension_ui","request":{"type":"extension_ui_request","id":"f1","method":"confirm","title":"Go?"}}"#
    ));
    assert_eq!(state.dialog.get().map(|d| d.id), Some("f1".to_string()));

    assert!(!state.ingest_frame("not json"), "a malformed frame must not panic");
}

// ── Phase 5: user journey ───────────────────────────────────────────────────

#[tokio::test]
async fn extension_ui_operator_journey_confirm() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;
    let (controls, state) = state_with_draft();
    let _ = controls;

    // pi asks a blocking question; the browser shows it.
    write_record(&mut to_child, request("c1", "confirm", json!({"title": "Allow?"}))).await;
    let message = next_message(&mut received).await;
    assert!(state.apply(&message));
    assert_eq!(state.dialog.get().unwrap().id, "c1");
    assert_eq!(session.pending_dialog().map(|r| r.id), Some("c1".to_string()));

    // The operator answers; the frame carries pi's uuid and no other shape.
    command_tx
        .send(Ok(response("c1", None, Some(true), None)))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["id"], "c1");
    assert_eq!(frame["confirmed"], true);
    state.clear_dialog();
    assert!(state.dialog.get().is_none());

    // The run continues: a following pi event still arrives.
    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    match next_message(&mut received).await {
        ServerMessage::Event { .. } => {}
        other => panic!("expected a following event, got {other:?}"),
    }

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_operator_mixed_chrome_journey() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, _session) = spawn_relay(&client, &mut to_child, &mut frames).await;
    let (controls, state) = state_with_draft();

    for raw in [
        request("n1", "notify", json!({"message": "blocked", "notifyType": "warning"})),
        request("s1", "setStatus", json!({"statusKey": "my-ext", "statusText": "Turn 3 running..."})),
        request("d1", "set_editor_text", json!({"text": "draft"})),
        request("q1", "select", json!({"title": "Pick", "options": ["a", "b"]})),
    ] {
        write_record(&mut to_child, raw).await;
        let message = next_message(&mut received).await;
        assert!(state.apply(&message));
    }

    assert_eq!(controls.draft.get(), "draft");
    assert_eq!(state.statuses.get().get("my-ext").map(String::as_str), Some("Turn 3 running..."));
    assert_eq!(state.toasts.get().len(), 1);
    assert_eq!(state.dialog.get().map(|d| d.id), Some("q1".to_string()));

    command_tx.send(Ok(response("q1", Some("b"), None, None))).unwrap();
    state.clear_dialog();

    // Answering the dialog must not disturb the transient chrome.
    assert!(state.dialog.get().is_none());
    assert_eq!(state.toasts.get().len(), 1);
    assert_eq!(state.statuses.get().get("my-ext").map(String::as_str), Some("Turn 3 running..."));

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_reconnect_seam_keeps_pending_request() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(&mut to_child, request("keep", "editor", json!({"title": "Edit"}))).await;
    let _ = next_message(&mut received).await;

    // Unrelated traffic after the blocking request must not disturb the slot.
    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    let _ = next_message(&mut received).await;

    assert_eq!(
        session.pending_dialog().map(|r| r.id),
        Some("keep".to_string()),
        "slice 9's get_state can re-show this request"
    );

    drop(command_tx);
    let _ = relay.await;
}

// ── Phase 6: boundaries and forward-compat ──────────────────────────────────

#[tokio::test]
async fn extension_ui_duplicate_late_answer_is_tolerated() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(&mut to_child, request("q1", "select", json!({"options": ["x"]}))).await;
    let _ = next_message(&mut received).await;
    command_tx.send(Ok(response("q1", Some("x"), None, None))).unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["id"], "q1");

    // The same answer again, after the slot cleared: no panic, no second frame.
    command_tx.send(Ok(response("q1", Some("x"), None, None))).unwrap();
    assert_no_command(&mut frames).await;
    assert!(session.pending_dialog().is_none());

    drop(command_tx);
    let _ = relay.await;
}

#[test]
fn extension_ui_missing_required_fields_do_not_clear_unrelated_state() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("s1", "setStatus", json!({"statusKey": "k", "statusText": "live"}))).unwrap(),
    });
    state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("w1", "setWidget", json!({"widgetKey": "w", "widgetLines": ["a"], "widgetPlacement": "aboveEditor"}))).unwrap(),
    });

    // A malformed sibling must be ignored, not wipe the stored chrome.
    state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("s2", "setStatus", json!({"statusKey": "k"}))).unwrap(),
    });
    state.apply(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("w2", "setWidget", json!({"widgetKey": "w"}))).unwrap(),
    });

    assert_eq!(state.statuses.get().get("k").map(String::as_str), Some("live"));
    assert_eq!(state.widgets.get().get("w").map(|w| w.lines.len()), Some(1));
}

#[tokio::test]
async fn extension_ui_fire_and_forget_never_emits_a_response() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, _session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(
        &mut to_child,
        request("uuid-6", "setStatus", json!({"statusKey": "k", "statusText": "running"})),
    )
    .await;
    let _ = next_message(&mut received).await;

    // Nothing is written back for its minted uuid.
    assert_no_command(&mut frames).await;

    drop(command_tx);
    let _ = relay.await;
}

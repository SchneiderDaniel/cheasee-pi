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
use cheasee_pi_ui::frame::UiSlice;
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

mod chrome;

mod state;

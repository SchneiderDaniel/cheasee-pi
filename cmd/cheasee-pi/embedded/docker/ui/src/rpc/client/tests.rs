#[path = "../tests_delivery.rs"]
mod delivery;

use super::*;
use std::path::PathBuf;
use std::time::Duration;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::time::timeout;
use crate::auth::ChildEnv;
use crate::pi_process::{spawn, PiChild, PiSpec};
use crate::protocol::ExtensionUiResponse;
use crate::test_support::unique_temp_dir;

/// A hang is a failure, not a stall: every await in these tests is bounded.
const BOUND: Duration = Duration::from_secs(2);

type Frames = JsonlReader<BufReader<DuplexStream>>;

/// Fake child: `to_child` is its stdout, `from_child` is its stdin.
pub(super) fn harness() -> (RpcClient, DuplexStream, DuplexStream) {
    let (stdout_tx, stdout_rx) = tokio::io::duplex(1 << 20);
    let (stdin_tx, stdin_rx) = tokio::io::duplex(1 << 20);
    let client = RpcClient::new(Box::new(stdout_rx), Box::new(stdin_tx));
    (client, stdout_tx, stdin_rx)
}

pub(super) fn frames(from_child: DuplexStream) -> Frames {
    JsonlReader::new(BufReader::new(from_child))
}

pub(super) async fn write_record(to_child: &mut DuplexStream, value: Value) {
    to_child
        .write_all(&encode_record(&value).unwrap())
        .await
        .unwrap();
    to_child.flush().await.unwrap();
}

async fn read_frame(frames: &mut Frames) -> Value {
    let raw = frames
        .next_record_str()
        .await
        .expect("frame read")
        .expect("frame present");
    serde_json::from_str(&raw).expect("frame is JSON")
}

pub(super) async fn next_frame(frames: &mut Frames) -> Value {
    timeout(BOUND, read_frame(frames))
        .await
        .expect("the client must emit a frame within 2s")
}

pub(super) async fn next_event(events: &mut broadcast::Receiver<ProtocolMessage>) -> ProtocolMessage {
    timeout(BOUND, events.recv())
        .await
        .expect("an event must arrive within 2s")
        .expect("event channel open")
}

/// Nothing more must arrive: used to prove a record was *not* fanned out.
pub(super) async fn assert_quiet(events: &mut broadcast::Receiver<ProtocolMessage>) {
    assert!(
        timeout(Duration::from_millis(150), events.recv()).await.is_err(),
        "an unexpected event was fanned out"
    );
}

/// Spawn a `/bin/sh` shim as the `pi` stand-in and hand its pipes to a
/// client. No real `pi` binary is needed.
pub(super) async fn spawn_shim(tag: &str, body: &str) -> (PiChild, RpcClient) {
    let dir = unique_temp_dir(&format!("cheasee-pi-rpc-test-{tag}"));
    let path = dir.join("shim.sh");
    std::fs::write(&path, body).unwrap();
    let spec = PiSpec {
        program: PathBuf::from("/bin/sh"),
        args: vec![path.to_string_lossy().into_owned()],
    };
    let mut child = spawn(&spec, &ChildEnv::none(), "sess-rpc").expect("shim spawn");
    let io = child.take_io().expect("shim pipes");
    (child, RpcClient::from_child_io(io))
}

pub(super) async fn wait_for_stderr(child: &PiChild, needle: &str) -> bool {
    let deadline = tokio::time::Instant::now() + BOUND;
    while tokio::time::Instant::now() < deadline {
        if child.stderr_snapshot().lossy().contains(needle) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

pub(super) fn abort_cmd() -> Command {
    Command::Abort { id: None }
}

// ── Slice 9: the live replay adapter (AC2/AC3) ─────────────────────────

/// Answer a `get_entries` request with `data` and return the request id.
async fn answer_entries(frames: &mut Frames, to_child: &mut DuplexStream, data: Value) -> String {
    let frame = next_frame(frames).await;
    assert_eq!(frame["type"], "get_entries");
    let id = frame["id"].as_str().unwrap().to_string();
    write_record(
        to_child,
        json!({"type":"response","command":"get_entries","success":true,"id":id,"data":data}),
    )
    .await;
    id
}

/// A malformed `entries` field must be an error, never a successful empty
/// replay that hides a gap.
#[tokio::test]
async fn replay_source_rejects_a_malformed_entries_payload() {
    let (client, mut to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);
    let source = RpcReplaySource::new(Arc::clone(&client));
    let replay = tokio::spawn(async move { source.replay(None).await });

    answer_entries(&mut frames, &mut to_child, json!({"leafId": "a"})).await;

    let err = replay.await.unwrap().unwrap_err();
    assert!(
        matches!(err, ReplayError::Failed(_)),
        "a missing entries array must fail: {err:?}"
    );
}

/// A failed `get_state` is surfaced, not silently turned into `None`.
#[tokio::test]
async fn replay_source_surfaces_a_failed_get_state() {
    let (client, mut to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);
    let source = RpcReplaySource::new(Arc::clone(&client));
    let replay = tokio::spawn(async move { source.replay(None).await });

    answer_entries(&mut frames, &mut to_child, json!({"entries": [], "leafId": null})).await;
    let frame = next_frame(&mut frames).await;
    let id = frame["id"].as_str().unwrap().to_string();
    assert_eq!(frame["type"], "get_state");
    write_record(
        &mut to_child,
        json!({"type":"response","command":"get_state","success":false,"id":id,"error":"nope"}),
    )
    .await;

    let err = replay.await.unwrap().unwrap_err();
    assert!(matches!(err, ReplayError::Failed(_)), "{err:?}");
}

/// A valid `null` in-flight text is `None` (nothing streaming), while a
/// successful response keeps the real metadata.
#[tokio::test]
async fn replay_source_keeps_a_valid_null_assistant_text() {
    let (client, mut to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);
    let source = RpcReplaySource::new(Arc::clone(&client));
    let replay = tokio::spawn(async move { source.replay(None).await });

    answer_entries(&mut frames, &mut to_child, json!({"entries": [], "leafId": null})).await;
    let frame = next_frame(&mut frames).await;
    let id = frame["id"].as_str().unwrap().to_string();
    write_record(
        &mut to_child,
        json!({"type":"response","command":"get_state","success":true,"id":id,"data":{"isStreaming":true}}),
    )
    .await;
    let frame = next_frame(&mut frames).await;
    let id = frame["id"].as_str().unwrap().to_string();
    assert_eq!(frame["type"], "get_last_assistant_text");
    write_record(
        &mut to_child,
        json!({"type":"response","command":"get_last_assistant_text","success":true,"id":id,"data":{"text":null}}),
    )
    .await;

    let data = replay.await.unwrap().unwrap();
    assert!(data.entries.is_empty());
    assert_eq!(data.state.unwrap()["isStreaming"], true);
    assert!(
        data.last_assistant_text.is_none(),
        "a valid null is None, not an error"
    );
}

// ── Phase 3: correlation and dispatch (AC2, AC5) ───────────────────────

#[tokio::test]
async fn request_assigns_strictly_monotonic_ids() {
    let (client, mut to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);

    for (expected, command, wire) in [
        ("req_1", abort_cmd(), "abort"),
        ("req_2", Command::GetState { id: None }, "get_state"),
    ] {
        let c = Arc::clone(&client);
        let pending = tokio::spawn(async move { c.request(&command).await });
        let frame = next_frame(&mut frames).await;
        assert_eq!(frame["id"], expected, "frame = {frame}");
        assert_eq!(frame["type"], wire);
        write_record(
            &mut to_child,
            json!({"type":"response","command":wire,"success":true,"id":expected}),
        )
        .await;
        assert!(pending.await.unwrap().is_ok());
    }
}

/// AC4: a caller-supplied id goes on the wire verbatim, because
/// `bash_execution_update` events repeat it.
#[tokio::test]
async fn request_with_id_writes_the_caller_id() {
    let (client, mut to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);

    let c = Arc::clone(&client);
    let pending = tokio::spawn(async move {
        c.request_with_id(
            "b1",
            &Command::Bash {
                id: None,
                command: "echo hi".into(),
                exclude_from_context: None,
            },
        )
        .await
    });
    let frame = next_frame(&mut frames).await;
    assert_eq!(frame["id"], "b1", "the caller's id must not be minted");
    assert_eq!(frame["type"], "bash");
    write_record(
        &mut to_child,
        json!({"type":"response","command":"bash","success":true,"id":"b1"}),
    )
    .await;
    assert!(pending.await.unwrap().is_ok());
}

/// A duplicate in-flight id fails fast instead of overwriting (and
/// stranding) the first sender.
#[tokio::test]
async fn request_with_id_rejects_a_duplicate() {
    let (client, mut to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);

    let c1 = Arc::clone(&client);
    let first = tokio::spawn(async move { c1.request_with_id("b1", &abort_cmd()).await });
    let frame = next_frame(&mut frames).await;
    assert_eq!(frame["id"], "b1");

    let err = client
        .request_with_id("b1", &abort_cmd())
        .await
        .expect_err("a duplicate id must be rejected");
    assert!(matches!(err, RpcError::IdInUse { ref id } if id == "b1"));

    // The first request is not stranded: its response still resolves it.
    write_record(
        &mut to_child,
        json!({"type":"response","command":"abort","success":true,"id":"b1"}),
    )
    .await;
    assert!(first.await.unwrap().is_ok());
}

/// AC2: "Command handling is asynchronous, so clients should correlate by
/// ID rather than response order."
#[tokio::test]
async fn out_of_order_responses_resolve_the_right_callers() {
    let (client, mut to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);

    let (c1, c2) = (Arc::clone(&client), Arc::clone(&client));
    let both = tokio::spawn(async move {
        tokio::join!(
            async move { c1.request(&abort_cmd()).await },
            async move { c2.request(&Command::GetState { id: None }).await },
        )
    });

    let first = next_frame(&mut frames).await;
    let second = next_frame(&mut frames).await;
    assert_eq!(first["id"], "req_1");
    assert_eq!(second["id"], "req_2");

    // Answer the second command first.
    write_record(
        &mut to_child,
        json!({"type":"response","command":"get_state","success":true,"id":"req_2","data":{"sessionId":"s-1"}}),
    )
    .await;
    write_record(
        &mut to_child,
        json!({"type":"response","command":"abort","success":true,"id":"req_1"}),
    )
    .await;

    let (abort, state) = both.await.unwrap();
    assert!(matches!(abort.unwrap(), Response::Abort(_)));
    let state = state.unwrap();
    assert!(matches!(state, Response::GetState(_)));
    assert_eq!(
        state.body().unwrap().data.as_ref().unwrap()["sessionId"],
        "s-1"
    );
}

/// An id nobody is waiting on is not a response to anything: fan it out,
/// resolve nothing, and leave no entry behind.
#[tokio::test]
async fn response_with_unknown_id_falls_through_without_resolving() {
    let (client, mut to_child, _from_child) = harness();
    let mut events = client.events();

    write_record(
        &mut to_child,
        json!({"type":"response","command":"abort","success":true,"id":"nope"}),
    )
    .await;
    match next_event(&mut events).await {
        ProtocolMessage::Unknown(value) => assert_eq!(value["id"], "nope"),
        other => panic!("expected Unknown fallthrough, got {other:?}"),
    }
}

#[tokio::test]
async fn id_less_response_falls_through_without_resolving() {
    let (client, mut to_child, _from_child) = harness();
    let mut events = client.events();

    write_record(
        &mut to_child,
        json!({"type":"response","command":"abort","success":true}),
    )
    .await;
    assert!(matches!(
        next_event(&mut events).await,
        ProtocolMessage::Unknown(_)
    ));
}


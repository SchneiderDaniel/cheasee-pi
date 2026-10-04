//! AC5 coexistence at the boundary that owns it: a session started in the
//! terminal (a plain `.jsonl` on the shared mount plus a `.cheasee-inuse/<id>`
//! claim written by Go's `start`) is listed by the same [`Session::relay`] the
//! `ssr` server runs, and the relay refuses to attach it while the claim is
//! live. This drives the UI's real list/attach path — not `SessionsStore`
//! directly — over the in-process browser sink the control tests share. This
//! crate's integration tests are plain `#[tokio::test]` (no `#[ignore]`
//! convention), so they run in the ui image build gate.
//!
//! Prefix: `coexist_`.
#![cfg(feature = "ssr")]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use cheasee_pi_ui::bridge::{ClientMessage, ServerMessage};
use cheasee_pi_ui::pi_process::PidRegistry;
use cheasee_pi_ui::rpc::framing::JsonlReader;
use cheasee_pi_ui::rpc::RpcClient;
use cheasee_pi_ui::session::{ClientSink, Session};
use cheasee_pi_ui::sessions_store::SessionsStore;
use serde_json::Value;
use tokio::io::{BufReader, DuplexStream};
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

/// A real [`RpcClient`] over a duplex "pi" child: `_to_child` is the child's
/// stdout, `frames` is the child's stdin (the frames the relay writes).
fn harness() -> (Arc<RpcClient>, DuplexStream, Frames) {
    let (stdout_tx, stdout_rx) = tokio::io::duplex(1 << 20);
    let (stdin_tx, from_child) = tokio::io::duplex(1 << 20);
    let client = Arc::new(RpcClient::new(Box::new(stdout_rx), Box::new(stdin_tx)));
    (client, stdout_tx, JsonlReader::new(BufReader::new(from_child)))
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

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cheasee-pi-ui-coexist-{tag}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Write a terminal-shaped session file (the header pi's `SessionManager`
/// emits) at `<dir>/<id>.jsonl`. The recorded cwd is the temp dir itself: the
/// store pre-validates cwd on resume, so it must be a real directory on the
/// host running this test (the container path is `/workspaces/main`).
fn write_terminal_session(dir: &Path, id: &str) -> PathBuf {
    let path = dir.join(format!("{id}.jsonl"));
    let cwd = dir.to_string_lossy().replace('\\', "/");
    std::fs::write(
        &path,
        format!("{{\"type\":\"session\",\"id\":{id:?},\"cwd\":{cwd:?}}}\n"),
    )
    .unwrap();
    path
}

/// The claim directory the Go writer and this reader share, per SESSION_DIR.
fn claim_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(".cheasee-inuse").join(id)
}

fn store(dir: &Path) -> Arc<SessionsStore> {
    Arc::new(SessionsStore::new(
        dir,
        dir.join(".cheasee-inuse"),
        Arc::new(PidRegistry::new()),
    ))
}

#[tokio::test]
async fn coexist_running_ui_lists_the_claimed_session_and_refuses_the_attach() {
    let dir = temp_dir("listed");
    write_terminal_session(&dir, "term0001");

    // The terminal's shared-mount claim (what Go's writeInUseClaim emits).
    std::fs::create_dir_all(dir.join(".cheasee-inuse")).unwrap();
    std::fs::write(claim_path(&dir, "term0001"), b"{\"container\":\"cheasee-pi\"}").unwrap();

    // Drive the same relay the `ssr` server runs, over the browser sink —
    // the UI's real list/attach path, not the store directly.
    let (client, _to_child, mut frames) = harness();
    let (command_tx, mut received, sink) = fake();
    let session = Arc::new(Session::with_store(Arc::clone(&client), Some(store(&dir))));
    let relay = tokio::spawn(async move { session.relay(sink).await });

    // List: the relay scans the shared dir and marks the claimed session in use.
    command_tx
        .send(Ok(ClientMessage::ListSessions {
            id: Some("coexist-list".into()),
        }))
        .unwrap();
    match next_message(&mut received).await {
        ServerMessage::SessionList { id, sessions } => {
            assert_eq!(id.as_deref(), Some("coexist-list"));
            let row = sessions
                .iter()
                .find(|s| s.id == "term0001")
                .expect("the terminal session must appear in the relay's list");
            assert!(row.in_use, "a live claim must mark the row in use");
        }
        other => panic!("expected a session list, got {other:?}"),
    }

    // Attach: refused by the in-use guard, and pi never sees a switch_session.
    command_tx
        .send(Ok(ClientMessage::ResumeSession {
            id: Some("coexist-resume".into()),
            session_id: "term0001".into(),
            mode: Some("resume".into()),
            entry_id: None,
        }))
        .unwrap();
    match next_message(&mut received).await {
        ServerMessage::SessionAction { success, error, .. } => {
            assert!(!success, "the running ui must not attach a live session");
            assert!(error.unwrap().contains("in use"));
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(200), frames.next_record_str())
            .await
            .is_err(),
        "a refused attach must not forward switch_session to pi"
    );

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn coexist_cleared_claim_lets_the_running_ui_attach_again() {
    let dir = temp_dir("cleared");
    write_terminal_session(&dir, "term0002");

    let (client, _to_child, mut frames) = harness();
    let (command_tx, mut received, sink) = fake();
    let session = Arc::new(Session::with_store(Arc::clone(&client), Some(store(&dir))));
    let relay = tokio::spawn(async move { session.relay(sink).await });

    // No claim: the running ui attaches the terminal-created session.
    command_tx
        .send(Ok(ClientMessage::ResumeSession {
            id: Some("clear-1".into()),
            session_id: "term0002".into(),
            mode: Some("resume".into()),
            entry_id: None,
        }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "switch_session");
    match next_message(&mut received).await {
        ServerMessage::SessionAction { success, .. } => assert!(success),
        other => panic!("expected an attach, got {other:?}"),
    }

    // The terminal starts a session (claim appears): the same attach is refused.
    std::fs::create_dir_all(dir.join(".cheasee-inuse")).unwrap();
    std::fs::write(claim_path(&dir, "term0002"), b"{}").unwrap();
    command_tx
        .send(Ok(ClientMessage::ResumeSession {
            id: Some("clear-2".into()),
            session_id: "term0002".into(),
            mode: Some("resume".into()),
            entry_id: None,
        }))
        .unwrap();
    match next_message(&mut received).await {
        ServerMessage::SessionAction { success, error, .. } => {
            assert!(!success);
            assert!(error.unwrap().contains("in use"));
        }
        other => panic!("expected a refusal, got {other:?}"),
    }

    // The terminal exits (claim clears): attachable again.
    std::fs::remove_file(claim_path(&dir, "term0002")).unwrap();
    command_tx
        .send(Ok(ClientMessage::ResumeSession {
            id: Some("clear-3".into()),
            session_id: "term0002".into(),
            mode: Some("resume".into()),
            entry_id: None,
        }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "switch_session");
    let _ = next_message(&mut received).await;

    drop(command_tx);
    let _ = relay.await;
}

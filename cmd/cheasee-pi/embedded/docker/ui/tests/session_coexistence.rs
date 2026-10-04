//! AC5 coexistence at the boundary that owns it: a session started in the
//! terminal (a plain `.jsonl` on the shared mount plus a `.cheasee-inuse/<id>`
//! claim written by Go's `start`) is listed by the UI's `SessionsStore` scan,
//! and the store refuses to attach it while the claim is live. This crate's
//! integration tests are plain `#[tokio::test]` (no `#[ignore]` convention),
//! so they run in the ui image build gate.
//!
//! Prefix: `coexist_`.
#![cfg(feature = "ssr")]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cheasee_pi_ui::pi_process::PidRegistry;
use cheasee_pi_ui::protocol::Command;
use cheasee_pi_ui::sessions_store::SessionsStore;

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

fn store(dir: &Path) -> SessionsStore {
    SessionsStore::new(
        dir,
        dir.join(".cheasee-inuse"),
        Arc::new(PidRegistry::new()),
    )
}

#[tokio::test]
async fn coexist_terminal_session_is_listed_and_refused_while_claimed() {
    let dir = temp_dir("listed");
    write_terminal_session(&dir, "term0001");

    // The terminal's shared-mount claim (what Go's writeInUseClaim emits).
    std::fs::create_dir_all(dir.join(".cheasee-inuse")).unwrap();
    std::fs::write(claim_path(&dir, "term0001"), b"{\"container\":\"cheasee-pi\"}").unwrap();

    let store = store(&dir);
    let rows = store.list().await.unwrap();
    assert_eq!(rows.len(), 1, "the terminal session must appear in the scan");
    assert_eq!(rows[0].id, "term0001");
    assert_eq!(rows[0].cwd.as_deref(), Some(dir.to_string_lossy().as_ref()));
    assert!(rows[0].in_use, "a live claim must mark the row in use");

    let err = store.guard("term0001").await.unwrap_err();
    assert!(
        err.contains("in use"),
        "the guard must refuse a live session, got {err}"
    );
    assert!(
        store.resume("term0001").await.is_err(),
        "resume must refuse while the claim is live"
    );
}

#[tokio::test]
async fn coexist_terminal_session_becomes_attachable_after_the_claim_clears() {
    let dir = temp_dir("cleared");
    write_terminal_session(&dir, "term0002");

    let store = store(&dir);
    // No claim yet: the UI may attach the (terminal-created) session.
    assert!(!store.list().await.unwrap()[0].in_use);
    assert!(store.guard("term0002").await.is_ok());

    // Claim appears (terminal start), then disappears (session exit) — the
    // guard tracks the shared mount both ways.
    std::fs::create_dir_all(dir.join(".cheasee-inuse")).unwrap();
    std::fs::write(claim_path(&dir, "term0002"), b"{}").unwrap();
    assert!(store.guard("term0002").await.is_err());
    std::fs::remove_file(claim_path(&dir, "term0002")).unwrap();

    let rows = store.list().await.unwrap();
    assert!(!rows[0].in_use, "a cleared claim must restore attachability");
    match store.resume("term0002").await.unwrap() {
        Command::SwitchSession { session_path, .. } => {
            assert_eq!(session_path, dir.join("term0002.jsonl").to_string_lossy());
        }
        other => panic!("expected SwitchSession after the claim cleared, got {other:?}"),
    }
}

#[path = "tests_replay.rs"]
mod tests_replay;

use super::*;
use std::io::Write;
use crate::test_support::unique_temp_dir;

pub(super) fn write_session(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(body.as_bytes()).unwrap();
    path
}

pub(super) fn store(dir: &Path) -> SessionsStore {
    SessionsStore::new(dir, dir.join(".cheasee-inuse"), Arc::new(PidRegistry::new()))
}

#[test]
fn parse_reads_header_and_last_name() {
    let bytes = b"{\"type\":\"session\",\"id\":\"abc123\",\"cwd\":\"/workspaces/main\",\"timestamp\":\"2024-01-01T00:00:00Z\"}\n\
{\"type\":\"model_change\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n\
{\"type\":\"session_info\",\"name\":\"first\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"assistant\"}}\n\
{\"type\":\"custom\"}\n\
{\"type\":\"session_info\",\"name\":\"second\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n";
    let parsed = parse_session_entry(bytes);
    assert_eq!(parsed.id.as_deref(), Some("abc123"));
    assert_eq!(parsed.cwd.as_deref(), Some("/workspaces/main"));
    assert_eq!(parsed.created.as_deref(), Some("2024-01-01T00:00:00Z"));
    assert_eq!(parsed.name.as_deref(), Some("second"));
    assert_eq!(parsed.message_count, 3);
}

#[test]
fn parse_header_only_is_a_live_row_not_an_error() {
    let parsed = parse_session_entry(b"{\"type\":\"session\",\"id\":\"live1\"}\n");
    assert_eq!(parsed.id.as_deref(), Some("live1"));
    assert!(parsed.name.is_none());
    assert_eq!(parsed.message_count, 0);
}

#[test]
fn parse_garbage_yields_no_id() {
    let parsed = parse_session_entry(b"not json\n\xff\xfe");
    assert!(parsed.id.is_none());
}

#[tokio::test]
async fn list_marks_a_corrupt_file_unavailable_and_keeps_going() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-list");
    write_session(
        &dir,
        "aaaa_good.jsonl",
        "{\"type\":\"session\",\"id\":\"aaaa\"}\n",
    );
    write_session(&dir, "bbbb_bad.jsonl", "not json at all\n");
    write_session(&dir, "notes.txt", "ignored");
    let entries = store(&dir).list().await.unwrap();
    assert_eq!(entries.len(), 2, "the .txt file must be ignored");
    assert!(entries.iter().any(|e| e.id == "aaaa" && !e.unavailable));
    assert!(
        entries.iter().any(|e| e.unavailable),
        "the garbage file must yield one unavailable row"
    );
}

#[tokio::test]
async fn list_of_a_missing_dir_is_empty() {
    let missing = unique_temp_dir("cheasee-pi-ui-sessions-missing").join("nope");
    let store = store(&missing);
    assert!(store.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn resolve_rejects_escape_and_ambiguity() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-resolve");
    write_session(
        &dir,
        "aaaa1111.jsonl",
        "{\"type\":\"session\",\"id\":\"aaaa1111\",\"cwd\":\"/\"}\n",
    );
    write_session(
        &dir,
        "aaaa2222.jsonl",
        "{\"type\":\"session\",\"id\":\"aaaa2222\",\"cwd\":\"/\"}\n",
    );
    let store = store(&dir);
    assert!(store.resolve("../etc/passwd").await.is_err());
    assert!(store.resolve("/etc/passwd").await.is_err());
    assert!(
        store.resolve("aaaa").await.is_err(),
        "a prefix matching two ids must be ambiguous"
    );
    assert_eq!(
        store.resolve("aaaa1111").await.unwrap(),
        dir.join("aaaa1111.jsonl")
    );
}

#[tokio::test]
async fn guard_refuses_on_a_present_claim() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-guard");
    write_session(
        &dir,
        "cafe_babe.jsonl",
        "{\"type\":\"session\",\"id\":\"cafe\"}\n",
    );
    let store = store(&dir);
    assert!(store.guard("cafe").await.is_ok());
    std::fs::create_dir_all(dir.join(".cheasee-inuse")).unwrap();
    std::fs::write(dir.join(".cheasee-inuse").join("cafe"), b"{}").unwrap();
    assert!(
        store.guard("cafe").await.is_err(),
        "a present claim must refuse the attach"
    );
}

#[tokio::test]
async fn list_marks_a_claimed_session_in_use() {
    // AC5 reader side: a terminal session's `.jsonl` plus the shared
    // `.cheasee-inuse/<id>` claim it writes must surface as an in-use row
    // and refuse an attach; removing the claim clears both.
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-list-claim");
    write_session(
        &dir,
        "feed_face.jsonl",
        "{\"type\":\"session\",\"id\":\"feed\",\"cwd\":\"/workspaces/main\"}\n",
    );
    let store = store(&dir);
    let rows = store.list().await.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].in_use, "no claim yet -> not in use");

    std::fs::create_dir_all(dir.join(".cheasee-inuse")).unwrap();
    std::fs::write(dir.join(".cheasee-inuse").join("feed"), b"{}").unwrap();
    let rows = store.list().await.unwrap();
    assert!(rows[0].in_use, "a present claim must mark the row in use");
    assert!(store.guard("feed").await.is_err(), "and refuse an attach");

    std::fs::remove_file(dir.join(".cheasee-inuse").join("feed")).unwrap();
    let rows = store.list().await.unwrap();
    assert!(!rows[0].in_use, "a removed claim must clear in_use");
    assert!(store.guard("feed").await.is_ok());
}

#[tokio::test]
async fn resume_refuses_when_the_recorded_cwd_is_missing() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-missing-cwd");
    write_session(
        &dir,
        "dead_beef.jsonl",
        "{\"type\":\"session\",\"id\":\"dead\",\"cwd\":\"/nonexistent/workspace\"}\n",
    );
    let err = store(&dir).resume("dead").await.unwrap_err();
    assert!(
        err.contains("cwd"),
        "resume must pre-validate cwd before switch_session, got {err}"
    );
}

#[tokio::test]
async fn resume_emits_switch_session_with_the_resolved_path() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-resume");
    let body = format!(
        "{{\"type\":\"session\",\"id\":\"beef\",\"cwd\":{:?}}}\n",
        dir.to_string_lossy()
    );
    write_session(&dir, "beef_beef.jsonl", &body);
    match store(&dir).resume("beef").await.unwrap() {
        Command::SwitchSession { session_path, .. } => {
            assert_eq!(session_path, dir.join("beef_beef.jsonl").to_string_lossy());
        }
        other => panic!("expected SwitchSession, got {other:?}"),
    }
}

// ── Slice 9: file replay + cursor ───────────────────────────────────────

pub(super) fn linear_session(dir: &Path, id: &str, ids: &[&str]) -> PathBuf {
    let mut body = format!("{{\"type\":\"session\",\"id\":{id:?}}}\n");
    for (i, entry) in ids.iter().enumerate() {
        let parent = if i == 0 {
            "null".to_string()
        } else {
            format!("{:?}", ids[i - 1])
        };
        body.push_str(&format!(
            "{{\"type\":\"message\",\"id\":{entry:?},\"parentId\":{parent}}}\n"
        ));
    }
    write_session(dir, &format!("{id}_{id}.jsonl"), &body)
}

pub(super) fn ids_of(entries: &[Value]) -> Vec<String> {
    entries
        .iter()
        .filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}


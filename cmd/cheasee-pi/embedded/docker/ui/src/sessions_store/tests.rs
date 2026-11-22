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
    assert!(parsed.first_message.is_none());
    assert_eq!(parsed.message_count, 0);
}

#[test]
fn parse_garbage_yields_no_id() {
    let parsed = parse_session_entry(b"not json\n\xff\xfe");
    assert!(parsed.id.is_none());
}

// ── Pi-parity description inputs: first user message + name semantics ────

#[test]
fn parse_captures_a_string_first_user_message() {
    let parsed = parse_session_entry(
        b"{\"type\":\"session\",\"id\":\"m1\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
    );
    assert_eq!(parsed.first_message.as_deref(), Some("hello"));
    assert_eq!(parsed.message_count, 1);
}

#[test]
fn parse_joins_text_blocks_of_the_first_user_message() {
    let parsed = parse_session_entry(
        b"{\"type\":\"session\",\"id\":\"m2\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\
[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"tool_use\"},{\"type\":\"text\",\"text\":\"b\"}]}}\n",
    );
    assert_eq!(parsed.first_message.as_deref(), Some("a b"));
}

#[test]
fn parse_skips_assistant_messages_when_looking_for_the_first_user_text() {
    let parsed = parse_session_entry(
        b"{\"type\":\"session\",\"id\":\"m3\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"reply\"}}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"real prompt\"}}\n",
    );
    assert_eq!(parsed.first_message.as_deref(), Some("real prompt"));
    assert_eq!(parsed.message_count, 2);
}

#[test]
fn parse_skips_an_empty_first_user_text() {
    let parsed = parse_session_entry(
        b"{\"type\":\"session\",\"id\":\"m4\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"\"}}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
    );
    assert_eq!(parsed.first_message.as_deref(), Some("second"));
}

#[test]
fn parse_skips_non_text_user_content() {
    let parsed = parse_session_entry(
        b"{\"type\":\"session\",\"id\":\"m5\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\"}]}}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"later\"}}\n",
    );
    assert_eq!(parsed.first_message.as_deref(), Some("later"));
}

#[test]
fn parse_keeps_only_the_first_qualifying_user_message() {
    let parsed = parse_session_entry(
        b"{\"type\":\"session\",\"id\":\"m6\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
    );
    assert_eq!(parsed.first_message.as_deref(), Some("first"));
}

#[test]
fn parse_tolerates_malformed_message_records() {
    let parsed = parse_session_entry(
        b"{\"type\":\"session\",\"id\":\"m7\"}\n\
{\"type\":\"message\",\"message\":null}\n\
{\"type\":\"message\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":42}}\n",
    );
    assert!(parsed.first_message.is_none());
    assert_eq!(parsed.message_count, 3, "every message record still counts");
}

#[test]
fn parse_trims_a_session_name() {
    let parsed = parse_session_entry(
        b"{\"type\":\"session\",\"id\":\"n1\"}\n\
{\"type\":\"session_info\",\"name\":\"  padded  \"}\n",
    );
    assert_eq!(parsed.name.as_deref(), Some("padded"));
}

#[test]
fn parse_clears_the_name_on_an_empty_session_info() {
    let parsed = parse_session_entry(
        b"{\"type\":\"session\",\"id\":\"n2\"}\n\
{\"type\":\"session_info\",\"name\":\"first\"}\n\
{\"type\":\"session_info\",\"name\":\"\"}\n",
    );
    assert!(parsed.name.is_none(), "an empty name clears the name");
}

#[test]
fn parse_clears_the_name_on_a_whitespace_only_session_info() {
    let parsed = parse_session_entry(
        b"{\"type\":\"session\",\"id\":\"n3\"}\n\
{\"type\":\"session_info\",\"name\":\"first\"}\n\
{\"type\":\"session_info\",\"name\":\"   \"}\n",
    );
    assert!(parsed.name.is_none(), "a blank name clears the name");
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

// ── Row assembly: `SessionEntry::description` / `to_row` ────────────────

fn entry(name: Option<&str>, first_message: Option<&str>) -> SessionEntry {
    SessionEntry {
        id: "abc".to_string(),
        name: name.map(str::to_string),
        path: std::path::PathBuf::from("/sessions/abc.jsonl"),
        cwd: Some("/workspaces/main".to_string()),
        created: Some("2024-01-01T00:00:00Z".to_string()),
        modified: 7,
        message_count: 1,
        in_use: false,
        unavailable: false,
        first_message: first_message.map(str::to_string),
    }
}

#[test]
fn to_row_describes_an_unnamed_session_by_its_first_message() {
    let row = entry(None, Some("Plan the fix")).to_row();
    assert_eq!(row.description.as_deref(), Some("Plan the fix"));
    assert!(row.name.is_none());
}

#[test]
fn to_row_prefers_the_session_name() {
    let row = entry(Some("Named"), Some("first message")).to_row();
    assert_eq!(row.description.as_deref(), Some("Named"));
    assert_eq!(row.name.as_deref(), Some("Named"));
}

#[test]
fn to_row_never_leaks_the_path_or_the_process_marker() {
    let row = entry(Some("Named"), None).to_row();
    let serialized = serde_json::to_string(&row).unwrap();
    assert!(
        !serialized.contains("/sessions"),
        "the row must never carry a host path: {serialized}"
    );
    assert!(
        !serialized.contains("CHEASEE_SESSION_ID"),
        "the row must never carry the process marker: {serialized}"
    );
}

const USER_MESSAGE: &str =
    "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Plan the fix\"}}\n";
const ASSISTANT_MESSAGE: &str =
    "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"hi\"}}\n";

#[tokio::test]
async fn list_describes_a_session_by_its_first_user_message() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-describe");
    write_session(
        &dir,
        "user_one.jsonl",
        &format!("{{\"type\":\"session\",\"id\":\"user1\"}}\n{USER_MESSAGE}"),
    );
    let rows = store(&dir).list().await.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].unavailable);
    assert!(rows[0].name.is_none());
    assert_eq!(rows[0].description().as_deref(), Some("Plan the fix"));
    assert_eq!(
        rows[0].to_row().description.as_deref(),
        Some("Plan the fix")
    );
}

#[tokio::test]
async fn list_leaves_a_header_only_session_undescribed() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-describe-live");
    write_session(
        &dir,
        "live_one.jsonl",
        "{\"type\":\"session\",\"id\":\"live1\"}\n",
    );
    let rows = store(&dir).list().await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].description(), None, "the panel falls back to the id");
    assert_eq!(rows[0].to_row().description, None);
}

#[tokio::test]
async fn list_leaves_an_unavailable_row_undescribed() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-describe-corrupt");
    write_session(&dir, "bad_one.jsonl", "not json at all\n");
    let rows = store(&dir).list().await.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].unavailable);
    assert_eq!(rows[0].description(), None);
}

#[tokio::test]
async fn list_keeps_the_metadata_and_order_of_description_bearing_rows() {
    // Same shape, same message count: only the first user text differs, so the
    // description is the single field `list()` gains.
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-describe-metadata");
    write_session(
        &dir,
        "user_one.jsonl",
        &format!("{{\"type\":\"session\",\"id\":\"user1\"}}\n{USER_MESSAGE}"),
    );
    write_session(
        &dir,
        "plain_one.jsonl",
        &format!("{{\"type\":\"session\",\"id\":\"plain1\"}}\n{ASSISTANT_MESSAGE}"),
    );
    let rows = store(&dir).list().await.unwrap();
    assert_eq!(rows.len(), 2);
    let user = rows.iter().find(|e| e.id == "user1").unwrap();
    let plain = rows.iter().find(|e| e.id == "plain1").unwrap();
    assert_eq!(user.created, plain.created);
    assert_eq!(user.cwd, plain.cwd);
    assert_eq!(user.name, plain.name);
    assert_eq!(user.message_count, plain.message_count);
    assert_eq!(user.in_use, plain.in_use);
    assert_eq!(user.unavailable, plain.unavailable);
    assert_eq!(user.description().as_deref(), Some("Plan the fix"));
    assert_eq!(plain.description(), None);

    let mut expected = rows.clone();
    expected.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
    assert_eq!(rows, expected, "newest first, id breaks the tie");
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


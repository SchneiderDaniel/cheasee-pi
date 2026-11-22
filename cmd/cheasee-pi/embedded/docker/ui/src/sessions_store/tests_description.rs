//! Pi-parity description inputs: the first user message, the last-wins trimmed
//! name, and the row `list()` assembles from both.
//!
//! Kept in its own module next to `tests_replay.rs` so each file owns one
//! concern and the parser cases stay table-driven rather than one function per
//! case — the repo's file-level function ceiling is a hard gate
//! (`test/large-refactor-2031.test.mts`, `test/god-object-refactor-2034.test.mts`).

use super::*;

/// A session entry built by hand, so `to_row` can be exercised without a file.
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

const USER_MESSAGE: &str =
    "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Plan the fix\"}}\n";
const ASSISTANT_MESSAGE: &str =
    "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"hi\"}}\n";

/// `parsed.first_message` per JSONL body, with the message count pi would report
/// for the same records — the two are parsed from one pass, so they are asserted
/// together.
#[test]
fn parse_takes_the_first_qualifying_user_message() {
    let cases: [(&str, &str, Option<&str>, usize); 7] = [
        (
            "string content is used as-is",
            "{\"type\":\"session\",\"id\":\"m1\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
            Some("hello"),
            1,
        ),
        (
            "text blocks are joined with one space",
            "{\"type\":\"session\",\"id\":\"m2\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\
[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"tool_use\"},{\"type\":\"text\",\"text\":\"b\"}]}}\n",
            Some("a b"),
            1,
        ),
        (
            "assistant messages are skipped",
            "{\"type\":\"session\",\"id\":\"m3\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"reply\"}}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"real prompt\"}}\n",
            Some("real prompt"),
            2,
        ),
        (
            "an empty first user text is skipped",
            "{\"type\":\"session\",\"id\":\"m4\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"\"}}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
            Some("second"),
            2,
        ),
        (
            "user content without text blocks is skipped",
            "{\"type\":\"session\",\"id\":\"m5\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"image\"}]}}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"later\"}}\n",
            Some("later"),
            2,
        ),
        (
            "only the first qualifying message is kept",
            "{\"type\":\"session\",\"id\":\"m6\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
            Some("first"),
            2,
        ),
        (
            "malformed message records yield no text but still count",
            "{\"type\":\"session\",\"id\":\"m7\"}\n\
{\"type\":\"message\",\"message\":null}\n\
{\"type\":\"message\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":42}}\n",
            None,
            3,
        ),
    ];
    for (case, body, expected, message_count) in cases {
        let parsed = parse_session_entry(body.as_bytes());
        assert_eq!(parsed.first_message.as_deref(), expected, "first message: {case}");
        assert_eq!(parsed.message_count, message_count, "message count: {case}");
    }
}

/// Pi's `name = entry.name?.trim() || undefined`: the last `session_info` wins,
/// it is trimmed, and a blank name clears the name instead of keeping the old one.
#[test]
fn parse_applies_the_pi_name_rule() {
    let cases: [(&str, &str, Option<&str>); 3] = [
        (
            "a name is trimmed",
            "{\"type\":\"session\",\"id\":\"n1\"}\n\
{\"type\":\"session_info\",\"name\":\"  padded  \"}\n",
            Some("padded"),
        ),
        (
            "an empty name clears the name",
            "{\"type\":\"session\",\"id\":\"n2\"}\n\
{\"type\":\"session_info\",\"name\":\"first\"}\n\
{\"type\":\"session_info\",\"name\":\"\"}\n",
            None,
        ),
        (
            "a whitespace-only name clears the name",
            "{\"type\":\"session\",\"id\":\"n3\"}\n\
{\"type\":\"session_info\",\"name\":\"first\"}\n\
{\"type\":\"session_info\",\"name\":\"   \"}\n",
            None,
        ),
    ];
    for (case, body, expected) in cases {
        let parsed = parse_session_entry(body.as_bytes());
        assert_eq!(parsed.name.as_deref(), expected, "session name: {case}");
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
    assert_eq!(rows[0].to_row().description.as_deref(), Some("Plan the fix"));
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

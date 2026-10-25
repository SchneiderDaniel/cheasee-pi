use super::*;

#[tokio::test]
async fn subscribe_file_replay_slices_after_the_cursor() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-replay-since");
    linear_session(&dir, "aaaa0001", &["a", "b", "c", "d"]);
    let data = store(&dir)
        .read_entries_since("aaaa0001", Some("b"))
        .await
        .unwrap();
    assert_eq!(ids_of(&data.entries), vec!["c", "d"]);
    assert_eq!(data.leaf_id.as_deref(), Some("d"));
    assert!(!data.live);
}

#[tokio::test]
async fn subscribe_file_replay_unknown_cursor_is_invalid() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-replay-unknown");
    linear_session(&dir, "aaaa0002", &["a", "b"]);
    let err = store(&dir)
        .read_entries_since("aaaa0002", Some("zzzz"))
        .await
        .unwrap_err();
    assert!(matches!(err, ReplayError::CursorInvalid(_)), "got {err:?}");
}

#[tokio::test]
async fn subscribe_file_replay_without_a_cursor_is_full() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-replay-full");
    linear_session(&dir, "aaaa0003", &["a", "b", "c"]);
    let data = store(&dir).read_entries_since("aaaa0003", None).await.unwrap();
    assert_eq!(ids_of(&data.entries), vec!["a", "b", "c"]);
}

#[tokio::test]
async fn subscribe_file_replay_skips_a_torn_tail_line() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-replay-torn");
    let mut body = String::from("{\"type\":\"session\",\"id\":\"aaaa0004\"}\n");
    body.push_str("{\"type\":\"message\",\"id\":\"a\",\"parentId\":null}\n");
    body.push_str("{\"type\":\"message\",\"id\":\"b\",\"paren"); // torn
    write_session(&dir, "aaaa0004_aaaa0004.jsonl", &body);
    let data = store(&dir).read_entries_since("aaaa0004", None).await.unwrap();
    assert_eq!(ids_of(&data.entries), vec!["a"]);
}

#[tokio::test]
async fn subscribe_file_replay_header_only_is_empty() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-replay-empty");
    write_session(
        &dir,
        "aaaa0005_aaaa0005.jsonl",
        "{\"type\":\"session\",\"id\":\"aaaa0005\"}\n",
    );
    let data = store(&dir).read_entries_since("aaaa0005", None).await.unwrap();
    assert!(data.entries.is_empty());
    assert!(data.leaf_id.is_none());
}

#[tokio::test]
async fn subscribe_file_replay_missing_session_errors() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-replay-missing");
    let err = store(&dir)
        .read_entries_since("nope", None)
        .await
        .unwrap_err();
    assert!(matches!(err, ReplayError::NotFound(_)), "got {err:?}");
}

#[tokio::test]
async fn subscribe_file_replay_leaf_ignores_an_abandoned_branch() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-replay-branch");
    // a -> b -> c, then branch from b and append x: x is now the leaf.
    let body = "{\"type\":\"session\",\"id\":\"aaaa0006\"}\n\
{\"type\":\"message\",\"id\":\"a\",\"parentId\":null}\n\
{\"type\":\"message\",\"id\":\"b\",\"parentId\":\"a\"}\n\
{\"type\":\"message\",\"id\":\"c\",\"parentId\":\"b\"}\n\
{\"type\":\"message\",\"id\":\"x\",\"parentId\":\"b\"}\n";
    write_session(&dir, "aaaa0006_aaaa0006.jsonl", body);
    let data = store(&dir).read_entries_since("aaaa0006", None).await.unwrap();
    assert_eq!(data.leaf_id.as_deref(), Some("x"));
}

#[tokio::test]
async fn subscribe_cursor_round_trips_and_is_absent_by_default() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-cursor");
    linear_session(&dir, "bbbb0001", &["a", "b"]);
    let store = store(&dir);
    assert!(store.read_cursor("bbbb0001").await.is_none());
    let cursor = Cursor {
        leaf_id: Some("b".into()),
        last_entry_id: Some("b".into()),
        updated_at: None,
    };
    store.write_cursor("bbbb0001", cursor.clone()).await.unwrap();
    assert_eq!(store.read_cursor("bbbb0001").await, Some(cursor));
    assert!(
        dir.join(STATE_DIR).join("bbbb0001.cursor").exists(),
        "the cursor lives in .cheasee-state and never ends in .jsonl"
    );
}

#[tokio::test]
async fn subscribe_a_corrupt_cursor_reads_as_none() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-cursor-corrupt");
    let store = store(&dir);
    std::fs::create_dir_all(dir.join(STATE_DIR)).unwrap();
    std::fs::write(dir.join(STATE_DIR).join("cccc.cursor"), b"not json").unwrap();
    assert!(store.read_cursor("cccc").await.is_none());
}

#[tokio::test]
async fn subscribe_cursor_files_are_not_session_rows() {
    let dir = unique_temp_dir("cheasee-pi-ui-sessions-cursor-list");
    linear_session(&dir, "dddd0001", &["a"]);
    let store = store(&dir);
    store
        .write_cursor(
            "dddd0001",
            Cursor {
                leaf_id: Some("a".into()),
                last_entry_id: Some("a".into()),
                updated_at: None,
            },
        )
        .await
        .unwrap();
    let rows = store.list().await.unwrap();
    assert_eq!(rows.len(), 1, "a cursor must never become a phantom row");
    assert_eq!(rows[0].id, "dddd0001");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use serde_json::json;

    /// An in-memory port. `since` selectors are matched against the ids of a
    /// fixed entry tree; an unknown selector returns `CursorInvalid`, exactly
    /// like pi's `Entry not found`.
    #[derive(Default)]
    struct FakeSource {
        entries: Vec<Value>,
        leaf_id: Option<String>,
        state: Option<Value>,
        last_assistant_text: Option<String>,
        live: bool,
        error: Option<ReplayError>,
        calls: Mutex<Vec<Option<String>>>,
    }

    impl FakeSource {
        fn linear(ids: &[&str]) -> Self {
            let entries = ids
                .iter()
                .enumerate()
                .map(|(i, id)| {
                    json!({
                        "type": "message",
                        "id": id,
                        "parentId": if i == 0 { Value::Null } else { Value::String(ids[i - 1].to_string()) },
                    })
                })
                .collect::<Vec<Value>>();
            Self {
                leaf_id: ids.last().map(|id| id.to_string()),
                entries,
                ..Self::default()
            }
        }
    }

    impl ReplaySource for FakeSource {
        fn replay<'a>(
            &'a self,
            since: Option<&'a str>,
        ) -> BoxFuture<'a, Result<ReplayData, ReplayError>> {
            Box::pin(async move {
                self.calls
                    .lock()
                    .unwrap()
                    .push(since.map(str::to_string));
                if let Some(err) = self.error.clone() {
                    return Err(err);
                }
                let entries = match since {
                    None => self.entries.clone(),
                    Some(id) => {
                        let index = self.entries.iter().position(|e| entry_id(e) == Some(id));
                        match index {
                            Some(index) => self.entries[index + 1..].to_vec(),
                            None => {
                                return Err(ReplayError::CursorInvalid(format!(
                                    "Entry not found: {id}"
                                )));
                            }
                        }
                    }
                };
                Ok(ReplayData {
                    entries,
                    leaf_id: self.leaf_id.clone(),
                    state: self.state.clone(),
                    last_assistant_text: self.last_assistant_text.clone(),
                    live: self.live,
                })
            })
        }
    }

    #[derive(Default)]
    struct FakeStore {
        cursor: Mutex<Option<Cursor>>,
        writes: Mutex<Vec<Cursor>>,
        /// When set, every write fails with this message.
        write_error: Option<String>,
    }

    impl CursorStore for FakeStore {
        fn read_cursor<'a>(&'a self, _session_id: &'a str) -> BoxFuture<'a, Option<Cursor>> {
            Box::pin(async move { self.cursor.lock().unwrap().clone() })
        }

        fn write_cursor<'a>(
            &'a self,
            _session_id: &'a str,
            cursor: Cursor,
        ) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                if let Some(error) = &self.write_error {
                    return Err(error.clone());
                }
                self.writes.lock().unwrap().push(cursor.clone());
                *self.cursor.lock().unwrap() = Some(cursor);
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn subscribe_empty_tail_preserves_the_durable_cursor() {
        let source = FakeSource::linear(&["a", "b"]);
        let store = FakeStore {
            cursor: Mutex::new(Some(Cursor {
                leaf_id: Some("b".into()),
                last_entry_id: Some("b".into()),
                updated_at: None,
            })),
            ..FakeStore::default()
        };
        let outcome = subscribe(&source, &store, "s", Some("b".into())).await.unwrap();
        assert!(outcome.entries.is_empty(), "nothing after the leaf");
        assert_eq!(
            outcome.cursor.last_entry_id.as_deref(),
            Some("b"),
            "an empty tail must not erase the cursor"
        );
        assert!(outcome.cursor_error.is_none());
    }

    #[tokio::test]
    async fn subscribe_surfaces_a_cursor_write_failure() {
        let source = FakeSource::linear(&["a"]);
        let store = FakeStore {
            write_error: Some("read-only session dir".into()),
            ..FakeStore::default()
        };
        let outcome = subscribe(&source, &store, "s", None).await.unwrap();
        let error = outcome.cursor_error.expect("a failed write must surface");
        assert!(error.contains("read-only session dir"), "{error}");
    }

    #[tokio::test]
    async fn subscribe_known_cursor_replays_only_newer_entries() {
        let source = FakeSource::linear(&["a", "b", "c", "d"]);
        let store = FakeStore::default();
        let outcome = subscribe(&source, &store, "s", Some("b".into())).await.unwrap();
        assert!(!outcome.cursor_invalid);
        let ids: Vec<&str> = outcome.entries.iter().filter_map(entry_id).collect();
        assert_eq!(ids, vec!["c", "d"]);
        assert_eq!(outcome.cursor.last_entry_id.as_deref(), Some("d"));
        assert_eq!(outcome.leaf_id.as_deref(), Some("d"));
    }

    #[tokio::test]
    async fn subscribe_unknown_cursor_fails_open_to_a_full_replay() {
        let source = FakeSource::linear(&["a", "b", "c"]);
        let store = FakeStore::default();
        let outcome = subscribe(&source, &store, "s", Some("nope".into())).await.unwrap();
        assert!(outcome.cursor_invalid, "an unknown cursor must be reported");
        let ids: Vec<&str> = outcome.entries.iter().filter_map(entry_id).collect();
        assert_eq!(ids, vec!["a", "b", "c"], "fail open, never an empty replay");
    }

    #[tokio::test]
    async fn subscribe_index_or_timestamp_like_cursors_are_unknown() {
        for bogus in ["12", "3f6c1b2e-0000-4000-8000-000000000000"] {
            let source = FakeSource::linear(&["a", "b"]);
            let store = FakeStore::default();
            let outcome = subscribe(&source, &store, "s", Some(bogus.into())).await.unwrap();
            assert!(outcome.cursor_invalid, "{bogus} is not a real entry id");
            assert_eq!(outcome.entries.len(), 2);
        }
    }

    #[tokio::test]
    async fn subscribe_absent_cursor_is_a_full_replay() {
        let source = FakeSource::linear(&["a", "b"]);
        let store = FakeStore::default();
        let outcome = subscribe(&source, &store, "s", None).await.unwrap();
        assert!(!outcome.cursor_invalid);
        assert_eq!(outcome.entries.len(), 2);
    }

    #[tokio::test]
    async fn subscribe_uses_the_persisted_cursor_when_since_is_absent() {
        let source = FakeSource::linear(&["a", "b", "c"]);
        let store = FakeStore {
            cursor: Mutex::new(Some(Cursor {
                leaf_id: Some("b".into()),
                last_entry_id: Some("b".into()),
                updated_at: None,
            })),
            ..FakeStore::default()
        };
        let outcome = subscribe(&source, &store, "s", None).await.unwrap();
        let ids: Vec<&str> = outcome.entries.iter().filter_map(entry_id).collect();
        assert_eq!(ids, vec!["c"], "the persisted cursor resumes the tail");
    }

    #[tokio::test]
    async fn subscribe_branched_source_emits_only_the_leaf_path() {
        // a -> b -> c(leaf); x is an abandoned branch off b, appended after c.
        let source = FakeSource {
            entries: vec![
                json!({"id": "a", "parentId": null}),
                json!({"id": "b", "parentId": "a"}),
                json!({"id": "c", "parentId": "b"}),
                json!({"id": "x", "parentId": "b"}),
            ],
            leaf_id: Some("c".into()),
            ..FakeSource::default()
        };
        let store = FakeStore::default();
        let outcome = subscribe(&source, &store, "s", Some("b".into())).await.unwrap();
        let ids: Vec<&str> = outcome.entries.iter().filter_map(entry_id).collect();
        assert_eq!(ids, vec!["c"], "abandoned branch x must not be replayed");
    }

    #[tokio::test]
    async fn subscribe_dedupes_by_stable_entry_id() {
        let source = FakeSource {
            entries: vec![
                json!({"id": "a", "parentId": null}),
                json!({"id": "a", "parentId": null}),
                json!({"id": "b", "parentId": "a"}),
            ],
            leaf_id: Some("b".into()),
            ..FakeSource::default()
        };
        let store = FakeStore::default();
        let outcome = subscribe(&source, &store, "s", None).await.unwrap();
        let ids: Vec<&str> = outcome.entries.iter().filter_map(entry_id).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[tokio::test]
    async fn subscribe_is_deterministic_and_idempotent() {
        let source = FakeSource::linear(&["a", "b", "c"]);
        let store = FakeStore::default();
        let first = subscribe(&source, &store, "s", Some("a".into())).await.unwrap();
        let second = subscribe(&source, &store, "s", Some("a".into())).await.unwrap();
        assert_eq!(first, second, "the same subscribe twice is byte-identical");
        let ids: Vec<&str> = first.entries.iter().filter_map(entry_id).collect();
        assert_eq!(ids, vec!["b", "c"]);
    }

    #[tokio::test]
    async fn subscribe_transport_error_is_surfaced_not_an_empty_replay() {
        let source = FakeSource {
            error: Some(ReplayError::Failed("child gone".into())),
            ..FakeSource::default()
        };
        let store = FakeStore::default();
        let err = subscribe(&source, &store, "s", None).await.unwrap_err();
        assert_eq!(err, ReplayError::Failed("child gone".into()));
    }

    #[tokio::test]
    async fn subscribe_carries_state_and_in_flight_text() {
        let source = FakeSource {
            state: Some(json!({"isStreaming": true})),
            last_assistant_text: Some("half a sentence".into()),
            live: true,
            ..FakeSource::linear(&["a"])
        };
        let store = FakeStore::default();
        let outcome = subscribe(&source, &store, "s", None).await.unwrap();
        assert!(outcome.live);
        assert_eq!(outcome.state.unwrap()["isStreaming"], true);
        assert_eq!(outcome.last_assistant_text.as_deref(), Some("half a sentence"));
    }

    #[tokio::test]
    async fn subscribe_chunks_with_exactly_one_terminal_done() {
        let entries: Vec<Value> = (0..(REPLAY_CHUNK_SIZE + 5))
            .map(|i| json!({"id": format!("e{i}")}))
            .collect();
        let chunks = chunk_replay(&entries);
        assert_eq!(chunks.len(), 2, "overflowing one chunk splits");
        assert!(!chunks[0].done);
        assert!(chunks[1].done);
        assert_eq!(chunks[0].entries.len() + chunks[1].entries.len(), entries.len());

        let empty = chunk_replay(&[]);
        assert_eq!(empty.len(), 1);
        assert!(empty[0].done, "an empty replay still closes with done:true");
    }

    #[test]
    fn subscribe_cursor_ignores_live_frames_without_an_entry_id() {
        let mut cursor = Cursor {
            leaf_id: Some("a".into()),
            last_entry_id: Some("a".into()),
            updated_at: None,
        };
        cursor.observe_live(None);
        assert_eq!(cursor.last_entry_id.as_deref(), Some("a"), "no id, no move");
        cursor.observe_live(Some("b"));
        assert_eq!(cursor.last_entry_id.as_deref(), Some("b"));
    }
}

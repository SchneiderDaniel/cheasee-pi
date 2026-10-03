//! Subscribe use case: durable-log replay and cursor semantics.
//!
//! The reconnect contract is *durable-log-first*: pi's append-only session
//! JSONL (via `get_entries` while the child lives, direct file read after a
//! restart) is the single replay source; the live broadcast is best-effort and
//! only healed by re-issuing [`ClientMessage::Subscribe`] with the last-seen
//! entry id.
//!
//! Everything here is transport-free: it drives a [`ReplaySource`] port and a
//! [`CursorStore`] port, both defined in this module, so the same logic serves
//! the live RPC adapter and the child-less file adapter and can be tested
//! against an in-memory fake. It must not import `axum`, `web-sys`,
//! [`crate::rpc::RpcClient`], or `tokio::fs` directly.
//!
//! [`ClientMessage::Subscribe`]: crate::bridge::ClientMessage::Subscribe

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A boxed future, so the ports stay object-safe (`dyn ReplaySource`) without
/// pulling in `async-trait`.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One replay chunk larger than this is split across several frames.
pub const REPLAY_CHUNK_SIZE: usize = 100;

/// The raw payload a [`ReplaySource`] can produce for one subscribe.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReplayData {
    /// Entries strictly after the requested cursor, in file order. Leaf-path
    /// filtering is the use case's job, not the source's.
    pub entries: Vec<Value>,
    /// The session's current leaf id, when the source can prove one.
    pub leaf_id: Option<String>,
    /// Raw `get_state` payload (live source only).
    pub state: Option<Value>,
    /// In-flight assistant text (`get_last_assistant_text`, live source only).
    pub last_assistant_text: Option<String>,
    /// Whether a live child backs this replay. `false` after a server restart.
    pub live: bool,
}

/// Why a replay could not be produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayError {
    /// The cursor names no entry in the log. Expected (8-hex ids collide and
    /// pi's `findIndex` can miss after branching), so the caller fails open to
    /// a full replay rather than closing the connection.
    CursorInvalid(String),
    /// The source does not know this session.
    NotFound(String),
    /// A transport or I/O failure. Surfaced, never swallowed as an empty replay.
    Failed(String),
}

impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CursorInvalid(detail) => write!(f, "cursor invalid: {detail}"),
            Self::NotFound(id) => write!(f, "session {id} not found"),
            Self::Failed(detail) => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for ReplayError {}

/// The replay port: live (`RpcClient`) or child-less (`SessionsStore`).
pub trait ReplaySource: Send + Sync {
    /// Entries after `since` plus the leaf. `since: None` means full replay.
    /// An unknown `since` must be reported as [`ReplayError::CursorInvalid`],
    /// never an empty success.
    fn replay<'a>(
        &'a self,
        since: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ReplayData, ReplayError>>;
}

/// The persisted cursor for one session. `last_entry_id` is a stable entry id
/// (never an index, timestamp, or ordering assumption about ids).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leaf_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_entry_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl Cursor {
    /// Advance on a live frame's entry id. Live pi events generally carry no
    /// entry id, so the cursor only moves at replay-payload boundaries.
    pub fn observe_live(&mut self, entry_id: Option<&str>) {
        if let Some(id) = entry_id {
            self.last_entry_id = Some(id.to_string());
        }
    }
}

/// Where the durable cursor lives. The file adapter puts it in a `.cursor`
/// file (never `*.jsonl`, which the session listing would treat as a session).
pub trait CursorStore: Send + Sync {
    fn read_cursor<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Option<Cursor>>;
    fn write_cursor<'a>(
        &'a self,
        session_id: &'a str,
        cursor: Cursor,
    ) -> BoxFuture<'a, Result<(), String>>;
}

/// A [`CursorStore`] that remembers nothing — for the forwarding-only test
/// harness and any live session with no store attached.
pub struct NoCursorStore;

impl CursorStore for NoCursorStore {
    fn read_cursor<'a>(&'a self, _session_id: &'a str) -> BoxFuture<'a, Option<Cursor>> {
        Box::pin(async { None })
    }

    fn write_cursor<'a>(
        &'a self,
        _session_id: &'a str,
        _cursor: Cursor,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

/// The result of a subscribe: a header plus the replay body the relay frames.
#[derive(Debug, Clone, PartialEq)]
pub struct SubscribeOutcome {
    pub live: bool,
    pub leaf_id: Option<String>,
    pub state: Option<Value>,
    pub last_assistant_text: Option<String>,
    pub cursor_invalid: bool,
    /// Leaf-path-filtered, de-duplicated entries.
    pub entries: Vec<Value>,
    /// The cursor after this replay.
    pub cursor: Cursor,
    /// A failed cursor write, surfaced rather than swallowed: AC4 needs the
    /// cursor to survive a restart, so a silent write failure is a real gap.
    pub cursor_error: Option<String>,
}

/// One `SessionReplay` frame's worth of entries. `done` is the terminal frame.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayChunk {
    pub entries: Vec<Value>,
    pub done: bool,
}

/// Resolve, replay, filter, and persist — the whole subscribe use case.
///
/// An explicit `since` wins; otherwise the persisted cursor is used; otherwise
/// the whole session is replayed. An unknown cursor fails *open*: a full replay
/// with `cursor_invalid = true` (AC2/AC4), never an empty replay and never a
/// closed connection.
pub async fn subscribe(
    source: &dyn ReplaySource,
    store: &dyn CursorStore,
    session_id: &str,
    since: Option<String>,
) -> Result<SubscribeOutcome, ReplayError> {
    let effective = match since {
        Some(id) => Some(id),
        None => store
            .read_cursor(session_id)
            .await
            .and_then(|cursor| cursor.last_entry_id),
    };

    let (data, cursor_invalid) = match source.replay(effective.as_deref()).await {
        Ok(data) => (data, false),
        Err(ReplayError::CursorInvalid(_)) => (source.replay(None).await?, true),
        Err(err) => return Err(err),
    };

    let entries = dedupe(leaf_path(&data.entries, data.leaf_id.as_deref()));
    // Never move the cursor backwards: an incremental replay that adds no
    // entries (an empty tail) must preserve the durable cursor rather than
    // erasing it with `None` — otherwise a no-op reconnect breaks AC4.
    let last_entry_id = entries
        .last()
        .and_then(entry_id)
        .map(str::to_string)
        .or_else(|| effective.clone());
    let cursor = Cursor {
        leaf_id: data.leaf_id.clone(),
        last_entry_id,
        updated_at: None,
    };
    // A failed write must not fail the replay the client can still use, but it
    // must be visible: swallowing it reports a durable cursor that is not there.
    // An empty session id has no durable cursor to key, so it is not an error.
    let cursor_error = if session_id.is_empty() {
        None
    } else {
        store
            .write_cursor(session_id, cursor.clone())
            .await
            .err()
            .map(|err| format!("cursor not persisted for {session_id}: {err}"))
    };

    Ok(SubscribeOutcome {
        live: data.live,
        leaf_id: data.leaf_id,
        state: data.state,
        last_assistant_text: data.last_assistant_text,
        cursor_invalid,
        entries,
        cursor,
        cursor_error,
    })
}

/// Split a replay into frames. Empty input still yields one terminal frame, so
/// the client always sees `done: true` to close the replay boundary.
pub fn chunk_replay(entries: &[Value]) -> Vec<ReplayChunk> {
    if entries.is_empty() {
        return vec![ReplayChunk {
            entries: Vec::new(),
            done: true,
        }];
    }
    let mut chunks: Vec<ReplayChunk> = entries
        .chunks(REPLAY_CHUNK_SIZE)
        .map(|chunk| ReplayChunk {
            entries: chunk.to_vec(),
            done: false,
        })
        .collect();
    if let Some(last) = chunks.last_mut() {
        last.done = true;
    }
    chunks
}

/// The entry id of a raw pi session entry, if it carries one.
pub fn entry_id(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

/// Keep only entries on the root→`leaf_id` path.
///
/// pi's session is a tree: a `since` slice in file order also contains entries
/// from abandoned branches. Emitting them would duplicate history when the
/// client already saw the branch, so the replay is pinned to the current leaf
/// (AC2's "no duplicate"). Entries without an id cannot be placed and pass
/// through.
fn leaf_path(entries: &[Value], leaf_id: Option<&str>) -> Vec<Value> {
    let Some(leaf) = leaf_id else {
        return entries.to_vec();
    };
    let parent: HashMap<&str, Option<&str>> = entries
        .iter()
        .filter_map(|entry| {
            let id = entry_id(entry)?;
            let parent = entry.get("parentId").and_then(Value::as_str);
            Some((id, parent))
        })
        .collect();

    let mut on_path: HashSet<&str> = HashSet::new();
    let mut current = Some(leaf);
    while let Some(id) = current {
        if !on_path.insert(id) {
            break; // cycle guard: a corrupt file must not hang the replay
        }
        current = parent.get(id).copied().flatten();
    }

    entries
        .iter()
        .filter(|entry| match entry_id(entry) {
            Some(id) => on_path.contains(id),
            None => true,
        })
        .cloned()
        .collect()
}

/// Drop repeated entry ids, keeping the first occurrence. Dedupe is by stable
/// id, never by arrival order.
fn dedupe(entries: Vec<Value>) -> Vec<Value> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        match entry_id(&entry) {
            Some(id) => {
                if seen.insert(id.to_string()) {
                    out.push(entry);
                }
            }
            None => out.push(entry),
        }
    }
    out
}

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

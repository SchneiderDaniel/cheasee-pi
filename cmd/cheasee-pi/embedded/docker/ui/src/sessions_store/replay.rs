use super::*;

pub(super) fn session_records(bytes: &[u8]) -> Vec<Value> {
    let mut records = Vec::new();
    for line in bytes.split(|b| *b == b'\n') {
        let line = trim_ascii(line);
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if !value.is_object() {
            continue;
        }
        if value.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        records.push(value);
    }
    records
}

pub(super) fn entry_id_of(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

/// The current leaf: the last record that no other record names as its parent.
/// Falls back to the last record's id when the tree has no obvious leaf.
pub(super) fn leaf_id_of(entries: &[Value]) -> Option<String> {
    let mut has_child: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for entry in entries {
        if let Some(parent) = entry.get("parentId").and_then(Value::as_str) {
            has_child.insert(parent);
        }
    }
    entries
        .iter()
        .rev()
        .find_map(|entry| match entry_id_of(entry) {
            Some(id) if !has_child.contains(id) => Some(id.to_string()),
            _ => None,
        })
        .or_else(|| entries.last().and_then(|entry| entry_id_of(entry)).map(str::to_string))
}

/// The child-less replay adapter: reads the session JSONL directly. Used after a
/// server restart, when no RPC client exists to answer `get_entries`.
pub struct FileReplaySource {
    store: Arc<SessionsStore>,
    session_id: String,
}

impl FileReplaySource {
    pub fn new(store: Arc<SessionsStore>, session_id: impl Into<String>) -> Self {
        Self {
            store,
            session_id: session_id.into(),
        }
    }
}

impl ReplaySource for FileReplaySource {
    fn replay<'a>(
        &'a self,
        since: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ReplayData, ReplayError>> {
        Box::pin(async move { self.store.read_entries_since(&self.session_id, since).await })
    }
}

impl CursorStore for FileReplaySource {
    fn read_cursor<'a>(&'a self, _session_id: &'a str) -> BoxFuture<'a, Option<Cursor>> {
        Box::pin(async move { self.store.read_cursor(&self.session_id).await })
    }

    fn write_cursor<'a>(
        &'a self,
        _session_id: &'a str,
        cursor: Cursor,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { self.store.write_cursor(&self.session_id, cursor).await })
    }
}

impl CursorStore for SessionsStore {
    fn read_cursor<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Option<Cursor>> {
        Box::pin(async move { SessionsStore::read_cursor(self, session_id).await })
    }

    fn write_cursor<'a>(
        &'a self,
        session_id: &'a str,
        cursor: Cursor,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { SessionsStore::write_cursor(self, session_id, cursor).await })
    }
}

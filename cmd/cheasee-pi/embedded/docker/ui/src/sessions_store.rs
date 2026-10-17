//! Server-side session store: scan the shared `.pi/sessions` directory, resolve
//! a session id to an in-directory path, and guard against attaching a second
//! process to a live session.
//!
//! The UI and the terminal share one flat `.pi/sessions` bind mount (pinned by
//! `PI_CODING_AGENT_SESSION_DIR`, see [`crate::pi_process`]). Listing is a plain
//! `read_dir` + `.jsonl` filter — the same shape pi's own `SessionManager`
//! performs when handed an explicit `sessionDir`.
//!
//! **Cross-container limitation.** The UI and the agent container have separate
//! PID namespaces: this store can never read the terminal's `/proc`. Liveness is
//! therefore two-tier:
//! * exact for UI-spawned children — the [`PidRegistry`] plus a `/proc` argv
//!   scan in *this* namespace;
//! * advisory for terminal sessions — a `.cheasee-inuse/<sessionId>` claim file
//!   on the shared mount, written and removed by Go's `start` path.
//!
//! The guard keys on *process presence*, never on file size or mtime: a freshly
//! started live session's file is legitimately empty/buffered.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::bridge::SessionRow;
use crate::pi_process::{marker_alive, PidRegistry};
use crate::protocol::Command;
use crate::subscribe::{
    BoxFuture, Cursor, CursorStore, ReplayData, ReplayError, ReplaySource,
};

/// Hidden sub-directory holding per-session cursors. Deliberately outside the
/// `*.jsonl` namespace so [`SessionsStore::list`] can never turn a cursor into
/// a phantom session row.
pub const STATE_DIR: &str = ".cheasee-state";

/// One session file parsed into metadata the server may render and the relay
/// may describe. `path` never leaves the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEntry {
    pub id: String,
    pub name: Option<String>,
    pub path: PathBuf,
    pub cwd: Option<String>,
    pub created: Option<String>,
    pub modified: u64,
    pub message_count: usize,
    pub in_use: bool,
    pub unavailable: bool,
}

impl SessionEntry {
    /// The browser DTO: ids and metadata only — no host path, no marker.
    pub fn to_row(&self) -> SessionRow {
        SessionRow {
            id: self.id.clone(),
            name: self.name.clone(),
            modified: self.modified,
            created: self.created.clone(),
            message_count: self.message_count,
            in_use: self.in_use,
            unavailable: self.unavailable,
        }
    }
}

/// The pure parse of one session file: the first `{"type":"session",...}`
/// header plus the last non-empty `session_info.name`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedSession {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub created: Option<String>,
    pub name: Option<String>,
    pub message_count: usize,
}

/// Parse a session file's bytes without touching the filesystem.
///
/// A missing header yields no id (the caller marks the row `unavailable`); a
/// header-only file — a live session whose entries are still buffered in memory
/// — yields an id with a zero message count. Neither is an error.
pub fn parse_session_entry(bytes: &[u8]) -> ParsedSession {
    let mut parsed = ParsedSession::default();
    for line in bytes.split(|b| *b == b'\n') {
        let line = trim_ascii(line);
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session") => {
                if parsed.id.is_none() {
                    parsed.id = value.get("id").and_then(Value::as_str).map(str::to_string);
                    parsed.cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
                    parsed.created = value
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
            Some("session_info") => {
                if let Some(name) = value.get("name").and_then(Value::as_str) {
                    if !name.is_empty() {
                        parsed.name = Some(name.to_string());
                    }
                }
            }
            // pi counts only transcript `message` records as messages; state
            // records (`model_change`, `custom`, `thinking_level_change`, …)
            // are not messages.
            Some("message") => parsed.message_count += 1,
            _ => {}
        }
    }
    parsed
}

fn trim_ascii(line: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = line.len();
    while start < end && matches!(line[start], b' ' | b'\r' | b'\t') {
        start += 1;
    }
    while end > start && matches!(line[end - 1], b' ' | b'\r' | b'\t') {
        end -= 1;
    }
    &line[start..end]
}

fn unavailable_row(path: &Path, modified: u64) -> SessionEntry {
    SessionEntry {
        id: path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string(),
        name: None,
        path: path.to_path_buf(),
        cwd: None,
        created: None,
        modified,
        message_count: 0,
        in_use: false,
        unavailable: true,
    }
}

/// The session application use case over the shared mount.
pub struct SessionsStore {
    dir: PathBuf,
    claim_dir: PathBuf,
    registry: Arc<PidRegistry>,
}

impl SessionsStore {
    pub fn new(
        dir: impl Into<PathBuf>,
        claim_dir: impl Into<PathBuf>,
        registry: Arc<PidRegistry>,
    ) -> Self {
        Self {
            dir: dir.into(),
            claim_dir: claim_dir.into(),
            registry,
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn registry(&self) -> &Arc<PidRegistry> {
        &self.registry
    }

    /// Scan the flat `.jsonl` directory, newest first. One unreadable or corrupt
    /// file yields a single `unavailable` row — the list itself never fails
    /// because of one bad file. A missing directory is an empty list.
    pub async fn list(&self) -> Result<Vec<SessionEntry>, String> {
        let mut entries = Vec::new();
        let mut read = match tokio::fs::read_dir(&self.dir).await {
            Ok(read) => read,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(format!("scan {}: {err}", self.dir.display())),
        };
        while let Some(entry) = read.next_entry().await.map_err(|e| e.to_string())? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let modified = entry
                .metadata()
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let Ok(bytes) = tokio::fs::read(&path).await else {
                entries.push(unavailable_row(&path, modified));
                continue;
            };
            let parsed = parse_session_entry(&bytes);
            let Some(id) = parsed.id else {
                entries.push(unavailable_row(&path, modified));
                continue;
            };
            let in_use = self.in_use(&id).await;
            entries.push(SessionEntry {
                id,
                name: parsed.name,
                path,
                cwd: parsed.cwd,
                created: parsed.created,
                modified,
                message_count: parsed.message_count,
                in_use,
                unavailable: false,
            });
        }
        // Newest first; the id breaks ties so the order is deterministic across
        // equal mtimes.
        entries.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        Ok(entries)
    }

    /// The in-use guard: a session is live when this UI's registry holds a child
    /// for it, when a marker-bearing process exists in this PID namespace, or
    /// when a terminal claim file exists on the shared mount (cross-container,
    /// advisory).
    pub async fn in_use(&self, session_id: &str) -> bool {
        if self.registry.pid(session_id).is_some() || marker_alive(session_id) {
            return true;
        }
        tokio::fs::try_exists(self.claim_dir.join(session_id))
            .await
            .unwrap_or(false)
    }

    /// Resolve a session id to an absolute in-directory path.
    ///
    /// An id carrying a path separator or `..` is rejected outright, and a
    /// prefix that matches more than one id is refused as ambiguous — the
    /// resolved path is always inside [`SessionsStore::dir`].
    pub async fn resolve(&self, session_id: &str) -> Result<PathBuf, String> {
        if session_id.is_empty()
            || session_id.contains('/')
            || session_id.contains('\\')
            || session_id.contains("..")
        {
            return Err(format!("invalid session id: {session_id:?}"));
        }
        let entries = self.list().await?;
        if let Some(exact) = entries.iter().find(|e| e.id == session_id && !e.unavailable) {
            return Ok(exact.path.clone());
        }
        let matches: Vec<&SessionEntry> = entries
            .iter()
            .filter(|e| !e.unavailable && e.id.starts_with(session_id))
            .collect();
        match matches.as_slice() {
            [one] => Ok(one.path.clone()),
            [] => Err(format!("session {session_id} not found")),
            _ => Err(format!("session id {session_id} is ambiguous")),
        }
    }

    /// Refuse to attach when the session is live. Exact for this UI's own
    /// children, advisory for terminal sessions via the shared claim.
    pub async fn guard(&self, session_id: &str) -> Result<(), String> {
        if self.in_use(session_id).await {
            return Err(format!(
                "session {session_id} is in use by another process — fork or clone instead"
            ));
        }
        Ok(())
    }

    /// Resolve, validate, and guard, then emit the `switch_session` command.
    ///
    /// The recorded `cwd` is checked *before* the command is sent: pi's
    /// `MissingSessionCwdError` exits the child in non-interactive (rpc) mode,
    /// which would take the UI's whole agent with it.
    pub async fn resume(&self, session_id: &str) -> Result<Command, String> {
        let path = self.resolve(session_id).await?;
        let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
        let parsed = parse_session_entry(&bytes);
        if let Some(cwd) = parsed.cwd.as_deref() {
            if !Path::new(cwd).is_dir() {
                return Err(format!(
                    "session {session_id} records missing cwd {cwd:?} — cannot resume"
                ));
            }
        }
        self.guard(session_id).await?;
        Ok(Command::SwitchSession {
            id: None,
            session_path: path.to_string_lossy().into_owned(),
        })
    }

    // ── Slice 9: durable-log replay + cursor ────────────────────────────────

    /// Replay a child-less session straight from its JSONL: entries strictly
    /// after `since`, plus the leaf reconstructed from the `parentId` chain.
    ///
    /// An unknown `since` is [`ReplayError::CursorInvalid`] — pi answers
    /// `Entry not found` for exactly this case, and the caller falls back to a
    /// full replay rather than an empty one (AC2/AC4). Torn trailing lines are
    /// skipped (a live file is written one line at a time), never fatal.
    pub async fn read_entries_since(
        &self,
        session_id: &str,
        since: Option<&str>,
    ) -> Result<ReplayData, ReplayError> {
        let path = self
            .resolve(session_id)
            .await
            .map_err(ReplayError::NotFound)?;
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|err| ReplayError::Failed(format!("read {}: {err}", path.display())))?;
        let entries = session_records(&bytes);
        let leaf_id = leaf_id_of(&entries);
        let entries = match since {
            None => entries,
            Some(cursor) => {
                let index = entries
                    .iter()
                    .position(|entry| entry_id_of(entry) == Some(cursor));
                match index {
                    Some(index) => entries[index + 1..].to_vec(),
                    None => {
                        return Err(ReplayError::CursorInvalid(format!(
                            "Entry not found: {cursor}"
                        )));
                    }
                }
            }
        };
        Ok(ReplayData {
            entries,
            leaf_id,
            state: None,
            last_assistant_text: None,
            live: false,
        })
    }

    /// `<dir>/.cheasee-state/<session_id>.cursor`. The id is validated the same
    /// way [`SessionsStore::resolve`] validates it, so a cursor path can never
    /// escape the session dir or collide with a `*.jsonl` session file.
    fn cursor_path(&self, session_id: &str) -> Result<PathBuf, String> {
        if session_id.is_empty()
            || session_id.contains('/')
            || session_id.contains('\\')
            || session_id.contains("..")
        {
            return Err(format!("invalid session id: {session_id:?}"));
        }
        Ok(self.dir.join(STATE_DIR).join(format!("{session_id}.cursor")))
    }

    /// The persisted cursor, or `None` when absent/corrupt. A garbage cursor
    /// file is treated as "no cursor" (full replay), never a panic.
    pub async fn read_cursor(&self, session_id: &str) -> Option<Cursor> {
        let path = self.cursor_path(session_id).ok()?;
        let bytes = tokio::fs::read(&path).await.ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Persist the cursor with a temp-write + rename, so an interrupted write
    /// leaves the previous cursor valid rather than a torn file.
    pub async fn write_cursor(&self, session_id: &str, cursor: Cursor) -> Result<(), String> {
        let path = self.cursor_path(session_id)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| format!("create {}: {err}", parent.display()))?;
        }
        let encoded = serde_json::to_vec(&cursor).map_err(|err| err.to_string())?;
        let temp = path.with_extension("cursor.tmp");
        tokio::fs::write(&temp, &encoded)
            .await
            .map_err(|err| format!("write {}: {err}", temp.display()))?;
        tokio::fs::rename(&temp, &path)
            .await
            .map_err(|err| format!("rename {}: {err}", path.display()))
    }
}

/// Every non-header session record, in file order. Lines that do not parse
/// (a torn tail on a live file) are skipped.
fn session_records(bytes: &[u8]) -> Vec<Value> {
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

fn entry_id_of(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

/// The current leaf: the last record that no other record names as its parent.
/// Falls back to the last record's id when the tree has no obvious leaf.
fn leaf_id_of(entries: &[Value]) -> Option<String> {
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

include!("sessions_store_part2.rs");

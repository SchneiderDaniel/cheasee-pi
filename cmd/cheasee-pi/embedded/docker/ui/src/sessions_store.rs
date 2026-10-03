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
            // Everything else (messages, tool calls, unknown records) counts as
            // one retained entry.
            Some(_) | None => parsed.message_count += 1,
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cheasee-pi-ui-sessions-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_session(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        path
    }

    fn store(dir: &Path) -> SessionsStore {
        SessionsStore::new(dir, dir.join(".cheasee-inuse"), Arc::new(PidRegistry::new()))
    }

    #[test]
    fn parse_reads_header_and_last_name() {
        let bytes = b"{\"type\":\"session\",\"id\":\"abc123\",\"cwd\":\"/workspaces/main\",\"timestamp\":\"2024-01-01T00:00:00Z\"}\n\
{\"type\":\"user\",\"text\":\"hi\"}\n\
{\"type\":\"session_info\",\"name\":\"first\"}\n\
{\"type\":\"assistant\"}\n\
{\"type\":\"session_info\",\"name\":\"second\"}\n";
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
        let dir = temp_dir("list");
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
        let missing = temp_dir("missing").join("nope");
        let store = store(&missing);
        assert!(store.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn resolve_rejects_escape_and_ambiguity() {
        let dir = temp_dir("resolve");
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
        let dir = temp_dir("guard");
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
    async fn resume_refuses_when_the_recorded_cwd_is_missing() {
        let dir = temp_dir("missing-cwd");
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
        let dir = temp_dir("resume");
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
}

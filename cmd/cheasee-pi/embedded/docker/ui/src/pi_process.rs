//! Child-process infra: fork/exec `pi --mode rpc` with an explicit env
//! allowlist, piped stdio, and a pid registry that owns the child.
//!
//! Consumes a [`ChildEnv`] (domain output) and never parses auth.json. The
//! child inherits *nothing* from the server process: `env_clear()` plus an
//! explicit allowlist is what makes AC2's "auth.json wins over host env" true
//! — an inherited superset would silently smuggle host credentials in.
//!
//! `stderr` is drained on a live concurrent task (a full ~64 KiB pipe would
//! otherwise block the child before slice 4's stdout reader runs) and is never
//! parsed as protocol. The child leads its own process group so a later
//! marker-kill (slice 8) can signal the whole tree.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::auth::ChildEnv;

/// Fixed container `PATH` for the child. Never inherited from the host server
/// env (AC2).
pub const CHILD_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/// The child's `HOME`. The config mount lives under `/home/agentuser`, so this
/// is the path `pi` reads its own auth from, matching the terminal client.
pub const CHILD_HOME: &str = "/home/agentuser";
pub const CHILD_LANG: &str = "C.UTF-8";
/// The child's working directory — the shared workspace mount. Without it the
/// child inherits `/app`, resolves no project settings, and writes sessions to
/// `~/.pi/agent/sessions`, which is not the terminal client's directory.
pub const CHILD_CWD: &str = "/workspaces/main";
/// The session directory env override, pinned so the UI child writes to the
/// same flat `.pi/sessions` the terminal client and the UI scanner read. This
/// is `PI_CODING_AGENT_SESSION_DIR` (pi derives it from `APP_NAME`).
pub const SESSION_DIR_ENV: &str = "PI_CODING_AGENT_SESSION_DIR";
/// The shared session directory (mirrors `sessionDir` in the embedded
/// `pi/settings.json`).
pub const SESSION_DIR: &str = "/workspaces/main/.pi/sessions";
/// Session marker env var; slice 8's marker-kill scans for this.
pub const SESSION_ID_VAR: &str = "CHEASEE_SESSION_ID";
/// Cap on retained stderr bytes. The pipe is still drained past the cap (the
/// buffer just stops growing) so the child never blocks on stderr backpressure.
pub const STDERR_CAP: usize = 16 * 1024;

/// The env var *names* every child gets regardless of auth.json, in the exact
/// order they are set.
pub fn static_env_var_names() -> [&'static str; 6] {
    [
        SESSION_ID_VAR,
        "HOME",
        "LANG",
        "PATH",
        SESSION_DIR_ENV,
        "PI_SKIP_VERSION_CHECK",
    ]
}

/// All env var *names* the child is spawned with — names only, never values
/// (the `/debug/child` surface mirrors Go's `redactEnvValue`).
pub fn child_env_var_names(env: &ChildEnv) -> Vec<String> {
    let mut names: Vec<String> = static_env_var_names()
        .iter()
        .map(|n| n.to_string())
        .collect();
    names.extend(env.vars.keys().cloned());
    names.sort();
    names.dedup();
    names
}

/// What to execute. Defaults to the RPC mode the terminal client also uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl Default for PiSpec {
    fn default() -> Self {
        Self {
            program: PathBuf::from("pi"),
            args: vec!["--mode".into(), "rpc".into()],
        }
    }
}

/// Retained stderr tail. `truncated` marks that the cap was hit — the drain
/// keeps consuming the pipe, only the copy is bounded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StderrBuffer {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

impl StderrBuffer {
    pub fn lossy(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

/// A running `pi --mode rpc` child. Owns the pipes slice 4 consumes and the
/// `stderr` tail for diagnostics.
///
/// `stdin`/`stdout` are `Option` because exactly one consumer may hold them:
/// [`PiChild::take_io`] hands them to the RPC client once, and a second call
/// returns `None`. Two stdout readers would silently steal records from each
/// other (AC4).
pub struct PiChild {
    pub child: Child,
    pub pid: u32,
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Arc<Mutex<StderrBuffer>>,
}

/// The protocol pipes, handed to the RPC client exactly once.
pub struct ChildIo {
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
}

impl PiChild {
    /// Hand over the protocol pipes. Returns `None` on a second call, so the
    /// single-reader invariant is enforced by the type, not by convention.
    pub fn take_io(&mut self) -> Option<ChildIo> {
        let stdin = self.stdin.take()?;
        let stdout = self.stdout.take()?;
        Some(ChildIo { stdin, stdout })
    }
    /// Snapshot the drained stderr without holding the lock.
    pub fn stderr_snapshot(&self) -> StderrBuffer {
        self.stderr
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Kill the whole process group, then the direct child as a backstop.
    /// Idempotent enough for teardown: a later `wait` still reaps the child.
    pub fn kill(&mut self) {
        #[cfg(unix)]
        {
            // SAFETY: `pid` is a live child we spawned with `process_group(0)`,
            // so its pgid equals its pid; the negated pid targets that group.
            unsafe {
                libc::kill(-(self.pid as libc::pid_t), libc::SIGTERM);
            }
        }
        let _ = self.child.start_kill();
    }

    /// Reap the child (required on Unix to avoid a zombie).
    pub async fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }
}

/// Spawn `pi --mode rpc` with the resolved provider env and piped stdio.
///
/// Records the PID (AC3); stderr is drained on a spawned task. `session_id` is
/// injected as [`SESSION_ID_VAR`] and returned with the child so slice 8 can
/// reuse the same construction.
pub fn spawn(spec: &PiSpec, env: &ChildEnv, session_id: &str) -> io::Result<PiChild> {
    // env: explicit allowlist only — never inherit the server process env.
    let mut std_cmd = std::process::Command::new(&spec.program);
    std_cmd.args(&spec.args);
    std_cmd.env_clear();
    std_cmd.current_dir(CHILD_CWD);
    std_cmd.env("PATH", CHILD_PATH);
    std_cmd.env("HOME", CHILD_HOME);
    std_cmd.env("LANG", CHILD_LANG);
    std_cmd.env("PI_SKIP_VERSION_CHECK", "1");
    std_cmd.env(SESSION_DIR_ENV, SESSION_DIR);
    std_cmd.env(SESSION_ID_VAR, session_id);
    for (name, value) in &env.vars {
        std_cmd.env(name, value);
    }
    std_cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // The child leads its own process group (degenerate group == pid). This is
    // what lets teardown/slice 8 signal grandchildren, not just the direct
    // child.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        std_cmd.process_group(0);
    }

    let mut cmd = Command::from(std_cmd);
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("spawned pi child has no pid"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("pi child stdin was not piped"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("pi child stdout was not piped"))?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("pi child stderr was not piped"))?;

    let stderr = Arc::new(Mutex::new(StderrBuffer::default()));
    let sink = Arc::clone(&stderr);
    tokio::spawn(async move { drain_stderr(stderr_pipe, sink).await });

    Ok(PiChild {
        child,
        pid,
        stdin: Some(stdin),
        stdout: Some(stdout),
        stderr,
    })
}

/// True when a child's argv is a `pi` process: a direct `/usr/bin/pi`/`pi`
/// argv[0], a shebang-launched `node <...>/pi-coding-agent/<...>` argv, or any
/// argv carrying an adjacent `--session`/`--session-id` flag pair. Tokenized —
/// an anchored prefix match on argv[0] misses the shebang install, whose
/// cmdline is `node\0/path/cli.js\0--mode\0rpc\0`.
pub fn argv_is_pi_session<S: AsRef<str>>(argv: &[S]) -> bool {
    if let Some(first) = argv.first() {
        let first: &str = first.as_ref();
        if first == "/usr/bin/pi" || first == "pi" || first.ends_with("/pi") {
            return true;
        }
    }
    if argv.iter().any(|a| a.as_ref().contains("pi-coding-agent")) {
        return true;
    }
    argv.windows(2)
        .any(|pair| matches!(pair[0].as_ref(), "--session" | "--session-id"))
}

/// True when a live process in this PID namespace carries
/// `CHEASEE_SESSION_ID=<session_id>` in its environment.
///
/// This is exact only for children of *this* process (same PID namespace). The
/// terminal's pi lives in the agent container's namespace and is invisible
/// here; its liveness joins cross-container through the shared `.pi/sessions`
/// claim file instead. An unreadable `/proc/<pid>/environ` (owner-only, 0400) is
/// treated as empty — the guard fails closed on a present claim, never open.
pub fn marker_alive(session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    let needle = format!("{SESSION_ID_VAR}={session_id}");
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(raw) = std::fs::read(entry.path().join("environ")) else {
            continue;
        };
        if raw.split(|b| *b == 0).any(|v| v == needle.as_bytes()) {
            return true;
        }
    }
    false
}

/// Continuously read stderr into a capped buffer until EOF. Never parsed.
async fn drain_stderr(raw: tokio::process::ChildStderr, sink: Arc<Mutex<StderrBuffer>>) {
    let mut reader = BufReader::new(raw);
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut buf = sink.lock().unwrap_or_else(|e| e.into_inner());
                let room = STDERR_CAP.saturating_sub(buf.bytes.len());
                let take = n.min(room);
                buf.bytes.extend_from_slice(&chunk[..take]);
                if take < n {
                    buf.truncated = true;
                }
            }
        }
    }
}

/// Owns the spawned children so teardown kills and reaps them, rather than
/// leaking zombies or orphaned grandchildren.
#[derive(Default)]
pub struct PidRegistry {
    children: Mutex<HashMap<String, PiChild>>,
}

impl PidRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a child under its session id. A duplicate id is a bug; the old
    /// child is killed rather than leaked.
    pub fn insert(&self, session_id: String, child: PiChild) {
        let mut map = self.children.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut old) = map.insert(session_id, child) {
            old.kill();
        }
    }

    pub fn pid(&self, session_id: &str) -> Option<u32> {
        self.children
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .map(|c| c.pid)
    }

    /// Kill and reap the exact child recorded under `session_id`. Returns
    /// whether a child was registered: a stop for an unknown session is a
    /// reported "no", never a blanket sweep of sibling children.
    pub fn kill_one(&self, session_id: &str) -> bool {
        let child = {
            self.children
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(session_id)
        };
        match child {
            Some(mut child) => {
                child.kill();
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                true
            }
            None => false,
        }
    }

    pub fn len(&self) -> usize {
        self.children
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Kill and reap every recorded child's process group.
    pub async fn shutdown_all(&self) {
        let mut taken: Vec<PiChild> = {
            let mut map = self.children.lock().unwrap_or_else(|e| e.into_inner());
            map.drain().map(|(_, child)| child).collect()
        };
        for child in &mut taken {
            child.kill();
            let _ = child.wait().await;
        }
    }
}

include!("pi_process_part2.rs");

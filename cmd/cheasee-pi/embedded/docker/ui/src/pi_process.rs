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
/// Session marker env var; slice 8's marker-kill scans for this.
pub const SESSION_ID_VAR: &str = "CHEASEE_SESSION_ID";
/// Cap on retained stderr bytes. The pipe is still drained past the cap (the
/// buffer just stops growing) so the child never blocks on stderr backpressure.
pub const STDERR_CAP: usize = 16 * 1024;

/// The env var *names* every child gets regardless of auth.json, in the exact
/// order they are set.
pub fn static_env_var_names() -> [&'static str; 5] {
    [
        SESSION_ID_VAR,
        "HOME",
        "LANG",
        "PATH",
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
    std_cmd.env("PATH", CHILD_PATH);
    std_cmd.env("HOME", CHILD_HOME);
    std_cmd.env("LANG", CHILD_LANG);
    std_cmd.env("PI_SKIP_VERSION_CHECK", "1");
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::Duration;

    use tokio::io::AsyncBufReadExt;

    fn unique_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cheasee-pi-process-test-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Write an executable `pi` shim that prints the env the child actually
    /// received, then blocks on stdin until teardown.
    fn write_shim(dir: &Path) -> PathBuf {
        let path = dir.join("pi");
        std::fs::write(
            &path,
            "#!/bin/sh\n\
             echo \"PATH=$PATH\"\n\
             echo \"HOME=$HOME\"\n\
             echo \"LANG=$LANG\"\n\
             echo \"SESSION=$CHEASEE_SESSION_ID\"\n\
             echo \"LEAK=$CHEASEE_TEST_HOST_LEAK\"\n\
             echo \"PROVIDER=$OPENAI_API_KEY\"\n\
             echo \"GH=$GH_TOKEN\"\n\
             echo \"STDERR-MARKER\" 1>&2\n\
             echo \"END\"\n\
             cat\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    /// Read the shim's `KEY=VALUE` stdout lines up to its `END` marker.
    async fn read_shim_env(child: &mut PiChild) -> HashMap<String, String> {
        let io = child.take_io().expect("shim pipes are handed over once");
        let mut lines = BufReader::new(io.stdout).lines();
        let mut map = HashMap::new();
        while let Some(line) = lines.next_line().await.unwrap() {
            if line == "END" {
                break;
            }
            if let Some((key, value)) = line.split_once('=') {
                map.insert(key.to_string(), value.to_string());
            }
        }
        map
    }

    async fn wait_for_stderr(child: &PiChild, needle: &str) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if child.stderr_snapshot().lossy().contains(needle) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    fn spec_for(script: &Path) -> PiSpec {
        // Run the shim as a *script argument* to `/bin/sh` rather than exec'ing
        // it directly: exec'ing a just-written script races the writer thread
        // (ETXTBSY) under parallel tests, and the spawn path under test is
        // identical either way.
        PiSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec![script.to_string_lossy().into_owned()],
        }
    }

    #[test]
    fn default_spec_is_pi_rpc_mode() {
        let spec = PiSpec::default();
        assert_eq!(spec.program, PathBuf::from("pi"));
        assert_eq!(spec.args, vec!["--mode".to_string(), "rpc".to_string()]);
    }

    #[tokio::test]
    async fn spawn_pipes_stdio_and_applies_env_allowlist() {
        let dir = unique_dir("allowlist");
        let spec = spec_for(&write_shim(&dir));

        let mut env = ChildEnv::none();
        env.vars.insert("OPENAI_API_KEY".into(), "prov-key".into());
        env.vars.insert("GH_TOKEN".into(), "ghp_secret".into());

        let mut child = spawn(&spec, &env, "sess-42").unwrap();
        assert!(child.pid > 0, "child pid must be recorded");
        let got = read_shim_env(&mut child).await;

        assert_eq!(got.get("SESSION").map(String::as_str), Some("sess-42"));
        assert_eq!(got.get("PROVIDER").map(String::as_str), Some("prov-key"));
        assert_eq!(got.get("GH").map(String::as_str), Some("ghp_secret"));
        assert_eq!(got.get("PATH").map(String::as_str), Some(CHILD_PATH));
        assert_eq!(got.get("HOME").map(String::as_str), Some(CHILD_HOME));
        assert_eq!(got.get("LANG").map(String::as_str), Some(CHILD_LANG));

        child.kill();
        let _ = child.wait().await;
    }

    #[tokio::test]
    async fn spawn_env_clear_blocks_host_shell_env() {
        let dir = unique_dir("env-clear");
        let spec = spec_for(&write_shim(&dir));

        // Present in the server process; must not reach the child (AC2).
        std::env::set_var("CHEASEE_TEST_HOST_LEAK", "host-secret");

        let mut child = spawn(&spec, &ChildEnv::none(), "sess-clean").unwrap();
        let got = read_shim_env(&mut child).await;
        assert_eq!(
            got.get("LEAK").map(String::as_str),
            Some(""),
            "host env must not be inherited (got {:?})",
            got.get("LEAK")
        );
        assert!(
            !got.values().any(|v| v.contains("host-secret")),
            "host secret leaked into child env: {got:?}"
        );

        child.kill();
        let _ = child.wait().await;
    }

    #[tokio::test]
    async fn child_without_provider_keys_still_spawns() {
        let dir = unique_dir("no-keys");
        let spec = spec_for(&write_shim(&dir));

        let env = ChildEnv::none();
        assert!(!env.has_provider_keys);
        // AC4: no keys is a reported state, not a spawn failure.
        let mut child = spawn(&spec, &env, "sess-empty").unwrap();
        let got = read_shim_env(&mut child).await;
        assert_eq!(got.get("PROVIDER").map(String::as_str), Some(""));
        assert_eq!(got.get("SESSION").map(String::as_str), Some("sess-empty"));

        child.kill();
        let _ = child.wait().await;
    }

    #[tokio::test]
    async fn stderr_is_drained_concurrently_and_never_parsed() {
        let dir = unique_dir("stderr");
        let spec = spec_for(&write_shim(&dir));

        let mut child = spawn(&spec, &ChildEnv::none(), "sess-stderr").unwrap();
        // Drain must run without us consuming stderr by hand.
        assert!(
            wait_for_stderr(&child, "STDERR-MARKER").await,
            "stderr was not drained concurrently: {:?}",
            child.stderr_snapshot()
        );

        child.kill();
        let _ = child.wait().await;
    }

    #[test]
    fn child_env_var_names_lists_names_only_sorted() {        let mut env = ChildEnv::none();
        env.vars.insert("OPENAI_API_KEY".into(), "very-secret".into());
        env.vars.insert("GH_TOKEN".into(), "also-secret".into());

        let names = child_env_var_names(&env);
        assert_eq!(
            names,
            vec![
                "CHEASEE_SESSION_ID",
                "GH_TOKEN",
                "HOME",
                "LANG",
                "OPENAI_API_KEY",
                "PATH",
                "PI_SKIP_VERSION_CHECK",
            ]
        );
        assert!(
            !names.iter().any(|n| n.contains("secret")),
            "names-only list leaked a value: {names:?}"
        );
    }

    /// AC4: stdout must have exactly one reader. `take_io` enforces it.
    #[tokio::test]
    async fn take_io_hands_pipes_over_exactly_once() {
        let dir = unique_dir("take-io");
        let spec = spec_for(&write_shim(&dir));
        let mut child = spawn(&spec, &ChildEnv::none(), "sess-io").unwrap();

        let io = child.take_io().expect("first call hands the pipes over");
        let mut lines = BufReader::new(io.stdout).lines();
        let first = lines.next_line().await.unwrap().unwrap_or_default();
        assert!(
            first.starts_with("PATH="),
            "handed-over stdout must still carry the child's records: {first:?}"
        );

        assert!(child.stdin.is_none(), "stdin must be moved out");
        assert!(child.stdout.is_none(), "stdout must be moved out");
        assert!(child.take_io().is_none(), "a second call must return None");

        drop(io.stdin);
        child.kill();
        let _ = child.wait().await;
    }

    #[tokio::test]
    async fn pid_registry_records_and_shuts_down_children() {
        let dir = unique_dir("registry");
        let spec = spec_for(&write_shim(&dir));

        let registry = PidRegistry::new();
        assert!(registry.is_empty());

        let child = spawn(&spec, &ChildEnv::none(), "sess-reg").unwrap();
        let pid = child.pid;
        registry.insert("sess-reg".to_string(), child);

        assert_eq!(registry.len(), 1);
        assert_eq!(registry.pid("sess-reg"), Some(pid));

        registry.shutdown_all().await;
        assert!(registry.is_empty(), "shutdown_all must drain the registry");
    }

    /// AC5 real-binary smoke: spawn the shipped `pi` and capture `--version`.
    /// Ignored by default because it needs `pi` on PATH (the ui runtime image
    /// ships it; the rust builder stage does not). Run in-container with
    /// `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore = "requires the ui image (pi on PATH); run with --ignored in-container"]
    async fn spawn_pi_version_in_container() {
        let spec = PiSpec {
            program: PathBuf::from("pi"),
            args: vec!["--version".into()],
        };
        let mut child = spawn(&spec, &ChildEnv::none(), "sess-version")
            .expect("pi must be on PATH — run this inside the built ui image");

        let mut out = String::new();
        BufReader::new(child.take_io().expect("pi pipes").stdout)
            .read_to_string(&mut out)
            .await
            .unwrap();

        child.kill();
        let _ = child.wait().await;
        assert!(
            !out.trim().is_empty(),
            "pi --version produced no output: {out:?}"
        );
    }
}

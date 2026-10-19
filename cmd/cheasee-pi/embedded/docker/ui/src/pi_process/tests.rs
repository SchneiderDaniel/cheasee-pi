use super::*;
use std::path::Path;
use std::time::Duration;

use tokio::io::AsyncBufReadExt;

use crate::test_support::unique_temp_dir;

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
         echo \"SESSIONDIR=$PI_CODING_AGENT_SESSION_DIR\"\n\
         echo \"PWD=$PWD\"\n\
         echo \"LEAK=$CHEASEE_TEST_HOST_LEAK\"\n\
         echo \"LEAKDIR=$CHEASEE_TEST_DIR_LEAK\"\n\
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
    let dir = unique_temp_dir("cheasee-pi-process-test-allowlist");
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
    let dir = unique_temp_dir("cheasee-pi-process-test-env-clear");
    let spec = spec_for(&write_shim(&dir));

    // Present in the server process; must not reach the child (AC2).
    std::env::set_var("CHEASEE_TEST_HOST_LEAK", "host-secret");
    // The session-dir override is pinned, not inherited: a host-set value
    // must not redirect the child's sessions away from the shared mount.
    std::env::set_var("CHEASEE_TEST_DIR_LEAK", "host-dir");

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

/// Phase 1: the child runs in the shared workspace mount with the session
/// dir pinned, so terminal and UI sessions share one flat `.pi/sessions`.
#[tokio::test]
async fn spawn_pins_workspace_cwd_and_session_dir() {
    let dir = unique_temp_dir("cheasee-pi-process-test-cwd");
    let spec = spec_for(&write_shim(&dir));

    let mut child = spawn(&spec, &ChildEnv::none(), "sess-cwd").unwrap();
    let got = read_shim_env(&mut child).await;
    assert_eq!(got.get("PWD").map(String::as_str), Some(CHILD_CWD));
    assert_eq!(
        got.get("SESSIONDIR").map(String::as_str),
        Some(SESSION_DIR)
    );

    child.kill();
    let _ = child.wait().await;
}

/// Phase 4: the in-use guard's argv match must see a shebang-launched pi
/// (the common install) and the explicit session flag pair, and must never
/// prefix-match an unrelated argv[0].
#[test]
fn argv_tokenizer_matches_shebang_and_session_pairs() {
    let shebang = [
        "node".to_string(),
        "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js".to_string(),
        "--mode".to_string(),
        "rpc".to_string(),
    ];
    assert!(argv_is_pi_session(&shebang));

    assert!(argv_is_pi_session(&["/usr/bin/pi", "--approve"]));
    assert!(argv_is_pi_session(&["pi", "--mode", "rpc"]));
    assert!(argv_is_pi_session(&[
        "/usr/bin/pi",
        "--session",
        "/workspaces/main/.pi/sessions/x.jsonl"
    ]));
    assert!(argv_is_pi_session(&[
        "/usr/bin/pi",
        "--session-id",
        "deadbeef"
    ]));

    // Near misses: python3.12, pipewire, a bare `node` script, and an
    // empty argv must all be rejected (no `*pi*` substring match).
    assert!(!argv_is_pi_session(&["python3.12", "/opt/app.py"]));
    assert!(!argv_is_pi_session(&["pipewire", "--mode", "rpc"]));
    assert!(!argv_is_pi_session(&["node", "/opt/app.js"]));
    assert!(!argv_is_pi_session::<String>(&[]));
}

#[tokio::test]
async fn child_without_provider_keys_still_spawns() {
    let dir = unique_temp_dir("cheasee-pi-process-test-no-keys");
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
    let dir = unique_temp_dir("cheasee-pi-process-test-stderr");
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
            "PI_CODING_AGENT_SESSION_DIR",
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
    let dir = unique_temp_dir("cheasee-pi-process-test-take-io");
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
    let dir = unique_temp_dir("cheasee-pi-process-test-registry");
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

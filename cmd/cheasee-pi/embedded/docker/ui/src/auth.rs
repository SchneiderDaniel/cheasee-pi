//! auth.json domain: resolve the provider environment for the spawned `pi` child.
//!
//! This mirrors the Go canonical source in `cmd/cheasee-pi`:
//! - `ProviderEnvAliases()` → the embedded `provider_env_map.json` snapshot,
//!   byte-pinned to `cheasee-pi auth envvars --format json` by
//!   `cmd/cheasee-pi/ui_provider_env_map_test.go`.
//! - `buildEnvFlags` unknown-provider fallback → `UPPER(provider)_API_KEY`.
//! - `isReservedAuthKey` / `ListProviders` → reserved top-level fields are not
//!   providers and are filtered before the provider loop.
//! - `GitHubToken` → `GH_TOKEN` comes from `auth.json` only, never the host env.
//!
//! The resolver (`resolve_child_env`) is pure so it unit-tests without I/O; the
//! file read is a separate adapter (`load_child_env`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The embedded canonical provider→envvar map (flat JSON), emitted by
/// `auth envvars --format json` and drift-pinned by a Go test.
const PROVIDER_ENV_MAP_JSON: &str = include_str!("../provider_env_map.json");

/// Top-level auth.json fields that are not provider entries — mirror of Go
/// `reservedAuthKeys` (`cmd/cheasee-pi/config_jsonfile.go`).
pub const RESERVED_AUTH_KEYS: [&str; 4] = ["github_token", "github_user", "repo_path", "api_key"];

/// Canonical auth.json path relative to `$HOME` (XDG, new).
pub const XDG_AUTH_REL: &str = ".config/cheasee-pi/auth.json";
/// Legacy pi auth.json path relative to `$HOME` (`auth-env.sh` fallback).
pub const LEGACY_AUTH_REL: &str = ".pi/agent/auth.json";

/// The canonical provider→envvar mapping, parsed once from the snapshot.
pub fn canonical_provider_env_map() -> &'static BTreeMap<String, String> {
    static MAP: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    MAP.get_or_init(|| {
        serde_json::from_str(PROVIDER_ENV_MAP_JSON)
            .expect("embedded provider_env_map.json must be a flat provider→envvar map")
    })
}

/// Reports whether `key` names a reserved auth.json field rather than a
/// provider entry.
pub fn is_reserved_auth_key(key: &str) -> bool {
    RESERVED_AUTH_KEYS.contains(&key)
}

/// Resolve a provider to its canonical env var name.
///
/// Mirrors `buildEnvFlags`: a mapped provider uses the mapping; an unknown one
/// falls back to `UPPER(provider)_API_KEY` — never an empty name, or the child
/// would receive no key for that provider.
pub fn provider_env_var(map: &BTreeMap<String, String>, provider: &str) -> String {
    match map.get(provider) {
        Some(env_var) if !env_var.is_empty() => env_var.clone(),
        _ => format!("{}_API_KEY", provider.to_uppercase()),
    }
}

/// One provider entry: `{"<provider>": {"key": "..."}}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEntry {
    pub key: String,
}

/// The parsed auth.json: provider entries plus the GitHub token. Reserved
/// fields never land in `providers`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthConfig {
    /// Provider name → entry. `BTreeMap` iterates in ascending key order so
    /// alias collisions (`anthropic` + `claude` → `ANTHROPIC_API_KEY`) resolve
    /// last-write-wins deterministically, mirroring `buildEnvFlags`' sorted
    /// provider iteration (Go map order is randomized by spec).
    pub providers: BTreeMap<String, ProviderEntry>,
    pub github_token: Option<String>,
}

/// Where the auth config was read from, for the startup log line.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AuthSource {
    /// The canonical XDG path (or an explicit `CHEASEE_AUTH_PATH` override).
    Config,
    /// The legacy `~/.pi/agent/auth.json` fallback.
    Legacy,
    /// No auth.json found — the child still spawns, with no provider keys.
    #[default]
    Missing,
}

/// The provider environment resolved for a `pi` child, plus the state the UI
/// reports (AC4).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChildEnv {
    /// Provider `*_API_KEY` vars and `GH_TOKEN` — never host-env passthrough.
    pub vars: BTreeMap<String, String>,
    /// Whether any provider key was found (drives the "no provider keys"
    /// warning, mirroring `runUpE`).
    pub has_provider_keys: bool,
    pub source: AuthSource,
}

impl ChildEnv {
    /// The empty state: no keys, nothing to spawn against.
    pub fn none() -> Self {
        Self {
            vars: BTreeMap::new(),
            has_provider_keys: false,
            source: AuthSource::Missing,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    Io(String),
    Parse(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Io(msg) => write!(f, "read auth.json: {msg}"),
            AuthError::Parse(msg) => write!(f, "parse auth.json: {msg}"),
        }
    }
}

impl std::error::Error for AuthError {}

/// Parse the raw auth.json text into an [`AuthConfig`].
///
/// Reads the file as a raw map (like Go's `readRawMap`) so reserved top-level
/// strings never break parsing and never leak into the provider loop. A
/// malformed file errors instead of silently resolving to no keys.
pub fn parse_auth_config(raw: &str) -> Result<AuthConfig, AuthError> {
    let root: BTreeMap<String, serde_json::Value> =
        serde_json::from_str(raw).map_err(|e| AuthError::Parse(e.to_string()))?;

    let mut providers = BTreeMap::new();
    for (key, value) in &root {
        if is_reserved_auth_key(key) {
            continue;
        }
        // `ListProviders` ignores entries that are not `{"key": "<non-empty>"}`.
        if let Some(entry_key) = value.get("key").and_then(|k| k.as_str()) {
            if !entry_key.is_empty() {
                providers.insert(
                    key.clone(),
                    ProviderEntry {
                        key: entry_key.to_string(),
                    },
                );
            }
        }
    }

    let github_token = root
        .get("github_token")
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty())
        .map(str::to_string);

    Ok(AuthConfig {
        providers,
        github_token,
    })
}

/// Resolve the child environment from a parsed config — pure, no I/O.
///
/// `GH_TOKEN` is taken solely from `auth.json.github_token` (AC2): the host
/// shell env and `gh`'s credential store are deliberately *not* consulted.
pub fn resolve_child_env(config: &AuthConfig, map: &BTreeMap<String, String>) -> ChildEnv {
    let mut vars = BTreeMap::new();
    for (provider, entry) in &config.providers {
        if is_reserved_auth_key(provider) || entry.key.is_empty() {
            continue;
        }
        vars.insert(provider_env_var(map, provider), entry.key.clone());
    }
    let has_provider_keys = !vars.is_empty();
    if let Some(token) = config.github_token.as_deref().filter(|t| !t.is_empty()) {
        vars.insert("GH_TOKEN".to_string(), token.to_string());
    }
    ChildEnv {
        vars,
        has_provider_keys,
        source: AuthSource::Config,
    }
}

/// Resolve which auth.json to read: explicit override, then the XDG path, then
/// the legacy `~/.pi/agent/auth.json` fallback. Returns the chosen path and its
/// source; `Missing` means neither file exists (the path is the XDG default for
/// the log line).
pub fn resolve_auth_path(home: &Path, override_path: Option<&Path>) -> (PathBuf, AuthSource) {
    if let Some(path) = override_path {
        if path.is_file() {
            return (path.to_path_buf(), AuthSource::Config);
        }
    }
    let xdg = home.join(XDG_AUTH_REL);
    if xdg.is_file() {
        return (xdg, AuthSource::Config);
    }
    let legacy = home.join(LEGACY_AUTH_REL);
    if legacy.is_file() {
        return (legacy, AuthSource::Legacy);
    }
    (xdg, AuthSource::Missing)
}

/// Read and parse the auth config at an explicit path.
pub fn load_auth_config(path: &Path) -> Result<AuthConfig, AuthError> {
    let raw = std::fs::read_to_string(path).map_err(|e| AuthError::Io(e.to_string()))?;
    parse_auth_config(&raw)
}

/// Adapter: resolve the child env from the process environment (`HOME`,
/// `CHEASEE_AUTH_PATH`). A missing auth.json is `Ok(empty)`, not an error; an
/// unreadable or malformed one is `Err` and the caller decides whether to still
/// spawn (AC4).
pub fn load_child_env() -> Result<ChildEnv, AuthError> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let override_path = std::env::var_os("CHEASEE_AUTH_PATH").map(PathBuf::from);
    load_child_env_from(home.as_deref(), override_path.as_deref())
}

/// Testable core of [`load_child_env`].
pub fn load_child_env_from(
    home: Option<&Path>,
    override_path: Option<&Path>,
) -> Result<ChildEnv, AuthError> {
    // Nothing to anchor a path on: an empty home would resolve to a
    // cwd-relative `.config/...` and could pick up an unrelated file.
    if home.is_none() && override_path.is_none() {
        return Ok(ChildEnv::none());
    }
    let home = home.unwrap_or_else(|| Path::new(""));
    let (path, source) = resolve_auth_path(home, override_path);
    if source == AuthSource::Missing {
        return Ok(ChildEnv::none());
    }
    let mut env = resolve_child_env(&load_auth_config(&path)?, canonical_provider_env_map());
    env.source = source;
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cheasee-auth-test-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_auth(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("auth.json");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn embedded_map_covers_aliases_and_canonical_providers() {
        let map = canonical_provider_env_map();
        // 13 canonical + claude/google/opencode aliases. A dropped snapshot
        // entry would strand a provider at the UPPER(_API_KEY) fallback.
        assert_eq!(map.len(), 15, "snapshot provider count drifted: {map:?}");
        assert_eq!(map.get("google").map(String::as_str), Some("GEMINI_API_KEY"));
        assert_eq!(map.get("claude").map(String::as_str), Some("ANTHROPIC_API_KEY"));
        assert_eq!(map.get("opencode").map(String::as_str), Some("OPENCODE_API_KEY"));
    }

    #[test]
    fn provider_env_var_maps_known_names_and_falls_back_unknown() {
        let map = canonical_provider_env_map();
        for (provider, want) in [
            ("opencode-go", "OPENCODE_API_KEY"),
            ("openai", "OPENAI_API_KEY"),
            ("claude", "ANTHROPIC_API_KEY"),
            ("google", "GEMINI_API_KEY"),
            ("cerebras", "CEREBRAS_API_KEY"),
        ] {
            assert_eq!(provider_env_var(map, provider), want, "provider {provider}");
        }
        // Unknown providers must never yield an empty env var name.
        assert_eq!(provider_env_var(map, "acme"), "ACME_API_KEY");
        assert_eq!(provider_env_var(map, "My-Provider"), "MY-PROVIDER_API_KEY");
    }

    #[test]
    fn parses_provider_entries_and_github_token() {
        let cfg = parse_auth_config(
            r#"{
                "openai": {"key": "sk-openai"},
                "opencode-go": {"key": "sk-oc"},
                "github_token": "ghp_secret",
                "github_user": "octocat",
                "repo_path": "/tmp/repo",
                "api_key": "legacy-flat"
            }"#,
        )
        .unwrap();
        assert_eq!(cfg.providers.len(), 2, "reserved keys must not be providers");
        assert_eq!(cfg.providers["openai"].key, "sk-openai");
        assert_eq!(cfg.github_token.as_deref(), Some("ghp_secret"));
        for reserved in RESERVED_AUTH_KEYS {
            assert!(!cfg.providers.contains_key(reserved), "reserved {reserved}");
        }
    }

    #[test]
    fn resolve_child_env_uses_canonical_mapping_and_auth_json_github_token() {
        let cfg = parse_auth_config(
            r#"{"openai": {"key": "sk-openai"}, "github_token": "ghp_secret"}"#,
        )
        .unwrap();
        let env = resolve_child_env(&cfg, canonical_provider_env_map());
        assert_eq!(env.vars["OPENAI_API_KEY"], "sk-openai");
        assert_eq!(env.vars["GH_TOKEN"], "ghp_secret");
        assert!(env.has_provider_keys);
        assert_eq!(env.source, AuthSource::Config);
    }

    #[test]
    fn resolve_child_env_unknown_provider_uses_upper_api_key_fallback() {
        let cfg = parse_auth_config(r#"{"acme": {"key": "k"}}"#).unwrap();
        let env = resolve_child_env(&cfg, canonical_provider_env_map());
        assert_eq!(env.vars["ACME_API_KEY"], "k");
    }

    #[test]
    fn resolve_child_env_alias_collision_is_last_write_wins_deterministically() {
        // `claude` sorts after `anthropic`, so it wins the shared env var.
        let cfg = parse_auth_config(
            r#"{"anthropic": {"key": "anth-key"}, "claude": {"key": "claude-key"}}"#,
        )
        .unwrap();
        let env = resolve_child_env(&cfg, canonical_provider_env_map());
        assert_eq!(env.vars.len(), 1);
        assert_eq!(env.vars["ANTHROPIC_API_KEY"], "claude-key");
    }

    #[test]
    fn github_token_absent_yields_no_gh_token() {
        let cfg = parse_auth_config(r#"{"openai": {"key": "sk"}}"#).unwrap();
        let env = resolve_child_env(&cfg, canonical_provider_env_map());
        assert!(!env.vars.contains_key("GH_TOKEN"));
    }

    #[test]
    fn empty_provider_key_is_ignored_like_list_providers() {
        let cfg = parse_auth_config(r#"{"openai": {"key": ""}, "groq": {"key": "g"}}"#).unwrap();
        assert_eq!(cfg.providers.len(), 1);
        let env = resolve_child_env(&cfg, canonical_provider_env_map());
        assert!(!env.vars.contains_key("OPENAI_API_KEY"));
        assert_eq!(env.vars["GROQ_API_KEY"], "g");
    }

    #[test]
    fn malformed_json_errors_not_silently_empty() {
        assert!(matches!(
            parse_auth_config("{ not json"),
            Err(AuthError::Parse(_))
        ));
    }

    #[test]
    fn missing_auth_file_reports_missing_source_and_no_keys() {
        let home = unique_dir("missing");
        let env = load_child_env_from(Some(&home), None).unwrap();
        assert_eq!(env.source, AuthSource::Missing);
        assert!(!env.has_provider_keys);
        assert!(env.vars.is_empty());
    }

    #[test]
    fn no_home_and_no_override_resolves_to_nothing() {
        let env = load_child_env_from(None, None).unwrap();
        assert_eq!(env.source, AuthSource::Missing);
        assert!(!env.has_provider_keys);
        assert!(env.vars.is_empty());
    }

    #[test]
    fn xdg_path_is_preferred_and_legacy_is_the_fallback() {
        let home = unique_dir("paths");
        std::fs::create_dir_all(home.join(".pi/agent")).unwrap();
        write_auth(&home.join(".pi/agent"), r#"{"groq": {"key": "legacy"}}"#);

        // Only legacy present → Legacy source.
        let env = load_child_env_from(Some(&home), None).unwrap();
        assert_eq!(env.source, AuthSource::Legacy);
        assert_eq!(env.vars["GROQ_API_KEY"], "legacy");

        // XDG present → wins over legacy.
        std::fs::create_dir_all(home.join(".config/cheasee-pi")).unwrap();
        write_auth(&home.join(".config/cheasee-pi"), r#"{"xai": {"key": "xdg"}}"#);
        let env = load_child_env_from(Some(&home), None).unwrap();
        assert_eq!(env.source, AuthSource::Config);
        assert_eq!(env.vars["XAI_API_KEY"], "xdg");
        assert!(!env.vars.contains_key("GROQ_API_KEY"));
    }

    #[test]
    fn explicit_override_path_wins_over_home_paths() {
        let home = unique_dir("override-home");
        let other = unique_dir("override-other");
        std::fs::create_dir_all(home.join(".config/cheasee-pi")).unwrap();
        write_auth(&home.join(".config/cheasee-pi"), r#"{"xai": {"key": "home"}}"#);
        let override_path = write_auth(&other, r#"{"together": {"key": "override"}}"#);

        let env = load_child_env_from(Some(&home), Some(&override_path)).unwrap();
        assert_eq!(env.source, AuthSource::Config);
        assert_eq!(env.vars["TOGETHER_API_KEY"], "override");
        assert!(!env.vars.contains_key("XAI_API_KEY"));
    }

    #[test]
    fn github_token_only_config_has_no_provider_keys() {
        let cfg = parse_auth_config(r#"{"github_token": "ghp"}"#).unwrap();
        let env = resolve_child_env(&cfg, canonical_provider_env_map());
        assert!(!env.has_provider_keys, "GH_TOKEN alone is not a provider key");
        assert_eq!(env.vars["GH_TOKEN"], "ghp");
    }

    /// Cross-check the embedded snapshot against the live CLI when present.
    /// Ignored by default: the Go parity test (`ui_provider_env_map_test.go`)
    /// is the always-run authority; this is a belt-and-braces check for a
    /// machine that has `cheasee-pi` on PATH.
    #[test]
    #[ignore = "requires cheasee-pi on PATH; run with --ignored where the CLI is available"]
    fn embedded_map_matches_live_cli_output() {
        let out = std::process::Command::new("cheasee-pi")
            .args(["auth", "envvars", "--format", "json"])
            .output()
            .expect("cheasee-pi must be on PATH");
        assert!(out.status.success(), "cheasee-pi auth envvars failed: {out:?}");
        let live: BTreeMap<String, String> = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(&live, canonical_provider_env_map());
    }
}

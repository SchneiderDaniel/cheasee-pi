use super::*;
use crate::test_support::unique_temp_dir;

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
    let home = unique_temp_dir("cheasee-auth-test-missing");
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
    let home = unique_temp_dir("cheasee-auth-test-paths");
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
    let home = unique_temp_dir("cheasee-auth-test-override-home");
    let other = unique_temp_dir("cheasee-auth-test-override-other");
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

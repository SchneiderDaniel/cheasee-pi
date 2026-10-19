use super::*;

// ── Command ────────────────────────────────────────────────────────────────

#[test]
fn rpc_every_captured_command_round_trips_with_its_id() {
    let samples = fixture_values("commands.jsonl");
    assert_eq!(samples.len(), 23, "captured command corpus changed");

    for sample in samples {
        let command: Command =
            serde_json::from_value(sample.clone()).unwrap_or_else(|e| panic!("{sample}: {e}"));
        assert!(
            !matches!(command, Command::Unknown),
            "a captured command fell through to Unknown: {sample}"
        );
        assert_eq!(
            round_trip(&command),
            sample,
            "round-trip changed the record"
        );
    }
}

#[test]
fn rpc_a_command_without_an_id_decodes_as_none() {
    let command: Command = serde_json::from_value(json!({"type": "abort"})).unwrap();
    match command {
        Command::Abort { id } => assert_eq!(id, None),
        other => panic!("expected Abort, got {other:?}"),
    }
}

#[test]
fn rpc_a_command_with_an_id_decodes_as_some() {
    let command: Command = serde_json::from_value(json!({"type": "abort", "id": "req-9"})).unwrap();
    match command {
        Command::Abort { id } => assert_eq!(id.as_deref(), Some("req-9")),
        other => panic!("expected Abort, got {other:?}"),
    }
}

#[test]
fn rpc_an_unmodelled_command_type_decodes_as_unknown() {
    let command: Command =
        serde_json::from_value(json!({"type": "reticulate_splines", "id": "req-1"})).unwrap();
    assert!(matches!(command, Command::Unknown));
}

/// AC1/AC2: the 1.0.1 command vocabulary serializes to the wire names pi
/// expects and decodes back (never `Unknown`).
#[test]
fn rpc_clear_queue_and_thinking_levels_commands_round_trip() {
    for (command, wire) in [
        (Command::ClearQueue { id: Some("req-20".into()) }, "clear_queue"),
        (
            Command::GetAvailableThinkingLevels {
                id: Some("req-21".into()),
            },
            "get_available_thinking_levels",
        ),
    ] {
        let value = round_trip(&command);
        assert_eq!(value["type"], wire);
        let decoded: Command = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(decoded, command, "{wire} did not round-trip");
    }
}

// ── Response ───────────────────────────────────────────────────────────────

#[test]
fn rpc_a_success_response_keeps_its_id_and_success() {
    let response: Response = serde_json::from_value(json!({
        "type": "response",
        "command": "prompt",
        "success": true,
        "id": "req-1",
    }))
    .unwrap();

    assert!(matches!(response, Response::Prompt(_)));
    let body = response.body().expect("Prompt has a body");
    assert!(body.success);
    assert_eq!(body.id.as_deref(), Some("req-1"));
    assert_eq!(body.error, None);
}

#[test]
fn rpc_an_error_response_keeps_its_message_without_an_id() {
    let response: Response = serde_json::from_value(json!({
        "type": "response",
        "command": "set_model",
        "success": false,
        "error": "Model not found: invalid/model",
    }))
    .unwrap();

    assert!(matches!(response, Response::SetModel(_)));
    let body = response.body().expect("SetModel has a body");
    assert!(!body.success);
    assert_eq!(body.error.as_deref(), Some("Model not found: invalid/model"));
    assert_eq!(body.id, None);
}

#[test]
fn rpc_an_unmodelled_response_command_decodes_as_unknown() {
    let response: Response = serde_json::from_value(json!({
        "type": "response",
        "command": "parse",
        "success": false,
        "error": "Failed to parse command",
    }))
    .unwrap();
    assert!(matches!(response, Response::Unknown));
}

/// AC2/AC4: `get_entries` omits `since` when absent, because pi treats
/// `since: null` as a present-but-unknown id.
#[test]
fn rpc_get_entries_omits_an_absent_since() {
    let present = round_trip(&Command::GetEntries {
        id: Some("req-22".into()),
        since: Some("b5a3a53d".into()),
    });
    assert_eq!(present["type"], "get_entries");
    assert_eq!(present["since"], "b5a3a53d");
    let decoded: Command = serde_json::from_value(present.clone()).unwrap();
    assert_eq!(decoded, Command::GetEntries {
        id: Some("req-22".into()),
        since: Some("b5a3a53d".into()),
    });

    let absent = round_trip(&Command::GetEntries {
        id: None,
        since: None,
    });
    assert_eq!(absent["type"], "get_entries");
    assert!(absent.get("since").is_none(), "since must be omitted: {absent}");
    assert!(absent.get("id").is_none(), "id must be omitted: {absent}");
}

/// AC2/AC4: a `get_entries` response reaches `.data.entries`/`.data.leafId`
/// through `Response::GetEntries`, never `Response::Unknown`.
#[test]
fn rpc_get_entries_response_decodes_with_data_and_error() {
    let response: Response = serde_json::from_value(json!({
        "type": "response",
        "command": "get_entries",
        "success": true,
        "id": "req-22",
        "data": {"entries": [{"id": "b5a3a53d"}], "leafId": "b5a3a53d"},
    }))
    .unwrap();
    assert!(matches!(response, Response::GetEntries(_)));
    let body = response.body().expect("GetEntries has a body");
    let data = body.data.clone().expect("data is present");
    assert_eq!(data["entries"][0]["id"], "b5a3a53d");
    assert_eq!(data["leafId"], "b5a3a53d");

    let errored: Response = serde_json::from_value(json!({
        "type": "response",
        "command": "get_entries",
        "success": false,
        "id": "req-22",
        "error": "Entry not found: b5a3a53d",
    }))
    .unwrap();
    let body = errored.body().unwrap();
    assert!(!body.success);
    assert_eq!(body.error.as_deref(), Some("Entry not found: b5a3a53d"));
}

// ── Response `data` DTOs ────────────────────────────────────────────────────

/// AC1: `clear_queue` returns the removed text so the client can restore it.
#[test]
fn rpc_clear_queue_response_carries_the_removed_text() {
    let response: Response = serde_json::from_value(json!({
        "type": "response",
        "command": "clear_queue",
        "success": true,
        "id": "req-20",
        "data": {"steering": ["a"], "followUp": ["b"]},
    }))
    .unwrap();
    assert!(matches!(response, Response::ClearQueue(_)));
    let body = response.body().expect("ClearQueue has a body");
    assert!(body.success);
    let data: ClearQueueData = serde_json::from_value(body.data.clone().unwrap()).unwrap();
    assert_eq!(data.steering, vec!["a".to_string()]);
    assert_eq!(data.follow_up, vec!["b".to_string()]);
    assert_eq!(data.as_draft(), "a\nb");
}

/// AC2: the non-reasoning `["off"]` case is a normal levels payload.
#[test]
fn rpc_thinking_levels_response_decodes() {
    let response: Response = serde_json::from_value(json!({
        "type": "response",
        "command": "get_available_thinking_levels",
        "success": true,
        "data": {"levels": ["off"]},
    }))
    .unwrap();
    assert!(matches!(response, Response::GetAvailableThinkingLevels(_)));
    let body = response.body().unwrap();
    let levels: ThinkingLevels = serde_json::from_value(body.data.clone().unwrap()).unwrap();
    assert_eq!(levels.levels, vec!["off".to_string()]);
}

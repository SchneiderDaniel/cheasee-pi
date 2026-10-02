//! AC3 round-trips over the four pi record families, plus a fixture corpus
//! captured from the vendored `@earendil-works/pi-coding-agent@0.79.10`.
//!
//! The fixtures are records only, one per line, with the captured version in a
//! sidecar `PI_VERSION` — a version header inside a `.jsonl` file would itself
//! be parsed as a record.
//!
//! Every function is `rpc_`-prefixed so the crate's `rpc` test filter reaches
//! it (`cargo test --no-default-features --features ssr rpc`).

use std::path::PathBuf;

use cheasee_pi_ui::protocol::{
    Command, Event, ExtensionUI, ExtensionUiRequest, ExtensionUiResponse, Response,
};
use serde_json::{json, Value};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

/// Every non-empty line of a fixture file, verbatim.
fn fixture_lines(name: &str) -> Vec<String> {
    let raw = std::fs::read_to_string(fixture(name)).expect("fixture is readable");
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect()
}

fn fixture_values(name: &str) -> Vec<Value> {
    fixture_lines(name)
        .into_iter()
        .map(|line| serde_json::from_str(&line).expect("fixture line is JSON"))
        .collect()
}

fn round_trip<T>(value: &T) -> Value
where
    T: serde::Serialize,
{
    serde_json::to_value(value).expect("serializable")
}

// ── Command ────────────────────────────────────────────────────────────────

#[test]
fn rpc_every_captured_command_round_trips_with_its_id() {
    let samples = fixture_values("commands.jsonl");
    assert_eq!(samples.len(), 19, "captured command corpus changed");

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

// ── Event ──────────────────────────────────────────────────────────────────

#[test]
fn rpc_every_captured_session_event_round_trips() {
    let samples = fixture_values("events.jsonl");
    for sample in samples {
        let kind = sample["type"].as_str().unwrap_or_default().to_string();
        if kind == "agent_settled" {
            continue; // covered by the Unknown test below
        }
        let event: Event =
            serde_json::from_value(sample.clone()).unwrap_or_else(|e| panic!("{sample}: {e}"));
        assert!(
            !matches!(event, Event::Unknown),
            "a documented event fell through to Unknown: {sample}"
        );
        assert_eq!(round_trip(&event), sample, "round-trip changed {kind}");
    }
}

#[test]
fn rpc_the_documented_event_set_is_covered() {
    // The 16 event types `docs/rpc.md` lists in the pinned release.
    for (kind, payload) in [
        ("agent_start", json!({})),
        ("agent_end", json!({"messages": []})),
        ("turn_start", json!({})),
        ("turn_end", json!({"message": {}, "toolResults": []})),
        ("message_start", json!({"message": {}})),
        (
            "message_update",
            json!({"message": {}, "assistantMessageEvent": {"type": "text_delta"}}),
        ),
        ("message_end", json!({"message": {}})),
        (
            "tool_execution_start",
            json!({"toolCallId": "c", "toolName": "bash", "args": {}}),
        ),
        (
            "tool_execution_update",
            json!({
                "toolCallId": "c",
                "toolName": "bash",
                "args": {},
                "partialResult": {},
            }),
        ),
        (
            "tool_execution_end",
            json!({
                "toolCallId": "c",
                "toolName": "bash",
                "result": {},
                "isError": false,
            }),
        ),
        ("queue_update", json!({"steering": [], "followUp": []})),
        ("compaction_start", json!({"reason": "manual"})),
        (
            "compaction_end",
            json!({
                "reason": "manual",
                "result": null,
                "aborted": false,
                "willRetry": false,
            }),
        ),
        (
            "auto_retry_start",
            json!({"attempt": 1, "maxAttempts": 3, "delayMs": 2000, "errorMessage": "e"}),
        ),
        ("auto_retry_end", json!({"success": true, "attempt": 2})),
        (
            "extension_error",
            json!({"extensionPath": "/e.ts", "event": "tool_call", "error": "boom"}),
        ),
    ] {
        let mut sample = payload;
        sample["type"] = json!(kind);
        let event: Event = serde_json::from_value(sample.clone())
            .unwrap_or_else(|e| panic!("{kind}: {e}"));
        assert!(
            !matches!(event, Event::Unknown),
            "{kind} is not modelled"
        );
        assert_eq!(round_trip(&event), sample, "{kind} did not round-trip");
    }
}

/// The exception to "session events carry no id": when the originating `bash`
/// command has an id, its output events repeat it.
#[test]
fn rpc_bash_execution_update_exposes_the_repeated_command_id() {
    let event: Event =
        serde_json::from_value(json!({"type": "bash_execution_update", "id": "req-12"}))
            .unwrap();
    match event {
        Event::BashExecutionUpdate { id, .. } => assert_eq!(id.as_deref(), Some("req-12")),
        other => panic!("expected BashExecutionUpdate, got {other:?}"),
    }

    // An id-less session event never gains one.
    let event: Event = serde_json::from_value(json!({"type": "agent_start"})).unwrap();
    assert_eq!(round_trip(&event), json!({"type": "agent_start"}));
}

#[test]
fn rpc_an_unmodelled_event_type_decodes_as_unknown() {
    // `agent_settled` is documented nowhere in the pinned release; a closed
    // enum would hard-error the whole stream on it.
    let event: Event = serde_json::from_value(json!({"type": "agent_settled"})).unwrap();
    assert!(matches!(event, Event::Unknown));
}

/// `usage` is the latest cumulative provider-reported usage, not a delta.
#[test]
fn rpc_message_update_carries_cumulative_usage() {
    let sample = json!({
        "type": "message_update",
        "message": {"role": "assistant"},
        "assistantMessageEvent": {"type": "text_delta", "delta": "hi"},
        "usage": {"input": 100, "output": 20},
    });
    let event: Event = serde_json::from_value(sample.clone()).unwrap();
    match &event {
        Event::MessageUpdate { usage, .. } => {
            assert_eq!(usage.as_ref().unwrap()["input"], 100)
        }
        other => panic!("expected MessageUpdate, got {other:?}"),
    }
    assert_eq!(round_trip(&event), sample);
}

// ── Extension UI ───────────────────────────────────────────────────────────

#[test]
fn rpc_every_extension_ui_request_round_trips_with_the_pi_uuid() {
    let samples: Vec<Value> = fixture_values("extension_ui.jsonl")
        .into_iter()
        .filter(|v| v["type"] == "extension_ui_request")
        .collect();
    assert_eq!(samples.len(), 9, "captured method corpus changed");

    for sample in samples {
        let ui: ExtensionUI =
            serde_json::from_value(sample.clone()).unwrap_or_else(|e| panic!("{sample}: {e}"));
        match ui {
            ExtensionUI::ExtensionUiRequest(ExtensionUiRequest { ref id, ref method, .. }) => {
                assert!(!id.is_empty(), "pi's uuid must be preserved: {sample}");
                assert!(!method.is_empty());
            }
            other => panic!("expected a request, got {other:?}"),
        }
        assert_eq!(round_trip(&ui), sample, "round-trip changed {sample}");
    }
}

#[test]
fn rpc_every_extension_ui_response_shape_round_trips() {
    for sample in fixture_values("extension_ui.jsonl")
        .into_iter()
        .filter(|v| v["type"] == "extension_ui_response")
    {
        let ui: ExtensionUI =
            serde_json::from_value(sample.clone()).unwrap_or_else(|e| panic!("{sample}: {e}"));
        match &ui {
            ExtensionUI::ExtensionUiResponse(ExtensionUiResponse { id, .. }) => {
                assert!(!id.is_empty())
            }
            other => panic!("expected a response, got {other:?}"),
        }
        assert_eq!(round_trip(&ui), sample);
    }
}

#[test]
fn rpc_our_extension_ui_response_matches_pi_shape() {
    let ui = ExtensionUI::ExtensionUiResponse(ExtensionUiResponse {
        id: "uuid-1".into(),
        value: Some("Allow".into()),
        confirmed: None,
        cancelled: None,
    });
    assert_eq!(
        round_trip(&ui),
        json!({"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"})
    );
}

// ── Forward compatibility ──────────────────────────────────────────────────

#[test]
fn rpc_an_additive_unknown_field_is_tolerated() {
    // pi ships as PI_VERSION=latest, so no wire type may deny unknown fields.
    let event: Event = serde_json::from_value(json!({
        "type": "agent_start",
        "futureField": {"nested": [1, 2]},
    }))
    .unwrap();
    assert!(matches!(event, Event::AgentStart));

    let command: Command = serde_json::from_value(json!({
        "type": "get_state",
        "id": "req-1",
        "futureField": 1,
    }))
    .unwrap();
    assert!(matches!(command, Command::GetState { .. }));

    let response: Response = serde_json::from_value(json!({
        "type": "response",
        "command": "get_state",
        "success": true,
        "futureField": 1,
    }))
    .unwrap();
    assert!(matches!(response, Response::GetState(_)));
}

// ── Fixture corpus ─────────────────────────────────────────────────────────

/// Every line of every fixture must decode into its own family without error.
#[test]
fn rpc_fixture_corpus_parses_by_family() {
    let version = std::fs::read_to_string(fixture("PI_VERSION")).expect("PI_VERSION sidecar");
    assert!(
        version.starts_with("@earendil-works/pi-coding-agent@"),
        "fixtures must record the pi version they were captured from: {version:?}"
    );

    for line in fixture_lines("commands.jsonl") {
        serde_json::from_str::<Command>(&line).unwrap_or_else(|e| panic!("{line}: {e}"));
    }
    for line in fixture_lines("responses.jsonl") {
        serde_json::from_str::<Response>(&line).unwrap_or_else(|e| panic!("{line}: {e}"));
    }
    for line in fixture_lines("events.jsonl") {
        serde_json::from_str::<Event>(&line).unwrap_or_else(|e| panic!("{line}: {e}"));
    }
    for line in fixture_lines("extension_ui.jsonl") {
        serde_json::from_str::<ExtensionUI>(&line).unwrap_or_else(|e| panic!("{line}: {e}"));
    }
}

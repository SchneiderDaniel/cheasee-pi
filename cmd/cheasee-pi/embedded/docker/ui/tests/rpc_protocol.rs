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

use cheasee_pi_ui::bridge::{ClientMessage, ServerMessage};
use cheasee_pi_ui::protocol::{
    AssistantMessageEvent, ClearQueueData, Command, ContextUsage, Event, ExtensionUI,
    ExtensionUiRequest, ExtensionUiResponse, ModelInfo, QueueContents, Response, SessionStats,
    ThinkingLevels,
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

/// AC3: `contextUsage.tokens`/`.percent` are a tri-state; null is distinct
/// from 0 and 100.
#[test]
fn rpc_context_usage_is_tri_state() {
    let unknown: ContextUsage = serde_json::from_value(json!({"contextWindow": 200000})).unwrap();
    assert_eq!(unknown.tokens, None);
    assert_eq!(unknown.percent, None);
    assert_eq!(unknown.context_window, 200000);

    for percent in [0.0, 100.0] {
        let usage: ContextUsage = serde_json::from_value(json!({
            "tokens": 1,
            "contextWindow": 200000,
            "percent": percent,
        }))
        .unwrap();
        assert_eq!(usage.percent, Some(percent));
    }

    let explicit_null: ContextUsage =
        serde_json::from_value(json!({"tokens": null, "contextWindow": 200000, "percent": null}))
            .unwrap();
    assert_eq!(explicit_null.tokens, None);
    assert_eq!(explicit_null.percent, None);
}

/// AC3: a full stats payload decodes; a minimal one defaults every optional.
#[test]
fn rpc_session_stats_decodes_full_and_minimal() {
    let full: SessionStats = serde_json::from_value(json!({
        "sessionFile": "/s.jsonl",
        "sessionId": "s",
        "userMessages": 1,
        "assistantMessages": 2,
        "toolCalls": 3,
        "toolResults": 3,
        "totalMessages": 4,
        "tokens": {"input": 10, "output": 5, "cacheRead": 1, "cacheWrite": 2, "total": 18},
        "cost": 0.45,
        "contextUsage": {"tokens": 100, "contextWindow": 200000, "percent": 0.05}
    }))
    .unwrap();
    assert_eq!(full.tokens.total, 18);
    assert_eq!(full.tokens.cache_read, 1);
    assert_eq!(full.cost, 0.45);
    assert_eq!(full.context_usage.unwrap().context_window, 200000);

    let minimal: SessionStats = serde_json::from_value(json!({"sessionId": "s"})).unwrap();
    assert_eq!(minimal.tokens.total, 0);
    assert_eq!(minimal.cost, 0.0);
    assert!(minimal.context_usage.is_none());
    assert!(minimal.session_file.is_none());
}

/// AC2/AC5: the remaining DTOs decode with absent optionals rather than error.
#[test]
fn rpc_control_dtos_tolerate_absent_fields() {
    let model: ModelInfo = serde_json::from_value(json!({"id": "m"})).unwrap();
    assert_eq!(model.label(), "m");
    assert_eq!(model.provider, "");

    let levels: ThinkingLevels = serde_json::from_value(json!({})).unwrap();
    assert!(levels.levels.is_empty());

    let queue: QueueContents = serde_json::from_value(json!({"steering": ["s"]})).unwrap();
    assert_eq!(queue.follow_up.len(), 0);
    assert_eq!(queue.as_draft(), "s");
}

/// Forward compatibility: a control command this build does not model still
/// decodes as `Unknown` rather than failing the stream.
#[test]
fn rpc_a_future_control_command_decodes_as_unknown() {
    let command: Command =
        serde_json::from_value(json!({"type": "set_telepathy", "id": "req-1"})).unwrap();
    assert!(matches!(command, Command::Unknown));
}

// ── Event ──────────────────────────────────────────────────────────────────

#[test]
fn rpc_every_captured_session_event_round_trips() {
    let samples = fixture_values("events.jsonl");
    for sample in samples {
        let kind = sample["type"].as_str().unwrap_or_default().to_string();
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
        ("thinking_level_changed", json!({"level": "high"})),
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
    // A genuinely unmodelled type: a closed enum would hard-error the whole
    // stream on it.
    let event: Event = serde_json::from_value(json!({"type": "future_event"})).unwrap();
    assert!(matches!(event, Event::Unknown));
}

/// AC2: the thinking level is pushed, so the control follows it without a poll.
#[test]
fn rpc_thinking_level_changed_round_trips() {
    let sample = json!({"type": "thinking_level_changed", "level": "high"});
    let event: Event = serde_json::from_value(sample.clone()).unwrap();
    match &event {
        Event::ThinkingLevelChanged { level } => assert_eq!(level, "high"),
        other => panic!("expected ThinkingLevelChanged, got {other:?}"),
    }
    assert_eq!(round_trip(&event), sample);
}

/// AC4: the chunk accessor prefers the typed `delta`, tolerates the legacy
/// `output` key, and the legacy record round-trips with `output` intact (no
/// serde alias would re-serialize it as `delta`).
#[test]
fn rpc_bash_delta_prefers_typed_and_tolerates_legacy() {
    let typed: Event = serde_json::from_value(
        json!({"type": "bash_execution_update", "id": "b1", "delta": "chunk"}),
    )
    .unwrap();
    assert_eq!(typed.bash_delta(), Some("chunk"));

    let legacy_sample = json!({"type": "bash_execution_update", "id": "b1", "output": "old"});
    let legacy: Event = serde_json::from_value(legacy_sample.clone()).unwrap();
    assert_eq!(legacy.bash_delta(), Some("old"));
    assert_eq!(
        round_trip(&legacy),
        legacy_sample,
        "legacy output key must be preserved"
    );

    let empty: Event =
        serde_json::from_value(json!({"type": "bash_execution_update", "id": "b1"})).unwrap();
    assert_eq!(empty.bash_delta(), None);
}

/// pi >=0.84 removed the cumulative `message` field from `message_update`. A
/// record without it must still decode — a required field here silently drops
/// every delta into `ProtocolMessage::Unknown`.
#[test]
fn rpc_delta_only_message_update_decodes() {
    let event: Event = serde_json::from_value(json!({
        "type": "message_update",
        "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "hi"},
        "usage": {"input": 1, "output": 1},
    }))
    .unwrap();
    match event {
        Event::MessageUpdate {
            message,
            assistant_message_event,
            usage,
        } => {
            assert!(message.is_none(), "the delta-only record has no message");
            assert_eq!(assistant_message_event["delta"], "hi");
            assert_eq!(usage.unwrap()["input"], 1);
        }
        other => panic!("expected MessageUpdate, got {other:?}"),
    }
}

/// `agent_end.willRetry` is a separate signal from `agent_settled`.
#[test]
fn rpc_agent_end_carries_will_retry() {
    let event: Event =
        serde_json::from_value(json!({"type": "agent_end", "messages": [], "willRetry": true}))
            .unwrap();
    match event {
        Event::AgentEnd { will_retry, .. } => assert_eq!(will_retry, Some(true)),
        other => panic!("expected AgentEnd, got {other:?}"),
    }

    let settled: Event = serde_json::from_value(json!({"type": "agent_settled"})).unwrap();
    assert!(matches!(settled, Event::AgentSettled));
}

/// The typed `assistantMessageEvent` vocabulary parses leniently.
#[test]
fn rpc_assistant_message_event_parses_leniently() {
    let delta = AssistantMessageEvent::parse_lenient(
        &json!({"type": "thinking_delta", "contentIndex": 1, "delta": "hmm"}),
    )
    .unwrap();
    assert!(matches!(
        delta,
        AssistantMessageEvent::ThinkingDelta {
            content_index: 1,
            ..
        }
    ));

    assert!(matches!(
        AssistantMessageEvent::parse_lenient(&json!({"type": "future_event", "contentIndex": 0}))
            .unwrap(),
        AssistantMessageEvent::Unknown
    ));

    // Not an object: no event to parse.
    assert!(AssistantMessageEvent::parse_lenient(&json!("nope")).is_none());
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

// ── Reconnect envelopes (slice 9) ──────────────────────────────────────────

/// AC1: `Subscribe` round-trips with `since`, and omits it when absent.
#[test]
fn rpc_subscribe_round_trips_with_and_without_since() {
    let with = ClientMessage::Subscribe {
        id: Some("c1".into()),
        session_id: "sess-1".into(),
        since: Some("b5a3a53d".into()),
    };
    let value = round_trip(&with);
    assert_eq!(value["type"], "subscribe");
    assert_eq!(value["sessionId"], "sess-1");
    assert_eq!(value["since"], "b5a3a53d");
    assert_eq!(serde_json::from_value::<ClientMessage>(value).unwrap(), with);

    // Absent `since`: the persisted-cursor case, key omitted.
    let persisted = round_trip(&ClientMessage::Subscribe {
        id: None,
        session_id: "sess-1".into(),
        since: None,
    });
    assert!(persisted.get("since").is_none(), "since must be omitted");
    assert!(matches!(
        serde_json::from_value::<ClientMessage>(persisted).unwrap(),
        ClientMessage::Subscribe { since: None, .. }
    ));
}

#[test]
fn rpc_unsubscribe_round_trips() {
    let value = round_trip(&ClientMessage::Unsubscribe {
        id: Some("c2".into()),
        session_id: "sess-1".into(),
    });
    assert_eq!(value["type"], "unsubscribe");
    assert_eq!(value["sessionId"], "sess-1");
}

/// AC2/AC3: the reconnect header carries live/leaf/state/pending/text.
#[test]
fn rpc_session_state_round_trips_all_fields() {
    let message = ServerMessage::SessionState {
        id: Some("c1".into()),
        session_id: "sess-1".into(),
        live: true,
        leaf_id: Some("b5a3a53d".into()),
        state: Some(json!({"isStreaming": true, "isCompacting": false})),
        pending: Some(ExtensionUiRequest {
            id: "uuid-1".into(),
            method: "confirm".into(),
            params: serde_json::Map::new(),
        }),
        last_assistant_text: Some("partial".into()),
        cursor_invalid: true,
    };
    let value = round_trip(&message);
    assert_eq!(value["type"], "session_state");
    assert_eq!(value["live"], true);
    assert_eq!(value["leafId"], "b5a3a53d");
    assert_eq!(value["state"]["isStreaming"], true);
    assert_eq!(value["pending"]["id"], "uuid-1");
    assert_eq!(value["lastAssistantText"], "partial");
    assert_eq!(value["cursorInvalid"], true);
    assert_eq!(serde_json::from_value::<ServerMessage>(value).unwrap(), message);
}

#[test]
fn rpc_session_replay_round_trips() {
    let message = ServerMessage::SessionReplay {
        id: Some("c1".into()),
        session_id: "sess-1".into(),
        entries: vec![json!({"id": "b5a3a53d"})],
        done: false,
    };
    let value = round_trip(&message);
    assert_eq!(value["type"], "session_replay");
    assert_eq!(value["entries"][0]["id"], "b5a3a53d");
    assert_eq!(value["done"], false);
    assert_eq!(serde_json::from_value::<ServerMessage>(value).unwrap(), message);
}

/// AC2: a resync-required lag round-trips, and a legacy
/// `{"type":"lagged","skipped":5}` frame still decodes.
#[test]
fn rpc_lagged_resync_round_trips_and_legacy_decodes() {
    let value = round_trip(&ServerMessage::Lagged {
        skipped: 7,
        resync_required: true,
    });
    assert_eq!(value["type"], "lagged");
    assert_eq!(value["skipped"], 7);
    assert_eq!(value["resyncRequired"], true);

    let legacy: ServerMessage = serde_json::from_value(json!({"type": "lagged", "skipped": 5}))
        .unwrap();
    match legacy {
        ServerMessage::Lagged {
            skipped,
            resync_required,
        } => {
            assert_eq!(skipped, 5);
            assert!(!resync_required, "legacy frames default to no resync");
        }
        other => panic!("expected Lagged, got {other:?}"),
    }
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

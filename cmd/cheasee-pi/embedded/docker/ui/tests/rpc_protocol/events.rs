use super::*;

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

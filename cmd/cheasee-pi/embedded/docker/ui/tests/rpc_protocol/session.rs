use super::*;

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
    // The pinned PI_VERSION can be advanced (or overridden to latest), so no
    // wire type may deny unknown fields.
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

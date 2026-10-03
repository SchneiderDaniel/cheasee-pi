//! Delta assembly over the crate's public API.
//!
//! AC2/AC3/AC4: `message_update` deltas append by `contentIndex`, `text_end`
//! and `message_end.message` are authoritative, and `usage` replaces rather
//! than accumulates. Every test is `stream_`-prefixed so the crate's `stream`
//! filter reaches it (`cargo test --no-default-features --features ssr stream`).

use cheasee_pi_ui::bridge::{ClientMessage, ServerMessage, StreamingBehavior};
use cheasee_pi_ui::protocol::{AssistantMessageEvent, Event};
use cheasee_pi_ui::stream::{Assembler, BlockKind, ChatState, StreamStatus, MAX_LIVE_TEXT};
use leptos::prelude::{Get, Owner};
use serde_json::{json, Value};

fn update(event: Value) -> Event {
    Event::MessageUpdate {
        message: None,
        assistant_message_event: event,
        usage: None,
    }
}

fn delta(index: u32, delta: &str) -> Event {
    update(json!({"type": "text_delta", "contentIndex": index, "delta": delta}))
}

#[test]
fn stream_assembles_text_deltas_in_order() {
    let mut assembler = Assembler::default();
    assembler.apply(&Event::MessageStart { message: json!({}) });
    assembler.apply(&delta(0, "Hello"));
    assembler.apply(&delta(0, ", "));
    assembler.apply(&delta(0, "world"));

    assert_eq!(assembler.blocks().len(), 1);
    assert_eq!(assembler.blocks()[0].index, 0);
    assert_eq!(assembler.blocks()[0].kind, BlockKind::Text);
    assert_eq!(assembler.blocks()[0].text, "Hello, world");
}

/// AC2: blocks are keyed by `contentIndex`, so interleaved thinking and text do
/// not merge into one block.
#[test]
fn stream_groups_blocks_by_content_index() {
    let mut assembler = Assembler::default();
    assembler.apply(&delta(0, "answer"));
    assembler.apply(&update(
        json!({"type": "thinking_delta", "contentIndex": 1, "delta": "hmm"}),
    ));
    assembler.apply(&delta(0, "!"));

    assert_eq!(assembler.blocks().len(), 2);
    assert_eq!(assembler.blocks()[0].text, "answer!");
    assert_eq!(assembler.blocks()[1].kind, BlockKind::Thinking);
    assert_eq!(assembler.blocks()[1].text, "hmm");
}

/// AC2/AC3: `text_end.content` replaces the delta buffer, and
/// `message_end.message` replaces the whole partial.
#[test]
fn stream_end_events_are_authoritative() {
    let mut assembler = Assembler::default();
    assembler.apply(&delta(0, "Hel"));
    assembler.apply(&delta(0, "lo wr"));
    assembler.apply(&update(
        json!({"type": "text_end", "contentIndex": 0, "content": "Hello world"}),
    ));
    assert_eq!(assembler.blocks()[0].text, "Hello world");

    assembler.apply(&Event::MessageEnd {
        message: json!({
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "let me think"},
                {"type": "text", "text": "final"}
            ]
        }),
    });
    assert_eq!(assembler.blocks().len(), 2);
    assert_eq!(assembler.blocks()[0].kind, BlockKind::Thinking);
    assert_eq!(assembler.blocks()[0].text, "let me think");
    assert_eq!(assembler.blocks()[1].kind, BlockKind::Text);
    assert_eq!(assembler.blocks()[1].text, "final");
}

/// AC4: `usage` is a cumulative snapshot — replaced, never summed.
#[test]
fn stream_usage_replaces_not_accumulates() {
    let mut assembler = Assembler::default();
    for (output, cost) in [(2u64, 0.01f64), (5, 0.02)] {
        assembler.apply(&Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "text_delta", "contentIndex": 0, "delta": "x"}),
            usage: Some(json!({"input": 10, "output": output, "cost": {"total": cost}})),
        });
    }
    let usage = assembler.usage();
    assert_eq!(usage.input, 10, "cumulative input must not double count");
    assert_eq!(usage.output, 5);
    assert_eq!(usage.cost_total, 0.02);
    assert!(usage.available);
}

/// AC5: `agent_end` alone does not end the run; `agent_settled` does, and
/// `willRetry` is surfaced separately.
#[test]
fn stream_settles_only_on_agent_settled() {
    let mut assembler = Assembler::default();
    assembler.apply(&Event::AgentStart);
    assert!(assembler.status().is_streaming());

    assembler.apply(&Event::AgentEnd {
        messages: vec![],
        will_retry: Some(true),
    });
    assert_eq!(assembler.status(), StreamStatus::Streaming);
    assert_eq!(assembler.will_retry(), Some(true));

    assembler.apply(&Event::AgentSettled);
    assert_eq!(assembler.status(), StreamStatus::Settled);
}

#[test]
fn stream_bounds_the_live_text() {
    let mut assembler = Assembler::default();
    for _ in 0..(MAX_LIVE_TEXT / 10 + 2) {
        assembler.apply(&delta(0, "0123456789"));
    }
    assert!(assembler.blocks()[0].truncated);
    assert!(assembler.blocks()[0].text.len() <= MAX_LIVE_TEXT);
}

/// pi >=0.84 emits `message_update` without the cumulative `message` field.
#[test]
fn stream_decodes_a_delta_only_message_update() {    let event: Event = serde_json::from_value(json!({
        "type": "message_update",
        "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "hi"},
    }))
    .expect("delta-only record must decode");
    let mut assembler = Assembler::default();
    assembler.apply(&event);
    assert_eq!(assembler.blocks()[0].text, "hi");
}

#[test]
fn stream_parses_assistant_events_leniently() {
    assert!(matches!(
        AssistantMessageEvent::parse_lenient(
            &json!({"type": "text_delta", "contentIndex": 0, "delta": "x"})
        )
        .unwrap(),
        AssistantMessageEvent::TextDelta {
            content_index: 0,
            ..
        }
    ));
    assert!(matches!(
        AssistantMessageEvent::parse_lenient(&json!({"type": "future"})).unwrap(),
        AssistantMessageEvent::Unknown
    ));
}

/// The browser<->server envelope is forward compatible and carries the
/// `streamingBehavior` wire values pi expects.
#[test]
fn stream_bridge_envelope_round_trips() {
    let prompt = ClientMessage::Prompt {
        id: Some("c1".into()),
        message: "hi".into(),
        streaming_behavior: Some(StreamingBehavior::FollowUp),
    };
    let value = serde_json::to_value(&prompt).unwrap();
    assert_eq!(value["type"], "prompt");
    assert_eq!(value["streamingBehavior"], "followUp");
    assert_eq!(serde_json::from_value::<ClientMessage>(value).unwrap(), prompt);

    // An unknown envelope decodes rather than failing the connection.
    let unknown: ClientMessage = serde_json::from_value(json!({"type": "future"})).unwrap();
    assert!(matches!(unknown, ClientMessage::Unknown));

    let event = ServerMessage::Event {
        event: Event::AgentSettled,
    };
    assert_eq!(
        serde_json::from_value::<ServerMessage>(serde_json::to_value(&event).unwrap()).unwrap(),
        event
    );
}

/// Relay lag is surfaced (a banner) and counted; a rejected command is
/// surfaced rather than swallowed (AC5).
#[test]
fn stream_chat_state_surfaces_lag_and_rejection() {
    let owner = Owner::new();
    owner.set();
    let state = ChatState::new();

    state.apply(&ServerMessage::Lagged { skipped: 5 });
    assert_eq!(state.lagged.get(), 5);
    assert!(state.notice.get().unwrap().contains("5 events dropped"));

    state.apply(&ServerMessage::CommandResponse {
        id: None,
        command: "prompt".into(),
        success: false,
        error: Some("busy".into()),
        disposition: None,
        data: None,
    });
    assert_eq!(state.notice.get().as_deref(), Some("busy"));
}

/// On the server there is no frame clock, so each frame flushes straight into
/// the signals.
#[test]
fn stream_chat_state_flushes_frames_into_signals() {
    let owner = Owner::new();
    owner.set();
    let state = ChatState::new();

    state.ingest_frame(
        &serde_json::to_string(&ServerMessage::Event {
            event: delta(0, "hello"),
        })
        .unwrap(),
    );
    assert_eq!(state.blocks.get()[0].text, "hello");

    state.ingest_frame(
        &serde_json::to_string(&ServerMessage::Event {
            event: Event::AgentSettled,
        })
        .unwrap(),
    );
    assert_eq!(state.status.get(), StreamStatus::Settled);
}

/// AC2/AC3/AC5: the response envelope carries pi's `data` payload through, and
/// omits the key entirely when there is none.
#[test]
fn stream_command_response_data_passes_through() {
    let with_data = ServerMessage::CommandResponse {
        id: Some("c1".into()),
        command: "get_session_stats".into(),
        success: true,
        error: None,
        disposition: None,
        data: Some(json!({"sessionId": "s"})),
    };
    let value = serde_json::to_value(&with_data).unwrap();
    assert_eq!(value["data"]["sessionId"], "s");
    assert_eq!(
        serde_json::from_value::<ServerMessage>(value).unwrap(),
        with_data
    );

    let without = ServerMessage::CommandResponse {
        id: None,
        command: "abort".into(),
        success: true,
        error: None,
        disposition: None,
        data: None,
    };
    let value = serde_json::to_value(&without).unwrap();
    assert!(
        value.get("data").is_none(),
        "an absent payload must not serialize as null"
    );
}

/// AC1–AC5: each curated control envelope round-trips over its wire `type`.
#[test]
fn stream_control_envelopes_round_trip() {
    let cases = vec![
        ClientMessage::ClearQueue { id: None },
        ClientMessage::GetState { id: None },
        ClientMessage::GetAvailableModels { id: None },
        ClientMessage::SetModel {
            id: None,
            provider: "anthropic".into(),
            model_id: "claude".into(),
        },
        ClientMessage::CycleModel { id: None },
        ClientMessage::GetAvailableThinkingLevels { id: None },
        ClientMessage::SetThinkingLevel {
            id: None,
            level: "high".into(),
        },
        ClientMessage::CycleThinkingLevel { id: None },
        ClientMessage::GetSessionStats { id: None },
        ClientMessage::Compact {
            id: None,
            custom_instructions: None,
        },
        ClientMessage::SetAutoCompaction {
            id: None,
            enabled: true,
        },
        ClientMessage::SetAutoRetry {
            id: None,
            enabled: false,
        },
        ClientMessage::AbortRetry { id: None },
        ClientMessage::Bash {
            id: "b1".into(),
            command: "echo hi".into(),
            exclude_from_context: None,
        },
        ClientMessage::AbortBash { id: None },
    ];
    for message in cases {
        let value = serde_json::to_value(&message).unwrap();
        assert!(value["type"].is_string(), "{value} has no wire type");
        assert_eq!(
            serde_json::from_value::<ClientMessage>(value).unwrap(),
            message
        );
    }

    // A control envelope this build does not model still decodes.
    let future: ClientMessage = serde_json::from_value(json!({"type": "set_telepathy"})).unwrap();
    assert!(matches!(future, ClientMessage::Unknown));
}

/// The control events are `ControlsState`'s; applying them to the transcript
/// must be a no-op (and must not panic).
#[test]
fn stream_control_events_do_not_touch_the_transcript() {
    let owner = Owner::new();
    owner.set();
    let state = ChatState::new();
    state.apply(&ServerMessage::Event {
        event: Event::AgentStart,
    });
    let before = state.blocks.get();

    for event in [
        Event::QueueUpdate {
            steering: vec!["a".into()],
            follow_up: vec![],
        },
        Event::CompactionStart {
            reason: "threshold".into(),
        },
        Event::CompactionEnd {
            reason: "threshold".into(),
            result: json!({}),
            aborted: false,
            will_retry: false,
            error_message: None,
        },
        Event::AutoRetryStart {
            attempt: 1,
            max_attempts: 3,
            delay_ms: 1000,
            error_message: "e".into(),
        },
        Event::AutoRetryEnd {
            success: true,
            attempt: 2,
            final_error: None,
        },
        Event::ThinkingLevelChanged {
            level: "high".into(),
        },
    ] {
        assert!(!state.apply(&ServerMessage::Event { event }));
    }
    assert_eq!(state.blocks.get(), before);
    assert_eq!(state.status.get(), StreamStatus::Streaming);
}

/// Session envelopes: the harness commands carry ids (not paths), and the
/// server row never leaks a host path or the process marker.
#[test]
fn stream_session_envelopes_round_trip() {
    use cheasee_pi_ui::bridge::SessionRow;

    let list = ClientMessage::ListSessions {
        id: Some("c1".into()),
    };
    let value = serde_json::to_value(&list).unwrap();
    assert_eq!(value["type"], "list_sessions");
    assert_eq!(
        serde_json::from_value::<ClientMessage>(value).unwrap(),
        list
    );

    let resume = ClientMessage::ResumeSession {
        id: None,
        session_id: "abc".into(),
        mode: Some("fork".into()),
        entry_id: Some("e1".into()),
    };
    let value = serde_json::to_value(&resume).unwrap();
    assert_eq!(value["type"], "resume_session");
    assert_eq!(value["sessionId"], "abc");
    assert_eq!(value["mode"], "fork");
    assert_eq!(value["entryId"], "e1");
    assert_eq!(
        serde_json::from_value::<ClientMessage>(value).unwrap(),
        resume
    );

    let stop = ClientMessage::StopSession {
        id: None,
        session_id: "abc".into(),
    };
    assert_eq!(serde_json::to_value(&stop).unwrap()["type"], "stop_session");

    let row = SessionRow {
        id: "abc".into(),
        name: Some("My session".into()),
        modified: 7,
        created: None,
        message_count: 3,
        in_use: false,
        unavailable: false,
    };
    let message = ServerMessage::SessionList {
        id: None,
        sessions: vec![row],
    };
    let value = serde_json::to_value(&message).unwrap();
    assert_eq!(value["type"], "session_list");
    assert_eq!(value["sessions"][0]["messageCount"], 3);
    let serialized = value.to_string();
    assert!(
        !serialized.contains("\"path\""),
        "the session row must never carry a host path: {serialized}"
    );
    assert!(
        !serialized.contains("CHEASEE_SESSION_ID"),
        "the session row must never carry the process marker: {serialized}"
    );
    assert_eq!(
        serde_json::from_value::<ServerMessage>(value).unwrap(),
        message
    );

    let action = ServerMessage::SessionAction {
        id: None,
        session_id: "abc".into(),
        success: false,
        error: Some("in use".into()),
    };
    assert_eq!(serde_json::to_value(&action).unwrap()["success"], false);
}

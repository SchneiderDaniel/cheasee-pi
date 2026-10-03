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
fn stream_decodes_a_delta_only_message_update() {
    let event: Event = serde_json::from_value(json!({
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

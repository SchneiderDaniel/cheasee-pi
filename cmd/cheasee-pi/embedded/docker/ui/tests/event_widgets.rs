//! Event-widget reducers: the pure tool-card reducer and the control-plane
//! compaction/retry reducers, plus the additive summarization-retry wire arms.
//!
//! This crate has no browser/e2e harness, so the DOM is not assertable; the
//! components are thin renderers over the state asserted here (precedent:
//! `session_controls.rs`). Go structural guards cover the keyed `<For>` and the
//! single-surface wiring.
//!
//! Functions are `tool_card_*`, `banners_*`, `rpc_*` and `renderer_*`-prefixed
//! so targeted filters reach the right group.

use cheasee_pi_ui::bridge::ServerMessage;
use cheasee_pi_ui::controls::{
    CompactionPhase, CompactionReason, CompactionState, ControlsState, RetryPill, RetrySource,
};
use cheasee_pi_ui::protocol::Event;
use cheasee_pi_ui::stream::{reconcile_row_views, Assembler, MAX_LIVE_TEXT};
use cheasee_pi_ui::tool_card::{content_text, ToolCard, ToolStatus};
use leptos::prelude::{Get, GetUntracked, Owner};
use serde_json::{json, Value};

fn controls() -> ControlsState {
    let owner = Owner::new();
    owner.set();
    std::mem::forget(owner);
    ControlsState::new()
}

fn event(event: Event) -> ServerMessage {
    ServerMessage::Event { event }
}

// ── Tool cards ─────────────────────────────────────────────────────────────

#[test]
fn tool_card_update_replaces_snapshot_never_appends() {
    let mut card = ToolCard::start("c", "bash", &json!({"command": "ls"}));
    assert!(card.update(
        &json!({"command": "ls"}),
        &json!({"content": [{"type": "text", "text": "par"}]}),
    ));
    assert!(card.update(
        &json!({"command": "ls"}),
        &json!({"content": [{"type": "text", "text": "partial"}]}),
    ));
    assert_eq!(card.output, "partial", "snapshots replace, never append");
    assert_eq!(card.status, ToolStatus::Running);
}

#[test]
fn tool_card_tolerates_empty_partial_result() {
    let mut card = ToolCard::start("c", "bash", &json!({}));
    // pi emits `onUpdate({content: []})` before any output exists.
    assert!(!card.update(&json!({}), &json!({})), "no change");
    assert!(card.output.is_empty());
    assert_eq!(card.status, ToolStatus::Running);
}

#[test]
fn tool_card_joins_text_parts_and_skips_non_text() {
    assert_eq!(
        content_text(&json!([
            {"type": "text", "text": "a"},
            {"type": "image", "data": "zzz"},
            {"type": "text", "text": "b"}
        ])),
        "a\nb"
    );
    assert_eq!(content_text(&json!({"content": []})), "");
}

#[test]
fn tool_card_end_result_marks_done() {
    let mut card = ToolCard::start("c", "bash", &json!({}));
    assert!(card.end(
        &json!({"content": [{"type": "text", "text": "total 48"}]}),
        false,
    ));
    assert_eq!(card.output, "total 48");
    assert_eq!(card.status, ToolStatus::Done);
}

#[test]
fn tool_card_end_error_marks_error_and_surfaces_text() {
    let mut card = ToolCard::start("c", "bash", &json!({}));
    assert!(card.end(
        &json!({"content": [{"type": "text", "text": "boom"}]}),
        true,
    ));
    assert_eq!(card.status, ToolStatus::Error);
    assert_eq!(card.output, "boom");
}

#[test]
fn tool_card_start_then_end_without_update() {
    let mut card = ToolCard::start("c", "bash", &json!({}));
    card.end(
        &json!({"content": [{"type": "text", "text": "done"}]}),
        false,
    );
    assert_eq!(card.output, "done");
    assert_eq!(card.status, ToolStatus::Done);
}

#[test]
fn tool_card_output_is_bounded() {
    let mut card = ToolCard::start("c", "bash", &json!({}));
    let long = "x".repeat(MAX_LIVE_TEXT + 500);
    card.update(
        &json!({}),
        &json!({"content": [{"type": "text", "text": long}]}),
    );
    assert!(card.truncated);
    assert!(card.output.len() <= MAX_LIVE_TEXT);
}

// ── Additive wire arms ─────────────────────────────────────────────────────

#[test]
fn rpc_summarization_retry_events_round_trip() {
    for sample in [
        json!({"type": "summarization_retry_scheduled", "attempt": 1, "maxAttempts": 3, "delayMs": 2000, "errorMessage": "e"}),
        json!({"type": "summarization_retry_attempt_start", "attempt": 2, "maxAttempts": 3, "delayMs": 2000, "errorMessage": "e"}),
        json!({"type": "summarization_retry_finished", "success": true, "attempt": 2}),
    ] {
        let decoded: Event = serde_json::from_value(sample.clone()).unwrap_or_else(|e| {
            panic!("{sample} must decode: {e}");
        });
        assert!(!matches!(decoded, Event::Unknown), "{sample} fell through");
        assert_eq!(
            serde_json::to_value(&decoded).unwrap(),
            sample,
            "round-trip changed the record"
        );
    }
}

/// The additive arms must not close the enum: an unmodelled type still decodes.
#[test]
fn rpc_unmodelled_event_still_decodes_as_unknown() {
    let value: Value = json!({"type": "future_event"});
    let event: Event = serde_json::from_value(value).unwrap();
    assert!(matches!(event, Event::Unknown));
}

// ── Renderer reactivity (keyed rows) ─────────────────────────────────────────

fn delta(index: u32, delta: &str) -> Event {
    Event::MessageUpdate {
        message: None,
        assistant_message_event: json!({"type": "text_delta", "contentIndex": index, "delta": delta}),
        usage: None,
    }
}

/// Audit regression: the keyed `<For>` renders each row from a stable `id` and
/// a reused payload signal. A same-id text update must mutate that signal — if
/// the view captured a snapshot, it would freeze at the first delta.
#[test]
fn renderer_same_id_text_update_reaches_row_signal() {
    let owner = Owner::new();
    owner.set();
    let mut a = Assembler::default();
    a.reduce_event(&Event::MessageStart { message: json!({}) });
    a.reduce_event(&delta(0, "Hel"));
    let first = reconcile_row_views(&[], a.rows());
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].kind.get_untracked().as_text().unwrap().text,
        "Hel"
    );

    a.reduce_event(&delta(0, "lo"));
    let second = reconcile_row_views(&first, a.rows());
    assert_eq!(second[0].id, first[0].id, "stable key");
    assert_eq!(
        second[0].kind.get_untracked().as_text().unwrap().text,
        "Hello",
        "same-id delta must reach the retained row signal (AC1)"
    );
}

/// Audit regression: a tool card keyed by `toolCallId` updates output and final
/// status in place — no second row, and an error result is not shown as success.
#[test]
fn renderer_same_id_tool_update_reaches_row_signal() {
    let owner = Owner::new();
    owner.set();
    let mut a = Assembler::default();
    a.reduce_event(&Event::ToolExecutionStart {
        tool_call_id: "call_1".into(),
        tool_name: "bash".into(),
        args: json!({"command": "ls"}),
    });
    let first = reconcile_row_views(&[], a.rows());
    assert_eq!(first.len(), 1);

    a.reduce_event(&Event::ToolExecutionUpdate {
        tool_call_id: "call_1".into(),
        tool_name: "bash".into(),
        args: json!({"command": "ls"}),
        partial_result: json!({"content": [{"type": "text", "text": "partial"}]}),
    });
    a.reduce_event(&Event::ToolExecutionEnd {
        tool_call_id: "call_1".into(),
        tool_name: "bash".into(),
        result: json!({"content": [{"type": "text", "text": "boom"}], "isError": true}),
        is_error: true,
    });

    let second = reconcile_row_views(&first, a.rows());
    assert_eq!(second.len(), 1, "one card per toolCallId");
    assert_eq!(second[0].id, first[0].id, "stable key");
    let kind = second[0].kind.get_untracked();
    let card = kind.as_tool().expect("tool row");
    assert_eq!(card.output, "boom");
    assert_eq!(card.status, ToolStatus::Error);
}

mod banners;

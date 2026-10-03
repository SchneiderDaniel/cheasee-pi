//! Event-widget reducers: the pure tool-card reducer and the control-plane
//! compaction/retry reducers, plus the additive summarization-retry wire arms.
//!
//! This crate has no browser/e2e harness, so the DOM is not assertable; the
//! components are thin renderers over the state asserted here (precedent:
//! `session_controls.rs`). Go structural guards cover the keyed `<For>` and the
//! single-surface wiring.
//!
//! Functions are `tool_card_*`, `banners_*` and `rpc_*`-prefixed so targeted
//! filters reach the right group.

use cheasee_pi_ui::bridge::ServerMessage;
use cheasee_pi_ui::controls::{
    CompactionPhase, CompactionReason, CompactionState, ControlsState, RetryPill, RetrySource,
};
use cheasee_pi_ui::protocol::Event;
use cheasee_pi_ui::stream::MAX_LIVE_TEXT;
use cheasee_pi_ui::tool_card::{content_text, ToolCard, ToolStatus};
use leptos::prelude::{Get, Owner};
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

// ── Compaction banner ──────────────────────────────────────────────────────

#[test]
fn banners_compaction_start_sets_running_with_reason() {
    let c = controls();
    assert!(c.apply(&event(Event::CompactionStart {
        reason: "manual".into(),
    })));
    assert_eq!(
        c.compaction.get(),
        Some(CompactionState {
            reason: CompactionReason::Manual,
            phase: CompactionPhase::Running,
        })
    );
}

#[test]
fn banners_compaction_end_labels_by_reason() {
    let c = controls();
    for (reason, label) in [
        ("manual", "Compacting context…"),
        ("threshold", "Auto-compacting…"),
        ("overflow", "Context overflow detected, Auto-compacting…"),
    ] {
        c.apply(&event(Event::CompactionEnd {
            reason: reason.into(),
            result: json!({}),
            aborted: false,
            will_retry: false,
            error_message: None,
        }));
        let state = c.compaction.get().unwrap();
        assert_eq!(state.label(), label);
        assert_eq!(
            state.phase,
            CompactionPhase::Finished {
                aborted: false,
                will_retry: false,
                error_message: None,
            }
        );
    }
}

#[test]
fn banners_compaction_unknown_reason_is_generic() {
    let c = controls();
    c.apply(&event(Event::CompactionStart {
        reason: "future".into(),
    }));
    let state = c.compaction.get().unwrap();
    assert_eq!(state.reason, CompactionReason::Unknown);
    assert_eq!(state.label(), "Compacting…");
}

#[test]
fn banners_compaction_restores_without_reason() {
    let c = controls();
    c.apply(&ServerMessage::CommandResponse {
        id: None,
        command: "get_state".into(),
        success: true,
        error: None,
        disposition: None,
        data: Some(json!({"isCompacting": true})),
    });
    let state = c.compaction.get().unwrap();
    assert_eq!(state.reason, CompactionReason::Unknown);
    assert_eq!(state.label(), "Compacting…");
    assert_eq!(state.phase, CompactionPhase::Running);
}

// ── Retry pills ────────────────────────────────────────────────────────────

#[test]
fn banners_retry_pill_from_auto_retry_start() {
    let c = controls();
    assert!(c.apply(&event(Event::AutoRetryStart {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 2000,
        error_message: "529".into(),
    })));
    assert_eq!(
        c.retry.get(),
        Some(RetryPill {
            source: RetrySource::Auto,
            attempt: 1,
            max_attempts: 3,
            delay_ms: 2000,
            error_message: "529".into(),
        })
    );
}

#[test]
fn banners_retry_pill_clears_on_success() {
    let c = controls();
    c.apply(&event(Event::AutoRetryStart {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 1000,
        error_message: "e".into(),
    }));
    assert!(c.apply(&event(Event::AutoRetryEnd {
        success: true,
        attempt: 2,
        final_error: None,
    })));
    assert!(c.retry.get().is_none());
}

#[test]
fn banners_retry_final_failure_surfaces_notice() {
    let c = controls();
    c.apply(&event(Event::AutoRetryStart {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 1000,
        error_message: "e".into(),
    }));
    assert!(c.apply(&event(Event::AutoRetryEnd {
        success: false,
        attempt: 3,
        final_error: Some("gave up".into()),
    })));
    assert!(c.retry.get().is_none(), "pill clears");
    assert!(c.notice.get().unwrap().contains("gave up"));
}

/// Pinned pi 0.79.10 emits no `summarization_retry_*`; the variants still exist
/// and drive a pill, so the widget is not permanently dead.
#[test]
fn banners_summarization_pill_from_synthesized_events() {
    let c = controls();
    c.apply(&event(Event::SummarizationRetryScheduled {
        attempt: 1,
        max_attempts: 2,
        delay_ms: 500,
        error_message: "context".into(),
    }));
    let pill = c.retry.get().unwrap();
    assert_eq!(pill.source, RetrySource::Summarization);
    assert_eq!(pill.attempt, 1);
    assert_eq!(pill.max_attempts, 2);

    c.apply(&event(Event::SummarizationRetryAttemptStart {
        attempt: 2,
        max_attempts: 2,
        delay_ms: 500,
        error_message: "context".into(),
    }));
    assert_eq!(c.retry.get().unwrap().attempt, 2);

    c.apply(&event(Event::SummarizationRetryFinished {
        success: true,
        attempt: 2,
        final_error: None,
    }));
    assert!(c.retry.get().is_none());
}

#[test]
fn banners_only_one_retry_pill_is_active() {
    let c = controls();
    c.apply(&event(Event::AutoRetryStart {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 1000,
        error_message: "auto".into(),
    }));
    c.apply(&event(Event::SummarizationRetryScheduled {
        attempt: 1,
        max_attempts: 2,
        delay_ms: 500,
        error_message: "sum".into(),
    }));
    let pill = c.retry.get().unwrap();
    assert_eq!(pill.source, RetrySource::Summarization);
    assert_eq!(pill.error_message, "sum");
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

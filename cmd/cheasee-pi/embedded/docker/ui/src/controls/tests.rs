use super::*;
use leptos::prelude::{Get, Owner};
use serde_json::json;

/// Signals need a reactive owner to allocate into (pattern from
/// `stream_assembly.rs`). The owner is leaked: dropping it at the end of
/// this helper would dispose the signals before the test reads them.
fn controls() -> ControlsState {
    let owner = Owner::new();
    owner.set();
    std::mem::forget(owner);
    ControlsState::new()
}

fn ok(command: &str, data: Value) -> ServerMessage {
    ServerMessage::CommandResponse {
        id: Some("c1".into()),
        command: command.into(),
        success: true,
        error: None,
        disposition: None,
        data: Some(data),
    }
}

fn failed(command: &str, error: &str) -> ServerMessage {
    ServerMessage::CommandResponse {
        id: Some("c1".into()),
        command: command.into(),
        success: false,
        error: Some(error.into()),
        disposition: None,
        data: None,
    }
}

#[test]
fn controls_available_models_populate_the_picker() {
    let c = controls();
    assert!(c.reduce_controls(&ok(
        "get_available_models",
        json!({"models": [
            {"id": "claude", "name": "Claude", "provider": "anthropic", "reasoning": true},
        ]}),
    )));
    assert_eq!(c.models.get().len(), 1);
    assert_eq!(c.models.get()[0].provider, "anthropic");
    assert_eq!(c.models.get()[0].label(), "Claude");
}

/// AC2: `["off"]` is the non-reasoning model's level list, not an error.
#[test]
fn controls_thinking_levels_include_the_off_case() {
    let c = controls();
    assert!(c.reduce_controls(&ok(
        "get_available_thinking_levels",
        json!({"levels": ["off"]}),
    )));
    assert_eq!(c.thinking_levels.get(), vec!["off".to_string()]);
}

/// AC3: `contextUsage.percent` is a tri-state — null, 0, and 100 differ.
#[test]
fn controls_stats_keep_the_unknown_context_state() {
    let c = controls();
    c.reduce_controls(&ok(
        "get_session_stats",
        json!({
            "sessionId": "s",
            "tokens": {"input": 10, "output": 2, "total": 12},
            "cost": 0.45,
            "contextUsage": {"contextWindow": 200000},
        }),
    ));
    let stats = c.stats.get().unwrap();
    assert_eq!(stats.tokens.total, 12);
    assert_eq!(stats.cost, 0.45);
    let usage = stats.context_usage.unwrap();
    assert_eq!(usage.percent, None, "unknown percent is null, not zero");
    assert_eq!(usage.tokens, None);

    c.reduce_controls(&ok(
        "get_session_stats",
        json!({"contextUsage": {"tokens": 0, "contextWindow": 200000, "percent": 0}}),
    ));
    assert_eq!(
        c.stats.get().unwrap().context_usage.unwrap().percent,
        Some(0.0)
    );

    c.reduce_controls(&ok(
        "get_session_stats",
        json!({"contextUsage": {"tokens": 200000, "contextWindow": 200000, "percent": 100}}),
    ));
    assert_eq!(
        c.stats.get().unwrap().context_usage.unwrap().percent,
        Some(100.0)
    );
}

/// AC5: `queue_update` replaces the panel; an empty update clears it.
#[test]
fn controls_queue_update_replaces_not_appends() {
    let c = controls();
    c.reduce_controls(&ServerMessage::Event {
        event: Event::QueueUpdate {
            steering: vec!["a".into()],
            follow_up: vec!["b".into()],
        },
    });
    assert_eq!(c.queue.get().steering, vec!["a".to_string()]);
    c.reduce_controls(&ServerMessage::Event {
        event: Event::QueueUpdate {
            steering: vec!["c".into()],
            follow_up: vec![],
        },
    });
    assert_eq!(c.queue.get().steering, vec!["c".to_string()]);
    c.reduce_controls(&ServerMessage::Event {
        event: Event::QueueUpdate {
            steering: vec![],
            follow_up: vec![],
        },
    });
    assert!(c.queue.get().is_empty());
}

/// AC1: `clear_queue` hands the removed text back for the editor.
#[test]
fn controls_clear_queue_restores_the_draft() {
    let c = controls();
    c.queue.set(QueueContents {
        steering: vec!["one".into()],
        follow_up: vec!["two".into()],
    });
    assert!(c.reduce_controls(&ok(
        "clear_queue",
        json!({"steering": ["one"], "followUp": ["two"]}),
    )));
    assert_eq!(c.draft.get(), "one\ntwo");
    assert!(c.queue.get().is_empty());
}

/// AC2: the level control follows the push event, not a poll.
#[test]
fn controls_thinking_level_changed_updates_without_polling() {
    let c = controls();
    assert!(c.reduce_controls(&ServerMessage::Event {
        event: Event::ThinkingLevelChanged {
            level: "high".into(),
        },
    }));
    assert_eq!(c.thinking_level.get().as_deref(), Some("high"));
}

/// AC5: the retry banner is event-driven and clears on `auto_retry_end`.
#[test]
fn controls_retry_banner_tracks_auto_retry_events() {
    let c = controls();
    assert_eq!(c.auto_retry.get(), None, "indeterminate until set");
    c.reduce_controls(&ServerMessage::Event {
        event: Event::AutoRetryStart {
            attempt: 1,
            max_attempts: 3,
            delay_ms: 2000,
            error_message: "529".into(),
        },
    });
    let banner = c.retry.get().unwrap();
    assert_eq!(banner.attempt, 1);
    assert_eq!(banner.max_attempts, 3);
    assert_eq!(banner.delay_ms, 2000);
    assert_eq!(banner.error_message, "529");

    c.reduce_controls(&ServerMessage::Event {
        event: Event::AutoRetryEnd {
            success: true,
            attempt: 2,
            final_error: None,
        },
    });
    assert!(c.retry.get().is_none());
}

/// AC2: a rejected `set_model` leaves the previous selection untouched.
#[test]
fn controls_failed_set_model_leaves_selection_unchanged() {
    let c = controls();
    c.reduce_controls(&ok(
        "set_model",
        json!({"id": "old", "name": "Old", "provider": "p"}),
    ));
    assert!(c.reduce_controls(&failed("set_model", "Model not found: p/new")));
    assert_eq!(c.model.get().unwrap().id, "old");
    assert!(c.notice.get().unwrap().contains("Model not found"));
}

/// AC2: an exhausted scoped cycle returns `data:null` — a no-op.
#[test]
fn controls_null_cycle_is_a_noop() {
    let c = controls();
    assert!(!c.reduce_controls(&ok("cycle_model", Value::Null)));
    assert!(!c.reduce_controls(&ok("cycle_thinking_level", Value::Null)));
    assert!(c.model.get().is_none());
    assert!(c.notice.get().is_none());
}

/// AC3/AC5: toggles commit only on success; `abort_retry` clears the banner.
#[test]
fn controls_toggles_commit_on_success() {
    let c = controls();
    c.set_auto_compaction(true);
    c.reduce_controls(&ok("set_auto_compaction", json!({})));
    assert_eq!(c.auto_compaction.get(), Some(true));

    c.set_auto_retry(false);
    c.reduce_controls(&ok("set_auto_retry", json!({})));
    assert_eq!(c.auto_retry.get(), Some(false));

    c.reduce_controls(&ServerMessage::Event {
        event: Event::AutoRetryStart {
            attempt: 1,
            max_attempts: 3,
            delay_ms: 1000,
            error_message: "e".into(),
        },
    });
    c.reduce_controls(&ok("abort_retry", json!({})));
    assert!(c.retry.get().is_none());
}

/// A failed toggle does not commit the pending value.
#[test]
fn controls_failed_toggle_does_not_commit() {
    let c = controls();
    c.set_auto_compaction(true);
    c.reduce_controls(&failed("set_auto_compaction", "nope"));
    assert_eq!(c.auto_compaction.get(), None);
}

/// AC4: bash chunks assemble into whole lines in the id's log.
#[test]
fn controls_bash_chunks_assemble_per_id() {
    let c = controls();
    c.reduce_controls(&ServerMessage::Event {
        event: Event::BashExecutionUpdate {
            id: Some("b1".into()),
            delta: Some("foo".into()),
            extra: serde_json::Map::new(),
        },
    });
    c.reduce_controls(&ServerMessage::Event {
        event: Event::BashExecutionUpdate {
            id: Some("b1".into()),
            delta: Some("bar\n".into()),
            extra: serde_json::Map::new(),
        },
    });
    c.reduce_controls(&ServerMessage::Event {
        event: Event::BashExecutionUpdate {
            id: Some("b2".into()),
            delta: Some("other\n".into()),
            extra: serde_json::Map::new(),
        },
    });
    let logs = c.bash.get();
    assert_eq!(logs.get("b1").unwrap().lines(), &["foobar"]);
    assert_eq!(logs.get("b2").unwrap().lines(), &["other"]);
}

/// AC1: the relay relays a rejected control instead of going silent.
#[test]
fn controls_reports_a_rejected_command() {
    let c = controls();
    assert!(c.reduce_controls(&failed("clear_queue", "Unknown command: clear_queue")));
    assert!(c
        .notice
        .get()
        .unwrap()
        .contains("Unknown command: clear_queue"));
}

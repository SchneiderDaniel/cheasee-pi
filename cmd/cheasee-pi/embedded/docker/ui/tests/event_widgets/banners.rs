use super::*;

// ── Compaction banner ──────────────────────────────────────────────────────

#[test]
fn banners_compaction_start_sets_running_with_reason() {
    let c = controls();
    assert!(c.reduce_controls(&event(Event::CompactionStart {
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
        c.reduce_controls(&event(Event::CompactionEnd {
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
    c.reduce_controls(&event(Event::CompactionStart {
        reason: "future".into(),
    }));
    let state = c.compaction.get().unwrap();
    assert_eq!(state.reason, CompactionReason::Unknown);
    assert_eq!(state.label(), "Compacting…");
}

#[test]
fn banners_compaction_restores_without_reason() {
    let c = controls();
    c.reduce_controls(&ServerMessage::CommandResponse {
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
    assert!(c.reduce_controls(&event(Event::AutoRetryStart {
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
    c.reduce_controls(&event(Event::AutoRetryStart {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 1000,
        error_message: "e".into(),
    }));
    assert!(c.reduce_controls(&event(Event::AutoRetryEnd {
        success: true,
        attempt: 2,
        final_error: None,
    })));
    assert!(c.retry.get().is_none());
}

#[test]
fn banners_retry_final_failure_surfaces_notice() {
    let c = controls();
    c.reduce_controls(&event(Event::AutoRetryStart {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 1000,
        error_message: "e".into(),
    }));
    assert!(c.reduce_controls(&event(Event::AutoRetryEnd {
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
    c.reduce_controls(&event(Event::SummarizationRetryScheduled {
        attempt: 1,
        max_attempts: 2,
        delay_ms: 500,
        error_message: "context".into(),
    }));
    let pill = c.retry.get().unwrap();
    assert_eq!(pill.source, RetrySource::Summarization);
    assert_eq!(pill.attempt, 1);
    assert_eq!(pill.max_attempts, 2);

    c.reduce_controls(&event(Event::SummarizationRetryAttemptStart {
        attempt: 2,
        max_attempts: 2,
        delay_ms: 500,
        error_message: "context".into(),
    }));
    assert_eq!(c.retry.get().unwrap().attempt, 2);

    c.reduce_controls(&event(Event::SummarizationRetryFinished {
        success: true,
        attempt: 2,
        final_error: None,
    }));
    assert!(c.retry.get().is_none());
}

#[test]
fn banners_only_one_retry_pill_is_active() {
    let c = controls();
    c.reduce_controls(&event(Event::AutoRetryStart {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 1000,
        error_message: "auto".into(),
    }));
    c.reduce_controls(&event(Event::SummarizationRetryScheduled {
        attempt: 1,
        max_attempts: 2,
        delay_ms: 500,
        error_message: "sum".into(),
    }));
    let pill = c.retry.get().unwrap();
    assert_eq!(pill.source, RetrySource::Summarization);
    assert_eq!(pill.error_message, "sum");
}

#[test]
fn banners_retry_end_ignores_foreign_source() {
    let c = controls();
    // A summarization retry is active; an auto-retry ending must not clear it.
    c.reduce_controls(&event(Event::SummarizationRetryScheduled {
        attempt: 1,
        max_attempts: 2,
        delay_ms: 500,
        error_message: "sum".into(),
    }));
    assert!(!c.reduce_controls(&event(Event::AutoRetryEnd {
        success: true,
        attempt: 1,
        final_error: None,
    })));
    assert_eq!(
        c.retry.get().unwrap().source,
        RetrySource::Summarization,
        "foreign end event must not clear the active pill"
    );

    // ...and the reverse: auto active, summarization ending is ignored.
    c.reduce_controls(&event(Event::AutoRetryStart {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 1000,
        error_message: "auto".into(),
    }));
    c.reduce_controls(&event(Event::SummarizationRetryFinished {
        success: true,
        attempt: 1,
        final_error: None,
    }));
    assert_eq!(c.retry.get().unwrap().source, RetrySource::Auto);
}

#[test]
fn banners_retry_failure_without_error_still_notices() {
    let c = controls();
    c.reduce_controls(&event(Event::AutoRetryStart {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 1000,
        error_message: "e".into(),
    }));
    assert!(c.reduce_controls(&event(Event::AutoRetryEnd {
        success: false,
        attempt: 3,
        final_error: None,
    })));
    assert!(c.retry.get().is_none(), "pill clears");
    assert!(
        c.notice.get().unwrap().contains("retry failed"),
        "a failure without a finalError still surfaces a notice"
    );
}

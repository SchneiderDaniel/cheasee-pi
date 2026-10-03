//! Control-plane reactive state: the queue, model/thinking selection, session
//! stats, the auto-compaction/auto-retry toggles, the retry banner, and the
//! composer draft.
//!
//! [`crate::stream::ChatState`] stays transcript-only; everything a mid-run
//! control needs to render lives here. The one rule that shapes this module:
//! pi pushes full-state control events (`queue_update`, `thinking_level_changed`,
//! `auto_retry_*`), so the panels are driven by events, not by command
//! responses. Command responses only carry a `data` payload (model lists,
//! levels, stats, `clear_queue` text) — read here and nowhere else.

use leptos::prelude::*;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::bash::BashLogs;
use crate::bridge::ServerMessage;
use crate::protocol::{ClearQueueData, Event, ModelInfo, QueueContents, SessionStats, ThinkingLevels};

/// A running auto-retry, raised by `auto_retry_start`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryBanner {
    pub attempt: u32,
    pub max_attempts: u32,
    pub delay_ms: u64,
    pub error_message: String,
}

/// The control-plane signals the panels read and [`ControlsState::apply`] writes.
#[derive(Clone, Copy)]
pub struct ControlsState {
    /// The full pending queue, replaced wholesale on every `queue_update`.
    pub queue: RwSignal<QueueContents>,
    pub models: RwSignal<Vec<ModelInfo>>,
    pub model: RwSignal<Option<ModelInfo>>,
    pub thinking_levels: RwSignal<Vec<String>>,
    pub thinking_level: RwSignal<Option<String>>,
    pub stats: RwSignal<Option<SessionStats>>,
    /// `None` until `get_state` or a successful set: pi exposes no read for
    /// auto-retry, so its toggle starts indeterminate.
    pub auto_compaction: RwSignal<Option<bool>>,
    pub auto_retry: RwSignal<Option<bool>>,
    pub retry: RwSignal<Option<RetryBanner>>,
    pub is_compacting: RwSignal<bool>,
    /// The composer draft. Owned here (not by the input) so `clear_queue` can
    /// restore the text it removed.
    pub draft: RwSignal<String>,
    pub notice: RwSignal<Option<String>>,
    pub bash: RwSignal<BashLogs>,
    /// The value a toggle was last asked to take, committed only when pi
    /// answers successfully. Without it a failed `set_auto_*` would leave the
    /// checkbox lying about pi's state.
    pending_auto_compaction: RwSignal<Option<bool>>,
    pending_auto_retry: RwSignal<Option<bool>>,
}

impl Default for ControlsState {
    fn default() -> Self {
        Self::new()
    }
}

impl ControlsState {
    pub fn new() -> Self {
        Self {
            queue: RwSignal::new(QueueContents::default()),
            models: RwSignal::new(Vec::new()),
            model: RwSignal::new(None),
            thinking_levels: RwSignal::new(Vec::new()),
            thinking_level: RwSignal::new(None),
            stats: RwSignal::new(None),
            auto_compaction: RwSignal::new(None),
            auto_retry: RwSignal::new(None),
            retry: RwSignal::new(None),
            is_compacting: RwSignal::new(false),
            draft: RwSignal::new(String::new()),
            notice: RwSignal::new(None),
            bash: RwSignal::new(BashLogs::default()),
            pending_auto_compaction: RwSignal::new(None),
            pending_auto_retry: RwSignal::new(None),
        }
    }

    /// Record the auto-compaction value the next successful response commits.
    pub fn set_auto_compaction(&self, enabled: bool) {
        self.pending_auto_compaction.set(Some(enabled));
    }

    /// Record the auto-retry value the next successful response commits.
    pub fn set_auto_retry(&self, enabled: bool) {
        self.pending_auto_retry.set(Some(enabled));
    }

    /// Reduce one server message. Returns whether anything visible changed.
    pub fn apply(&self, message: &ServerMessage) -> bool {
        match message {
            ServerMessage::Event { event } => self.apply_event(event),
            ServerMessage::CommandResponse {
                id,
                command,
                success,
                error,
                data,
                ..
            } => self.apply_response(id.as_deref(), command, *success, error.as_deref(), data.as_ref()),
            ServerMessage::Error { message } => {
                self.notice.set(Some(message.clone()));
                true
            }
            // Notices and lag are the transcript's concern.
            _ => false,
        }
    }

    /// Decode and reduce one WS frame. A malformed frame is left to
    /// `ChatState` (which surfaces it); it must not blank the control panel.
    pub fn ingest_frame(&self, text: &str) -> bool {
        match serde_json::from_str::<ServerMessage>(text) {
            Ok(message) => self.apply(&message),
            Err(_) => false,
        }
    }

    fn apply_event(&self, event: &Event) -> bool {
        match event {
            // Full-state, not a delta: replace, never append.
            Event::QueueUpdate {
                steering,
                follow_up,
            } => {
                self.queue.set(QueueContents {
                    steering: steering.clone(),
                    follow_up: follow_up.clone(),
                });
                true
            }
            Event::ThinkingLevelChanged { level } => {
                self.thinking_level.set(Some(level.clone()));
                true
            }
            Event::AutoRetryStart {
                attempt,
                max_attempts,
                delay_ms,
                error_message,
            } => {
                self.retry.set(Some(RetryBanner {
                    attempt: *attempt,
                    max_attempts: *max_attempts,
                    delay_ms: *delay_ms,
                    error_message: error_message.clone(),
                }));
                true
            }
            Event::AutoRetryEnd {
                success,
                final_error,
                ..
            } => {
                let had = self.retry.get_untracked().is_some();
                self.retry.set(None);
                if !success {
                    if let Some(err) = final_error {
                        self.notice.set(Some(format!("auto-retry failed: {err}")));
                    }
                }
                had || !success
            }
            Event::CompactionStart { .. } => {
                self.is_compacting.set(true);
                true
            }
            Event::CompactionEnd { .. } => {
                self.is_compacting.set(false);
                true
            }
            // AC4: route by the id pi repeats, so concurrent commands cannot
            // cross streams.
            Event::BashExecutionUpdate { id, .. } => {
                let (Some(id), Some(delta)) = (id.as_deref(), event.bash_delta()) else {
                    return false;
                };
                self.bash.update(|logs| logs.push(id, delta));
                true
            }
            _ => false,
        }
    }

    fn apply_response(
        &self,
        id: Option<&str>,
        command: &str,
        success: bool,
        error: Option<&str>,
        data: Option<&Value>,
    ) -> bool {
        if !success {
            // A rejected control must be visible; a future pi may not know a
            // command at all (e.g. `clear_queue` on pre-0.84.4).
            let detail = error
                .map(str::to_string)
                .unwrap_or_else(|| format!("{command} rejected"));
            self.notice.set(Some(detail));
            // Drop the optimistic toggle so the checkbox still matches pi.
            if command == "set_auto_compaction" {
                self.pending_auto_compaction.set(None);
            }
            if command == "set_auto_retry" {
                self.pending_auto_retry.set(None);
            }
            return true;
        }

        match command {
            "get_available_models" => {
                let models = data
                    .and_then(|d| parse::<Vec<ModelInfo>>(&d["models"]))
                    .unwrap_or_default();
                self.models.set(models);
                true
            }
            "set_model" => match data.and_then(parse::<ModelInfo>) {
                Some(model) => {
                    self.model.set(Some(model));
                    true
                }
                None => false,
            },
            // `data` is null when the scoped cycle is exhausted — a no-op, not
            // an error.
            "cycle_model" => {
                let Some(data) = data.filter(|d| !d.is_null()) else {
                    return false;
                };
                let Some(model) = parse::<ModelInfo>(&data["model"]) else {
                    return false;
                };
                self.model.set(Some(model));
                if let Some(level) = data["thinkingLevel"].as_str() {
                    self.thinking_level.set(Some(level.to_string()));
                }
                true
            }
            "get_available_thinking_levels" => match data.and_then(parse::<ThinkingLevels>) {
                Some(levels) => {
                    self.thinking_levels.set(levels.levels);
                    true
                }
                None => false,
            },
            "get_session_stats" => match data.and_then(parse::<SessionStats>) {
                Some(stats) => {
                    self.stats.set(Some(stats));
                    true
                }
                None => false,
            },
            "clear_queue" => match data.and_then(parse::<ClearQueueData>) {
                Some(removed) => {
                    // Restore the removed text into the editor, then empty the
                    // panel (a successful clear_queue removed all of it).
                    self.draft.set(removed.as_draft());
                    self.queue.set(QueueContents::default());
                    true
                }
                None => false,
            },
            "get_state" => match data.and_then(|d| d["autoCompactionEnabled"].as_bool()) {
                Some(enabled) => {
                    self.auto_compaction.set(Some(enabled));
                    true
                }
                None => false,
            },
            "set_auto_compaction" => {
                if let Some(enabled) = self.pending_auto_compaction.get_untracked() {
                    self.auto_compaction.set(Some(enabled));
                }
                true
            }
            "set_auto_retry" => {
                if let Some(enabled) = self.pending_auto_retry.get_untracked() {
                    self.auto_retry.set(Some(enabled));
                }
                true
            }
            "abort_retry" => {
                self.retry.set(None);
                true
            }
            // The bash command resolved: flush the log's trailing partial line
            // so the block stops showing a half line.
            "bash" => {
                if let Some(id) = id {
                    self.bash.update(|logs| logs.finish(id));
                }
                true
            }
            _ => false,
        }
    }
}

fn parse<T: DeserializeOwned>(value: &Value) -> Option<T> {
    serde_json::from_value(value.clone()).ok()
}

#[cfg(test)]
mod tests {
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
        assert!(c.apply(&ok(
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
        assert!(c.apply(&ok(
            "get_available_thinking_levels",
            json!({"levels": ["off"]}),
        )));
        assert_eq!(c.thinking_levels.get(), vec!["off".to_string()]);
    }

    /// AC3: `contextUsage.percent` is a tri-state — null, 0, and 100 differ.
    #[test]
    fn controls_stats_keep_the_unknown_context_state() {
        let c = controls();
        c.apply(&ok(
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

        c.apply(&ok(
            "get_session_stats",
            json!({"contextUsage": {"tokens": 0, "contextWindow": 200000, "percent": 0}}),
        ));
        assert_eq!(c.stats.get().unwrap().context_usage.unwrap().percent, Some(0.0));

        c.apply(&ok(
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
        c.apply(&ServerMessage::Event {
            event: Event::QueueUpdate {
                steering: vec!["a".into()],
                follow_up: vec!["b".into()],
            },
        });
        assert_eq!(c.queue.get().steering, vec!["a".to_string()]);
        c.apply(&ServerMessage::Event {
            event: Event::QueueUpdate {
                steering: vec!["c".into()],
                follow_up: vec![],
            },
        });
        assert_eq!(c.queue.get().steering, vec!["c".to_string()]);
        c.apply(&ServerMessage::Event {
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
        assert!(c.apply(&ok(
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
        assert!(c.apply(&ServerMessage::Event {
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
        c.apply(&ServerMessage::Event {
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

        c.apply(&ServerMessage::Event {
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
        c.apply(&ok(
            "set_model",
            json!({"id": "old", "name": "Old", "provider": "p"}),
        ));
        assert!(c.apply(&failed("set_model", "Model not found: p/new")));
        assert_eq!(c.model.get().unwrap().id, "old");
        assert!(c.notice.get().unwrap().contains("Model not found"));
    }

    /// AC2: an exhausted scoped cycle returns `data:null` — a no-op.
    #[test]
    fn controls_null_cycle_is_a_noop() {
        let c = controls();
        assert!(!c.apply(&ok("cycle_model", Value::Null)));
        assert!(!c.apply(&ok("cycle_thinking_level", Value::Null)));
        assert!(c.model.get().is_none());
        assert!(c.notice.get().is_none());
    }

    /// AC3/AC5: toggles commit only on success; `abort_retry` clears the banner.
    #[test]
    fn controls_toggles_commit_on_success() {
        let c = controls();
        c.set_auto_compaction(true);
        c.apply(&ok("set_auto_compaction", json!({})));
        assert_eq!(c.auto_compaction.get(), Some(true));

        c.set_auto_retry(false);
        c.apply(&ok("set_auto_retry", json!({})));
        assert_eq!(c.auto_retry.get(), Some(false));

        c.apply(&ServerMessage::Event {
            event: Event::AutoRetryStart {
                attempt: 1,
                max_attempts: 3,
                delay_ms: 1000,
                error_message: "e".into(),
            },
        });
        c.apply(&ok("abort_retry", json!({})));
        assert!(c.retry.get().is_none());
    }

    /// A failed toggle does not commit the pending value.
    #[test]
    fn controls_failed_toggle_does_not_commit() {
        let c = controls();
        c.set_auto_compaction(true);
        c.apply(&failed("set_auto_compaction", "nope"));
        assert_eq!(c.auto_compaction.get(), None);
    }

    /// AC4: bash chunks assemble into whole lines in the id's log.
    #[test]
    fn controls_bash_chunks_assemble_per_id() {
        let c = controls();
        c.apply(&ServerMessage::Event {
            event: Event::BashExecutionUpdate {
                id: Some("b1".into()),
                delta: Some("foo".into()),
                extra: serde_json::Map::new(),
            },
        });
        c.apply(&ServerMessage::Event {
            event: Event::BashExecutionUpdate {
                id: Some("b1".into()),
                delta: Some("bar\n".into()),
                extra: serde_json::Map::new(),
            },
        });
        c.apply(&ServerMessage::Event {
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
        assert!(c.apply(&failed("clear_queue", "Unknown command: clear_queue")));
        assert!(c
            .notice
            .get()
            .unwrap()
            .contains("Unknown command: clear_queue"));
    }
}

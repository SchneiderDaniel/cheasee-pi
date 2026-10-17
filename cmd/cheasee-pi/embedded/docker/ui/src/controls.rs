//! Control-plane reactive state: the queue, model/thinking selection, session
//! stats, the auto-compaction/auto-retry toggles, the compaction banner, the
//! retry pill, and the composer draft.
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
use crate::protocol::{
    ClearQueueData, Event, ModelInfo, QueueContents, SessionStats, ThinkingLevels,
};

/// Which retry loop a pill belongs to. Auto is pi's provider auto-retry;
/// Summarization is the compaction/summarization retry path. Only one pill is
/// shown at a time — a new start replaces whatever was active.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetrySource {
    Auto,
    Summarization,
}

/// A running retry, raised by `auto_retry_start` or the additive
/// `summarization_retry_*` events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryPill {
    pub source: RetrySource,
    pub attempt: u32,
    pub max_attempts: u32,
    pub delay_ms: u64,
    pub error_message: String,
}

/// Why compaction started. The wire `reason` is authoritative; anything the
/// build does not model stays [`CompactionReason::Unknown`] rather than
/// inventing a label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CompactionReason {
    Manual,
    Threshold,
    Overflow,
    #[default]
    Unknown,
}

impl CompactionReason {
    pub fn from_wire(raw: &str) -> Self {
        match raw {
            "manual" => CompactionReason::Manual,
            "threshold" => CompactionReason::Threshold,
            "overflow" => CompactionReason::Overflow,
            _ => CompactionReason::Unknown,
        }
    }

    /// The banner label, mirroring pi's own TUI wording per reason.
    pub fn label(self) -> &'static str {
        match self {
            CompactionReason::Manual => "Compacting context…",
            CompactionReason::Threshold => "Auto-compacting…",
            CompactionReason::Overflow => "Context overflow detected, Auto-compacting…",
            CompactionReason::Unknown => "Compacting…",
        }
    }
}

/// Whether compaction is still running or finished, and how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactionPhase {
    Running,
    Finished {
        aborted: bool,
        will_retry: bool,
        error_message: Option<String>,
    },
}

/// A compaction banner. `reason` labels it; `phase` says whether it is still
/// running (`compaction_start` / `get_state` restored) or finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionState {
    pub reason: CompactionReason,
    pub phase: CompactionPhase,
}

impl CompactionState {
    pub fn label(&self) -> &'static str {
        self.reason.label()
    }
}

/// The control-plane signals the panels read and [`ControlsState::reduce_controls`] writes.
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
    /// The single active retry pill (auto or summarization), if any.
    pub retry: RwSignal<Option<RetryPill>>,
    /// The compaction banner, if compaction is running or last finished.
    pub compaction: RwSignal<Option<CompactionState>>,
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
            compaction: RwSignal::new(None),
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
    pub fn reduce_controls(&self, message: &ServerMessage) -> bool {
        match message {
            ServerMessage::Event { event } => self.apply_event(event),
            ServerMessage::CommandResponse {
                id,
                command,
                success,
                error,
                data,
                ..
            } => self.apply_response(
                id.as_deref(),
                command,
                *success,
                error.as_deref(),
                data.as_ref(),
            ),
            ServerMessage::Error { message } => {
                self.notice.set(Some(message.clone()));
                true
            }
            // AC3: a reconnect header carries the same `get_state` payload a
            // `get_state` response would, so the control surface is restored
            // (streaming/compaction/auto-compaction) without a second request.
            ServerMessage::SessionState { state, .. } => match state {
                Some(data) => self.apply_response(None, "get_state", true, None, Some(data)),
                None => false,
            },
            // Notices and lag are the transcript's concern.
            _ => false,
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
                self.retry.set(Some(RetryPill {
                    source: RetrySource::Auto,
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
            } => self.clear_retry(RetrySource::Auto, !success, final_error.as_deref()),
            Event::SummarizationRetryScheduled {
                attempt,
                max_attempts,
                delay_ms,
                error_message,
            }
            | Event::SummarizationRetryAttemptStart {
                attempt,
                max_attempts,
                delay_ms,
                error_message,
            } => {
                self.retry.set(Some(RetryPill {
                    source: RetrySource::Summarization,
                    attempt: *attempt,
                    max_attempts: *max_attempts,
                    delay_ms: *delay_ms,
                    error_message: error_message.clone(),
                }));
                true
            }
            Event::SummarizationRetryFinished {
                success,
                final_error,
                ..
            } => self.clear_retry(RetrySource::Summarization, !success, final_error.as_deref()),
            Event::CompactionStart { reason } => {
                self.compaction.set(Some(CompactionState {
                    reason: CompactionReason::from_wire(reason),
                    phase: CompactionPhase::Running,
                }));
                true
            }
            Event::CompactionEnd {
                reason,
                aborted,
                will_retry,
                error_message,
                ..
            } => {
                self.compaction.set(Some(CompactionState {
                    reason: CompactionReason::from_wire(reason),
                    phase: CompactionPhase::Finished {
                        aborted: *aborted,
                        will_retry: *will_retry,
                        error_message: error_message.clone(),
                    },
                }));
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

    /// Clear the active retry pill. Only the matching source ends the pill, so
    /// an ending event from the other retry loop cannot hide a still-running
    /// retry. A final failure is surfaced as a notice — with a generic message
    /// when the event carries no error — rather than silently dropping it.
    fn clear_retry(&self, source: RetrySource, failed: bool, error: Option<&str>) -> bool {
        let mut changed = false;
        if self.retry.get_untracked().map(|pill| pill.source) == Some(source) {
            self.retry.set(None);
            changed = true;
        }
        if failed {
            let err = error.unwrap_or("unknown error");
            self.notice.set(Some(format!("retry failed: {err}")));
            changed = true;
        }
        changed
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
            "get_state" => {
                let mut changed = false;
                if let Some(enabled) = data.and_then(|d| d["autoCompactionEnabled"].as_bool()) {
                    self.auto_compaction.set(Some(enabled));
                    changed = true;
                }
                if let Some(compacting) = data.and_then(|d| d["isCompacting"].as_bool()) {
                    // A restored compaction has no reason on the wire: use the
                    // generic label, never invent one. `compaction_end.reason`
                    // is authoritative once the event fires.
                    if compacting && self.compaction.get_untracked().is_none() {
                        self.compaction.set(Some(CompactionState {
                            reason: CompactionReason::Unknown,
                            phase: CompactionPhase::Running,
                        }));
                        changed = true;
                    } else if !compacting && self.compaction.get_untracked().is_some() {
                        self.compaction.set(None);
                        changed = true;
                    }
                }
                changed
            }
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

include!("controls_part2.rs");

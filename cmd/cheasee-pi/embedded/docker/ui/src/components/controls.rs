//! Model/thinking pickers, session stats, and the compaction/retry controls.
//!
//! Every control is a thin wrapper over one [`crate::bridge::ClientMessage`]
//! (which maps 1:1 onto a pi [`crate::protocol::Command`]) — no JSON is
//! duplicated here. State is read from [`ControlsState`], never local to the
//! component, so the panels and the relay stay in sync.

use leptos::prelude::*;

use crate::app::ConnectionStatus;
use crate::bridge::ClientMessage;
use crate::components::banners::{CompactionBanner, RetryPill};
use crate::components::dispatch;
use crate::controls::ControlsState;

/// The model/thinking/stats/compaction control surface.
#[component]
pub fn ControlsPanel(status: RwSignal<ConnectionStatus>) -> impl IntoView {
    let controls = expect_context::<ControlsState>();

    // pi has no stats push event (usage only rides `message_update`), so the
    // cumulative totals are refetched when the run settles.
    #[cfg(feature = "hydrate")]
    {
        let chat = expect_context::<crate::stream::ChatState>();
        Effect::new(move |_| {
            if chat.status.get() == crate::stream::StreamStatus::Settled {
                crate::ws::send(ClientMessage::GetSessionStats { id: None }, status);
            }
        });
    }

    let refresh_models = move |_| dispatch(ClientMessage::GetAvailableModels { id: None }, status);
    let cycle_model = move |_| dispatch(ClientMessage::CycleModel { id: None }, status);
    let refresh_levels = move |_| {
        dispatch(
            ClientMessage::GetAvailableThinkingLevels { id: None },
            status,
        )
    };
    let cycle_level = move |_| dispatch(ClientMessage::CycleThinkingLevel { id: None }, status);
    let compact = move |_| {
        dispatch(
            ClientMessage::Compact {
                id: None,
                custom_instructions: None,
            },
            status,
        )
    };
    let toggle_compaction = move |_| {
        // Unknown reads as off; the response commits the real value.
        let next = !controls.auto_compaction.get_untracked().unwrap_or(false);
        controls.set_auto_compaction(next);
        dispatch(
            ClientMessage::SetAutoCompaction {
                id: None,
                enabled: next,
            },
            status,
        );
    };
    let toggle_retry = move |_| {
        let next = !controls.auto_retry.get_untracked().unwrap_or(false);
        controls.set_auto_retry(next);
        dispatch(
            ClientMessage::SetAutoRetry {
                id: None,
                enabled: next,
            },
            status,
        );
    };
    let abort_retry = move |_| dispatch(ClientMessage::AbortRetry { id: None }, status);

    let select_model = move |ev| {
        let value = event_target_value(&ev);
        let Some((provider, model_id)) = value.split_once('|') else {
            return;
        };
        dispatch(
            ClientMessage::SetModel {
                id: None,
                provider: provider.to_string(),
                model_id: model_id.to_string(),
            },
            status,
        );
    };
    let select_level = move |ev| {
        dispatch(
            ClientMessage::SetThinkingLevel {
                id: None,
                level: event_target_value(&ev),
            },
            status,
        );
    };

    view! {
        <section class="controls">
            <div class="control model-control">
                <label>"model"</label>
                <select on:change=select_model>
                    <option value="">"choose model"</option>
                    {move || {
                        controls
                            .models
                            .get()
                            .into_iter()
                            .map(|model| {
                                let value = format!("{}|{}", model.provider, model.id);
                                view! { <option value=value>{model.label().to_string()}</option> }
                            })
                            .collect_view()
                    }}
                </select>
                <button on:click=refresh_models>"refresh"</button>
                <button on:click=cycle_model>"cycle"</button>
                <span class="current-model">
                    {move || {
                        controls
                            .model
                            .get()
                            .map(|m| format!("{} / {}", m.provider, m.id))
                            .unwrap_or_else(|| "model unknown".to_string())
                    }}
                </span>
            </div>

            <div class="control thinking-control">
                <label>"thinking"</label>
                <select on:change=select_level>
                    <option value="">"choose level"</option>
                    {move || {
                        controls
                            .thinking_levels
                            .get()
                            .into_iter()
                            .map(|level| {
                                let value = level.clone();
                                view! { <option value=value>{level}</option> }
                            })
                            .collect_view()
                    }}
                </select>
                <button on:click=refresh_levels>"refresh"</button>
                <button on:click=cycle_level>"cycle"</button>
                <span class="current-level">
                    {move || {
                        controls
                            .thinking_level
                            .get()
                            .unwrap_or_else(|| "level unknown".to_string())
                    }}
                </span>
            </div>

            <div class="control stats-panel">
                <label>"stats"</label>
                {move || match controls.stats.get() {
                    None => view! { <p class="stats-empty">"no stats yet"</p> }.into_any(),
                    Some(stats) => {
                        let context = match stats.context_usage {
                            None => "context unknown".to_string(),
                            Some(usage) => match usage.percent {
                                None => format!("context unknown / {} window", usage.context_window),
                                Some(percent) => {
                                    format!("context {:.1}% of {}", percent, usage.context_window)
                                }
                            },
                        };
                        view! {
                            <div class="stats">
                                <p class="stats-tokens">
                                    {format!(
                                        "tokens in {} · out {} · total {}",
                                        stats.tokens.input, stats.tokens.output, stats.tokens.total,
                                    )}
                                </p>
                                <p class="stats-cost">{format!("cost ${:.4}", stats.cost)}</p>
                                <p class="stats-context">{context}</p>
                                <p class="stats-counts">
                                    {format!(
                                        "messages {} · tool calls {}",
                                        stats.total_messages, stats.tool_calls,
                                    )}
                                </p>
                            </div>
                        }
                        .into_any()
                    }
                }}
            </div>

            <div class="control compaction-control">
                <button on:click=compact>"compact"</button>
                <button on:click=toggle_compaction>
                    {move || match controls.auto_compaction.get() {
                        None => "auto-compaction: unknown",
                        Some(true) => "auto-compaction: on",
                        Some(false) => "auto-compaction: off",
                    }}
                </button>
                <CompactionBanner/>
            </div>

            <div class="control retry-control">
                <button on:click=toggle_retry>
                    {move || match controls.auto_retry.get() {
                        None => "auto-retry: unknown",
                        Some(true) => "auto-retry: on",
                        Some(false) => "auto-retry: off",
                    }}
                </button>
                <button on:click=abort_retry>"abort retry"</button>
                <RetryPill/>
            </div>

            {move || controls.notice.get().map(|notice| view! { <p class="control-notice">{notice}</p> })}
        </section>
    }
}

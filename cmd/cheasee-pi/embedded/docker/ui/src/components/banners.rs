//! Ephemeral run chrome: the compaction banner, the retry pill, and run/turn
//! markers.
//!
//! These read [`ControlsState`] (compaction, retry) and the transcript marker
//! value; they are pure renderers. The banner is labelled from
//! `compaction_end.reason` (or `compaction_start.reason`), never from local
//! timing, and a restored compaction with no reason stays generic. Only one
//! retry pill is ever shown — `ControlsState.retry` is a single `Option`.

use leptos::prelude::*;

use crate::controls::{CompactionPhase, ControlsState};

/// The compaction banner. `role="status"` announces the transition, not every
/// frame.
#[component]
pub fn CompactionBanner() -> impl IntoView {
    let controls = expect_context::<ControlsState>();
    view! {
        {move || {
            controls
                .compaction
                .get()
                .map(|state| {
                    let label = state.label();
                    let detail = match state.phase {
                        CompactionPhase::Running => String::new(),
                        CompactionPhase::Finished {
                            aborted,
                            will_retry,
                            error_message,
                        } => {
                            if aborted {
                                " — aborted".to_string()
                            } else if let Some(err) = error_message {
                                format!(" — failed: {err}")
                            } else if will_retry {
                                " — retrying".to_string()
                            } else {
                                " — done".to_string()
                            }
                        }
                    };
                    view! {
                        <div class="compaction-banner" role="status" aria-live="polite">
                            {label} {detail}
                        </div>
                    }
                })
        }}
    }
}

/// The retry pill: `Retrying ({attempt}/{max}) in {delay}ms — {error}`. The
/// attempt and max come from the event; the delay is shown as reported rather
/// than ticked, so SSR and hydrate render identically.
#[component]
pub fn RetryPill() -> impl IntoView {
    let controls = expect_context::<ControlsState>();
    view! {
        {move || {
            controls
                .retry
                .get()
                .map(|pill| {
                    let text = format!(
                        "Retrying ({}/{}) in {}ms — {}",
                        pill.attempt, pill.max_attempts, pill.delay_ms, pill.error_message,
                    );
                    view! { <span class="retry-pill" role="status" aria-live="polite">{text}</span> }
                })
        }}
    }
}

/// A run/turn boundary divider.
#[component]
pub fn Marker(marker: crate::stream::Marker) -> impl IntoView {
    let class = format!("row-marker marker-{}", marker.slug());
    view! { <div class=class>{marker.label()}</div> }
}

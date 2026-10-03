//! The queue panel: the pending steering/follow-up prompts pi reports through
//! `queue_update`, plus the clear-queue control.
//!
//! `abort` leaves the queue intact, so "clear queue" is deliberately its own
//! button rather than folded into Stop. A successful `clear_queue` response
//! restores the removed text into the composer draft
//! ([`crate::controls::ControlsState`] owns that).

use leptos::prelude::*;

use crate::app::ConnectionStatus;
use crate::bridge::ClientMessage;
use crate::components::dispatch;
use crate::controls::ControlsState;

#[component]
pub fn QueuePanel(status: RwSignal<ConnectionStatus>) -> impl IntoView {
    let controls = expect_context::<ControlsState>();
    let clear = move |_| dispatch(ClientMessage::ClearQueue { id: None }, status);

    view! {
        <section class="queue">
            <h2>"queued"</h2>
            {move || {
                let queue = controls.queue.get();
                if queue.is_empty() {
                    return view! { <p class="queue-empty">"nothing queued"</p> }.into_any();
                }
                view! {
                    <ul class="queue-list">
                        {queue
                            .steering
                            .iter()
                            .map(|text| view! { <li class="queue-steer">{text.clone()}</li> })
                            .collect_view()}
                        {queue
                            .follow_up
                            .iter()
                            .map(|text| view! { <li class="queue-follow-up">{text.clone()}</li> })
                            .collect_view()}
                    </ul>
                }
                .into_any()
            }}
            <button class="queue-clear" on:click=clear>
                "clear queue"
            </button>
        </section>
    }
}

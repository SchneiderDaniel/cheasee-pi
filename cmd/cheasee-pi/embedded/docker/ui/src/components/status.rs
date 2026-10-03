//! Fire-and-forget extension chrome: `notify` toasts and the
//! `setStatus`/`setWidget`/`setTitle` regions.
//!
//! Thin renderers over [`ExtensionUiState`]. All of these are fire-and-forget:
//! no response is written for their minted uuid, so the components only read
//! state — they never dispatch.

use leptos::prelude::*;

use crate::extension_ui::ExtensionUiState;

/// How long an unclicked toast stays before it dismisses itself.
#[cfg(feature = "hydrate")]
const DISMISS_MS: u32 = 5000;

/// The toast stack. Each toast auto-dismisses; clicking it dismisses early.
#[component]
pub fn NotifyToasts() -> impl IntoView {
    let extension = expect_context::<ExtensionUiState>();
    view! {
        <div class="ext-toasts">
            {move || {
                extension
                    .toasts
                    .get()
                    .into_iter()
                    .map(|toast| {
                        let id = toast.id.clone();
                        let id_for_click = id.clone();
                        // ponytail: a fixed 5s lifetime. Per-notify durations
                        // only exist if pi ever adds one to the request; until
                        // then a constant is the whole feature.
                        #[cfg(feature = "hydrate")]
                        Effect::new(move |_| {
                            let id = id.clone();
                            leptos::task::spawn_local(async move {
                                gloo_timers::future::TimeoutFuture::new(DISMISS_MS).await;
                                extension.dismiss_toast(&id);
                            });
                        });
                        view! {
                            <div class=format!("ext-toast ext-toast-{}", toast.notify_type)>
                                <span class="ext-toast-message">{toast.message.clone()}</span>
                                <button
                                    class="ext-toast-close"
                                    on:click=move |_| extension.dismiss_toast(&id_for_click)
                                >
                                    "×"
                                </button>
                            </div>
                        }
                    })
                    .collect_view()
            }}
        </div>
    }
}

/// The `setStatus`/`setWidget`/`setTitle` chrome regions.
#[component]
pub fn StatusChrome() -> impl IntoView {
    let extension = expect_context::<ExtensionUiState>();
    view! {
        <div class="ext-chrome">
            {move || {
                let Some(title) = extension.title.get() else {
                    return ().into_any();
                };
                view! { <div class="ext-title">{title}</div> }.into_any()
            }}
            <div class="ext-statuses">
                {move || {
                    extension
                        .statuses
                        .get()
                        .into_iter()
                        .map(|(key, text)| view! {
                            <span class="ext-status" data-key=key>{text}</span>
                        })
                        .collect_view()
                }}
            </div>
            <div class="ext-widgets">
                {move || {
                    extension
                        .widgets
                        .get()
                        .into_iter()
                        .map(|(key, widget)| view! {
                            <div class=format!("ext-widget ext-widget-{}", widget.placement) data-key=key>
                                {widget
                                    .lines
                                    .into_iter()
                                    .map(|line| view! { <div class="ext-widget-line">{line}</div> })
                                    .collect_view()}
                            </div>
                        })
                        .collect_view()
                }}
            </div>
        </div>
    }
}

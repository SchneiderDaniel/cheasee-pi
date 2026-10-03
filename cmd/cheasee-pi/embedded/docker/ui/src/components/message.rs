//! The transcript renderer: the assembled [`crate::stream::ChatState`] rows as
//! plain text nodes, tool cards, markers and extension-error cards, plus the
//! streaming-status and usage readout.
//!
//! Deliberately text-only. `set_inner_html`/markdown rendering would be this
//! crate's first injection surface (no sanitisation dependency exists here) and
//! no acceptance criterion requires it.
//!
//! The row list is rendered with a keyed `<For>` over `row.id`, so a new delta
//! updates one row's DOM and untouched rows are never rebuilt (AC5). Streaming
//! bodies carry `aria-live="off"` so a token stream is not one screen-reader
//! announcement per delta; state transitions (a tool finishing, an extension
//! error) carry their own roles.

use leptos::prelude::*;

use crate::components::banners::Marker;
use crate::components::tool_card::ToolCardRow;
use crate::stream::{ChatState, RowKind};

/// Renders the ordered transcript, the streaming indicator, and the cumulative
/// usage readout.
#[component]
pub fn Transcript() -> impl IntoView {
    let state = expect_context::<ChatState>();

    view! {
        <section class="transcript">
            <p class="stream-status">
                "status: " {move || state.status.get().label()}
                {move || match state.will_retry.get() {
                    Some(true) => " — retrying",
                    Some(false) => "",
                    None => "",
                }}
            </p>
            <div class="rows">
                <For
                    each=move || state.rows_view.get()
                    key=|row| row.id
                    children=move |row| {
                        // `id` is the stable key; read the payload signal
                        // inside the row so a same-id delta (text, tool
                        // snapshot, final status) updates this row in place
                        // instead of freezing at its first value (AC1/AC5).
                        let kind = row.kind;
                        move || match kind.get() {
                            RowKind::Text(body) => {
                                view! { <pre class="block block-text" aria-live="off">{body.text}</pre> }
                                    .into_any()
                            }
                            RowKind::Thinking(body) => {
                                view! { <pre class="block block-thinking" aria-live="off">{body.text}</pre> }
                                    .into_any()
                            }
                            RowKind::Tool(card) => view! { <ToolCardRow card=card/> }.into_any(),
                            RowKind::Marker(marker) => view! { <Marker marker=marker/> }.into_any(),
                            RowKind::ExtensionError(card) => {
                                view! {
                                    <div class="extension-error" role="alert">
                                        {format!(
                                            "extension error ({}): {}",
                                            card.event, card.error,
                                        )}
                                    </div>
                                }
                                .into_any()
                            }
                        }
                    }
                />
            </div>
            <p class="usage">
                {move || {
                    let usage = state.usage.get();
                    if usage.available {
                        format!(
                            "tokens in {} · out {} · total {} · cost ${:.4}",
                            usage.input, usage.output, usage.total, usage.cost_total,
                        )
                    } else {
                        "usage unavailable".to_string()
                    }
                }}
            </p>
            {move || state.notice.get().map(|notice| view! { <p class="notice">{notice}</p> })}
        </section>
    }
}

//! The transcript renderer: the assembled [`crate::stream::Assembler`] blocks as
//! plain text nodes plus the streaming-status and usage readout.
//!
//! Deliberately text-only. `set_inner_html`/markdown rendering would be this
//! crate's first injection surface (no sanitisation dependency exists here) and
//! no acceptance criterion requires it.

use leptos::prelude::*;

use crate::stream::{BlockKind, ChatState};

/// Renders the current run's blocks, the streaming indicator, and the
/// cumulative usage readout.
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
            {move || {
                state
                    .blocks
                    .get()
                    .into_iter()
                    .map(|block| {
                        let class = match block.kind {
                            BlockKind::Text => "block block-text",
                            BlockKind::Thinking => "block block-thinking",
                            BlockKind::ToolCall => "block block-tool",
                        };
                        view! { <pre class=class>{block.text}</pre> }
                    })
                    .collect_view()
            }}
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

//! The tool-card view: one durable card per model-invoked tool call, keyed by
//! `toolCallId`.
//!
//! A humble renderer over [`crate::tool_card::ToolCard`] — it reads the card
//! state and emits DOM, no decoding. The body is a `<pre>` of plain text nodes,
//! so output stays selectable and copyable (AC5). Truncation is a terminal
//! state: pi writes the full copy to a container-local path the browser cannot
//! fetch, so no "view full output" action is offered (same limit as
//! `components::bash::BashPanel`).

use leptos::prelude::*;

use crate::tool_card::{ToolCard, ToolStatus};

#[component]
pub fn ToolCardRow(card: ToolCard) -> impl IntoView {
    let status_class = format!("tool-card tool-card-{}", card.status.slug());
    let status_label = card.status.label();
    let busy = if card.status == ToolStatus::Running {
        "true"
    } else {
        "false"
    };
    let tool_call_id = card.tool_call_id.clone();
    let name = card.name.clone();
    let args = card.args.clone();
    let output = card.output.clone();
    let truncated = card.truncated;

    view! {
        <div class=status_class data-tool-call-id=tool_call_id>
            <div class="tool-card-head">
                <span class="tool-card-name">{name}</span>
                <span class="tool-card-status">{status_label}</span>
            </div>
            {(!args.is_empty())
                .then(|| view! { <pre class="tool-card-args" aria-live="off">{args}</pre> })}
            <pre class="tool-card-output" aria-live="off" aria-busy=busy>
                {output}
            </pre>
            {truncated
                .then(|| view! { <p class="tool-card-truncated">"output truncated"</p> })}
        </div>
    }
}

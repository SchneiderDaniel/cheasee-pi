//! Blocking extension-UI dialog overlay (`select`, `confirm`, `input`,
//! `editor`).
//!
//! A thin renderer over [`ExtensionUiState::dialog`]: pi sends the request, the
//! operator answers, one [`ClientMessage::ExtensionUiResponse`] carrying pi's
//! uuid is dispatched, and the dialog closes. There is no command response to
//! wait for (the sub-protocol is fire-and-forget), so the close is optimistic —
//! but only after the frame is reported delivered, or a send failure would
//! discard the question silently.
//!
//! Policy: pi defines no queue, so the newest blocking request replaces the
//! pending slot. `editor` never carries a `timeout`; the timeout line is
//! therefore informational and absent for it.

use leptos::prelude::*;
use serde_json::Value;

use crate::app::ConnectionStatus;
use crate::bridge::ClientMessage;
use crate::components::dispatch_delivered;
use crate::extension_ui::{ExtensionUiState, PendingDialog};

#[component]
pub fn DialogOverlay(status: RwSignal<ConnectionStatus>) -> impl IntoView {
    let extension = expect_context::<ExtensionUiState>();
    // The editable buffer shared by the `input` and `editor` forms; reset to the
    // request's `prefill` whenever a new dialog takes the slot.
    let text = RwSignal::new(String::new());
    Effect::new(move |_| {
        if let Some(dialog) = extension.dialog.get() {
            text.set(param(&dialog, "prefill").unwrap_or_default());
        }
    });

    let answer = move |id: String, value: Option<String>, confirmed: Option<bool>, cancelled: Option<bool>| {
        let delivered = dispatch_delivered(
            ClientMessage::ExtensionUiResponse {
                id,
                value,
                confirmed,
                cancelled,
            },
            status,
        );
        if delivered {
            extension.clear_dialog();
        }
    };

    view! {
        <Show when=move || extension.dialog.get().is_some()>
            {move || extension.dialog.get().map(|dialog| {
                let timeout = dialog.timeout();
                let title = param(&dialog, "title").unwrap_or_else(|| dialog.method.clone());
                let message = param(&dialog, "message");
                let method = dialog.method.clone();
                let body = match method.as_str() {
                    "select" => select_body(&dialog, answer).into_any(),
                    "confirm" => confirm_body(&dialog, answer).into_any(),
                    "input" => input_body(&dialog, text, answer).into_any(),
                    "editor" => editor_body(&dialog, text, answer).into_any(),
                    _ => ().into_any(),
                };
                view! {
                    <div class="ext-overlay">
                        <div class="ext-dialog" role="dialog" aria-modal="true">
                            <h2 class="ext-dialog-title">{title}</h2>
                            {message.map(|text| view! { <p class="ext-dialog-message">{text}</p> })}
                            {body}
                            {timeout.map(|ms| view! {
                                <p class="ext-dialog-timeout">"pi auto-resolves in " {ms} " ms"</p>
                            })}
                        </div>
                    </div>
                }
            })}
        </Show>
    }
}

/// `select`: one button per option. The answer is the option **string**, never
/// an index — pi's response parser returns `value` verbatim.
fn select_body(dialog: &PendingDialog, answer: impl Fn(String, Option<String>, Option<bool>, Option<bool>) + Copy + 'static) -> impl IntoView {
    let id = dialog.id.clone();
    let options: Vec<String> = dialog
        .params
        .get("options")
        .and_then(Value::as_array)
        .map(|options| options.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    view! {
        <div class="ext-dialog-options">
            {options.into_iter().map(|option| {
                let id = id.clone();
                let value = option.clone();
                view! {
                    <button on:click=move |_| answer(id.clone(), Some(value.clone()), None, None)>
                        {option}
                    </button>
                }
            }).collect_view()}
        </div>
    }
}

/// `confirm`: pi collapses "No" and "dismiss" to `false`, so one path suffices.
fn confirm_body(dialog: &PendingDialog, answer: impl Fn(String, Option<String>, Option<bool>, Option<bool>) + Copy + 'static) -> impl IntoView {
    let yes = dialog.id.clone();
    let no = dialog.id.clone();
    view! {
        <div class="ext-dialog-actions">
            <button on:click=move |_| answer(yes.clone(), None, Some(true), None)>"Yes"</button>
            <button on:click=move |_| answer(no.clone(), None, None, Some(true))>"No"</button>
        </div>
    }
}

/// `input`: a single-line answer, submitted verbatim.
fn input_body(dialog: &PendingDialog, text: RwSignal<String>, answer: impl Fn(String, Option<String>, Option<bool>, Option<bool>) + Copy + 'static) -> impl IntoView {
    let id = dialog.id.clone();
    let placeholder = param(dialog, "placeholder").unwrap_or_default();
    view! {
        <div class="ext-dialog-actions">
            <input
                class="ext-dialog-input"
                placeholder=placeholder
                prop:value=move || text.get()
                on:input=move |ev| text.set(event_target_value(&ev))
            />
            <button on:click=move |_| answer(id.clone(), Some(text.get_untracked()), None, None)>"Submit"</button>
        </div>
    }
}

/// `editor`: a multi-line answer prefilled from the request's `prefill`.
fn editor_body(dialog: &PendingDialog, text: RwSignal<String>, answer: impl Fn(String, Option<String>, Option<bool>, Option<bool>) + Copy + 'static) -> impl IntoView {
    let id = dialog.id.clone();
    view! {
        <div class="ext-dialog-actions">
            <textarea
                class="ext-dialog-editor"
                prop:value=move || text.get()
                on:input=move |ev| text.set(event_target_value(&ev))
            ></textarea>
            <button on:click=move |_| answer(id.clone(), Some(text.get_untracked()), None, None)>"Submit"</button>
        </div>
    }
}

fn param(dialog: &PendingDialog, key: &str) -> Option<String> {
    dialog.params.get(key).and_then(Value::as_str).map(str::to_string)
}

//! Presentation layer: the reactive view and its signals only. No transport or
//! endpoint knowledge lives here — the WS lifecycle is `crate::ws`.

use leptos::prelude::*;
use leptos_meta::{provide_meta_context, Title};

use crate::bridge::ClientMessage;
use crate::components::bash::BashPanel;
use crate::components::controls::ControlsPanel;
use crate::components::dialog::DialogOverlay;
use crate::components::dispatch;
use crate::components::message::Transcript;
use crate::components::queue::QueuePanel;
use crate::components::status::{NotifyToasts, StatusChrome};
use crate::controls::ControlsState;
use crate::extension_ui::ExtensionUiState;
use crate::stream::ChatState;

/// Connection state the view renders. A dropped socket must never read as a
/// silent hang, nor a lost frame as a successful send, so the view always
/// shows one of these.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    Disconnected,
    /// A send was attempted while the socket was closed or rejected it.
    SendFailed,
}

impl ConnectionStatus {
    pub fn label(self) -> &'static str {
        match self {
            ConnectionStatus::Connecting => "connecting",
            ConnectionStatus::Connected => "connected",
            ConnectionStatus::Disconnected => "disconnected — retrying",
            ConnectionStatus::SendFailed => "send failed — not delivered",
        }
    }
}

/// Hydrated client root. `provide_meta_context` provides the `MetaContext` the
/// meta components read; the shell renders `HydrationScripts` to bootstrap
/// this view in the browser.
#[component]
pub fn App() -> impl IntoView {
    provide_meta_context();
    // The streaming state lives for the whole app: the WS adapter feeds it and
    // the transcript reads it. Defaults are deterministic, which is what
    // hydration requires.
    let chat = ChatState::new();
    provide_context(chat);
    // The control-plane state (queue, model/thinking, stats, toggles, draft)
    // is separate from the transcript and provided for the same lifetime.
    let controls = ControlsState::new();
    provide_context(controls);
    // Extension UI chrome shares the composer draft so `set_editor_text` lands
    // in the same signal the prompt input reads.
    let extension_ui = ExtensionUiState::new(controls.draft);
    provide_context(extension_ui);
    let status = RwSignal::new(ConnectionStatus::Disconnected);

    // Browser-only: open the WS, reconnect with backoff, and feed frames into
    // the chat state. Compiled out of the server target entirely.
    #[cfg(feature = "hydrate")]
    crate::ws::connect(chat, controls, extension_ui, status);

    view! {
        <Title text="cheasee-pi"/>
        <DialogOverlay status=status/>
        <NotifyToasts/>
        <main class="shell">
            <h1>"cheasee-pi control center"</h1>
            <StatusChrome/>
            <Counter/>
            <ControlsPanel status=status/>
            <QueuePanel status=status/>
            <BashPanel status=status/>
            <PromptInput status=status/>
            <Transcript/>
        </main>
    }
}

/// Deterministic initial state (0) — the only shape hydration tolerates.
#[component]
fn Counter() -> impl IntoView {
    let count = RwSignal::new(0);
    view! {
        <section class="counter">
            <button on:click=move |_| *count.write() += 1>
                "count: " {move || count.get()}
            </button>
        </section>
    }
}

/// The prompt box: sends a [`ClientMessage::Prompt`] to the server.
#[component]
fn PromptInput(status: RwSignal<ConnectionStatus>) -> impl IntoView {
    // The draft is owned by the control state so `clear_queue` can restore the
    // text it removed back into the editor.
    let controls = expect_context::<ControlsState>();
    let draft = controls.draft;
    // Used only to decide the streaming behavior of a mid-run prompt.
    #[cfg(feature = "hydrate")]
    let chat = expect_context::<ChatState>();

    let send = move |_| {
        let message = draft.get();
        if message.trim().is_empty() {
            return;
        }
        #[cfg(feature = "hydrate")]
        {
            // pi rejects a prompt sent mid-run without a `streamingBehavior`
            // (`docs/rpc-commands.md`); steer the running turn, the common case.
            let streaming_behavior = if chat.status.get_untracked().is_streaming() {
                Some(crate::bridge::StreamingBehavior::Steer)
            } else {
                None
            };
            // Only clear the draft when the frame actually left the socket: a
            // prompt typed before connection or during a send failure must not
            // be lost.
            let delivered = crate::ws::send(
                crate::bridge::ClientMessage::Prompt {
                    id: None,
                    message,
                    streaming_behavior,
                },
                status,
            );
            if delivered {
                draft.set(String::new());
            }
        }
        #[cfg(not(feature = "hydrate"))]
        {
            let _ = message;
            draft.set(String::new());
        }
    };

    // AC1: Stop maps to `abort`. It deliberately leaves pi's queue intact —
    // clearing queued input is the queue panel's own "clear queue" control.
    let stop = move |_| dispatch(ClientMessage::Abort { id: None }, status);

    // AC1: a prompt typed mid-run is either delivered to the running turn
    // (`Send` -> steer) or held until the agent stops (`Queue` -> follow_up).
    let queue = move |_| {
        let message = draft.get();
        if message.trim().is_empty() {
            return;
        }
        #[cfg(feature = "hydrate")]
        {
            // Only clear on a delivered frame, matching `send`.
            if crate::ws::send(ClientMessage::FollowUp { id: None, message }, status) {
                draft.set(String::new());
            }
        }
        #[cfg(not(feature = "hydrate"))]
        {
            let _ = message;
            draft.set(String::new());
        }
    };

    view! {
        <section class="prompt">
            <input
                type="text"
                placeholder="type a message"
                prop:value=draft
                on:input=move |ev| draft.set(event_target_value(&ev))
            />
            <button on:click=send>"Send"</button>
            <button class="queue-prompt" on:click=queue>"Queue"</button>
            <button class="stop" on:click=stop>"Stop"</button>
            <p class="status">"status: " {move || status.get().label()}</p>
        </section>
    }
}

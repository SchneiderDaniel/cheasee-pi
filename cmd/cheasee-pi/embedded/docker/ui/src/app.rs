//! Presentation layer: the reactive view and its signals only. No transport or
//! endpoint knowledge lives here — the WS lifecycle is `crate::ws`.

use leptos::prelude::*;
use leptos_meta::{provide_meta_context, Title};

use crate::components::message::Transcript;
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
    let status = RwSignal::new(ConnectionStatus::Disconnected);

    // Browser-only: open the WS, reconnect with backoff, and feed frames into
    // the chat state. Compiled out of the server target entirely.
    #[cfg(feature = "hydrate")]
    crate::ws::connect(chat, status);

    view! {
        <Title text="cheasee-pi"/>
        <main class="shell">
            <h1>"cheasee-pi control center"</h1>
            <Counter/>
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
    let draft = RwSignal::new(String::new());
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
            crate::ws::send(
                crate::bridge::ClientMessage::Prompt {
                    id: None,
                    message,
                    streaming_behavior,
                },
                status,
            );
        }
        #[cfg(not(feature = "hydrate"))]
        let _ = message;
        draft.set(String::new());
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
            <p class="status">"status: " {move || status.get().label()}</p>
        </section>
    }
}

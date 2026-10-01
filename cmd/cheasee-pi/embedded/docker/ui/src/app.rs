//! Presentation layer: the reactive view and its signals only. No transport or
//! endpoint knowledge lives here — the WS lifecycle is `crate::ws`.

use leptos::prelude::*;
use leptos_meta::{provide_meta_context, Title};

/// Connection state the echo view renders. A dropped socket must never read as
/// a silent hang, nor a lost frame as a successful send, so the view always
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
    view! {
        <Title text="cheasee-pi"/>
        <main class="shell">
            <h1>"cheasee-pi control center"</h1>
            <Counter/>
            <Echo/>
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

#[component]
fn Echo() -> impl IntoView {
    let draft = RwSignal::new(String::new());
    let echoed = RwSignal::new(String::new());
    let status = RwSignal::new(ConnectionStatus::Disconnected);

    // Browser-only: open the WS, reconnect with backoff, and feed frames into
    // the signals above. Compiled out of the server target entirely.
    #[cfg(feature = "hydrate")]
    crate::ws::connect(echoed, status);

    let send = move |_| {
        let text = draft.get();
        if text.is_empty() {
            return;
        }
        #[cfg(feature = "hydrate")]
        crate::ws::send(text, status);
        #[cfg(not(feature = "hydrate"))]
        let _ = text;
    };

    view! {
        <section class="echo">
            <input
                type="text"
                placeholder="type a message"
                prop:value=draft
                on:input=move |ev| draft.set(event_target_value(&ev))
            />
            <button on:click=send>"Send"</button>
            <p class="status">"status: " {move || status.get().label()}</p>
            <p class="echo-out">"echo: " {move || echoed.get()}</p>
        </section>
    }
}

//! Browser WebSocket adapter — owns the live-event channel lifecycle.
//!
//! Deep module: callers get `connect`/`send` and a pair of signals; the
//! reconnect-with-backoff and the native socket stay behind this boundary. The
//! channel is framing-agnostic here — every JSON text frame echoed by the
//! server is surfaced verbatim, leaving slice 4 free to layer strict framing on
//! the pi child pipe instead.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use futures::channel::oneshot;
use leptos::prelude::*;
use leptos::task::spawn_local;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;
use web_sys::{MessageEvent, WebSocket};

use crate::app::ConnectionStatus;
use crate::retry::{deliver, Reconnect, SendOutcome, STABLE_CONNECTION_MS};

/// The live socket plus the closures the browser holds callbacks into. Stored
/// together so dropping the pair at once can never leave a JS callback pointing
/// at a freed Rust closure.
struct Live {
    socket: WebSocket,
    _open: Closure<dyn FnMut()>,
    _message: Closure<dyn FnMut(MessageEvent)>,
    _close: Closure<dyn FnMut()>,
}

thread_local! {
    static LIVE: RefCell<Option<Live>> = const { RefCell::new(None) };
}

fn ws_url() -> String {
    let location = web_sys::window().expect("window").location();
    let scheme = if location.protocol().unwrap_or_default() == "https:" {
        "wss"
    } else {
        "ws"
    };
    format!("{scheme}://{}/ws", location.host().unwrap_or_default())
}

/// Send one text frame, reporting the outcome to the caller *and* the view.
///
/// A send against a closed socket, or one the native socket rejects, must be
/// visible — a lost frame can never masquerade as a successful send.
pub fn send(text: String, set_status: RwSignal<ConnectionStatus>) -> SendOutcome {
    let outcome = LIVE.with(|live| match live.borrow().as_ref() {
        Some(live) => deliver(&live.socket, &text),
        None => SendOutcome::NotConnected,
    });
    if outcome != SendOutcome::Sent {
        set_status.set(ConnectionStatus::SendFailed);
    }
    outcome
}

/// Connect, then reconnect with backoff until the page goes away. `set_echo`
/// receives each echoed frame; `set_status` drives the visible connection state.
pub fn connect(set_echo: RwSignal<String>, set_status: RwSignal<ConnectionStatus>) {
    // Shared reconnect policy plus a generation token: each attempt bumps it,
    // which makes a stability timer left pending by a short-lived socket inert.
    let reconnect = Rc::new(RefCell::new(Reconnect::new()));
    let generation = Rc::new(Cell::new(0u32));
    spawn_local(async move {
        loop {
            let my_generation = generation.get().wrapping_add(1);
            generation.set(my_generation);
            reconnect.borrow_mut().on_open();
            set_status.set(ConnectionStatus::Connecting);

            if let Ok(closed) = open(set_echo, set_status) {
                // A socket only counts as stable if it is still the current one
                // after the window; one that opens and immediately drops keeps
                // the retry counter climbing instead of resetting.
                let timer_generation = generation.clone();
                let timer_reconnect = reconnect.clone();
                spawn_local(async move {
                    gloo_timers::future::TimeoutFuture::new(STABLE_CONNECTION_MS as u32).await;
                    if timer_generation.get() == my_generation {
                        timer_reconnect.borrow_mut().on_stable();
                    }
                });
                let _ = closed.await;
                // Invalidate the timer before the backoff wait so it cannot
                // mark a just-dropped socket stable.
                generation.set(generation.get().wrapping_add(1));
            }

            // Drop the dead socket and its closures before waiting to retry.
            LIVE.with(|live| *live.borrow_mut() = None);
            set_status.set(ConnectionStatus::Disconnected);
            let delay = reconnect.borrow_mut().on_close();
            gloo_timers::future::TimeoutFuture::new(delay.as_millis() as u32).await;
        }
    });
}

/// Open one socket. `Ok(rx)` resolves when the socket closes (or errors and
/// closes); `Err` means the URL itself was rejected — retried by the caller.
fn open(
    set_echo: RwSignal<String>,
    set_status: RwSignal<ConnectionStatus>,
) -> Result<oneshot::Receiver<()>, ()> {
    let socket = WebSocket::new(&ws_url()).map_err(|_| ())?;
    let (tx, rx) = oneshot::channel::<()>();
    let mut tx = Some(tx);

    let on_open = Closure::<dyn FnMut()>::new(move || {
        set_status.set(ConnectionStatus::Connected);
    });
    let on_message = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
        if let Some(text) = event.data().as_string() {
            set_echo.set(text);
        }
    });
    // A failed connect fires `error` then `close`; closing on either is enough
    // to drive the retry. `take` makes the second event a no-op.
    let on_close = Closure::<dyn FnMut()>::new(move || {
        if let Some(tx) = tx.take() {
            let _ = tx.send(());
        }
    });

    socket.set_onopen(Some(on_open.as_ref().unchecked_ref()));
    socket.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
    socket.set_onclose(Some(on_close.as_ref().unchecked_ref()));

    LIVE.with(|live| {
        *live.borrow_mut() = Some(Live {
            socket,
            _open: on_open,
            _message: on_message,
            _close: on_close,
        });
    });

    Ok(rx)
}

/// The native socket as the transport the send policy drives.
impl crate::retry::Transport for WebSocket {
    fn is_open(&self) -> bool {
        self.ready_state() == WebSocket::OPEN
    }

    fn send_text(&self, text: &str) -> Result<(), ()> {
        self.send_with_str(text).map_err(|_| ())
    }
}

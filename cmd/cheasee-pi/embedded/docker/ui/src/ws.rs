//! Browser WebSocket adapter — owns the live-event channel lifecycle.
//!
//! Deep module: callers get `connect`/`send` and a pair of signals; the
//! reconnect-with-backoff and the native socket stay behind this boundary. The
//! channel is framing-agnostic here — every JSON text frame echoed by the
//! server is surfaced verbatim, leaving slice 4 free to layer strict framing on
//! the pi child pipe instead.

use std::cell::RefCell;
use std::rc::Rc;

use futures::channel::oneshot;
use leptos::prelude::*;
use leptos::task::spawn_local;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;
use web_sys::{MessageEvent, WebSocket};

use crate::app::ConnectionStatus;
use crate::retry::{deliver, send_status, Adapter, SendOutcome, SessionEffect};

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

/// Translate a lifecycle decision into the state the view renders.
fn status_of(effect: SessionEffect) -> ConnectionStatus {
    match effect {
        SessionEffect::Connecting => ConnectionStatus::Connecting,
        SessionEffect::Connected => ConnectionStatus::Connected,
        SessionEffect::Reconnect(_) => ConnectionStatus::Disconnected,
        SessionEffect::SendFailed => ConnectionStatus::SendFailed,
    }
}

/// Send one text frame, reporting the outcome to the view.
///
/// A send against a closed socket, or one the native socket rejects, must be
/// visible; a delivered frame must equally clear a previous failure, or a later
/// success would still read as undelivered.
pub fn send(text: String, set_status: RwSignal<ConnectionStatus>) {
    let outcome = LIVE.with(|live| match live.borrow().as_ref() {
        Some(live) => deliver(&live.socket, &text),
        None => SendOutcome::NotConnected,
    });
    set_status.set(status_of(send_status(outcome)));
}

/// Connect, then reconnect with backoff until the page goes away. `set_echo`
/// receives each echoed frame; `set_status` drives the visible connection state.
pub fn connect(set_echo: RwSignal<String>, set_status: RwSignal<ConnectionStatus>) {
    // The lifecycle wiring lives in `retry::Adapter` (host-testable); this shell
    // feeds it transport callbacks and applies the returned effects.
    let adapter = Rc::new(RefCell::new(Adapter::new()));
    spawn_local(async move {
        loop {
            let (_, dial) = adapter.borrow_mut().dial_started();
            set_status.set(status_of(dial));

            // A rejected URL never opens; fall straight through to the backoff.
            if let Ok(closed) = open(adapter.clone(), set_echo, set_status) {
                let _ = closed.await;
            }

            // Drop the dead socket and its closures before waiting to retry.
            LIVE.with(|live| *live.borrow_mut() = None);
            let delay = match adapter.borrow_mut().closed() {
                SessionEffect::Reconnect(delay) => delay,
                _ => continue,
            };
            set_status.set(ConnectionStatus::Disconnected);
            gloo_timers::future::TimeoutFuture::new(delay.as_millis() as u32).await;
        }
    });
}

/// Open one socket. `Ok(rx)` resolves when the socket closes (or errors and
/// closes); `Err` means the URL itself was rejected — retried by the caller.
fn open(
    adapter: Rc<RefCell<Adapter>>,
    set_echo: RwSignal<String>,
    set_status: RwSignal<ConnectionStatus>,
) -> Result<oneshot::Receiver<()>, ()> {
    let socket = WebSocket::new(&ws_url()).map_err(|_| ())?;
    let (tx, rx) = oneshot::channel::<()>();
    let mut tx = Some(tx);

    let open_adapter = adapter.clone();
    let on_open = Closure::<dyn FnMut()>::new(move || {
        // The window is armed by `opened` and carries the generation it was
        // armed under: a handshake that pends past the window and then fails
        // never reaches this callback, and a late timer from a dead socket
        // cannot mark a newer one stable.
        let (effect, timer) = open_adapter.borrow_mut().opened();
        set_status.set(status_of(effect));
        let timer_adapter = open_adapter.clone();
        spawn_local(async move {
            gloo_timers::future::TimeoutFuture::new(timer.after.as_millis() as u32).await;
            timer_adapter.borrow_mut().stable_elapsed(timer.generation);
        });
    });
    let on_message = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
        if let Some(text) = event.data().as_string() {
            set_echo.set(text);
        }
    });
    // A failed connect fires `error` then `close`; closing on either is enough
    // to drive the retry. `take` makes the second event a no-op. Disarm the
    // stability timer before signalling the loop so it cannot reset the backoff
    // in the gap.
    let close_adapter = adapter;
    let on_close = Closure::<dyn FnMut()>::new(move || {
        close_adapter.borrow_mut().transport_closed();
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

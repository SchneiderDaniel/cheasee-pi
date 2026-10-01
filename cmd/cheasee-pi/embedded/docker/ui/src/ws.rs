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
use crate::retry::backoff;

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

/// Send one text frame if the socket is open. A no-op otherwise: the view
/// already shows the disconnected state, so this never hides a failure.
pub fn send(text: String) {
    LIVE.with(|live| {
        if let Some(live) = live.borrow().as_ref() {
            if live.socket.ready_state() == WebSocket::OPEN {
                let _ = live.socket.send_with_str(&text);
            }
        }
    });
}

/// Connect, then reconnect with backoff until the page goes away. `set_echo`
/// receives each echoed frame; `set_status` drives the visible connection state.
pub fn connect(set_echo: RwSignal<String>, set_status: RwSignal<ConnectionStatus>) {
    // Shared attempt counter: reset on a successful open, bumped after each
    // drop, so backoff grows across a flapping connection but not across a
    // single reconnect.
    let attempt = Rc::new(Cell::new(0u32));
    spawn_local(async move {
        loop {
            set_status.set(ConnectionStatus::Connecting);
            if let Ok(closed) = open(set_echo, set_status, attempt.clone()) {
                let _ = closed.await;
            }
            // Drop the dead socket and its closures before waiting to retry.
            LIVE.with(|live| *live.borrow_mut() = None);
            set_status.set(ConnectionStatus::Disconnected);
            let next = attempt.get() + 1;
            attempt.set(next);
            gloo_timers::future::TimeoutFuture::new(backoff(next).as_millis() as u32).await;
        }
    });
}

/// Open one socket. `Ok(rx)` resolves when the socket closes (or errors and
/// closes); `Err` means the URL itself was rejected — retried by the caller.
fn open(
    set_echo: RwSignal<String>,
    set_status: RwSignal<ConnectionStatus>,
    attempt: Rc<Cell<u32>>,
) -> Result<oneshot::Receiver<()>, ()> {
    let socket = WebSocket::new(&ws_url()).map_err(|_| ())?;
    let (tx, rx) = oneshot::channel::<()>();
    let mut tx = Some(tx);

    let on_open = Closure::<dyn FnMut()>::new(move || {
        attempt.set(0);
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

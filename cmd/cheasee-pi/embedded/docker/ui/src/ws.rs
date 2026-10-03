//! Browser WebSocket adapter — owns the live-event channel lifecycle.
//!
//! Thin shell: it owns the native `WebSocket` and the browser clock, and hands
//! the callback-to-adapter wiring to [`crate::retry::wire`] — the *same*
//! function the host lifecycle tests drive with a fake socket and clock. Every
//! incoming frame is a [`crate::bridge::ServerMessage`] fed into
//! [`crate::stream::ChatState`]; every outgoing frame is an encoded
//! [`crate::bridge::ClientMessage`].

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use futures::channel::oneshot;
use leptos::prelude::*;
use leptos::task::spawn_local;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{MessageEvent, WebSocket};

use crate::app::ConnectionStatus;
use crate::bridge::ClientMessage;
use crate::controls::ControlsState;
use crate::retry::{deliver, send_status, wire, Adapter, SendOutcome, SessionEffect, Socket, Timer};
use crate::stream::ChatState;

/// The live socket plus the JS closures the browser holds callbacks into. Each
/// closure is kept alive as a `JsValue` for the socket's lifetime; dropping the
/// pair at once can never leave a JS callback pointing at a freed Rust closure.
struct BrowserSocket {
    socket: WebSocket,
    handlers: RefCell<Vec<JsValue>>,
}

impl BrowserSocket {
    fn new(socket: WebSocket) -> Self {
        Self {
            socket,
            handlers: RefCell::new(Vec::new()),
        }
    }

    fn keep(&self, closure: JsValue) {
        self.handlers.borrow_mut().push(closure);
    }
}

/// The native socket's callback surface. `wire` installs the lifecycle here; the
/// host test installs it on a fake implementing the same trait.
impl Socket for BrowserSocket {
    fn on_open<F: FnMut() + 'static>(&self, handler: F) {
        let boxed: Box<dyn FnMut()> = Box::new(handler);
        let closure = Closure::wrap(boxed);
        self.socket.set_onopen(Some(closure.as_ref().unchecked_ref()));
        self.keep(closure.into_js_value());
    }

    fn on_message<F: FnMut(String) + 'static>(&self, mut handler: F) {
        let closure = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
            if let Some(text) = event.data().as_string() {
                handler(text);
            }
        });
        self.socket
            .set_onmessage(Some(closure.as_ref().unchecked_ref()));
        self.keep(closure.into_js_value());
    }

    fn on_close<F: FnMut() + 'static>(&self, handler: F) {
        let boxed: Box<dyn FnMut()> = Box::new(handler);
        let closure = Closure::wrap(boxed);
        self.socket.set_onclose(Some(closure.as_ref().unchecked_ref()));
        self.keep(closure.into_js_value());
    }
}

/// The native socket as the transport the send policy drives.
impl crate::retry::Transport for BrowserSocket {
    fn is_open(&self) -> bool {
        self.socket.ready_state() == WebSocket::OPEN
    }

    fn send_text(&self, text: &str) -> Result<(), ()> {
        self.socket.send_with_str(text).map_err(|_| ())
    }
}

/// The browser clock: a scheduled `gloo_timers` timeout. `wire` arms the
/// stability window through this, so the timing policy stays in `retry`.
struct BrowserTimer;

impl Timer for BrowserTimer {
    fn after<F: FnMut() + 'static>(&self, delay: Duration, mut task: F) {
        spawn_local(async move {
            gloo_timers::future::TimeoutFuture::new(delay.as_millis() as u32).await;
            task();
        });
    }
}

thread_local! {
    static LIVE: RefCell<Option<BrowserSocket>> = const { RefCell::new(None) };
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

/// Send one [`ClientMessage`], reporting the outcome to the view.
///
/// A send against a closed socket, or one the native socket rejects, must be
/// visible; a delivered frame must equally clear a previous failure, or a later
/// success would still read as undelivered. Returns whether the frame actually
/// left the socket, so the caller can retain a draft that was not delivered.
pub fn send(message: ClientMessage, set_status: RwSignal<ConnectionStatus>) -> bool {
    let text = match serde_json::to_string(&message) {
        Ok(text) => text,
        // Encoding our own envelope cannot fail in practice; if it ever did, a
        // silent no-op would read as a delivered prompt.
        Err(_) => {
            set_status.set(ConnectionStatus::SendFailed);
            return false;
        }
    };
    let outcome = LIVE.with(|live| match live.borrow().as_ref() {
        Some(live) => deliver(live, &text),
        None => SendOutcome::NotConnected,
    });
    set_status.set(status_of(send_status(outcome)));
    matches!(outcome, SendOutcome::Sent)
}

/// Connect, then reconnect with backoff until the page goes away. `state`
/// receives each decoded server frame into the transcript and `controls` into
/// the control surface; `set_status` drives the visible connection state.
pub fn connect(
    state: ChatState,
    controls: ControlsState,
    set_status: RwSignal<ConnectionStatus>,
) {
    // The lifecycle decisions live in `retry` (host-testable); this shell owns
    // the native socket and the clock, installs the shared `retry::wire`
    // callbacks, and applies the returned effects.
    let adapter = Rc::new(RefCell::new(Adapter::new()));
    spawn_local(async move {
        loop {
            let (_, dial) = adapter.borrow_mut().dial_started();
            set_status.set(status_of(dial));

            // A rejected URL never opens; fall straight through to the backoff.
            if let Ok(closed) = open(adapter.clone(), state, controls, set_status) {
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

/// Open one socket and install the shared callback wiring on it. `Ok(rx)`
/// resolves when the socket closes (or errors and closes); `Err` means the URL
/// itself was rejected — retried by the caller.
fn open(
    adapter: Rc<RefCell<Adapter>>,
    state: ChatState,
    controls: ControlsState,
    set_status: RwSignal<ConnectionStatus>,
) -> Result<oneshot::Receiver<()>, ()> {
    let socket = WebSocket::new(&ws_url()).map_err(|_| ())?;
    let browser = BrowserSocket::new(socket);
    let (tx, rx) = oneshot::channel::<()>();
    let mut tx = Some(tx);

    // The callback-to-adapter wiring lives once, in `retry::wire`; the host
    // lifecycle tests install that same function on a fake socket.
    wire(
        &browser,
        BrowserTimer,
        adapter,
        move |effect| set_status.set(status_of(effect)),
        move |text| {
            state.ingest_frame(&text);
            controls.ingest_frame(&text);
        },
        move || {
            if let Some(tx) = tx.take() {
                let _ = tx.send(());
            }
        },
    );

    LIVE.with(|live| *live.borrow_mut() = Some(browser));
    Ok(rx)
}

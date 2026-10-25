use super::*;

/// The browser shell's lifecycle surface: every socket callback and timer
/// firing the wasm build produces is one method here, and `ws` is a thin shim
/// that owns the native socket and calls in.
///
/// This type exists so the *wiring* is host-testable. A test against [`Session`]
/// alone cannot see the shell arming the window from the wrong callback (or not
/// at all) — the exact defect a prior audit caught — because the arming is a
/// decision of this adapter, not of the policy underneath.
#[derive(Debug, Default)]
pub struct Adapter {
    session: Session,
}

impl Adapter {
    pub fn new() -> Self {
        Self::default()
    }

    /// A dial began: the generation the socket's stability timer must carry,
    /// plus the state to show meanwhile. Deliberately arms nothing — a handshake
    /// that pends and then fails must not count as a stable session.
    pub fn dial_started(&mut self) -> (u32, SessionEffect) {
        let effect = self.session.dial_started();
        (self.session.generation(), effect)
    }

    /// The socket's `open` callback: the usable state, plus the stability window
    /// to arm. The window names the live generation so a late timer cannot mark
    /// a newer socket stable.
    pub fn opened(&mut self) -> (SessionEffect, StabilityTimer) {
        let effect = self.session.opened();
        (
            effect,
            StabilityTimer {
                generation: self.session.generation(),
                after: Duration::from_millis(STABLE_CONNECTION_MS),
            },
        )
    }

    /// The stability window elapsed for `generation`; inert if stale or disarmed.
    pub fn stable_elapsed(&mut self, generation: u32) {
        self.session.stable_elapsed(generation);
    }

    /// The socket's `close`/`error` callback: disarm the window *before* the
    /// reconnect loop is signalled, so a timer firing in the gap cannot reset the
    /// backoff for a connection that never held.
    pub fn transport_closed(&mut self) {
        self.session.transport_closed();
    }

    /// The loop's post-close step: the state to show and, for `Reconnect`, the
    /// delay before the next dial.
    pub fn closed(&mut self) -> SessionEffect {
        self.session.closed()
    }
}

/// The native socket surface the connection wiring installs callbacks on. The
/// wasm shell (`ws`) implements this over `web_sys::WebSocket`; the host
/// lifecycle test implements it with a fake whose callbacks it can fire, so the
/// wiring below is exercised without a browser.
pub trait Socket {
    fn on_open<F: FnMut() + 'static>(&self, handler: F);
    fn on_message<F: FnMut(String) + 'static>(&self, handler: F);
    fn on_close<F: FnMut() + 'static>(&self, handler: F);
}

/// The delayed callback the stability window needs. The wasm shell schedules
/// on `gloo_timers`; the host test records the task and fires it on demand, so
/// "the window is armed from `on_open`" is an assertable fact.
pub trait Timer {
    fn after<F: FnMut() + 'static>(&self, delay: Duration, task: F);
}

/// Install the connection lifecycle on one socket. This is the *single*
/// implementation of the callback wiring: `ws` calls it with the browser socket
/// and the view's signals, and the lifecycle tests call it with a fake socket
/// and clock. A regression that stops arming the stability window from
/// `on_open`, or stops disarming it on `on_close`, therefore fails the tests
/// instead of only failing in a browser.
///
/// Wiring contract, in one place:
/// - `on_open`: mark connected and arm the stability window for this socket —
///   never at dial time, or a handshake that pends then fails would count as a
///   session and reset the backoff.
/// - `on_message`: hand the frame to the decoder (the `echo` callback is)
///   [`crate::frame::UiSlice::ingest_frame`], which parses the server envelope).
/// - `on_close`: disarm the window *before* signalling the retry loop, then
///   signal it, so a timer firing in the gap cannot reset the backoff.
pub fn wire<S, T>(
    socket: &S,
    timer: T,
    adapter: Rc<RefCell<Adapter>>,
    mut status: impl FnMut(SessionEffect) + 'static,
    mut echo: impl FnMut(String) + 'static,
    mut closed: impl FnMut() + 'static,
) where
    S: Socket,
    T: Timer + 'static,
{
    let open_adapter = adapter.clone();
    socket.on_open(move || {
        let (effect, window) = open_adapter.borrow_mut().opened();
        status(effect);
        let timer_adapter = open_adapter.clone();
        timer.after(window.after, move || {
            timer_adapter.borrow_mut().stable_elapsed(window.generation);
        });
    });

    socket.on_message(move |text| echo(text));

    socket.on_close(move || {
        adapter.borrow_mut().transport_closed();
        closed();
    });
}

/// Outcome of one attempt to put a frame on the wire. The browser branch of
/// `ws::send` maps this to a user-visible state, so a lost frame is never a
/// silent no-op.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    /// The socket accepted the frame.
    Sent,
    /// The socket is not open (never connected, or already dropped).
    NotConnected,
    /// The socket was open but rejected the frame.
    SendFailed,
}

/// Minimal socket surface the send policy needs. Implemented by `ws`'s
/// `BrowserSocket` (over the native `web_sys::WebSocket`) and by a fake in tests.
pub trait Transport {
    fn is_open(&self) -> bool;
    fn send_text(&self, text: &str) -> Result<(), ()>;
}

/// Decide and perform one send. Returns why a frame did not leave instead of
/// discarding the error.
pub fn deliver<T: Transport>(transport: &T, text: &str) -> SendOutcome {
    if !transport.is_open() {
        return SendOutcome::NotConnected;
    }
    match transport.send_text(text) {
        Ok(()) => SendOutcome::Sent,
        Err(()) => SendOutcome::SendFailed,
    }
}

/// Map a send outcome to the status the shell shows. A delivered frame clears a
/// previous failure — otherwise one failed send would leave the UI claiming a
/// later delivered message was not delivered. A frame that did not leave (closed
/// socket or rejected send) is always surfaced.
pub fn send_status(outcome: SendOutcome) -> SessionEffect {
    match outcome {
        SendOutcome::Sent => SessionEffect::Connected,
        SendOutcome::NotConnected | SendOutcome::SendFailed => SessionEffect::SendFailed,
    }
}

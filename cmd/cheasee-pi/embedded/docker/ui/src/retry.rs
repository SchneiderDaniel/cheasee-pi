//! Connection policy — pure, transport-free, and compiled for both targets so
//! the browser transport's retry timing and send decisions stay host-testable.
//!
//! `ws` is a thin shell over these decisions: [`Reconnect`] says *when* to
//! retry, [`deliver`] says *whether* a frame actually left the socket. Keeping
//! both here means the client lifecycle is assertable without a browser.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

/// First retry delay, in milliseconds.
pub const BASE_BACKOFF_MS: u32 = 500;
/// Ceiling for the exponential retry delay, in milliseconds.
pub const MAX_BACKOFF_MS: u32 = 8_000;

/// How long a connection must hold before it counts as a real session and
/// resets the retry counter. Shorter than this and the socket is treated as
/// flapping, so the next delay keeps growing instead of restarting at base.
pub const STABLE_CONNECTION_MS: u64 = 5_000;

/// Exponential backoff for a 0-based reconnect `attempt`, clamped at
/// [`MAX_BACKOFF_MS`] so a long outage settles into a slow steady retry instead
/// of skipping past the ceiling.
pub fn backoff(attempt: u32) -> Duration {
    let shift = attempt.min(4);
    let ms = (BASE_BACKOFF_MS << shift).min(MAX_BACKOFF_MS);
    Duration::from_millis(u64::from(ms))
}

/// Reconnect policy: tracks consecutive unstable connections and decides the
/// wait before the next attempt.
///
/// The counter is *not* reset when a socket opens — a server that accepts and
/// immediately drops would then retry at the same delay forever. It resets only
/// once a connection has held past the stability window ([`STABLE_CONNECTION_MS`]).
#[derive(Debug, Default)]
pub struct Reconnect {
    attempt: u32,
    stable: bool,
}

impl Reconnect {
    pub fn new() -> Self {
        Self::default()
    }

    /// A socket opened. Nothing resets here on purpose — an open/immediate-drop
    /// cycle must keep growing the delay.
    pub fn on_open(&mut self) {
        self.stable = false;
    }

    /// The connection held past the stability window: it was a real session, so
    /// the next disconnect starts back at the base delay.
    pub fn on_stable(&mut self) {
        self.attempt = 0;
        self.stable = true;
    }

    /// The socket closed; returns the delay to wait before reconnecting. The
    /// delay comes from the *current* attempt, which is advanced only after the
    /// delay is computed: the first retry is the declared base
    /// ([`BASE_BACKOFF_MS`]) and the next is double it, not base-plus-one-step.
    pub fn on_close(&mut self) -> Duration {
        if self.stable {
            // A connection that held past the window is a real session.
            self.attempt = 0;
        }
        let delay = backoff(self.attempt);
        self.attempt = self.attempt.saturating_add(1);
        self.stable = false;
        delay
    }
}

/// One decision the connection lifecycle produced. The browser shell (`ws`) is
/// the only place these become DOM state or a sleep — the decisions themselves
/// stay host-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEffect {
    /// A dial began; the channel is not yet usable.
    Connecting,
    /// The socket opened, or a send that had failed now left successfully.
    Connected,
    /// The socket is down; the shell reconnects after this delay.
    Reconnect(Duration),
    /// A send was attempted and did not leave the socket.
    SendFailed,
}

/// Injectable connection lifecycle — when to retry and whether a connection is
/// stable, separated from the async browser shell that owns the real socket.
///
/// The shell feeds transport callbacks and stability-timer firings in, then
/// applies the returned [`SessionEffect`]. The stability timer is therefore
/// just the [`Session::stable_elapsed`] event, so a test owns the clock: a
/// delayed failed handshake and a flapping server are ordinary inputs here.
#[derive(Debug, Default)]
pub struct Session {
    reconnect: Reconnect,
    generation: u32,
    /// Armed by [`Session::opened`], cleared by a close or a fresh dial. A
    /// stability timer firing while this is clear lost the race with the
    /// socket's lifetime and must not reset the retry counter.
    stable_armed: bool,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    /// Token for the dial that just started. A timer carries the token it was
    /// armed under, so a late timer from a dead socket cannot mark the
    /// *current* socket stable.
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// A dial attempt began. Nothing resets here — a server that accepts and
    /// immediately drops must keep the delay growing.
    pub fn dial_started(&mut self) -> SessionEffect {
        self.generation = self.generation.wrapping_add(1);
        self.stable_armed = false;
        SessionEffect::Connecting
    }

    /// The socket's `open` fired: the channel is usable, and the stability
    /// window starts *here*, not at dial time. A handshake that pends then
    /// fails never reaches this, so it cannot count as a stable session.
    pub fn opened(&mut self) -> SessionEffect {
        self.stable_armed = true;
        SessionEffect::Connected
    }

    /// The stability window elapsed for `generation`. The connection was a real
    /// session, so the next disconnect retries at the base delay; a timer from a
    /// socket that already dropped, or from an earlier dial, is inert.
    pub fn stable_elapsed(&mut self, generation: u32) {
        if self.stable_armed && generation == self.generation {
            self.stable_armed = false;
            self.reconnect.on_stable();
        }
    }

    /// The socket closed. Disarms the stability timer *before* the shell signals
    /// its reconnect loop, so a timer firing in that gap cannot reset the
    /// backoff for a connection that never held.
    pub fn transport_closed(&mut self) {
        self.stable_armed = false;
    }

    /// The connection is down for good; returns the delay before reconnecting.
    pub fn closed(&mut self) -> SessionEffect {
        self.stable_armed = false;
        SessionEffect::Reconnect(self.reconnect.on_close())
    }
}

/// A stability window the shell must arm. Returned by [`Adapter::opened`] — and
/// only there — so the window can never start before the socket actually opened.
/// The shim schedules [`Adapter::stable_elapsed`] for `generation` after `after`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StabilityTimer {
    pub generation: u32,
    pub after: Duration,
}

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

include!("retry_part2.rs");

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
/// - `on_message`: hand the frame to the view verbatim (framing-agnostic).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_attempt_is_base() {
        assert_eq!(backoff(0), Duration::from_millis(500));
    }

    #[test]
    fn grows_strictly_until_the_cap() {
        let steps: Vec<u64> = (0..=4).map(|n| backoff(n).as_millis() as u64).collect();
        assert_eq!(steps, vec![500, 1000, 2000, 4000, 8000]);
        for pair in steps.windows(2) {
            assert!(pair[1] > pair[0], "backoff must grow: {steps:?}");
        }
    }

    #[test]
    fn caps_after_the_growth_steps() {
        assert_eq!(backoff(4), Duration::from_millis(8000));
        assert_eq!(backoff(50), Duration::from_millis(8000));
    }

    fn flap(r: &mut Reconnect) -> u64 {
        r.on_open();
        r.on_close().as_millis() as u64
    }

    /// Finding: `open()` used to reset the counter, so a flapping server
    /// retried at one fixed delay. It must now grow across open/drop cycles.
    #[test]
    fn flapping_connection_grows_the_backoff() {
        let mut r = Reconnect::new();
        let delays: Vec<u64> = (0..5).map(|_| flap(&mut r)).collect();
        // The first retry is the declared base; each flapping drop doubles it
        // until the ceiling.
        assert_eq!(delays, vec![500, 1000, 2000, 4000, 8000]);
        for pair in delays.windows(2) {
            assert!(pair[1] >= pair[0], "backoff must not shrink: {delays:?}");
        }
    }

    /// A connection that survives the stability window is a real session: the
    /// counter resets, so the next disconnect retries at the base delay.
    #[test]
    fn stable_connection_resets_to_the_base_delay() {
        let mut r = Reconnect::new();
        assert_eq!(flap(&mut r), 500);
        assert_eq!(flap(&mut r), 1000);
        r.on_open();
        r.on_stable();
        assert_eq!(r.on_close().as_millis() as u64, 500);
        // And the growth starts over after the reset.
        assert_eq!(flap(&mut r), 1000);
    }

    struct Fake {
        open: bool,
        reject: bool,
    }

    impl Transport for Fake {
        fn is_open(&self) -> bool {
            self.open
        }
        fn send_text(&self, _text: &str) -> Result<(), ()> {
            if self.reject {
                Err(())
            } else {
                Ok(())
            }
        }
    }

    /// Finding: a send on a closed socket used to be a silent no-op.
    #[test]
    fn send_on_closed_socket_is_reported() {
        let t = Fake { open: false, reject: false };
        assert_eq!(deliver(&t, "x"), SendOutcome::NotConnected);
    }

    /// Finding: `send_with_str` errors used to be discarded.
    #[test]
    fn send_failure_is_reported_not_swallowed() {
        let t = Fake { open: true, reject: true };
        assert_eq!(deliver(&t, "x"), SendOutcome::SendFailed);
    }

    #[test]
    fn send_on_open_socket_succeeds() {
        let t = Fake { open: true, reject: false };
        assert_eq!(deliver(&t, "x"), SendOutcome::Sent);
    }

    // ── Session: the browser adapter's open/close/timer/retry lifecycle ──────

    fn reconnect_delay(effect: SessionEffect) -> u64 {
        match effect {
            SessionEffect::Reconnect(delay) => delay.as_millis() as u64,
            other => panic!("expected a reconnect delay, got {other:?}"),
        }
    }

    /// Finding: the stability timer used to be armed at dial time, so a
    /// handshake that pends past the window and *then* fails reset the retry
    /// counter despite never connecting. The window now opens on `opened`, so a
    /// delayed failed handshake — and even a stray timer firing mid-handshake —
    /// keeps the delay growing.
    #[test]
    fn delayed_failed_handshake_keeps_the_backoff_growing() {
        let mut s = Session::new();
        let mut delays = Vec::new();
        for _ in 0..3 {
            assert_eq!(s.dial_started(), SessionEffect::Connecting);
            // The pending handshake's window elapses, then it fails. No open
            // happened, so the timer is inert.
            s.stable_elapsed(s.generation());
            delays.push(reconnect_delay(s.closed()));
        }
        assert_eq!(delays, vec![500, 1000, 2000]);
    }

    /// A socket that opens and immediately drops is flapping, not a session:
    /// the delay must keep growing across open/drop cycles.
    #[test]
    fn open_immediate_drop_still_grows() {
        let mut s = Session::new();
        let mut delays = Vec::new();
        for _ in 0..3 {
            s.dial_started();
            assert_eq!(s.opened(), SessionEffect::Connected);
            // No stability event: the drop happened inside the window.
            delays.push(reconnect_delay(s.closed()));
        }
        assert_eq!(delays, vec![500, 1000, 2000]);
    }

    /// A connection that holds past the window is a real session: the next
    /// disconnect retries at the base delay.
    #[test]
    fn stable_open_then_drop_resets_to_base() {
        let mut s = Session::new();
        s.dial_started();
        assert_eq!(s.opened(), SessionEffect::Connected);
        s.stable_elapsed(s.generation());
        assert_eq!(reconnect_delay(s.closed()), 500);
    }

    // ── Wire: the callback plumbing `ws.rs` installs on the live socket ──────

    /// A fake socket the test fires by hand. [`wire`] registers the callbacks
    /// here, so firing them runs the *actual* wiring closures — not a lookalike.
    /// A regression that moves `opened()` out of `on_open`, forgets to arm the
    /// window, or never disarms on close fails these tests.
    #[derive(Default)]
    struct FakeSocket {
        open: RefCell<Option<Box<dyn FnMut()>>>,
        message: RefCell<Option<Box<dyn FnMut(String)>>>,
        close: RefCell<Option<Box<dyn FnMut()>>>,
    }

    impl Socket for FakeSocket {
        fn on_open<F: FnMut() + 'static>(&self, handler: F) {
            *self.open.borrow_mut() = Some(Box::new(handler));
        }
        fn on_message<F: FnMut(String) + 'static>(&self, handler: F) {
            *self.message.borrow_mut() = Some(Box::new(handler));
        }
        fn on_close<F: FnMut() + 'static>(&self, handler: F) {
            *self.close.borrow_mut() = Some(Box::new(handler));
        }
    }

    impl FakeSocket {
        fn fire_open(&self) {
            (self.open.borrow_mut().as_mut().expect("on_open registered"))();
        }
        fn fire_message(&self, text: &str) {
            (self.message.borrow_mut().as_mut().expect("on_message registered"))(text.to_string());
        }
        fn fire_close(&self) {
            (self.close.borrow_mut().as_mut().expect("on_close registered"))();
        }
    }

    /// Fake clock: records every stability window [`wire`] arms and fires them
    /// on demand, so "the window is armed from `on_open`" is an assertable fact
    /// without a browser event loop.
    #[derive(Clone, Default)]
    struct FakeTimer {
        windows: Rc<RefCell<Vec<(Duration, Box<dyn FnMut()>)>>>,
    }

    impl Timer for FakeTimer {
        fn after<F: FnMut() + 'static>(&self, delay: Duration, task: F) {
            self.windows.borrow_mut().push((delay, Box::new(task)));
        }
    }

    impl FakeTimer {
        fn count(&self) -> usize {
            self.windows.borrow().len()
        }
        fn delay(&self, index: usize) -> u64 {
            self.windows.borrow()[index].0.as_millis() as u64
        }
        fn fire(&self, index: usize) {
            let mut windows = self.windows.borrow_mut();
            (windows[index].1)();
        }
    }

    /// What the view would render (the sinks `wire` reports into).
    #[derive(Default)]
    struct View {
        status: RefCell<Vec<SessionEffect>>,
        echoed: RefCell<Vec<String>>,
        closed: RefCell<usize>,
    }

    /// Drives [`wire`] exactly as `ws.rs` does, but with a fireable fake socket
    /// and clock: the callbacks are the real ones, only the transport is faked.
    struct Harness {
        adapter: Rc<RefCell<Adapter>>,
        socket: FakeSocket,
        timer: FakeTimer,
        view: Rc<View>,
    }

    impl Harness {
        fn new() -> Self {
            let adapter = Rc::new(RefCell::new(Adapter::new()));
            let socket = FakeSocket::default();
            let timer = FakeTimer::default();
            let view = Rc::new(View::default());

            let status = view.clone();
            let echo = view.clone();
            let closed = view.clone();
            wire(
                &socket,
                timer.clone(),
                adapter.clone(),
                move |effect| status.status.borrow_mut().push(effect),
                move |text| echo.echoed.borrow_mut().push(text),
                move || *closed.closed.borrow_mut() += 1,
            );

            Self { adapter, socket, timer, view }
        }

        /// The dial step `ws.rs`'s loop performs before installing callbacks.
        /// `ws.rs`'s `connect` loop records the Connecting status itself — it is
        /// not wired through [`wire`], whose closures cover open/message/close
        /// only — so the harness mirrors that push here.
        fn dial(&mut self) {
            let (_, effect) = self.adapter.borrow_mut().dial_started();
            assert_eq!(effect, SessionEffect::Connecting);
            self.view.status.borrow_mut().push(effect);
        }

        /// The reconnect step `ws.rs`'s loop performs after the socket closes.
        fn reconnect_delay(&mut self) -> u64 {
            reconnect_delay(self.adapter.borrow_mut().closed())
        }

        fn last_status(&self) -> SessionEffect {
            *self.view.status.borrow().last().expect("no status recorded")
        }
    }

    /// The window is armed by the socket's `open` callback and not before; a
    /// connection that then holds past the window resets the next delay to base.
    #[test]
    fn wiring_arms_the_window_on_open_then_resets_after_stable() {
        let mut h = Harness::new();
        h.dial();
        assert_eq!(h.timer.count(), 0, "dial must not arm a stability window");
        assert_eq!(h.last_status(), SessionEffect::Connecting);

        h.socket.fire_open();
        assert_eq!(h.last_status(), SessionEffect::Connected);
        assert_eq!(h.timer.count(), 1, "on_open must arm the stability window");
        assert_eq!(h.timer.delay(0), STABLE_CONNECTION_MS);

        h.timer.fire(0); // the connection held past the window -> a real session
        h.socket.fire_close();
        assert_eq!(*h.view.closed.borrow(), 1, "on_close must signal the loop");
        assert_eq!(h.reconnect_delay(), 500, "a stable session resets the backoff");
    }

    /// A socket that opens and drops before the window elapses is flapping: the
    /// delay must keep growing, with 500 ms on the first retry.
    #[test]
    fn wiring_keeps_growing_across_flapping_drops() {
        let mut h = Harness::new();
        for (i, want) in [500u64, 1_000, 2_000, 4_000].into_iter().enumerate() {
            h.dial();
            h.socket.fire_open();
            assert_eq!(h.timer.count(), i + 1, "each open arms one window");
            h.socket.fire_close();
            assert_eq!(h.reconnect_delay(), want, "flapping drop #{i}");
        }
    }

    /// A handshake that never opens cannot arm a window, so its failure must keep
    /// the delay growing rather than reset it because wall-clock time passed.
    #[test]
    fn wiring_failed_handshake_keeps_growing() {
        let mut h = Harness::new();
        for want in [500u64, 1_000, 2_000] {
            h.dial();
            h.socket.fire_close(); // error/close without an open
            assert_eq!(h.reconnect_delay(), want);
        }
        assert_eq!(h.timer.count(), 0, "a failed handshake must not arm a window");
    }

    /// A window armed for a socket that already dropped must be inert when it
    /// fires late — it may not mark the *current* socket stable.
    #[test]
    fn wiring_stale_window_from_a_previous_socket_is_inert() {
        let mut h = Harness::new();
        h.dial();
        h.socket.fire_open(); // window #0
        h.socket.fire_close();
        assert_eq!(h.reconnect_delay(), 500);

        h.dial();
        h.socket.fire_open(); // window #1
        h.timer.fire(0); // socket #0's window arrives late
        h.socket.fire_close();
        assert_eq!(h.reconnect_delay(), 1_000, "a stale window reset the backoff");
    }

    /// The wiring forwards the server's frame verbatim — it parses nothing.
    #[test]
    fn wiring_forwards_echoed_frames_verbatim() {
        let mut h = Harness::new();
        h.dial();
        h.socket.fire_open();
        h.socket.fire_message(r#"{"n":1}"#);
        assert_eq!(*h.view.echoed.borrow(), vec![r#"{"n":1}"#.to_string()]);
    }

    /// Finding: a successful send used to leave a previous `SendFailed` status
    /// in place, so a delivered frame could still read as undelivered.
    #[test]
    fn successful_send_clears_a_previous_failure() {
        assert_eq!(send_status(SendOutcome::SendFailed), SessionEffect::SendFailed);
        assert_eq!(send_status(SendOutcome::Sent), SessionEffect::Connected);
        assert_eq!(send_status(SendOutcome::NotConnected), SessionEffect::SendFailed);
    }
}

// ponytail: no jitter and no attempt ceiling — one browser talking to a local
// sidecar. Add jitter if a fleet of clients ever backs off in lockstep.

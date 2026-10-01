//! Connection policy — pure, transport-free, and compiled for both targets so
//! the browser transport's retry timing and send decisions stay host-testable.
//!
//! `ws` is a thin shell over these decisions: [`Reconnect`] says *when* to
//! retry, [`deliver`] says *whether* a frame actually left the socket. Keeping
//! both here means the client lifecycle is assertable without a browser.

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

    /// The socket closed; returns the delay to wait before reconnecting.
    pub fn on_close(&mut self) -> Duration {
        if !self.stable {
            self.attempt = self.attempt.saturating_add(1);
        }
        self.stable = false;
        backoff(self.attempt)
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

/// Minimal socket surface the send policy needs. Implemented by the native
/// `web_sys::WebSocket` in `ws` and by a fake in tests.
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
        assert_eq!(delays, vec![1000, 2000, 4000, 8000, 8000]);
        for pair in delays.windows(2) {
            assert!(pair[1] >= pair[0], "backoff must not shrink: {delays:?}");
        }
    }

    /// A connection that survives the stability window is a real session: the
    /// counter resets, so the next disconnect retries at the base delay.
    #[test]
    fn stable_connection_resets_to_the_base_delay() {
        let mut r = Reconnect::new();
        assert_eq!(flap(&mut r), 1000);
        assert_eq!(flap(&mut r), 2000);
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
        assert_eq!(delays, vec![1000, 2000, 4000]);
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
        assert_eq!(delays, vec![1000, 2000, 4000]);
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

    /// The full event order the browser shell emits across a session — dial,
    /// open, drop, timer, retry — so the shell's wiring cannot drift from the
    /// policy these tests pin.
    #[test]
    fn adapter_lifecycle_sequence_matches_the_shell() {
        let mut s = Session::new();
        // Attempt 1: opens, drops inside the window — backoff grows.
        assert_eq!(s.dial_started(), SessionEffect::Connecting);
        assert_eq!(s.opened(), SessionEffect::Connected);
        s.transport_closed();
        assert_eq!(reconnect_delay(s.closed()), 1000);
        // Attempt 2: handshake pends past the window then fails — still grows.
        assert_eq!(s.dial_started(), SessionEffect::Connecting);
        s.stable_elapsed(s.generation());
        assert_eq!(reconnect_delay(s.closed()), 2000);
        // Attempt 3: holds past the window, then drops — resets to base.
        assert_eq!(s.dial_started(), SessionEffect::Connecting);
        assert_eq!(s.opened(), SessionEffect::Connected);
        s.stable_elapsed(s.generation());
        s.transport_closed();
        assert_eq!(reconnect_delay(s.closed()), 500);
    }

    /// A timer left behind by a previous socket must not mark the *current*
    /// socket stable when it later fires.
    #[test]
    fn stale_timer_from_a_previous_socket_is_ignored() {
        let mut s = Session::new();
        s.dial_started();
        let old = s.generation();
        assert_eq!(s.opened(), SessionEffect::Connected);
        s.transport_closed();
        assert_eq!(reconnect_delay(s.closed()), 1000);

        s.dial_started();
        assert_eq!(s.opened(), SessionEffect::Connected);
        s.stable_elapsed(old); // socket #1's timer arrives late
        assert_eq!(
            reconnect_delay(s.closed()),
            2000,
            "a stale timer reset the backoff"
        );
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

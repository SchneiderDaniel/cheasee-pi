//! Connection policy — pure, transport-free, and compiled for both targets so
//! the browser transport's retry timing and send decisions stay host-testable.
//!
//! `ws` is a thin shell over these decisions: [`Reconnect`] says *when* to
//! retry, [`deliver`] says *whether* a frame actually left the socket. Keeping
//! both here means the client lifecycle is assertable without a browser.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

mod wiring;

pub use wiring::{deliver, send_status, wire, Adapter, SendOutcome, Socket, Timer, Transport};

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

#[cfg(test)]
mod tests;

#[cfg(test)]
mod tests_wiring;

// ponytail: no jitter and no attempt ceiling — one browser talking to a local
// sidecar. Add jitter if a fleet of clients ever backs off in lockstep.

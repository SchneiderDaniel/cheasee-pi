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
}

// ponytail: no jitter and no attempt ceiling — one browser talking to a local
// sidecar. Add jitter if a fleet of clients ever backs off in lockstep.

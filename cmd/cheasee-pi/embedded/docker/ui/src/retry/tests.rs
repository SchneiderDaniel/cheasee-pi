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

pub(super) fn reconnect_delay(effect: SessionEffect) -> u64 {
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


/// Finding: a successful send used to leave a previous `SendFailed` status
/// in place, so a delivered frame could still read as undelivered.
#[test]
fn successful_send_clears_a_previous_failure() {
    assert_eq!(send_status(SendOutcome::SendFailed), SessionEffect::SendFailed);
    assert_eq!(send_status(SendOutcome::Sent), SessionEffect::Connected);
    assert_eq!(send_status(SendOutcome::NotConnected), SessionEffect::SendFailed);
}

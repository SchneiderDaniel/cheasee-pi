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

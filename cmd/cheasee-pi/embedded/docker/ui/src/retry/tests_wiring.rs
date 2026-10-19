use super::*;
use super::tests::reconnect_delay;

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

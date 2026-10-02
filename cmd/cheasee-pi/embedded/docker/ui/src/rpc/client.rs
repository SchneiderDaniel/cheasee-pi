//! RPC client over the pi child's pipes: id correlation, dispatch, lifecycle.
//!
//! Owns three things and nothing else:
//!
//! * **Correlation.** Every command we send gets a monotonic `req_{n}` id
//!   (`docs/rpc.md`: "Command handling is asynchronous, so clients should
//!   correlate by ID rather than response order"). A pending map keyed on that
//!   id is what makes out-of-order responses resolve the right caller.
//! * **Dispatch.** A record is a response only when it is
//!   `{"type":"response"}` *and* its `id` names a pending command. Everything
//!   else is fanned out to [`RpcClient::events`]. That single rule is what
//!   keeps `bash_execution_update` — which repeats the originating `bash`
//!   command's id — from being consumed as that command's response.
//! * **Lifecycle.** stdout EOF, a framing fault, and a stdin write failure all
//!   reject every pending request instead of leaving a caller hanging, so a
//!   killed child surfaces as an error (AC5) rather than a freeze.
//!
//! stdout is read here and only here: [`crate::pi_process::PiChild::take_io`]
//! hands the pipes over exactly once. Diagnostics stay on the child's stderr,
//! which `pi_process` drains and this module never reads (AC4).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, oneshot, Mutex as AsyncMutex};

use crate::pi_process::ChildIo;
use crate::protocol::{Command, Event, ExtensionUI, Response};
use crate::rpc::framing::{encode_record, FramingError, JsonlReader};

/// Fan-out depth for [`RpcClient::events`]. A UI that falls further behind
/// than this drops the oldest events and is told so by the channel; it never
/// blocks the reader task.
pub const EVENT_CHANNEL_CAPACITY: usize = 1024;

/// Why an RPC operation failed.
#[derive(Debug)]
pub enum RpcError {
    /// The child was reaped and reported an exit status.
    ChildExited {
        code: Option<i32>,
        signal: Option<i32>,
    },
    /// The child's pipes are gone: stdout hit EOF, or stdin could not be
    /// written. Pending requests are rejected with this rather than hanging.
    ChildGone,
    /// A record-level framing fault (see [`FramingError`]).
    Frame(FramingError),
    /// The record was valid UTF-8 but not a valid record of its family.
    Protocol {
        raw: String,
        source: serde_json::Error,
    },
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ChildExited { code, signal } => {
                write!(f, "pi child exited (code {code:?}, signal {signal:?})")
            }
            Self::ChildGone => write!(f, "pi child pipes are closed"),
            Self::Frame(err) => write!(f, "{err}"),
            Self::Protocol { raw, source } => {
                write!(f, "invalid RPC record: {source} (raw: {raw})")
            }
        }
    }
}

impl std::error::Error for RpcError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Frame(err) => Some(err),
            Self::Protocol { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// One decoded stdout record, for consumers that are not the id map.
#[derive(Debug, Clone)]
pub enum ProtocolMessage {
    /// A session event (including `Event::Unknown` for unmodelled types).
    Session(Event),
    /// An extension UI request or response.
    ExtensionUi(ExtensionUI),
    /// Valid JSON that belongs to no family this build knows, or a response
    /// that matched no pending id. Kept raw so a later slice can log it.
    Unknown(Value),
    /// A transport-level framing fault on stdout — invalid UTF-8, an overlong
    /// record, or a stream that ended mid-record. Deliberately distinct from
    /// [`ProtocolMessage::ParseError`], which means the bytes *were* valid
    /// UTF-8 and simply not valid JSON (AC5's two error classes).
    Frame(FramingError),
    /// A record that could not be parsed, plus the `command:"parse"` failure
    /// pi emits for malformed input. Never routed through the id map: that
    /// record has no request id by design (`docs/rpc.md`).
    ParseError { raw: String, error: String },
}

type PendingSender = oneshot::Sender<Result<Response, RpcError>>;

/// Pending-request bookkeeping, mutated only under one lock so that "may I
/// register a request?" and "has the reader exited?" cannot race.
#[derive(Default)]
struct PendingState {
    map: HashMap<String, PendingSender>,
    /// Set by the stdout reader on exit and by [`RpcClient::shutdown`]. Once
    /// true, no new request may be registered: it would be written to a stdin
    /// nobody answers and wait forever.
    terminated: bool,
}

type Pending = Mutex<PendingState>;

/// State shared with the stdout reader task.
struct Shared {
    pending: Arc<Pending>,
    events: broadcast::Sender<ProtocolMessage>,
}

/// The id-correlating RPC client. Cheap to clone behind an `Arc`; holds the
/// only writer to the child's stdin.
pub struct RpcClient {
    stdin: AsyncMutex<Option<Box<dyn AsyncWrite + Send + Unpin>>>,
    pending: Arc<Pending>,
    events: broadcast::Sender<ProtocolMessage>,
    next_id: AtomicU64,
}

impl RpcClient {
    /// Take the child's pipes. `stdout` is read on a spawned task for the
    /// client's lifetime, so it must not be read anywhere else.
    pub fn new(
        stdout: Box<dyn AsyncRead + Send + Unpin>,
        stdin: Box<dyn AsyncWrite + Send + Unpin>,
    ) -> Self {
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let pending: Arc<Pending> = Arc::new(Mutex::new(PendingState::default()));
        let shared = Shared {
            pending: Arc::clone(&pending),
            events: events.clone(),
        };
        tokio::spawn(read_loop(JsonlReader::new(BufReader::new(stdout)), shared));

        Self {
            stdin: AsyncMutex::new(Some(stdin)),
            pending,
            events,
            next_id: AtomicU64::new(0),
        }
    }

    /// Build the client from a spawned child's pipes (slice 3's handoff).
    pub fn from_child_io(io: ChildIo) -> Self {
        Self::new(Box::new(io.stdout), Box::new(io.stdin))
    }

    /// Every stdout record that is not a correlated response.
    pub fn events(&self) -> broadcast::Receiver<ProtocolMessage> {
        self.events.subscribe()
    }

    /// Send a command and await its response. The command's own `id` is
    /// overwritten with the generated one, so correlation cannot be lost by a
    /// caller that forgets to stamp an id.
    pub async fn request(&self, command: &Command) -> Result<Response, RpcError> {
        let id = format!("req_{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let mut value = serde_json::to_value(command).map_err(|source| RpcError::Protocol {
            raw: String::new(),
            source,
        })?;
        if let Value::Object(map) = &mut value {
            map.insert("id".to_string(), Value::String(id.clone()));
        }

        // Register under the same lock the reader takes when it terminates, so
        // a request can never be registered after the reader has exited. The
        // response can arrive before `write_all` returns, hence register first.
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.lock_pending();
            if state.terminated {
                return Err(RpcError::ChildGone);
            }
            state.map.insert(id.clone(), tx);
        }

        if let Err(err) = self.write_value(&value).await {
            self.lock_pending().map.remove(&id);
            self.reject_all_pending();
            return Err(err);
        }

        match rx.await {
            Ok(result) => result,
            // The reader task dropped the sender: it already surfaced the exit
            // by rejecting everything still pending.
            Err(_) => Err(RpcError::ChildGone),
        }
    }

    /// Write a record with no response expected (extension UI responses,
    /// fire-and-forget commands).
    pub async fn send<T: Serialize>(&self, value: &T) -> Result<(), RpcError> {
        let value = serde_json::to_value(value).map_err(|source| RpcError::Protocol {
            raw: String::new(),
            source,
        })?;
        let result = self.write_value(&value).await;
        if result.is_err() {
            self.reject_all_pending();
        }
        result
    }

    /// Close the child's stdin, which is how pi is asked for an orderly
    /// shutdown ("Pi disposes the active runtime before exiting"). Idempotent;
    /// later requests fail with [`RpcError::ChildGone`] instead of hanging.
    pub async fn shutdown(&self) {
        // Mark terminal and reject in-flight requests under the one lock the
        // reader also uses, so a request racing shutdown cannot slip in after.
        self.reject_all_pending();
        self.stdin.lock().await.take();
    }

    async fn write_value(&self, value: &Value) -> Result<(), RpcError> {
        if self.lock_pending().terminated {
            return Err(RpcError::ChildGone);
        }
        let bytes = encode_record(value).map_err(|source| RpcError::Protocol {
            raw: String::new(),
            source,
        })?;
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return Err(RpcError::ChildGone);
        };
        // A write to a dead child is EPIPE, which is the exit signal — not a
        // retryable transport hiccup.
        stdin
            .write_all(&bytes)
            .await
            .map_err(|_| RpcError::ChildGone)?;
        stdin.flush().await.map_err(|_| RpcError::ChildGone)
    }

    fn lock_pending(&self) -> std::sync::MutexGuard<'_, PendingState> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reject everything still in flight. The caller is told the child is
    /// gone, never left waiting.
    fn reject_all_pending(&self) {
        reject_all(&self.pending);
    }
}

/// Mark the client terminal and reject everything in flight. The caller is
/// told the child is gone, never left waiting; a later `request` fails fast
/// instead of registering into a dead map.
fn reject_all(pending: &Pending) {
    let mut state = pending.lock().unwrap_or_else(|e| e.into_inner());
    state.terminated = true;
    for (_, tx) in state.map.drain() {
        let _ = tx.send(Err(RpcError::ChildGone));
    }
}

fn emit(shared: &Shared, message: ProtocolMessage) {
    // No subscriber, or one that fell behind, is not a protocol fault: the
    // reader task must never die because the UI is slow or absent.
    let _ = shared.events.send(message);
}

async fn read_loop<R>(mut reader: JsonlReader<R>, shared: Shared)
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    loop {
        match reader.next_record().await {
            Ok(Some(bytes)) => match String::from_utf8(bytes) {
                Ok(raw) => dispatch(&shared, &raw),
                // A transport encoding fault, not a JSON one. It must not be
                // reported as a parse failure (AC5 taxonomy).
                Err(_) => emit(&shared, ProtocolMessage::Frame(FramingError::NotUtf8)),
            },
            // Clean EOF: the child is gone.
            Ok(None) => break,
            Err(err) => {
                // A framing fault (mid-record kill, overlong record, stdout
                // read failure) is surfaced as a transport error before the
                // pending requests are rejected below.
                emit(&shared, ProtocolMessage::Frame(err));
                break;
            }
        }
    }
    reject_all(&shared.pending);
}

/// Classify one record by its minimal envelope (`type`, `id`, `command`) before
/// any typed decode. One extra parse per record buys correlation and no-death
/// semantics that hold regardless of how much of the enum surface this build
/// models.
fn dispatch(shared: &Shared, raw: &str) {
    let value: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(err) => {
            emit(
                shared,
                ProtocolMessage::ParseError {
                    raw: raw.to_string(),
                    error: err.to_string(),
                },
            );
            return;
        }
    };

    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();

    if kind == "response" {
        // pi emits this arm for malformed input, without a request id.
        if value.get("command").and_then(Value::as_str) == Some("parse") {
            emit(
                shared,
                ProtocolMessage::ParseError {
                    raw: raw.to_string(),
                    error: value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("pi could not parse the command")
                        .to_string(),
                },
            );
            return;
        }

        let id = value.get("id").and_then(Value::as_str).map(str::to_string);
        if let Some(id) = id {
            // Take the entry out before resolving: an id must never outlive
            // its resolution, and a duplicate response must not resolve twice.
            let sender = shared
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .map
                .remove(&id);
            if let Some(tx) = sender {
                let decoded = serde_json::from_value::<Response>(value).map_err(|source| {
                    RpcError::Protocol {
                        raw: raw.to_string(),
                        source,
                    }
                });
                let _ = tx.send(decoded);
                return;
            }
        }
        // No id, or an id nobody is waiting on: fan it out, resolve nothing.
        emit(shared, ProtocolMessage::Unknown(value));
        return;
    }

    if kind == "extension_ui_request" || kind == "extension_ui_response" {
        match serde_json::from_value::<ExtensionUI>(value.clone()) {
            Ok(ui) => emit(shared, ProtocolMessage::ExtensionUi(ui)),
            Err(_) => emit(shared, ProtocolMessage::Unknown(value)),
        }
        return;
    }

    match serde_json::from_value::<Event>(value.clone()) {
        Ok(Event::Unknown) => emit(shared, ProtocolMessage::Unknown(value)),
        Ok(event) => emit(shared, ProtocolMessage::Session(event)),
        // A known type whose payload this build cannot decode is still not a
        // reason to kill the stream.
        Err(_) => emit(shared, ProtocolMessage::Unknown(value)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
    use tokio::time::timeout;

    use crate::auth::ChildEnv;
    use crate::pi_process::{spawn, PiChild, PiSpec};
    use crate::protocol::ExtensionUiResponse;

    /// A hang is a failure, not a stall: every await in these tests is bounded.
    const BOUND: Duration = Duration::from_secs(2);

    type Frames = JsonlReader<BufReader<DuplexStream>>;

    /// Fake child: `to_child` is its stdout, `from_child` is its stdin.
    fn harness() -> (RpcClient, DuplexStream, DuplexStream) {
        let (stdout_tx, stdout_rx) = tokio::io::duplex(1 << 20);
        let (stdin_tx, stdin_rx) = tokio::io::duplex(1 << 20);
        let client = RpcClient::new(Box::new(stdout_rx), Box::new(stdin_tx));
        (client, stdout_tx, stdin_rx)
    }

    fn frames(from_child: DuplexStream) -> Frames {
        JsonlReader::new(BufReader::new(from_child))
    }

    async fn write_record(to_child: &mut DuplexStream, value: Value) {
        to_child
            .write_all(&encode_record(&value).unwrap())
            .await
            .unwrap();
        to_child.flush().await.unwrap();
    }

    async fn read_frame(frames: &mut Frames) -> Value {
        let raw = frames
            .next_record_str()
            .await
            .expect("frame read")
            .expect("frame present");
        serde_json::from_str(&raw).expect("frame is JSON")
    }

    async fn next_frame(frames: &mut Frames) -> Value {
        timeout(BOUND, read_frame(frames))
            .await
            .expect("the client must emit a frame within 2s")
    }

    async fn next_event(events: &mut broadcast::Receiver<ProtocolMessage>) -> ProtocolMessage {
        timeout(BOUND, events.recv())
            .await
            .expect("an event must arrive within 2s")
            .expect("event channel open")
    }

    /// Nothing more must arrive: used to prove a record was *not* fanned out.
    async fn assert_quiet(events: &mut broadcast::Receiver<ProtocolMessage>) {
        assert!(
            timeout(Duration::from_millis(150), events.recv()).await.is_err(),
            "an unexpected event was fanned out"
        );
    }

    fn unique_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::AtomicUsize;
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cheasee-pi-rpc-test-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Spawn a `/bin/sh` shim as the `pi` stand-in and hand its pipes to a
    /// client. No real `pi` binary is needed.
    async fn spawn_shim(tag: &str, body: &str) -> (PiChild, RpcClient) {
        let dir = unique_dir(tag);
        let path = dir.join("shim.sh");
        std::fs::write(&path, body).unwrap();
        let spec = PiSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec![path.to_string_lossy().into_owned()],
        };
        let mut child = spawn(&spec, &ChildEnv::none(), "sess-rpc").expect("shim spawn");
        let io = child.take_io().expect("shim pipes");
        (child, RpcClient::from_child_io(io))
    }

    async fn wait_for_stderr(child: &PiChild, needle: &str) -> bool {
        let deadline = tokio::time::Instant::now() + BOUND;
        while tokio::time::Instant::now() < deadline {
            if child.stderr_snapshot().lossy().contains(needle) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    fn abort_cmd() -> Command {
        Command::Abort { id: None }
    }

    // ── Phase 3: correlation and dispatch (AC2, AC5) ───────────────────────

    #[tokio::test]
    async fn request_assigns_strictly_monotonic_ids() {
        let (client, mut to_child, from_child) = harness();
        let client = Arc::new(client);
        let mut frames = frames(from_child);

        for (expected, command, wire) in [
            ("req_1", abort_cmd(), "abort"),
            ("req_2", Command::GetState { id: None }, "get_state"),
        ] {
            let c = Arc::clone(&client);
            let pending = tokio::spawn(async move { c.request(&command).await });
            let frame = next_frame(&mut frames).await;
            assert_eq!(frame["id"], expected, "frame = {frame}");
            assert_eq!(frame["type"], wire);
            write_record(
                &mut to_child,
                json!({"type":"response","command":wire,"success":true,"id":expected}),
            )
            .await;
            assert!(pending.await.unwrap().is_ok());
        }
    }

    /// AC2: "Command handling is asynchronous, so clients should correlate by
    /// ID rather than response order."
    #[tokio::test]
    async fn out_of_order_responses_resolve_the_right_callers() {
        let (client, mut to_child, from_child) = harness();
        let client = Arc::new(client);
        let mut frames = frames(from_child);

        let (c1, c2) = (Arc::clone(&client), Arc::clone(&client));
        let both = tokio::spawn(async move {
            tokio::join!(
                async move { c1.request(&abort_cmd()).await },
                async move { c2.request(&Command::GetState { id: None }).await },
            )
        });

        let first = next_frame(&mut frames).await;
        let second = next_frame(&mut frames).await;
        assert_eq!(first["id"], "req_1");
        assert_eq!(second["id"], "req_2");

        // Answer the second command first.
        write_record(
            &mut to_child,
            json!({"type":"response","command":"get_state","success":true,"id":"req_2","data":{"sessionId":"s-1"}}),
        )
        .await;
        write_record(
            &mut to_child,
            json!({"type":"response","command":"abort","success":true,"id":"req_1"}),
        )
        .await;

        let (abort, state) = both.await.unwrap();
        assert!(matches!(abort.unwrap(), Response::Abort(_)));
        let state = state.unwrap();
        assert!(matches!(state, Response::GetState(_)));
        assert_eq!(
            state.body().unwrap().data.as_ref().unwrap()["sessionId"],
            "s-1"
        );
    }

    /// An id nobody is waiting on is not a response to anything: fan it out,
    /// resolve nothing, and leave no entry behind.
    #[tokio::test]
    async fn response_with_unknown_id_falls_through_without_resolving() {
        let (client, mut to_child, _from_child) = harness();
        let mut events = client.events();

        write_record(
            &mut to_child,
            json!({"type":"response","command":"abort","success":true,"id":"nope"}),
        )
        .await;
        match next_event(&mut events).await {
            ProtocolMessage::Unknown(value) => assert_eq!(value["id"], "nope"),
            other => panic!("expected Unknown fallthrough, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn id_less_response_falls_through_without_resolving() {
        let (client, mut to_child, _from_child) = harness();
        let mut events = client.events();

        write_record(
            &mut to_child,
            json!({"type":"response","command":"abort","success":true}),
        )
        .await;
        assert!(matches!(
            next_event(&mut events).await,
            ProtocolMessage::Unknown(_)
        ));
    }

    /// AC5: malformed input produces a response without a request id, so it
    /// cannot travel through the id map.
    #[tokio::test]
    async fn parse_failure_response_routes_to_the_parse_sink() {
        let (client, mut to_child, _from_child) = harness();
        let mut events = client.events();

        write_record(
            &mut to_child,
            json!({"type":"response","command":"parse","success":false,"error":"Failed to parse command: Unexpected token"}),
        )
        .await;
        match next_event(&mut events).await {
            ProtocolMessage::ParseError { error, .. } => {
                assert!(error.contains("Unexpected token"), "error = {error}")
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    /// AC5: a bad line is surfaced and the reader keeps going.
    #[tokio::test]
    async fn malformed_json_is_surfaced_and_the_stream_continues() {
        let (client, mut to_child, _from_child) = harness();
        let mut events = client.events();

        to_child.write_all(b"{not json\n").await.unwrap();
        to_child.flush().await.unwrap();
        match next_event(&mut events).await {
            ProtocolMessage::ParseError { raw, .. } => assert_eq!(raw, "{not json"),
            other => panic!("expected ParseError, got {other:?}"),
        }

        write_record(&mut to_child, json!({"type":"agent_start"})).await;
        assert!(matches!(
            next_event(&mut events).await,
            ProtocolMessage::Session(Event::AgentStart)
        ));
    }

    #[tokio::test]
    async fn unknown_event_type_is_forwarded_not_fatal() {
        let (client, mut to_child, _from_child) = harness();
        let mut events = client.events();

        // `agent_settled` is documented nowhere in the pinned pi release.
        write_record(&mut to_child, json!({"type":"agent_settled"})).await;
        match next_event(&mut events).await {
            ProtocolMessage::Unknown(value) => assert_eq!(value["type"], "agent_settled"),
            other => panic!("expected Unknown, got {other:?}"),
        }

        write_record(&mut to_child, json!({"type":"agent_start"})).await;
        assert!(matches!(
            next_event(&mut events).await,
            ProtocolMessage::Session(Event::AgentStart)
        ));
    }

    /// AC2 hazard: `bash_execution_update` repeats the originating `bash`
    /// command's id, and must not be consumed as that command's response.
    #[tokio::test]
    async fn bash_execution_update_repeating_a_pending_id_is_not_a_response() {
        let (client, mut to_child, from_child) = harness();
        let client = Arc::new(client);
        let mut frames = frames(from_child);
        let mut events = client.events();

        let c = Arc::clone(&client);
        let pending = tokio::spawn(async move {
            c.request(&Command::Bash {
                id: None,
                command: "ls".into(),
                exclude_from_context: None,
            })
            .await
        });
        let frame = next_frame(&mut frames).await;
        let id = frame["id"].as_str().unwrap().to_string();

        write_record(
            &mut to_child,
            json!({"type":"bash_execution_update","id":id,"output":"partial"}),
        )
        .await;
        match next_event(&mut events).await {
            ProtocolMessage::Session(Event::BashExecutionUpdate { id: Some(got), .. }) => {
                assert_eq!(got, id)
            }
            other => panic!("expected a BashExecutionUpdate event, got {other:?}"),
        }
        assert!(
            !pending.is_finished(),
            "the session event resolved the pending bash command"
        );

        write_record(
            &mut to_child,
            json!({"type":"response","command":"bash","success":true,"id":id}),
        )
        .await;
        assert!(matches!(pending.await.unwrap().unwrap(), Response::Bash(_)));
    }

    /// The id map must be empty after a resolution: a duplicate response with
    /// the same id has nothing left to consume.
    #[tokio::test]
    async fn a_resolved_id_never_outlives_its_resolution() {
        let (client, mut to_child, from_child) = harness();
        let client = Arc::new(client);
        let mut frames = frames(from_child);
        let mut events = client.events();

        let c = Arc::clone(&client);
        let pending = tokio::spawn(async move { c.request(&abort_cmd()).await });
        next_frame(&mut frames).await;
        write_record(
            &mut to_child,
            json!({"type":"response","command":"abort","success":true,"id":"req_1"}),
        )
        .await;
        assert!(pending.await.unwrap().is_ok());

        write_record(
            &mut to_child,
            json!({"type":"response","command":"abort","success":true,"id":"req_1"}),
        )
        .await;
        assert!(matches!(
            next_event(&mut events).await,
            ProtocolMessage::Unknown(_)
        ));
    }

    /// A caller that goes away must not panic the resolver.
    #[tokio::test]
    async fn a_dropped_caller_does_not_break_the_reader() {
        let (client, mut to_child, from_child) = harness();
        let client = Arc::new(client);
        let mut frames = frames(from_child);
        let mut events = client.events();

        let c = Arc::clone(&client);
        let pending = tokio::spawn(async move { c.request(&abort_cmd()).await });
        next_frame(&mut frames).await;
        pending.abort();
        let _ = pending.await;

        write_record(
            &mut to_child,
            json!({"type":"response","command":"abort","success":true,"id":"req_1"}),
        )
        .await;
        // The reader survives the failed send and keeps dispatching.
        write_record(&mut to_child, json!({"type":"agent_start"})).await;
        assert!(matches!(
            next_event(&mut events).await,
            ProtocolMessage::Session(Event::AgentStart)
        ));
    }

    /// Extension UI is a sub-protocol: pi's uuid is echoed, never correlated
    /// through the command id map.
    #[tokio::test]
    async fn extension_ui_request_is_answered_with_the_pi_uuid() {
        let (client, mut to_child, from_child) = harness();
        let mut frames = frames(from_child);
        let mut events = client.events();

        write_record(
            &mut to_child,
            json!({"type":"extension_ui_request","id":"uuid-1","method":"select","title":"Allow?","options":["Allow","Block"],"timeout":10000}),
        )
        .await;
        match next_event(&mut events).await {
            ProtocolMessage::ExtensionUi(ExtensionUI::ExtensionUiRequest(req)) => {
                assert_eq!(req.id, "uuid-1");
                assert_eq!(req.method, "select");
                assert_eq!(req.params["options"][1], "Block");
            }
            other => panic!("expected an extension UI request, got {other:?}"),
        }

        client
            .send(&ExtensionUI::ExtensionUiResponse(ExtensionUiResponse {
                id: "uuid-1".into(),
                value: Some("Allow".into()),
                confirmed: None,
                cancelled: None,
            }))
            .await
            .unwrap();

        let frame = next_frame(&mut frames).await;
        assert_eq!(frame["type"], "extension_ui_response");
        assert_eq!(frame["id"], "uuid-1");
        assert_eq!(frame["value"], "Allow");
    }

    // ── Phase 4: lifecycle, exit, separation (AC4, AC5) ────────────────────

    #[tokio::test]
    async fn stdout_eof_rejects_pending_requests() {
        let (client, to_child, from_child) = harness();
        let client = Arc::new(client);
        let mut frames = frames(from_child);

        let c = Arc::clone(&client);
        let pending = tokio::spawn(async move { c.request(&abort_cmd()).await });
        next_frame(&mut frames).await;

        // Child stdout closes: this is the exit signal the client watches.
        drop(to_child);

        let err = timeout(BOUND, pending)
            .await
            .expect("a rejected request must not hang")
            .unwrap()
            .unwrap_err();
        assert!(matches!(err, RpcError::ChildGone), "got {err:?}");
    }

    /// Audit fix: once stdout hits EOF the client is terminal. A later request
    /// must fail fast, not be written to a stdin nobody answers and hang — the
    /// child's stdin stays open here precisely to exercise that.
    #[tokio::test]
    async fn request_after_stdout_eof_fails_fast_instead_of_hanging() {
        let (client, to_child, child_stdin) = harness();
        drop(to_child); // stdout EOF
        let _child_stdin = child_stdin; // keep stdin writable

        let err = timeout(BOUND, client.request(&abort_cmd()))
            .await
            .expect("a request after stdout EOF must not hang")
            .unwrap_err();
        assert!(matches!(err, RpcError::ChildGone), "got {err:?}");
    }

    /// Audit fix: invalid UTF-8 is a transport framing fault, not a JSON parse
    /// error. It surfaces as `Frame`, and it is not fatal: the reader
    /// continues to the next record.
    #[tokio::test]
    async fn non_utf8_record_is_surfaced_as_a_framing_fault() {
        let (client, mut to_child, _from_child) = harness();
        let mut events = client.events();

        to_child.write_all(b"\xff\xfe\n").await.unwrap();
        to_child.flush().await.unwrap();
        match next_event(&mut events).await {
            ProtocolMessage::Frame(FramingError::NotUtf8) => {}
            other => panic!("expected Frame(NotUtf8), got {other:?}"),
        }

        // Not fatal: the next well-formed record is still delivered.
        write_record(&mut to_child, json!({"type":"agent_start"})).await;
        assert!(matches!(
            next_event(&mut events).await,
            ProtocolMessage::Session(Event::AgentStart)
        ));
    }

    #[tokio::test]
    async fn stdin_write_failure_rejects_pending_requests() {
        let (client, _to_child, from_child) = harness();
        let client = Arc::new(client);
        let mut frames = frames(from_child);

        let c = Arc::clone(&client);
        let pending = tokio::spawn(async move { c.request(&abort_cmd()).await });
        next_frame(&mut frames).await;

        // Drop the reading half of the client's stdin: the next write EPIPEs.
        drop(frames.into_inner());

        let err = timeout(BOUND, client.request(&abort_cmd()))
            .await
            .expect("a failed write must not hang")
            .unwrap_err();
        assert!(matches!(err, RpcError::ChildGone), "got {err:?}");

        // The failed write also rejected the request already in flight,
        // instead of leaving it pending forever.
        let err = timeout(BOUND, pending)
            .await
            .expect("a rejected pending request must not hang")
            .unwrap()
            .unwrap_err();
        assert!(matches!(err, RpcError::ChildGone), "got {err:?}");
    }

    #[tokio::test]
    async fn shutdown_closes_stdin_and_later_requests_error() {
        let (client, to_child, mut from_child) = harness();

        client.shutdown().await;
        let err = timeout(BOUND, client.request(&abort_cmd()))
            .await
            .expect("a request after shutdown must not hang")
            .unwrap_err();
        assert!(matches!(err, RpcError::ChildGone), "got {err:?}");

        // Stdin is closed: the reading half sees EOF, not a record.
        let mut raw = Vec::new();
        from_child.read_to_end(&mut raw).await.unwrap();
        assert!(raw.is_empty(), "shutdown must not write a record: {raw:?}");
        drop(to_child);
    }

    /// AC4: stdout carries protocol records only. The shim writes one record to
    /// stdout and one diagnostic to stderr; the client must see only the
    /// former, and `pi_process` must have retained the latter.
    #[tokio::test]
    async fn shim_stdout_is_protocol_only_and_stderr_is_diagnostics() {
        let (mut child, client) = spawn_shim(
            "ac4",
            "#!/bin/sh\n\
             printf '{\"type\":\"agent_start\"}\\n'\n\
             printf 'DIAG-MARKER\\n' 1>&2\n\
             cat\n",
        )
        .await;
        let mut events = client.events();

        assert!(matches!(
            next_event(&mut events).await,
            ProtocolMessage::Session(Event::AgentStart)
        ));
        assert!(
            wait_for_stderr(&child, "DIAG-MARKER").await,
            "stderr was not drained: {:?}",
            child.stderr_snapshot()
        );
        assert_quiet(&mut events).await;

        child.kill();
        let _ = child.wait().await;
    }

    /// AC5: a bad line does not kill the process or the reader.
    #[tokio::test]
    async fn shim_malformed_line_then_valid_line_keeps_the_stream_alive() {
        let (mut child, client) = spawn_shim(
            "malformed",
            "#!/bin/sh\n\
             printf 'oops\\n'\n\
             printf '{\"type\":\"agent_start\"}\\n'\n\
             cat\n",
        )
        .await;
        let mut events = client.events();

        assert!(matches!(
            next_event(&mut events).await,
            ProtocolMessage::ParseError { .. }
        ));
        assert!(matches!(
            next_event(&mut events).await,
            ProtocolMessage::Session(Event::AgentStart)
        ));

        child.kill();
        let _ = child.wait().await;
    }

    /// The operator journey from the issue: kill the child mid-record and the
    /// UI reports a child-exit error instead of freezing.
    #[tokio::test]
    async fn killed_child_rejects_pending_requests_instead_of_freezing() {
        let (mut child, client) = spawn_shim(
            "killed",
            "#!/bin/sh\n\
             printf '{\"type\":\"agent_st'\n\
             sleep 30\n",
        )
        .await;
        let client = Arc::new(client);
        let mut events = client.events();

        let c = Arc::clone(&client);
        let pending = tokio::spawn(async move { c.request(&abort_cmd()).await });

        // Let the request reach the (never reading) shim's pipe.
        tokio::time::sleep(Duration::from_millis(100)).await;
        child.kill();

        let err = timeout(BOUND, pending)
            .await
            .expect("a killed child must not hang a pending request")
            .unwrap()
            .unwrap_err();
        assert!(matches!(err, RpcError::ChildGone), "got {err:?}");

        // The unterminated tail is surfaced as a transport framing fault,
        // never delivered as a record.
        match next_event(&mut events).await {
            ProtocolMessage::Frame(FramingError::UnterminatedTail { .. }) => {}
            other => panic!("expected a surfaced framing fault, got {other:?}"),
        }

        let _ = child.wait().await;
    }

    #[tokio::test]
    async fn spawn_failure_surfaces_an_io_error() {
        let spec = PiSpec {
            program: PathBuf::from("/nonexistent/pi-binary"),
            args: vec![],
        };
        let err = spawn(&spec, &ChildEnv::none(), "sess-missing")
            .err()
            .expect("spawning a nonexistent program must fail");
        assert!(
            !err.to_string().is_empty(),
            "a failed spawn must carry a message"
        );
    }
}

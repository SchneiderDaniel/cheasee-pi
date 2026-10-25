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
    /// A caller-supplied request id is already in flight. Registering a second
    /// sender under it would overwrite (and strand) the first, so it fails fast.
    IdInUse { id: String },
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
            Self::IdInUse { id } => write!(f, "request id {id:?} is already in flight"),
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
        self.request_with_id(&id, command).await
    }

    /// Send a command under a caller-supplied id and await its response.
    ///
    /// Used when the id is itself a correlation key the caller already holds:
    /// `bash_execution_update` events repeat the originating `bash` command's
    /// id, so that id must go on the wire verbatim rather than being replaced
    /// by a minted `req_N`. A duplicate in-flight id is rejected with
    /// [`RpcError::IdInUse`] instead of silently overwriting the first sender.
    pub async fn request_with_id(
        &self,
        id: &str,
        command: &Command,
    ) -> Result<Response, RpcError> {
        let mut value = serde_json::to_value(command).map_err(|source| RpcError::Protocol {
            raw: String::new(),
            source,
        })?;
        if let Value::Object(map) = &mut value {
            map.insert("id".to_string(), Value::String(id.to_string()));
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
            if state.map.contains_key(id) {
                return Err(RpcError::IdInUse { id: id.to_string() });
            }
            state.map.insert(id.to_string(), tx);
        }

        if let Err(err) = self.write_value(&value).await {
            self.lock_pending().map.remove(id);
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

mod replay;

pub use replay::RpcReplaySource;

#[cfg(test)]
mod tests;

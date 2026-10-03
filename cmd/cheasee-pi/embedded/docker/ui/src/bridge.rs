//! Browser <-> server envelope.
//!
//! The WS upgrade is no longer a verbatim echo: the browser sends
//! [`ClientMessage`] commands and the server relays pi records back as
//! [`ServerMessage`] values. Both live here, compiled for both targets, so the
//! browser decoder and the server relay share one definition and neither
//! transport type (`web_sys::WebSocket`, `axum::extract::ws`) appears in this
//! module.
//!
//! Forward compatible by the same rule as [`crate::protocol`]: every enum
//! carries `#[serde(other)] Unknown`, so a future envelope never kills the
//! connection.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::{Event, ExtensionUiRequest};

/// A browser -> server command.
///
/// `id` is the browser's correlation id; it is deliberately not pi's `req_N`.
/// The server stamps its own id when it forwards the translated command to pi,
/// keeping the two id spaces decoupled.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    Prompt {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
        /// Required by pi when a run is already streaming; omitting it there
        /// is an error (`docs/rpc-commands.md`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        streaming_behavior: Option<StreamingBehavior>,
    },
    Steer {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
    },
    FollowUp {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
    },
    Abort {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Empty pi's steering/follow-up queue. `abort` leaves the queue intact, so
    /// Stop is a separate decision from clear-queue.
    ClearQueue {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetState {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetAvailableModels {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SetModel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        provider: String,
        model_id: String,
    },
    CycleModel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetAvailableThinkingLevels {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SetThinkingLevel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        level: String,
    },
    CycleThinkingLevel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetSessionStats {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Compact {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
    },
    SetAutoCompaction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        enabled: bool,
    },
    SetAutoRetry {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        enabled: bool,
    },
    AbortRetry {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Run a shell command inline. `id` is mandatory and is used verbatim as
    /// the wire correlation id, because `bash_execution_update` events repeat
    /// it — the relay must not mint its own for this command.
    Bash {
        id: String,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exclude_from_context: Option<bool>,
    },
    AbortBash {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Answer a pi `extension_ui_request`. Fire-and-forget: it produces no
    /// command response, and `id` is pi's uuid, not a browser correlation id.
    /// Exactly one of `value`/`confirmed`/`cancelled` is set.
    ExtensionUiResponse {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirmed: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cancelled: Option<bool>,
    },
    /// List the workspace sessions from the shared `.pi/sessions` mount. Handled
    /// by the relay's session store, never forwarded to pi.
    ListSessions {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Attach the running ui child to an existing session, or branch from it.
    /// `mode` is `"resume"` | `"fork"` | `"clone"`; `entry_id` is required for
    /// `fork` (the entry to branch from). The server resolves `session_id` to an
    /// in-directory path before it reaches pi.
    ResumeSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entry_id: Option<String>,
    },
    /// Stop the exact ui-spawned child for `session_id`: `abort` then
    /// marker-kill. Distinct from `Abort`, which only ends the current turn.
    StopSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        session_id: String,
    },
    #[serde(other)]
    Unknown,
}

/// One session row the browser may render. Carries ids and metadata only: no
/// host path (the server resolves ids to paths itself) and no process marker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Session `modified` time in epoch milliseconds; rows sort on it.
    pub modified: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    pub message_count: usize,
    /// A live process (this UI's registry or a terminal claim) owns the session.
    pub in_use: bool,
    /// The file could not be parsed; it is listed but not resumable.
    pub unavailable: bool,
}

/// How a prompt issued mid-stream is handled. The wire values are exactly
/// `"steer"` and `"followUp"` (`docs/rpc-commands.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamingBehavior {
    Steer,
    FollowUp,
}

impl StreamingBehavior {
    /// The wire string pi expects.
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "followUp",
        }
    }
}

/// A server -> browser envelope wrapping one pi record or a relay notice.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    /// One pi session event, already decoded into the wire vocabulary.
    Event { event: Event },
    /// The response to a forwarded [`ClientMessage`]. `success: false` means pi
    /// rejected the command before accepting it and must be surfaced, not
    /// swallowed (AC5). `disposition` is `"handled"` | `"queued"` | `"started"`
    /// for prompts.
    CommandResponse {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        command: String,
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        disposition: Option<String>,
        /// The pi response's `data` payload, passed through untyped. Model
        /// lists, thinking levels, session stats, and `clear_queue`'s removed
        /// text all reach the browser through this single hop.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
    },
    /// A non-fatal notice (e.g. pi emit a parse failure on the child pipe).
    Notice { kind: String, detail: String },
    /// An `extension_ui_request` relayed from pi: a dialog or fire-and-forget
    /// chrome call. `request.method` selects which component handles it.
    ExtensionUi { request: ExtensionUiRequest },
    /// The session list answering a [`ClientMessage::ListSessions`].
    SessionList {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        sessions: Vec<SessionRow>,
    },
    /// The outcome of a resume/fork/clone/stop request. `success: false` carries
    /// the refusal reason (in-use guard, missing cwd, unknown child) and must be
    /// surfaced, never swallowed.
    SessionAction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        session_id: String,
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// The relay's broadcast lagged and skipped `skipped` pi records. Surfaced
    /// as a banner; replay/catch-up is slice 9.
    Lagged { skipped: u64 },
    /// A transport- or child-level error.
    Error { message: String },
    #[serde(other)]
    Unknown,
}

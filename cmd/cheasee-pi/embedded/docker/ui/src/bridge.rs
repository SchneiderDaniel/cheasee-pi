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

use crate::protocol::Event;

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
    #[serde(other)]
    Unknown,
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
    },
    /// A non-fatal notice (e.g. pi emit a parse failure on the child pipe).
    Notice { kind: String, detail: String },
    /// The relay's broadcast lagged and skipped `skipped` pi records. Surfaced
    /// as a banner; replay/catch-up is slice 9.
    Lagged { skipped: u64 },
    /// A transport- or child-level error.
    Error { message: String },
    #[serde(other)]
    Unknown,
}

//! Shared wire DTOs.
//!
//! Innermost module: serde only. It must not import axum, web-sys, or any
//! transport type — the WS is framing-agnostic in this slice, and slice 4
//! layers strict JSONL framing *above* these types on the child pipe.

use serde::{Deserialize, Serialize};

/// Echo request — the only payload this slice actually exchanges over the WS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientMessage {
    pub text: String,
}

/// Echo response, rendered verbatim by the client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerMessage {
    pub text: String,
}

// ── Slice 4 shells ──────────────────────────────────────────────────────────
// The pi RPC event/command/UI-shape enums live here so later slices extend one
// module instead of inventing a second wire vocabulary. They stay empty until
// slice 4 owns their variants; serde derives keep them round-trippable shells.

/// Events pushed from the pi child process to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Event {}

/// Commands the UI sends into the pi child process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Command {}

/// Extension UI requests (prompt/confirm/select) surfaced to the browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExtensionUI {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_message_round_trips() {
        let msg = ClientMessage { text: "hello".into() };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, r#"{"text":"hello"}"#);
        assert_eq!(serde_json::from_str::<ClientMessage>(&json).unwrap(), msg);
    }

    #[test]
    fn server_message_round_trips() {
        let msg = ServerMessage { text: "{\"a\":1}".into() };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(serde_json::from_str::<ServerMessage>(&json).unwrap(), msg);
    }

    #[test]
    fn unknown_fields_are_tolerated() {
        // Slice 4 adds fields/variants; today an extra key must not break a
        // client that is one version behind.
        let parsed: ClientMessage =
            serde_json::from_str(r#"{"text":"hi","future_field":true}"#).unwrap();
        assert_eq!(parsed.text, "hi");
    }
}

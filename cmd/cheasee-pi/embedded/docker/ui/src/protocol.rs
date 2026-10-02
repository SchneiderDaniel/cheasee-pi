//! Shared wire DTOs.
//!
//! Innermost module: serde only. It must not import axum, web-sys, or any
//! transport type — the WS is framing-agnostic in this slice: every JSON text
//! frame is echoed verbatim. Slice 4 layers strict JSONL framing *above* these
//! types on the child pipe.

use serde::{Deserialize, Serialize};

// ── Slice 4 shells ──────────────────────────────────────────────────────────
// The pi RPC event/command/UI-shape enums live here so later slices extend one
// module instead of inventing a second wire vocabulary. They stay empty until
// slice 4 owns their variants; the serde derive keeps a variant added later
// wire-ready. They do not round-trip today: an uninhabited enum serializes to
// nothing.

/// Events pushed from the pi child process to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Event {}

/// Commands the UI sends into the pi child process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Command {}

/// Extension UI requests (prompt/confirm/select) surfaced to the browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExtensionUI {}

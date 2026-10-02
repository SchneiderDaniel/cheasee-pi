//! Server-only RPC transport over the spawned `pi --mode rpc` child's pipes.
//!
//! Two layers, deliberately separate:
//!
//! * [`framing`] owns record boundaries on the byte stream (LF only, one
//!   trailing CR stripped, an explicit length cap) and the transport-vs-UTF-8
//!   error split.
//! * [`client`] owns id correlation, response-vs-event dispatch, event
//!   fan-out, and rejecting pending requests when the child goes away.
//!
//! The wire vocabulary itself lives in [`crate::protocol`], which stays
//! transport-free and compiles for both targets. This module is `ssr`-gated
//! because it links `tokio::process` types and must never reach the wasm
//! hydrate build.

pub mod client;
pub mod framing;

pub use client::{ProtocolMessage, RpcClient, RpcError, EVENT_CHANNEL_CAPACITY};
pub use framing::{encode_record, FramingError, JsonlReader, MAX_RECORD_BYTES};

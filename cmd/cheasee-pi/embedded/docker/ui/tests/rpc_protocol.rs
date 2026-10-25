//! AC3 round-trips over the four pi record families, plus a fixture corpus
//! captured from the vendored `@earendil-works/pi-coding-agent@0.79.10`.
//!
//! The fixtures are records only, one per line, with the captured version in a
//! sidecar `PI_VERSION` — a version header inside a `.jsonl` file would itself
//! be parsed as a record.
//!
//! Every function is `rpc_`-prefixed so the crate's `rpc` test filter reaches
//! it (`cargo test --no-default-features --features ssr rpc`).

use std::path::PathBuf;
use cheasee_pi_ui::bridge::{ClientMessage, ServerMessage};
use cheasee_pi_ui::protocol::{
    AssistantMessageEvent, ClearQueueData, Command, ContextUsage, Event, ExtensionUI,
    ExtensionUiRequest, ExtensionUiResponse, ModelInfo, QueueContents, Response, SessionStats,
    ThinkingLevels,
};
use serde_json::{json, Value};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

/// Every non-empty line of a fixture file, verbatim.
fn fixture_lines(name: &str) -> Vec<String> {
    let raw = std::fs::read_to_string(fixture(name)).expect("fixture is readable");
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect()
}

fn fixture_values(name: &str) -> Vec<Value> {
    fixture_lines(name)
        .into_iter()
        .map(|line| serde_json::from_str(&line).expect("fixture line is JSON"))
        .collect()
}

fn round_trip<T>(value: &T) -> Value
where
    T: serde::Serialize,
{
    serde_json::to_value(value).expect("serializable")
}

#[path = "rpc_protocol/codec.rs"]
mod codec;

#[path = "rpc_protocol/events.rs"]
mod events;

#[path = "rpc_protocol/session.rs"]
mod session;

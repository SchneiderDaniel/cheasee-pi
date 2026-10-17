//! Delta assembly and the reactive chat surface.
//!
//! [`Assembler`] is the pure reducer: it turns the pi event stream into one
//! append-only, ordered list of [`Row`]s (monotonic [`Row::id`]) so message
//! text, tool cards, run/turn markers and extension errors interleave
//! chronologically. It has no transport and no reactive runtime, so the
//! delta-assembly tests run fast.
//!
//! [`ChatState`] is the reactive adapter: it owns an [`Assembler`] and copies
//! its snapshot into Leptos signals, coalescing per-delta writes behind a
//! frame-rate flush so a token stream does not become one DOM mutation per
//! token (precedent: the context-info TPS sampler, 150 ms). The `rows` signal
//! is the replayed-history + live-run snapshot (history followed by the live
//! run); the view iterates `rows_view`, a keyed list of [`RowView`] handles
//! whose `id` is stable across flushes and whose `kind` is a reused signal, so
//! a same-id delta reaches the DOM without re-keying the row.

use std::collections::{HashMap, HashSet};

use leptos::prelude::*;
use serde_json::Value;

use crate::bridge::ServerMessage;
use crate::protocol::{AssistantMessageEvent, Event};
use crate::tool_card::{content_text, ToolCard, ToolStatus};

/// Cap on one row's live text. Mirrors the supervisor's live buffer so a long
/// answer (or a 50 KB tool snapshot re-sent ~10×/s) cannot grow unbounded.
pub const MAX_LIVE_TEXT: usize = 10_000;
/// When a row exceeds [`MAX_LIVE_TEXT`] it is trimmed to this many trailing
/// characters — the newest tokens are what is still streaming.
pub const LIVE_TEXT_TRIM: usize = 8_000;
/// Coalescing window for per-delta signal writes, in milliseconds.
pub const FLUSH_INTERVAL_MS: u64 = 150;

/// The kind of content block, from the `message.content[]` element type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Text,
    Thinking,
    ToolCall,
}

/// A text or thinking body, keyed by the pi `contentIndex` / element index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextBody {
    pub content_index: u32,
    pub text: String,
    /// Set when [`MAX_LIVE_TEXT`] was exceeded and text was trimmed.
    pub truncated: bool,
}

/// A run/turn boundary marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Marker {
    TurnStart,
    TurnEnd,
    RunStart,
    RunEnd,
}

impl Marker {
    pub fn label(self) -> &'static str {
        match self {
            Marker::TurnStart => "turn started",
            Marker::TurnEnd => "turn ended",
            Marker::RunStart => "run started",
            Marker::RunEnd => "run ended",
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Marker::TurnStart => "turn-start",
            Marker::TurnEnd => "turn-end",
            Marker::RunStart => "run-start",
            Marker::RunEnd => "run-end",
        }
    }
}

/// An `extension_error` surfaced as a durable transcript row. It renders as a
/// card and never breaks the stream (a later delta still appends).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorCard {
    pub extension_path: String,
    pub event: String,
    pub error: String,
}

/// What a transcript row is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowKind {
    Text(TextBody),
    Thinking(TextBody),
    Tool(ToolCard),
    Marker(Marker),
    ExtensionError(ErrorCard),
}

impl RowKind {
    /// The text body, for text and thinking rows.
    pub fn as_text(&self) -> Option<&TextBody> {
        match self {
            RowKind::Text(body) | RowKind::Thinking(body) => Some(body),
            _ => None,
        }
    }

    /// The tool card, for tool rows.
    pub fn as_tool(&self) -> Option<&ToolCard> {
        match self {
            RowKind::Tool(card) => Some(card),
            _ => None,
        }
    }

    fn is_text(&self) -> bool {
        matches!(self, RowKind::Text(_) | RowKind::Thinking(_))
    }
}

/// One ordered transcript row. `id` is monotonic and unique across both replay
/// and the live run (the leptos `<For>` key).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub id: u64,
    pub kind: RowKind,
}

/// A reactive handle to one transcript row, for the keyed `<For>`.
///
/// `id` is the stable key; `kind` is a signal reused across flushes so a
/// same-id update (a text delta, a tool snapshot, a final status) mutates the
/// retained row instead of leaving the view frozen at the first value it saw.
#[derive(Clone, Copy, Debug)]
pub struct RowView {
    pub id: u64,
    pub kind: RwSignal<RowKind>,
}

/// Builds the view list for `rows`, reusing the payload signal of every id
/// already present in `existing` and creating signals only for new rows.
///
/// Pure and public so the renderer regression test can assert that a same-id
/// update actually mutates the signal the view reads.
pub fn reconcile_row_views(existing: &[RowView], rows: &[Row]) -> Vec<RowView> {
    let by_id: HashMap<u64, RwSignal<RowKind>> =
        existing.iter().map(|view| (view.id, view.kind)).collect();
    rows.iter()
        .map(|row| {
            let kind = match by_id.get(&row.id) {
                Some(sig) => {
                    if sig.get_untracked() != row.kind {
                        sig.set(row.kind.clone());
                    }
                    *sig
                }
                None => RwSignal::new(row.kind.clone()),
            };
            RowView { id: row.id, kind }
        })
        .collect()
}

/// Cumulative token/cost readout. `available` is false until pi reports usage
/// (some providers report only at completion), so the view can say so instead
/// of showing a permanently flat zero.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
    pub cost_total: f64,
    pub available: bool,
}

/// Streaming lifecycle. Cleared to [`StreamStatus::Settled`] only on
/// `agent_settled`; `agent_end` can still be followed by retry/steering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StreamStatus {
    #[default]
    Idle,
    Streaming,
    Settled,
}

impl StreamStatus {
    pub fn is_streaming(self) -> bool {
        matches!(self, StreamStatus::Streaming)
    }

    pub fn label(self) -> &'static str {
        match self {
            StreamStatus::Idle => "idle",
            StreamStatus::Streaming => "streaming",
            StreamStatus::Settled => "settled",
        }
    }
}

/// An internal assembled message block. Rows are derived from it; it exists so
/// `contentIndex` accumulation stays simple.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Block {
    index: u32,
    kind: BlockKind,
    text: String,
    truncated: bool,
}

/// The pure row assembler. See the module docs.
#[derive(Debug, Default)]
pub struct Assembler {
    /// The live run's rows, oldest first, append-only across turns.
    rows: Vec<Row>,
    /// Replayed history from the durable log, rendered *before* the live run.
    history: Vec<Row>,
    /// Monotonic row-id allocator, shared by history and the live run so every
    /// key is unique across the transcript.
    next_id: u64,
    usage: Usage,
    status: StreamStatus,
    will_retry: Option<bool>,
    /// Set once an assistant `message_end` has been applied. It is authoritative
    /// for the whole message, so any later `message_update` is a trailing delta
    /// that must not append to the final text; the flag clears only on the next
    /// `message_start` (or a fresh `agent_start`).
    finalized: bool,
    /// The current message's text/thinking assembly, keyed by `contentIndex`.
    blocks: Vec<Block>,
    /// `rows` index where the current message's rows begin; the message's
    /// rendered rows are rebuilt from `blocks` at `message_end`.
    message_start: usize,
    /// Entry ids already folded into `history`, so replaying the same entries
    /// twice (a reconnect, a resync) is idempotent and never duplicates a row.
    replayed: HashSet<String>,
}

impl Assembler {
include!("stream_part2.rs");
include!("stream_part3.rs");
}

include!("stream_part4.rs");
#[cfg(test)]
mod tests {
include!("stream_part5.rs");
include!("stream_part6.rs");
}

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
    /// Reduce one event. Returns whether anything visible changed.
    pub fn apply(&mut self, event: &Event) -> bool {
        // `message_end` is authoritative: ignore trailing deltas for a message
        // that is already finalized, until the next `message_start` opens one.
        if self.finalized && matches!(event, Event::MessageUpdate { .. }) {
            return false;
        }
        match event {
            Event::AgentStart => {
                self.status = StreamStatus::Streaming;
                self.will_retry = None;
                self.finalized = false;
                self.push_marker(Marker::RunStart);
                true
            }
            // A new assistant message: its text assembly is built fresh, but the
            // rows already emitted for earlier turns are never cleared
            // (append-only across turns).
            Event::MessageStart { .. } => {
                let changed = !self.blocks.is_empty() || self.finalized;
                self.blocks.clear();
                self.finalized = false;
                self.message_start = self.rows.len();
                changed
            }
            Event::MessageUpdate {
                assistant_message_event,
                usage,
                ..
            } => {
                let mut changed = false;
                if let Some(u) = usage.as_ref().and_then(usage_from_value) {
                    // Cumulative snapshot: replace, never accumulate.
                    if u != self.usage {
                        self.usage = u;
                        changed = true;
                    }
                }
                if let Some(ev) = AssistantMessageEvent::parse_lenient(assistant_message_event) {
                    changed |= self.apply_assistant(ev);
                }
                changed
            }
            Event::MessageEnd { message } => self.apply_message_end(message),
            Event::AgentEnd { will_retry, .. } => {
                if self.will_retry != *will_retry {
                    self.will_retry = *will_retry;
                }
                self.push_marker(Marker::RunEnd);
                true
            }
            Event::TurnStart => {
                self.push_marker(Marker::TurnStart);
                true
            }
            Event::TurnEnd { .. } => {
                self.push_marker(Marker::TurnEnd);
                true
            }
            Event::AgentSettled => {
                let changed = self.status != StreamStatus::Settled;
                self.status = StreamStatus::Settled;
                changed
            }
            Event::ToolExecutionStart {
                tool_call_id,
                tool_name,
                args,
            } => {
                let card = ToolCard::start(tool_call_id, tool_name, args);
                self.push_row(RowKind::Tool(card));
                true
            }
            Event::ToolExecutionUpdate {
                tool_call_id,
                tool_name,
                args,
                partial_result,
            } => self.update_tool(tool_call_id, tool_name, |card| {
                card.update(args, partial_result)
            }),
            Event::ToolExecutionEnd {
                tool_call_id,
                tool_name,
                result,
                is_error,
            } => self.update_tool(tool_call_id, tool_name, |card| card.end(result, *is_error)),
            Event::ExtensionError {
                extension_path,
                event,
                error,
            } => {
                self.push_row(RowKind::ExtensionError(ErrorCard {
                    extension_path: extension_path.clone(),
                    event: event.clone(),
                    error: error.clone(),
                }));
                true
            }
            // Control-plane events do not touch the transcript. The queue,
            // model/thinking selection, retry pills, compaction banner and
            // bash chunks belong to `ControlsState`; the assembler only keeps
            // the transcript. These arms are explicit so a future event cannot
            // be mistaken for one the transcript is supposed to render.
            Event::QueueUpdate { .. }
            | Event::CompactionStart { .. }
            | Event::CompactionEnd { .. }
            | Event::AutoRetryStart { .. }
            | Event::AutoRetryEnd { .. }
            | Event::SummarizationRetryScheduled { .. }
            | Event::SummarizationRetryAttemptStart { .. }
            | Event::SummarizationRetryFinished { .. }
            | Event::ThinkingLevelChanged { .. }
            | Event::BashExecutionUpdate { .. } => false,
            _ => false,
        }
    }

    fn apply_assistant(&mut self, event: AssistantMessageEvent) -> bool {
        match event {
            AssistantMessageEvent::TextStart { content_index } => {
                self.ensure_block(content_index, BlockKind::Text)
            }
            AssistantMessageEvent::TextDelta {
                content_index,
                delta,
            } => self.push_delta(content_index, BlockKind::Text, &delta),
            AssistantMessageEvent::TextEnd {
                content_index,
                content,
            } => self.replace_block(content_index, BlockKind::Text, content),
            AssistantMessageEvent::ThinkingStart { content_index } => {
                self.ensure_block(content_index, BlockKind::Thinking)
            }
            AssistantMessageEvent::ThinkingDelta {
                content_index,
                delta,
            } => self.push_delta(content_index, BlockKind::Thinking, &delta),
            AssistantMessageEvent::ThinkingEnd {
                content_index,
                content,
            } => self.replace_block(content_index, BlockKind::Thinking, content),
            // Tool calls are declared in the assistant message but executed as
            // top-level `tool_execution_*` events; the durable tool row comes
            // from those, not from the declaration.
            AssistantMessageEvent::ToolcallStart { .. }
            | AssistantMessageEvent::ToolcallDelta { .. }
            | AssistantMessageEvent::ToolcallEnd { .. } => false,
            AssistantMessageEvent::Unknown => false,
        }
    }

    /// `message_end.message` is authoritative for the whole message: rebuild
    /// the message's rows from its `content` array rather than concatenating
    /// onto what the deltas assembled. Thinking rows render separately.
    fn apply_message_end(&mut self, message: &Value) -> bool {
        let Some(obj) = message.as_object() else {
            return false;
        };
        if obj.get("role").and_then(Value::as_str) != Some("assistant") {
            return false;
        }

        // The message is now authoritative; subsequent deltas are ignored until
        // the next `message_start`.
        let mut changed = !self.finalized;
        self.finalized = true;
        if let Some(content) = obj.get("content").and_then(Value::as_array) {
            let mut blocks = Vec::new();
            for (i, part) in content.iter().enumerate() {
                let Some(kind) = part
                    .get("type")
                    .and_then(Value::as_str)
                    .and_then(block_kind)
                else {
                    continue;
                };
                let raw = match kind {
                    BlockKind::Text => part.get("text").and_then(Value::as_str).unwrap_or_default(),
                    BlockKind::Thinking => part
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    BlockKind::ToolCall => "",
                };
                let (text, truncated) = bounded(raw.to_string());
                blocks.push(Block {
                    index: i as u32,
                    kind,
                    text,
                    truncated,
                });
            }
            if blocks != self.blocks {
                self.blocks = blocks;
                changed = true;
            }
        }
        self.rebuild_message_rows();

        if let Some(u) = obj.get("usage").and_then(usage_from_value) {
            // Fallback source for providers that report usage only at the end
            // (`message_update.usage` stays zero while streaming).
            if u != self.usage {
                self.usage = u;
                changed = true;
            }
        }
        changed
    }

    fn ensure_block(&mut self, index: u32, kind: BlockKind) -> bool {
        if let Some(block) = self.blocks.iter_mut().find(|b| b.index == index) {
            if block.kind != kind {
                block.kind = kind;
                self.sync_row(index);
                return true;
            }
            return false;
        }
        let pos = self.blocks.partition_point(|b| b.index < index);
        self.blocks.insert(
            pos,
            Block {
                index,
                kind,
                text: String::new(),
                truncated: false,
            },
        );
        self.sync_row(index);
        true
    }

    fn push_delta(&mut self, index: u32, kind: BlockKind, delta: &str) -> bool {
        let created = self.ensure_block(index, kind);
        if delta.is_empty() {
            return created;
        }
        let block = self
            .blocks
            .iter_mut()
            .find(|b| b.index == index)
            .expect("block was just ensured");
        block.text.push_str(delta);
        if block.text.len() > MAX_LIVE_TEXT {
            let cut = floor_char_boundary(block.text.len() - LIVE_TEXT_TRIM, &block.text);
            block.text.drain(..cut);
            block.truncated = true;
        }
        self.sync_row(index);
        true
    }

    fn replace_block(&mut self, index: u32, kind: BlockKind, content: String) -> bool {
        self.ensure_block(index, kind);
        let block = self
            .blocks
            .iter_mut()
            .find(|b| b.index == index)
            .expect("block was just ensured");
        let (text, truncated) = bounded(content);
        if block.text == text && block.truncated == truncated {
            return false;
        }
        block.text = text;
        block.truncated = truncated;
        self.sync_row(index);
        true
    }

    /// Copy one assembled block into its row, creating the row on first sight.
    fn sync_row(&mut self, index: u32) {
        let Some(block) = self.blocks.iter().find(|b| b.index == index).cloned() else {
            return;
        };
        let kind = text_row(block.kind, block.index, block.text, block.truncated);
        if let Some(row) = self.rows[self.message_start..]
            .iter_mut()
            .find(|r| r.kind.as_text().is_some_and(|b| b.content_index == index))
        {
            row.kind = kind;
            return;
        }
        self.push_row(kind);
    }

    /// Reconcile the current message's rendered text/thinking rows with the
    /// authoritative blocks *in place*. A row keeps its position, so rows that
    /// arrived between deltas (tool cards, markers, extension errors) stay
    /// chronological; a block with no row yet is appended and a row with no
    /// block is dropped. Earlier turns are never touched.
    fn rebuild_message_rows(&mut self) {
        let blocks: Vec<Block> = self
            .blocks
            .iter()
            .filter(|b| b.kind != BlockKind::ToolCall)
            .cloned()
            .collect();
        // Match text rows to blocks by arrival order: `content_index` can shift
        // when the authoritative message re-indexes its parts, so index alone
        // cannot pair them.
        let text_positions: Vec<usize> = (self.message_start..self.rows.len())
            .filter(|&i| self.rows[i].kind.is_text())
            .collect();
        for (k, &pos) in text_positions.iter().enumerate() {
            if let Some(block) = blocks.get(k) {
                self.rows[pos].kind =
                    text_row(block.kind, block.index, block.text.clone(), block.truncated);
            }
        }
        // Drop rows the finalized message no longer contains (reverse so the
        // earlier positions stay valid).
        for &pos in text_positions.iter().skip(blocks.len()).rev() {
            self.rows.remove(pos);
        }
        // Blocks with no row yet were never streamed; append them.
        for block in blocks.iter().skip(text_positions.len()) {
            let kind = text_row(block.kind, block.index, block.text.clone(), block.truncated);
            self.push_row(kind);
        }
    }

    /// Apply an update/end to the tool row for `tool_call_id`. A synthesised
    /// card is created when the start was never seen, so a tool that only
    /// reports its end still renders.
    fn update_tool(
        &mut self,
        tool_call_id: &str,
        name: &str,
        apply: impl FnOnce(&mut ToolCard) -> bool,
    ) -> bool {
        if let Some(row) = self.rows.iter_mut().rev().find(|r| {
            r.kind
                .as_tool()
                .is_some_and(|c| c.tool_call_id == tool_call_id)
        }) {
            if let RowKind::Tool(card) = &mut row.kind {
                return apply(card);
            }
        }
        let mut card = ToolCard::start(tool_call_id, name, &Value::Null);
        apply(&mut card);
        self.push_row(RowKind::Tool(card));
        true
    }

    fn push_marker(&mut self, marker: Marker) {
        self.push_row(RowKind::Marker(marker));
    }

    fn push_row(&mut self, kind: RowKind) {
        let id = self.alloc_id();
        self.rows.push(Row { id, kind });
    }

    fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// The live run's rows, oldest first.
    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    /// The replayed history, oldest first.
    pub fn history(&self) -> &[Row] {
        &self.history
    }

    /// History followed by the live run: the single ordered transcript the view
    /// renders.
    pub fn transcript(&self) -> Vec<Row> {
        self.history
            .iter()
            .chain(self.rows.iter())
            .cloned()
            .collect()
    }

    /// Fold raw pi session entries into the transcript history. Idempotent by
    /// stable entry id; an entry with no renderable message is skipped.
    pub fn apply_replay(&mut self, entries: &[Value]) -> bool {
        let mut changed = false;
        for entry in entries {
            changed |= self.fold_replay_entry(entry);
        }
        changed
    }

    fn fold_replay_entry(&mut self, entry: &Value) -> bool {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            return false;
        };
        // Dedupe by stable entry id, never by arrival order.
        if !self.replayed.insert(id.to_string()) {
            return false;
        }
        let Some(message) = entry.get("message") else {
            return false;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role == "toolResult" || role == "tool_result" {
            return self.fold_tool_result(message);
        }
        let kinds = row_kinds_from_message(message);
        if kinds.is_empty() {
            return false;
        }
        for kind in kinds {
            let id = self.alloc_id();
            self.history.push(Row { id, kind });
        }
        true
    }

    /// Pair a replayed `toolResult` with the `toolCall` row it answers, by
    /// `toolCallId`. Falls back to a standalone card when the call was never
    /// folded. The persisted `isError` flag decides the status, so a failed
    /// historical call is not misrepresented as success.
    fn fold_tool_result(&mut self, message: &Value) -> bool {
        let tool_call_id = message
            .get("toolCallId")
            .or_else(|| message.get("tool_call_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let is_error = message
            .get("isError")
            .or_else(|| message.get("is_error"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let status = if is_error {
            ToolStatus::Error
        } else {
            ToolStatus::Done
        };
        let (output, truncated) = bounded(content_text(message));
        if let Some(row) = self.history.iter_mut().rev().find(|r| {
            r.kind
                .as_tool()
                .is_some_and(|c| c.tool_call_id == tool_call_id)
        }) {
            if let RowKind::Tool(card) = &mut row.kind {
                card.output = output;
                card.truncated = truncated;
                card.status = status;
                return true;
            }
        }
        let card = ToolCard {
            tool_call_id,
            name: String::new(),
            args: String::new(),
            output,
            status,
            truncated,
        };
        let id = self.alloc_id();
        self.history.push(Row {
            id,
            kind: RowKind::Tool(card),
        });
        true
    }

    pub fn usage(&self) -> Usage {
        self.usage.clone()
    }

    pub fn status(&self) -> StreamStatus {
        self.status
    }

    pub fn will_retry(&self) -> Option<bool> {
        self.will_retry
    }
}

fn text_row(kind: BlockKind, content_index: u32, text: String, truncated: bool) -> RowKind {
    let body = TextBody {
        content_index,
        text,
        truncated,
    };
    match kind {
        BlockKind::Thinking => RowKind::Thinking(body),
        _ => RowKind::Text(body),
    }
}

fn block_kind(raw: &str) -> Option<BlockKind> {
    match raw {
        "text" => Some(BlockKind::Text),
        "thinking" => Some(BlockKind::Thinking),
        "toolcall" | "tool_call" | "toolCall" => Some(BlockKind::ToolCall),
        _ => None,
    }
}

/// Build transcript row kinds from one raw pi message. A user message carries a
/// plain string; an assistant message carries a typed content array. A
/// `toolcall` part becomes a running tool card; a matching `toolResult` entry
/// fills it in.
fn row_kinds_from_message(message: &Value) -> Vec<RowKind> {
    let mut out = Vec::new();
    match message.get("content") {
        Some(Value::String(text)) => {
            let (text, truncated) = bounded(text.clone());
            out.push(RowKind::Text(TextBody {
                content_index: 0,
                text,
                truncated,
            }));
        }
        Some(Value::Array(parts)) => {
            for (i, part) in parts.iter().enumerate() {
                let Some(kind) = part.get("type").and_then(Value::as_str) else {
                    continue;
                };
                match kind {
                    "text" => {
                        let raw = part.get("text").and_then(Value::as_str).unwrap_or_default();
                        let (text, truncated) = bounded(raw.to_string());
                        out.push(RowKind::Text(TextBody {
                            content_index: i as u32,
                            text,
                            truncated,
                        }));
                    }
                    "thinking" => {
                        let raw = part
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let (text, truncated) = bounded(raw.to_string());
                        out.push(RowKind::Thinking(TextBody {
                            content_index: i as u32,
                            text,
                            truncated,
                        }));
                    }
                    "toolcall" | "tool_call" | "toolCall" => {
                        let id = part
                            .get("id")
                            .or_else(|| part.get("toolCallId"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let name = part
                            .get("name")
                            .or_else(|| part.get("toolName"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let args = part
                            .get("arguments")
                            .or_else(|| part.get("input"))
                            .or_else(|| part.get("args"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        out.push(RowKind::Tool(ToolCard::start(id, name, &args)));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

/// Bound a row's text to [`MAX_LIVE_TEXT`], keeping the trailing
/// [`LIVE_TEXT_TRIM`] characters, returning the text and whether it was cut.
pub(crate) fn bounded(mut text: String) -> (String, bool) {
    if text.len() <= MAX_LIVE_TEXT {
        return (text, false);
    }
    let cut = floor_char_boundary(text.len() - LIVE_TEXT_TRIM, &text);
    text.drain(..cut);
    (text, true)
}

/// The largest char boundary at or below `index`.
fn floor_char_boundary(mut index: usize, text: &str) -> usize {
    if index >= text.len() {
        return text.len();
    }
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// Parse a pi `usage` object into the cumulative readout. Cumulative means the
/// object *is* the current total — callers replace, they never add.
fn usage_from_value(value: &Value) -> Option<Usage> {
    let obj = value.as_object()?;
    let num = |key: &str| obj.get(key).and_then(Value::as_u64).unwrap_or(0);
    let input = num("input");
    let output = num("output");
    let cache_read = num("cacheRead");
    let cache_write = num("cacheWrite");
    let total = obj
        .get("total")
        .and_then(Value::as_u64)
        .unwrap_or(input + output + cache_read + cache_write);
    let cost_total = obj
        .get("cost")
        .and_then(|c| c.get("total"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    Some(Usage {
        input,
        output,
        cache_read,
        cache_write,
        total,
        cost_total,
        available: true,
    })
}

/// The reactive chat surface: one [`Assembler`] plus the signals the view
/// reads.
///
/// Per-delta writes are coalesced: the assembler is updated on every event, but
/// its `rows` snapshot is copied into the display signal at most once per
/// [`FLUSH_INTERVAL_MS`] in the browser (immediately on the server, where there
/// is no frame clock).
#[derive(Clone, Copy)]
pub struct ChatState {
    assembler: RwSignal<Assembler>,
    /// The ordered transcript the view renders: replayed history followed by
    /// the live run, keyed by [`Row::id`]. Snapshot for consumers/tests.
    pub rows: RwSignal<Vec<Row>>,
    /// The keyed view list derived from [`Self::rows`]: stable [`RowView::id`]
    /// keys with a reused payload signal, so a same-id update reaches the DOM
    /// without re-keying the row (AC5).
    pub rows_view: RwSignal<Vec<RowView>>,
    pub usage: RwSignal<Usage>,
    pub status: RwSignal<StreamStatus>,
    pub will_retry: RwSignal<Option<bool>>,
    /// Latest user-visible alert (rejected prompt, relay lag, child error).
    pub notice: RwSignal<Option<String>>,
    /// Total pi records the relay reported as dropped.
    pub lagged: RwSignal<u64>,
    flush_pending: RwSignal<bool>,
}

impl Default for ChatState {
    fn default() -> Self {
        Self::new()
    }
}

impl ChatState {
    pub fn new() -> Self {
        Self {
            assembler: RwSignal::new(Assembler::default()),
            rows: RwSignal::new(Vec::new()),
            rows_view: RwSignal::new(Vec::new()),
            usage: RwSignal::new(Usage::default()),
            status: RwSignal::new(StreamStatus::default()),
            will_retry: RwSignal::new(None),
            notice: RwSignal::new(None),
            lagged: RwSignal::new(0),
            flush_pending: RwSignal::new(false),
        }
    }

    /// Reduce one server message. Returns whether anything changed.
    pub fn apply(&self, message: &ServerMessage) -> bool {
        match message {
            ServerMessage::Event { event } => {
                // `try_maybe_update` notifies subscribers only when the
                // assembler reports a change.
                let changed = self
                    .assembler
                    .try_maybe_update(|a| {
                        let changed = a.apply(event);
                        (changed, changed)
                    })
                    .unwrap_or(false);
                if changed {
                    self.schedule_flush();
                }
                changed
            }
            ServerMessage::CommandResponse {
                command,
                success,
                error,
                ..
            } => {
                if *success {
                    false
                } else {
                    // `success:false` means pi rejected the command before
                    // acceptance; surface it rather than swallowing it.
                    let detail = error
                        .clone()
                        .unwrap_or_else(|| format!("{command} rejected"));
                    self.notice.set(Some(detail));
                    true
                }
            }
            ServerMessage::Notice { kind, detail } => {
                self.notice.set(Some(format!("{kind}: {detail}")));
                true
            }
            ServerMessage::Lagged {
                skipped,
                resync_required,
            } => {
                self.lagged.update(|n| *n = n.saturating_add(*skipped));
                // A resync signal tells the transport to re-send `Subscribe {
                // since: lastSeenEntryId }`; the durable log heals the gap.
                let detail = if *resync_required {
                    format!("{skipped} events dropped (relay lag) — resyncing")
                } else {
                    format!("{skipped} events dropped (relay lag)")
                };
                self.notice.set(Some(detail));
                true
            }
            ServerMessage::Error { message } => {
                self.notice.set(Some(message.clone()));
                true
            }
            // Extension UI chrome is the concern of `ExtensionUiState`.
            ServerMessage::ExtensionUi { .. } => false,
            // Session list/action frames are the concern of `SessionListState`.
            ServerMessage::SessionList { .. } | ServerMessage::SessionAction { .. } => false,
            // Subscribe header and replay chunks are reduced by the session
            // boundary (`controls`/`extension_ui`), not the transcript
            // assembler.
            ServerMessage::SessionState { cursor_invalid, .. } => {
                if *cursor_invalid {
                    // The cursor was unknown; the server failed open to a full
                    // replay. Surface it rather than showing a silent gap.
                    self.notice.set(Some(
                        "session cursor was unknown — replayed full history".into(),
                    ));
                    true
                } else {
                    false
                }
            }
            // Replay entries are folded into the transcript history so a
            // reconnect or a child-less restart actually shows the history;
            // dedupe by stable entry id lives in the assembler.
            ServerMessage::SessionReplay { entries, .. } => {
                let changed = self
                    .assembler
                    .try_maybe_update(|a| {
                        let changed = a.apply_replay(entries);
                        (changed, changed)
                    })
                    .unwrap_or(false);
                if changed {
                    self.schedule_flush();
                }
                changed
            }
            ServerMessage::Unknown => false,
        }
    }

    /// Decode and reduce one WS text frame. A malformed frame is surfaced, not
    /// silently dropped, and never kills the connection.
    pub fn ingest_frame(&self, text: &str) -> bool {
        match serde_json::from_str::<ServerMessage>(text) {
            Ok(message) => self.apply(&message),
            Err(err) => {
                self.notice
                    .set(Some(format!("malformed server frame: {err}")));
                true
            }
        }
    }

    fn schedule_flush(&self) {
        #[cfg(feature = "hydrate")]
        {
            if self.flush_pending.get_untracked() {
                return;
            }
            self.flush_pending.set(true);
            let state = *self;
            gloo_timers::callback::Timeout::new(FLUSH_INTERVAL_MS as u32, move || {
                state.flush_now();
            })
            .forget();
        }
        #[cfg(not(feature = "hydrate"))]
        {
            self.flush_now();
        }
    }

    /// Copy the assembler's snapshot into the display signals. Public so the
    /// browser timer (and tests) can force a flush.
    pub fn flush_now(&self) {
        self.flush_pending.set(false);
        let (rows, usage, status, will_retry) = self
            .assembler
            .with(|a| (a.transcript(), a.usage(), a.status(), a.will_retry()));
        // Update the reused per-row payload signals before publishing the
        // keyed view list, so same-id deltas mutate the retained row instead
        // of freezing at the value first rendered (AC1/AC5).
        let views = reconcile_row_views(&self.rows_view.get_untracked(), &rows);
        self.rows_view.set(views);
        self.rows.set(rows);
        self.usage.set(usage);
        self.status.set(status);
        self.will_retry.set(will_retry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Event;
    use serde_json::json;

    fn delta(index: u32, delta: &str) -> Event {
        Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "text_delta", "contentIndex": index, "delta": delta}),
            usage: None,
        }
    }

    fn thinking_delta(index: u32, delta: &str) -> Event {
        Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "thinking_delta", "contentIndex": index, "delta": delta}),
            usage: None,
        }
    }

    fn texts(assembler: &Assembler) -> Vec<(u32, String)> {
        assembler
            .rows()
            .iter()
            .filter_map(|row| {
                row.kind
                    .as_text()
                    .map(|b| (b.content_index, b.text.clone()))
            })
            .collect()
    }

    #[test]
    fn deltas_append_in_order() {
        let mut a = Assembler::default();
        a.apply(&Event::MessageStart { message: json!({}) });
        assert!(a.apply(&delta(0, "Hello")));
        assert!(a.apply(&delta(0, ", ")));
        a.apply(&delta(0, "world"));
        assert_eq!(texts(&a), vec![(0, "Hello, world".to_string())]);
        assert!(matches!(a.rows()[0].kind, RowKind::Text(_)));
    }

    /// AC2: rows are keyed by `contentIndex`, so interleaved thinking and
    /// text do not merge into one row.
    #[test]
    fn interleaved_blocks_are_grouped_by_content_index() {
        let mut a = Assembler::default();
        a.apply(&delta(0, "answer"));
        a.apply(&thinking_delta(1, "hmm"));
        a.apply(&delta(0, "!"));
        a.apply(&thinking_delta(1, "?"));
        assert_eq!(
            texts(&a),
            vec![(0, "answer!".to_string()), (1, "hmm?".to_string())]
        );
        assert!(matches!(a.rows()[1].kind, RowKind::Thinking(_)));
    }

    /// AC2/AC3: `text_end.content` is authoritative — it replaces the
    /// assembled deltas rather than concatenating.
    #[test]
    fn text_end_replaces_the_delta_buffer() {
        let mut a = Assembler::default();
        a.apply(&delta(0, "Hel"));
        a.apply(&delta(0, "lo wor"));
        a.apply(&Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "text_end", "contentIndex": 0, "content": "Hello world"}),
            usage: None,
        });
        assert_eq!(texts(&a), vec![(0, "Hello world".to_string())]);
    }

    /// AC3: `message_end.message` replaces the whole assembled partial, and a
    /// thinking row is rendered separately from text.
    #[test]
    fn message_end_is_authoritative_and_splits_thinking() {
        let mut a = Assembler::default();
        a.apply(&delta(0, "partial that is wrong"));
        a.apply(&Event::MessageEnd {
            message: json!({
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "let me think"},
                    {"type": "text", "text": "final answer"}
                ],
                "usage": {"input": 7, "output": 3}
            }),
        });
        assert_eq!(
            texts(&a),
            vec![
                (0, "let me think".to_string()),
                (1, "final answer".to_string())
            ]
        );
        assert!(matches!(a.rows()[0].kind, RowKind::Thinking(_)));
        assert!(matches!(a.rows()[1].kind, RowKind::Text(_)));
        assert_eq!(a.usage().input, 7);
        assert!(a.usage().available);
    }

    /// `message_end` is authoritative: a trailing `message_update` for the same
    /// message must not append to the final text, and the next `message_start`
    /// re-opens the message for a new run.
    #[test]
    fn trailing_delta_after_message_end_is_ignored_until_next_message_start() {
        let mut a = Assembler::default();
        a.apply(&Event::MessageStart { message: json!({}) });
        a.apply(&delta(0, "partial"));
        a.apply(&Event::MessageEnd {
            message: json!({
                "role": "assistant",
                "content": [{"type": "text", "text": "final"}]
            }),
        });
        // A stray delta after the authoritative end cannot corrupt the text.
        assert!(!a.apply(&delta(0, " CORRUPT")));
        assert_eq!(texts(&a), vec![(0, "final".to_string())]);
        // The next message start re-opens assembly; earlier rows are kept.
        assert!(a.apply(&Event::MessageStart { message: json!({}) }));
        assert!(a.apply(&delta(0, "second")));
        assert_eq!(
            texts(&a),
            vec![(0, "final".to_string()), (0, "second".to_string())]
        );
    }

    /// AC4: usage is cumulative — a later snapshot replaces the earlier one
    /// instead of summing.
    #[test]
    fn usage_is_replaced_not_accumulated() {
        let mut a = Assembler::default();
        a.apply(&Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "text_delta", "contentIndex": 0, "delta": "x"}),
            usage: Some(json!({"input": 10, "output": 2, "cost": {"total": 0.01}})),
        });
        a.apply(&Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "text_delta", "contentIndex": 0, "delta": "y"}),
            usage: Some(json!({"input": 10, "output": 5, "cost": {"total": 0.02}})),
        });
        let usage = a.usage();
        assert_eq!(usage.input, 10, "input must not be double counted");
        assert_eq!(usage.output, 5);
        assert_eq!(usage.cost_total, 0.02);
    }

    /// AC5: the streaming indicator clears on `agent_settled`, not `agent_end`.
    #[test]
    fn settled_clears_streaming_but_agent_end_does_not() {
        let mut a = Assembler::default();
        a.apply(&Event::AgentStart);
        assert!(a.status().is_streaming());
        a.apply(&Event::AgentEnd {
            messages: vec![],
            will_retry: Some(true),
        });
        assert_eq!(
            a.status(),
            StreamStatus::Streaming,
            "agent_end may still be retried"
        );
        assert_eq!(a.will_retry(), Some(true));
        assert!(a.apply(&Event::AgentSettled));
        assert_eq!(a.status(), StreamStatus::Settled);
    }

    #[test]
    fn live_text_is_bounded() {
        let mut a = Assembler::default();
        for _ in 0..(MAX_LIVE_TEXT / 10 + 2) {
            a.apply(&delta(0, "0123456789"));
        }
        let body = a.rows()[0].kind.as_text().unwrap();
        assert!(body.truncated);
        assert!(body.text.len() <= MAX_LIVE_TEXT);
    }

    /// The delta-only pi >=0.84 record (no `message`, no `partial`) reaches the
    /// assembler — the decode regression the research flagged.
    #[test]
    fn delta_only_message_update_reaches_the_assembler() {
        let event: Event = serde_json::from_value(json!({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "hi"}
        }))
        .unwrap();
        let mut a = Assembler::default();
        assert!(a.apply(&event));
        assert_eq!(texts(&a), vec![(0, "hi".to_string())]);
    }

    /// AC5: a rejected prompt response is surfaced, not swallowed.
    #[test]
    fn chat_state_surfaces_rejected_prompt() {
        // Signals need a reactive owner to allocate into.
        let owner = leptos::prelude::Owner::new();
        owner.set();
        let state = ChatState::new();
        assert!(state.apply(&ServerMessage::CommandResponse {
            id: None,
            command: "prompt".into(),
            success: false,
            error: Some("agent is streaming; specify streamingBehavior".into()),
            disposition: None,
            data: None,
        }));
        assert!(state.notice.get().unwrap().contains("streamingBehavior"));
    }

    /// Phase 1: two messages append; the second does not clear the first.
    #[test]
    fn rows_are_append_only_across_turns() {
        let mut a = Assembler::default();
        a.apply(&Event::MessageStart { message: json!({}) });
        a.apply(&delta(0, "first"));
        a.apply(&Event::MessageStart { message: json!({}) });
        a.apply(&delta(0, "second"));
        assert_eq!(texts(&a).len(), 2);
    }

    /// Phase 1: ids are strictly increasing and pairwise distinct.
    #[test]
    fn row_ids_are_monotonic_and_unique() {
        let mut a = Assembler::default();
        a.apply(&Event::AgentStart);
        a.apply(&delta(0, "x"));
        a.apply(&Event::TurnEnd {
            message: json!({}),
            tool_results: vec![],
        });
        a.apply(&Event::ToolExecutionStart {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
        });
        let mut seen = std::collections::HashSet::new();
        let mut last = None;
        for row in a.rows() {
            assert!(seen.insert(row.id), "duplicate id {}", row.id);
            if let Some(prev) = last {
                assert!(row.id > prev, "ids must increase");
            }
            last = Some(row.id);
        }
    }

    /// Phase 1: identical sequences produce identical `(id, kind)` rows — the
    /// SSR/hydrate parity seed.
    #[test]
    fn rows_are_deterministic_for_identical_sequences() {
        let events = vec![
            Event::AgentStart,
            delta(0, "hello"),
            Event::ToolExecutionStart {
                tool_call_id: "c".into(),
                tool_name: "bash".into(),
                args: json!({}),
            },
            Event::ExtensionError {
                extension_path: "/e.ts".into(),
                event: "ev".into(),
                error: "boom".into(),
            },
        ];
        let run = || {
            let mut a = Assembler::default();
            for event in &events {
                a.apply(event);
            }
            a.rows().to_vec()
        };
        assert_eq!(run(), run());
    }

    /// Phase 1: defaults are empty — hydration-safe.
    #[test]
    fn default_assembler_has_no_rows() {
        let a = Assembler::default();
        assert!(a.rows().is_empty());
        assert!(a.history().is_empty());
        let owner = leptos::prelude::Owner::new();
        owner.set();
        let state = ChatState::new();
        assert!(state.rows.get().is_empty());
    }

    /// Phase 2: streaming tool snapshots replace, never append.
    #[test]
    fn tool_update_replaces_snapshot_never_appends() {
        let mut a = Assembler::default();
        a.apply(&Event::ToolExecutionStart {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
        });
        a.apply(&Event::ToolExecutionUpdate {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
            partial_result: json!({"content": [{"type": "text", "text": "par"}]}),
        });
        a.apply(&Event::ToolExecutionUpdate {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
            partial_result: json!({"content": [{"type": "text", "text": "partial"}]}),
        });
        assert_eq!(a.rows().len(), 1);
        assert_eq!(a.rows()[0].kind.as_tool().unwrap().output, "partial");
        assert_eq!(
            a.rows()[0].kind.as_tool().unwrap().status,
            ToolStatus::Running
        );
    }

    /// Phase 2: end marks done/error and replaces the body.
    #[test]
    fn tool_end_marks_done_or_error() {
        let mut a = Assembler::default();
        a.apply(&Event::ToolExecutionStart {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
        });
        a.apply(&Event::ToolExecutionEnd {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            result: json!({"content": [{"type": "text", "text": "total 48"}]}),
            is_error: false,
        });
        let card = a.rows()[0].kind.as_tool().unwrap();
        assert_eq!(card.output, "total 48");
        assert_eq!(card.status, ToolStatus::Done);

        let mut b = Assembler::default();
        b.apply(&Event::ToolExecutionStart {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
        });
        b.apply(&Event::ToolExecutionEnd {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            result: json!({"content": [{"type": "text", "text": "boom"}]}),
            is_error: true,
        });
        assert_eq!(
            b.rows()[0].kind.as_tool().unwrap().status,
            ToolStatus::Error
        );
    }

    /// Phase 2: tool events interleave between text rows.
    #[test]
    fn tool_events_become_rows_between_text() {
        let mut a = Assembler::default();
        a.apply(&delta(0, "before"));
        a.apply(&Event::ToolExecutionStart {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
        });
        a.apply(&Event::ToolExecutionEnd {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            result: json!({"content": []}),
            is_error: false,
        });
        a.apply(&Event::MessageStart { message: json!({}) });
        a.apply(&delta(0, "after"));
        let kinds: Vec<&str> = a
            .rows()
            .iter()
            .map(|r| match r.kind {
                RowKind::Text(_) => "text",
                RowKind::Tool(_) => "tool",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["text", "tool", "text"]);
        assert!(a.rows().windows(2).all(|w| w[1].id > w[0].id));
    }

    /// Phase 2: the browser bash id-space is disjoint — no tool row.
    #[test]
    fn bash_update_does_not_create_a_tool_row() {
        let owner = leptos::prelude::Owner::new();
        owner.set();
        let state = ChatState::new();
        state.apply(&ServerMessage::Event {
            event: Event::BashExecutionUpdate {
                id: Some("b1".into()),
                delta: Some("out\n".into()),
                extra: serde_json::Map::new(),
            },
        });
        assert!(state.rows.get().is_empty());
    }

    /// Phase 3: run/turn boundaries each append a distinct marker.
    #[test]
    fn turn_and_run_boundaries_emit_markers() {
        let mut a = Assembler::default();
        a.apply(&Event::AgentStart);
        a.apply(&Event::TurnStart);
        a.apply(&Event::TurnEnd {
            message: json!({}),
            tool_results: vec![],
        });
        a.apply(&Event::AgentEnd {
            messages: vec![],
            will_retry: None,
        });
        let markers: Vec<Marker> = a
            .rows()
            .iter()
            .filter_map(|r| match r.kind {
                RowKind::Marker(m) => Some(m),
                _ => None,
            })
            .collect();
        assert_eq!(
            markers,
            vec![
                Marker::RunStart,
                Marker::TurnStart,
                Marker::TurnEnd,
                Marker::RunEnd
            ]
        );
    }

    /// Phase 3: markers interleave chronologically with text.
    #[test]
    fn markers_interleave_chronologically() {
        let mut a = Assembler::default();
        a.apply(&Event::AgentStart);
        a.apply(&delta(0, "x"));
        a.apply(&Event::TurnEnd {
            message: json!({}),
            tool_results: vec![],
        });
        let kinds: Vec<&str> = a
            .rows()
            .iter()
            .map(|r| match r.kind {
                RowKind::Marker(Marker::RunStart) => "run-start",
                RowKind::Text(_) => "text",
                RowKind::Marker(Marker::TurnEnd) => "turn-end",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["run-start", "text", "turn-end"]);
    }

    /// Audit regression: an `extension_error` arriving after a text delta but
    /// before `message_end` must not be reordered — the finalized text row is
    /// reconciled in place, so the transcript stays chronological.
    #[test]
    fn extension_error_before_message_end_keeps_chronology() {
        let mut a = Assembler::default();
        a.apply(&Event::MessageStart { message: json!({}) });
        a.apply(&delta(0, "streaming"));
        a.apply(&Event::ExtensionError {
            extension_path: "/e.ts".into(),
            event: "tool_call".into(),
            error: "boom".into(),
        });
        a.apply(&Event::MessageEnd {
            message: json!({
                "role": "assistant",
                "content": [{"type": "text", "text": "final"}]
            }),
        });
        let kinds: Vec<&str> = a
            .rows()
            .iter()
            .map(|r| match r.kind {
                RowKind::Text(_) => "text",
                RowKind::ExtensionError(_) => "error",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["text", "error"]);
        assert_eq!(a.rows()[0].kind.as_text().unwrap().text, "final");
        assert!(a.rows().windows(2).all(|w| w[1].id > w[0].id));
    }

    /// Phase 3: an extension error is a row and the stream continues.
    #[test]
    fn extension_error_is_a_row_and_stream_continues() {
        let mut a = Assembler::default();
        a.apply(&Event::ExtensionError {
            extension_path: "/e.ts".into(),
            event: "tool_call".into(),
            error: "boom".into(),
        });
        assert!(matches!(a.rows()[0].kind, RowKind::ExtensionError(_)));
        assert!(a.apply(&delta(0, "still alive")));
        assert_eq!(a.rows().len(), 2);
    }

    /// Phase 3: an empty `agent_end` still marks its boundary.
    #[test]
    fn empty_agent_end_still_marks_boundary() {
        let mut a = Assembler::default();
        a.apply(&Event::AgentEnd {
            messages: vec![],
            will_retry: None,
        });
        assert!(matches!(a.rows()[0].kind, RowKind::Marker(Marker::RunEnd)));
    }

    /// Phase 5: replay pairs a tool call with its result (one row, no duplicate).
    #[test]
    fn replay_pairs_tool_call_with_tool_result() {
        let mut a = Assembler::default();
        a.apply_replay(&[
            json!({"id": "a1", "message": {"role": "assistant", "content": [
                {"type": "toolcall", "id": "call_1", "name": "bash", "arguments": {"command": "ls"}}
            ]}}),
            json!({"id": "t1", "message": {"role": "toolResult", "toolCallId": "call_1",
                "content": [{"type": "text", "text": "total 48"}]}}),
        ]);
        assert_eq!(a.history().len(), 1);
        let card = a.history()[0].kind.as_tool().unwrap();
        assert_eq!(card.tool_call_id, "call_1");
        assert_eq!(card.output, "total 48");
        assert_eq!(card.status, ToolStatus::Done);
    }

    /// Phase 5: replay is idempotent by entry id.
    #[test]
    fn replay_is_idempotent_by_entry_id() {
        let entries = vec![
            json!({"id": "u1", "message": {"role": "user", "content": "hello"}}),
            json!({"id": "a1", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}}),
        ];
        let mut a = Assembler::default();
        assert!(a.apply_replay(&entries));
        assert!(!a.apply_replay(&entries));
        assert_eq!(a.history().len(), 2);
    }

    /// Phase 5: a result-less tool call renders a running card without panic.
    #[test]
    fn replay_tool_call_without_result_does_not_panic() {
        let mut a = Assembler::default();
        a.apply_replay(&[
            json!({"id": "a1", "message": {"role": "assistant", "content": [
                {"type": "toolcall", "id": "call_1", "name": "bash", "arguments": {}}
            ]}}),
        ]);
        assert_eq!(a.history().len(), 1);
        assert_eq!(
            a.history()[0].kind.as_tool().unwrap().status,
            ToolStatus::Running
        );
        assert!(a.history()[0].kind.as_tool().unwrap().output.is_empty());
    }

    /// Phase 5: history renders before the live run and is not reset by a
    /// `message_start`.
    #[test]
    fn rows_render_history_then_live() {
        let owner = leptos::prelude::Owner::new();
        owner.set();
        let state = ChatState::new();
        state.apply(&ServerMessage::SessionReplay {
            id: None,
            session_id: "s".into(),
            entries: vec![json!({"id": "u1", "message": {"role": "user", "content": "hi"}})],
            done: false,
        });
        assert_eq!(state.rows.get().len(), 1);
        state.apply(&ServerMessage::Event {
            event: Event::MessageStart { message: json!({}) },
        });
        state.apply(&ServerMessage::Event {
            event: delta(0, "live"),
        });
        assert_eq!(state.rows.get().len(), 2);
        assert_eq!(state.rows.get()[0].kind.as_text().unwrap().text, "hi");
        assert_eq!(state.rows.get()[1].kind.as_text().unwrap().text, "live");
    }

    /// Phase 5: the same `toolCallId` folded from replay (the SSR pass) and
    /// reduced from live `tool_execution_*` (the hydrate pass) yields the same
    /// card shape, so history and live rows cannot diverge on hydration.
    #[test]
    fn replay_and_live_agree_on_tool_shape() {
        let mut replayed = Assembler::default();
        replayed.apply_replay(&[
            json!({"id": "a1", "message": {"role": "assistant", "content": [
                {"type": "toolcall", "id": "call_1", "name": "bash", "arguments": {"command": "ls"}}
            ]}}),
            json!({"id": "t1", "message": {"role": "toolResult", "toolCallId": "call_1",
                "content": [{"type": "text", "text": "total 48"}]}}),
        ]);

        let mut live = Assembler::default();
        live.apply(&Event::ToolExecutionStart {
            tool_call_id: "call_1".into(),
            tool_name: "bash".into(),
            args: json!({"command": "ls"}),
        });
        live.apply(&Event::ToolExecutionEnd {
            tool_call_id: "call_1".into(),
            tool_name: "bash".into(),
            result: json!({"content": [{"type": "text", "text": "total 48"}]}),
            is_error: false,
        });

        assert_eq!(replayed.history().len(), 1);
        assert_eq!(live.rows().len(), 1);
        assert_eq!(
            replayed.history()[0].kind.as_tool().unwrap(),
            live.rows()[0].kind.as_tool().unwrap(),
            "replay and live tool cards must have the same shape"
        );
    }
}

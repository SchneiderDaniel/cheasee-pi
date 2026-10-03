//! Delta assembly and the reactive chat surface.
//!
//! [`Assembler`] is the pure reducer: it turns the pi event stream into an
//! ordered list of [`Block`]s, keyed by `contentIndex`, treating `*_end`
//! payloads and `message_end.message` as authoritative and `usage` as a
//! cumulative snapshot (never a sum). It has no transport and no reactive
//! runtime, so the delta-assembly test runs fast.
//!
//! [`ChatState`] is the reactive adapter: it owns an [`Assembler`] and copies
//! its snapshot into Leptos signals, coalescing per-delta writes behind a
//! frame-rate flush so a token stream does not become one DOM mutation per
//! token (precedent: the context-info TPS sampler, 150 ms).

use leptos::prelude::*;
use serde_json::Value;

use crate::bridge::ServerMessage;
use crate::protocol::{AssistantMessageEvent, Event};

/// Cap on one block's live text. Mirrors the supervisor's live buffer so a
/// long answer cannot grow unbounded now that pi no longer sends a capped
/// `partial` snapshot.
pub const MAX_LIVE_TEXT: usize = 10_000;
/// When a block exceeds [`MAX_LIVE_TEXT`] it is trimmed to this many trailing
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

/// One assembled content block. `index` is the pi `contentIndex` / element
/// index, which is what interleaved text and thinking blocks are keyed by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub index: u32,
    pub kind: BlockKind,
    pub text: String,
    /// Set when [`MAX_LIVE_TEXT`] was exceeded and text was trimmed.
    pub truncated: bool,
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

/// The pure delta assembler. See the module docs.
#[derive(Debug, Default)]
pub struct Assembler {
    blocks: Vec<Block>,
    usage: Usage,
    status: StreamStatus,
    will_retry: Option<bool>,
    /// Set once an assistant `message_end` has been applied. It is authoritative
    /// for the whole message, so any later `message_update` is a trailing delta
    /// that must not append to the final text; the flag clears only on the next
    /// `message_start` (or a fresh `agent_start`).
    finalized: bool,
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
                let changed = self.status != StreamStatus::Streaming
                    || self.will_retry.is_some()
                    || self.finalized;
                self.status = StreamStatus::Streaming;
                self.will_retry = None;
                self.finalized = false;
                changed
            }
            // A new assistant message: its blocks are built fresh, so a
            // previous run's text is never appended to.
            Event::MessageStart { .. } => {
                let changed = !self.blocks.is_empty() || self.finalized;
                self.blocks.clear();
                self.finalized = false;
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
                // `willRetry` is a separate signal from the settled state.
                if self.will_retry != *will_retry {
                    self.will_retry = *will_retry;
                    true
                } else {
                    false
                }
            }
            Event::AgentSettled => {
                let changed = self.status != StreamStatus::Settled;
                self.status = StreamStatus::Settled;
                changed
            }
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
            // Tool calls are tolerated (the block exists so an interleaved
            // index is not merged) but not rendered in this slice.
            AssistantMessageEvent::ToolcallStart { content_index, .. }
            | AssistantMessageEvent::ToolcallDelta { content_index, .. }
            | AssistantMessageEvent::ToolcallEnd { content_index, .. } => {
                self.ensure_block(content_index, BlockKind::ToolCall)
            }
            AssistantMessageEvent::Unknown => false,
        }
    }

    /// `message_end.message` is authoritative for the whole message: rebuild
    /// the block list from its `content` array rather than concatenating onto
    /// what the deltas assembled. Thinking blocks render separately from text.
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
                let Some(kind) = part.get("type").and_then(Value::as_str).and_then(block_kind) else {
                    continue;
                };
                let raw = match kind {
                    BlockKind::Text => part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
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
        if self.blocks.iter().any(|b| b.index == index) {
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
        true
    }

    pub fn blocks(&self) -> &[Block] {
        &self.blocks
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

fn block_kind(raw: &str) -> Option<BlockKind> {
    match raw {
        "text" => Some(BlockKind::Text),
        "thinking" => Some(BlockKind::Thinking),
        "toolcall" | "tool_call" => Some(BlockKind::ToolCall),
        _ => None,
    }
}

/// Bound a block's text to [`MAX_LIVE_TEXT`], keeping the trailing
/// [`LIVE_TEXT_TRIM`] characters, returning the text and whether it was cut.
fn bounded(mut text: String) -> (String, bool) {
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
/// the snapshot is copied into the display signals at most once per
/// [`FLUSH_INTERVAL_MS`] in the browser (immediately on the server, where there
/// is no frame clock).
#[derive(Clone, Copy)]
pub struct ChatState {
    assembler: RwSignal<Assembler>,
    pub blocks: RwSignal<Vec<Block>>,
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
            blocks: RwSignal::new(Vec::new()),
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
            ServerMessage::Lagged { skipped } => {
                self.lagged.update(|n| *n = n.saturating_add(*skipped));
                self.notice
                    .set(Some(format!("{skipped} events dropped (relay lag)")));
                true
            }
            ServerMessage::Error { message } => {
                self.notice.set(Some(message.clone()));
                true
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
                self.notice.set(Some(format!("malformed server frame: {err}")));
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
        let (blocks, usage, status, will_retry) = self.assembler.with(|a| {
            (
                a.blocks().to_vec(),
                a.usage(),
                a.status(),
                a.will_retry(),
            )
        });
        self.blocks.set(blocks);
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

    #[test]
    fn deltas_append_in_order() {
        let mut a = Assembler::default();
        a.apply(&Event::MessageStart { message: json!({}) });
        assert!(a.apply(&delta(0, "Hello")));
        assert!(a.apply(&delta(0, ", ")));
        a.apply(&delta(0, "world"));
        assert_eq!(a.blocks().len(), 1);
        assert_eq!(a.blocks()[0].text, "Hello, world");
        assert_eq!(a.blocks()[0].kind, BlockKind::Text);
    }

    /// AC2: blocks are keyed by `contentIndex`, so interleaved thinking and
    /// text do not merge into one block.
    #[test]
    fn interleaved_blocks_are_grouped_by_content_index() {
        let mut a = Assembler::default();
        a.apply(&delta(0, "answer"));
        a.apply(&thinking_delta(1, "hmm"));
        a.apply(&delta(0, "!"));
        a.apply(&thinking_delta(1, "?"));
        assert_eq!(a.blocks().len(), 2);
        assert_eq!(a.blocks()[0].index, 0);
        assert_eq!(a.blocks()[0].kind, BlockKind::Text);
        assert_eq!(a.blocks()[0].text, "answer!");
        assert_eq!(a.blocks()[1].index, 1);
        assert_eq!(a.blocks()[1].kind, BlockKind::Thinking);
        assert_eq!(a.blocks()[1].text, "hmm?");
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
        assert_eq!(a.blocks()[0].text, "Hello world");
    }

    /// AC3: `message_end.message` replaces the whole assembled partial, and a
    /// thinking block is rendered separately from text.
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
        assert_eq!(a.blocks().len(), 2);
        assert_eq!(a.blocks()[0].kind, BlockKind::Thinking);
        assert_eq!(a.blocks()[0].text, "let me think");
        assert_eq!(a.blocks()[1].kind, BlockKind::Text);
        assert_eq!(a.blocks()[1].text, "final answer");
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
        assert_eq!(a.blocks()[0].text, "final");
        // The next message start re-opens assembly.
        assert!(a.apply(&Event::MessageStart { message: json!({}) }));
        assert!(a.apply(&delta(0, "second")));
        assert_eq!(a.blocks()[0].text, "second");
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
        assert_eq!(a.status(), StreamStatus::Streaming, "agent_end may still be retried");
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
        assert!(a.blocks()[0].truncated);
        assert!(a.blocks()[0].text.len() <= MAX_LIVE_TEXT);
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
        assert_eq!(a.blocks()[0].text, "hi");
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
        }));
        assert!(state.notice.get().unwrap().contains("streamingBehavior"));
    }
}

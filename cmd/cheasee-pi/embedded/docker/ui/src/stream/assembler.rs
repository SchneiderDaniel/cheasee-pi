use super::*;

use super::rows::{block_kind, bounded, floor_char_boundary, row_kinds_from_message, text_row, usage_from_value};

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
    pub fn reduce_event(&mut self, event: &Event) -> bool {
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

mod replay;

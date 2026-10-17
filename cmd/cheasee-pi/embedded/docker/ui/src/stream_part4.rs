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
    pub fn reduce_transcript(&self, message: &ServerMessage) -> bool {
        match message {
            ServerMessage::Event { event } => {
                // `try_maybe_update` notifies subscribers only when the
                // assembler reports a change.
                let changed = self
                    .assembler
                    .try_maybe_update(|a| {
                        let changed = a.reduce_event(event);
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

    /// Surface a malformed frame instead of killing the connection.
    pub fn note_malformed_frame(&self, err: &serde_json::Error) -> bool {
        self.notice
            .set(Some(format!("malformed server frame: {err}")));
        true
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


/// A session event pushed from the pi child on stdout (`docs/rpc.md`).
///
/// Events generally carry no command id — they describe session activity.
/// `bash_execution_update` is the documented exception: when the originating
/// `bash` command has an id, its output events repeat that id. A record whose
/// `type` is not `"response"` is therefore never consumed as a response, even
/// when its id matches a pending command (AC2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Event {
    AgentStart,
    AgentEnd {
        #[serde(default)]
        messages: Vec<Value>,
        /// Pi ended this low-level run but will retry it automatically. Set
        /// independently of the settled state, so the UI surfaces it instead
        /// of showing a stopped spinner (`docs/json.md`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        will_retry: Option<bool>,
    },
    /// Pi will not continue automatically. This — not `agent_end` — is where
    /// the streaming indicator clears: retry, overflow recovery, compaction
    /// retry, steering and follow-up work can all still follow an `agent_end`
    /// (`docs/json.md`).
    AgentSettled,
    TurnStart,
    TurnEnd {
        message: Value,
        #[serde(default)]
        tool_results: Vec<Value>,
    },
    MessageStart {
        message: Value,
    },
    /// A streaming delta. `usage` is the latest **cumulative**
    /// provider-reported usage for the assistant response — it is not a delta,
    /// and can stay zero until completion when the provider reports nothing
    /// while streaming (`docs/json.md`). Slice 5 renders it.
    ///
    /// `message` is *optional*: pi >=0.84 removed the cumulative `message`
    /// field (and every `assistantMessageEvent.partial` snapshot) to fix
    /// quadratic output growth, emitting only `usage` + `assistantMessageEvent`.
    /// A required field here would fail the decode and silently drop every
    /// delta into [`crate::rpc::ProtocolMessage::Unknown`].
    MessageUpdate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<Value>,
        assistant_message_event: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Value>,
    },
    MessageEnd {
        message: Value,
    },
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        args: Value,
    },
    ToolExecutionUpdate {
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        args: Value,
        #[serde(default)]
        partial_result: Value,
    },
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        is_error: bool,
    },
    QueueUpdate {
        #[serde(default)]
        steering: Vec<String>,
        #[serde(default)]
        follow_up: Vec<String>,
    },
    CompactionStart {
        reason: String,
    },
    CompactionEnd {
        reason: String,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        aborted: bool,
        #[serde(default)]
        will_retry: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
    },
    AutoRetryStart {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        error_message: String,
    },
    AutoRetryEnd {
        success: bool,
        attempt: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        final_error: Option<String>,
    },
    /// Summarization-retry lifecycle for the compaction/summarization path.
    /// Pinned pi 0.79.10 never emits these; they are modelled additively so a
    /// newer pi's retry pills render and the enum stays open (a closed enum
    /// would hard-error the stream).
    SummarizationRetryScheduled {
        attempt: u32,
        #[serde(default)]
        max_attempts: u32,
        #[serde(default)]
        delay_ms: u64,
        #[serde(default)]
        error_message: String,
    },
    SummarizationRetryAttemptStart {
        attempt: u32,
        #[serde(default)]
        max_attempts: u32,
        #[serde(default)]
        delay_ms: u64,
        #[serde(default)]
        error_message: String,
    },
    SummarizationRetryFinished {
        success: bool,
        #[serde(default)]
        attempt: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        final_error: Option<String>,
    },
    /// The active thinking level changed without a command — the UI follows
    /// this instead of polling `get_state` after every `set_thinking_level`.
    ThinkingLevelChanged {
        level: String,
    },
    ExtensionError {
        extension_path: String,
        event: String,
        error: String,
    },
    /// Bash tool output. Not documented in the pinned 0.79.10 docs, but the
    /// epic needs it: it repeats the originating `bash` command's `id`, so the
    /// client must not mistake it for that command's response. The payload
    /// beyond the id is unmodelled, so it is kept verbatim rather than guessed
    /// at and dropped.
    /// `delta` is a raw stdout/stderr chunk, not a line, so the consumer must
    /// reassemble lines. It is optional and typed; a non-`delta` payload (e.g.
    /// the legacy `output` key) is preserved in `extra` and read by
    /// [`Event::bash_delta`]. No serde alias: an alias would serialize the
    /// legacy key back as `delta` and break the fixture round-trip.
    BashExecutionUpdate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delta: Option<String>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// An event type this build does not model. Decoding succeeds; a closed
    /// enum would hard-error the stream on exactly the events the epic renders.
    #[serde(other)]
    Unknown,
}

impl Event {
    /// The bash output chunk of a [`Event::BashExecutionUpdate`], tolerating the
    /// legacy `output` key. `None` means the event carries no output text.
    pub fn bash_delta(&self) -> Option<&str> {
        match self {
            Event::BashExecutionUpdate { delta, extra, .. } => delta
                .as_deref()
                .or_else(|| extra.get("output").and_then(Value::as_str))
                .or_else(|| extra.get("delta").and_then(Value::as_str)),
            _ => None,
        }
    }
}

/// The `assistantMessageEvent` payload of a [`Event::MessageUpdate`].
///
/// Delta event shapes on the wire (`docs/json.md`): `text_delta` is
/// `{contentIndex, delta}`, `text_end` is `{contentIndex, content}` with the
/// authoritative block text. `contentIndex` is the index into the message's
/// `content` array, so text, thinking and tool-call blocks interleave — the
/// assembler must key accumulated state by index, not by block kind.
///
/// Forward compatible: an unknown `type` decodes to [`Self::Unknown`] rather
/// than failing the whole record, because `Event` keeps this raw and parses it
/// with [`Self::parse_lenient`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AssistantMessageEvent {
    TextStart {
        content_index: u32,
    },
    TextDelta {
        content_index: u32,
        #[serde(default)]
        delta: String,
    },
    TextEnd {
        content_index: u32,
        #[serde(default)]
        content: String,
    },
    ThinkingStart {
        content_index: u32,
    },
    ThinkingDelta {
        content_index: u32,
        #[serde(default)]
        delta: String,
    },
    ThinkingEnd {
        content_index: u32,
        #[serde(default)]
        content: String,
    },
    ToolcallStart {
        content_index: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
    },
    ToolcallDelta {
        content_index: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delta: Option<Value>,
    },
    ToolcallEnd {
        content_index: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call: Option<Value>,
    },
    /// An event type this build does not model; the assembler ignores it
    /// without dropping the surrounding `message_update`.
    #[serde(other)]
    Unknown,
}

impl AssistantMessageEvent {
    /// Tolerant decode of a raw `assistantMessageEvent` value.
    ///
    /// Returns `None` only when the value is not an object carrying a `type`
    /// string; a known `type` with an unexpected payload, or an unmodelled
    /// `type`, yields [`AssistantMessageEvent::Unknown`] instead of a hard
    /// decode failure.
    pub fn parse_lenient(value: &Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// An `extension_ui_request` from pi: a dialog or fire-and-forget UI call
/// issued by an extension (`docs/rpc-extension-ui.md`).
///
/// `id` is pi's uuid, not the client's; the matching
/// [`ExtensionUiResponse`] echoes it and is **not** correlated through the
/// command id map ("It does not produce a normal command response").
///
/// `method` stays a string and the method-specific fields stay in `params`
/// rather than becoming nine typed variants: pi can add a method without a
/// client release, and a typed enum would turn that into a stream-killing
/// decode error (AC5). Known methods: `select`, `confirm`, `input`, `editor`,
/// `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionUiRequest {
    pub id: String,
    pub method: String,
    #[serde(flatten)]
    pub params: Map<String, Value>,
}

/// An `extension_ui_response` from pi, or the one we send back.
///
/// Exactly one of the three shapes is present: `value`, `confirmed`, or
/// `cancelled: true`. They are modelled as optional fields rather than an
/// untagged enum because pi does not tag the shapes — the presence of the key
/// is the discriminator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionUiResponse {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
}

/// The extension UI sub-protocol, both directions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtensionUI {
    ExtensionUiRequest(ExtensionUiRequest),
    ExtensionUiResponse(ExtensionUiResponse),
    /// A UI record this build does not model.
    #[serde(other)]
    Unknown,
}

// ── Response `data` payloads (AC2/AC3/AC5) ───────────────────────────────────
// These are the typed shapes the controls read out of `ResponseBody.data`.
// Every field is defaulted, so a pi release that adds or drops one still
// decodes; the caller decides what a missing field means.

/// One `Model` from `get_available_models` / the echoed `set_model` payload.
///
/// Only the fields the picker displays are typed; the rest of pi's `Model`
/// object is ignored (it is never sent back).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub context_window: Option<u64>,
}

impl ModelInfo {
    /// The label the picker shows: the model name, falling back to its id.
    pub fn label(&self) -> &str {
        if self.name.is_empty() {
            &self.id
        } else {
            &self.name
        }
    }
}

/// `get_available_thinking_levels` payload. `["off"]` means the active model
/// does not support reasoning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingLevels {
    #[serde(default)]
    pub levels: Vec<String>,
}

/// Token counters nested inside [`SessionStats`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokens {
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
    #[serde(default)]
    pub total: u64,
}

/// Context-window usage. `tokens` and `percent` are **null when unknown**
/// (right after compaction, before the next provider response), which is a
/// third state distinct from 0 and 100.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    #[serde(default)]
    pub tokens: Option<u64>,
    #[serde(default)]
    pub context_window: u64,
    #[serde(default)]
    pub percent: Option<f64>,
}

/// `get_session_stats` payload: cumulative session totals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub user_messages: u64,
    #[serde(default)]
    pub assistant_messages: u64,
    #[serde(default)]
    pub tool_calls: u64,
    #[serde(default)]
    pub tool_results: u64,
    #[serde(default)]
    pub total_messages: u64,
    #[serde(default)]
    pub tokens: SessionTokens,
    #[serde(default)]
    pub cost: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<ContextUsage>,
}

/// The full pending queue as pi reports it. `queue_update` carries this shape,
/// and `clear_queue` returns the text it removed in the same shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueContents {
    #[serde(default)]
    pub steering: Vec<String>,
    #[serde(default)]
    pub follow_up: Vec<String>,
}

impl QueueContents {
    pub fn is_empty(&self) -> bool {
        self.steering.is_empty() && self.follow_up.is_empty()
    }

    /// The removed text as one editable draft, preserving the order pi held.
    pub fn as_draft(&self) -> String {
        self.steering
            .iter()
            .chain(self.follow_up.iter())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// `clear_queue`'s response payload — the queue it emptied.
///
/// Same shape as [`QueueContents`]; kept as a named alias so the response
/// meaning is readable at the call site without a second identical struct.
pub type ClearQueueData = QueueContents;

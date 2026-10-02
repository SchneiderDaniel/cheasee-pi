//! Shared wire DTOs.
//!
//! Innermost module: serde only. It must not import axum, web-sys, or any
//! transport type — the WS is framing-agnostic in this slice: every JSON text
//! frame is echoed verbatim. Slice 4 layers strict JSONL framing *above* these
//! types on the child pipe.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// ── Slice 4: the wire vocabulary ────────────────────────────────────────────
// Every pi RPC record is one of four families (`docs/rpc.md`): commands in,
// responses and session events out, extension UI both ways. Each family is an
// enum here so a consuming slice matches on a variant instead of re-walking
// `serde_json::Value` ad hoc.
//
// Two rules hold for every type below:
//
// * **Forward compatible.** Each family carries a catch-all (`Unknown`) and no
//   type denies unknown fields. pi ships as `PI_VERSION=latest`, so a release
//   that adds a command, event, or field must not hard-error the record stream
//   (AC5: no parse failure may kill the stream).
// * **Partially typed on purpose.** Payloads that a later slice owns (model
//   objects, agent messages, tool results) stay raw `Value` until that slice
//   types them. Typing them now would churn against every pi release.
//
// The variants below were captured from the vendored
// `@earendil-works/pi-coding-agent@0.79.10` (`dist/modes/rpc/rpc-types.d.ts`),
// which documents 29 commands and 16 session events.

/// A command sent to the pi child on stdin (`docs/rpc-commands.md`).
///
/// Internally tagged on `type`; every variant accepts an optional string `id`,
/// which pi echoes on the matching response (`docs/rpc.md`: "Every command
/// accepts an optional string `id`").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Command {
    Prompt {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        streaming_behavior: Option<String>,
    },
    Steer {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<Value>>,
    },
    FollowUp {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        images: Option<Vec<Value>>,
    },
    Abort {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    NewSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_session: Option<String>,
    },
    GetState {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SetModel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        provider: String,
        model_id: String,
    },
    CycleModel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetAvailableModels {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SetThinkingLevel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        level: String,
    },
    CycleThinkingLevel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SetSteeringMode {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        mode: String,
    },
    SetFollowUpMode {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        mode: String,
    },
    Compact {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
    },
    SetAutoCompaction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        enabled: bool,
    },
    SetAutoRetry {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        enabled: bool,
    },
    AbortRetry {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Bash {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exclude_from_context: Option<bool>,
    },
    AbortBash {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetSessionStats {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    ExportHtml {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_path: Option<String>,
    },
    SwitchSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        session_path: String,
    },
    Fork {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        entry_id: String,
    },
    Clone {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetForkMessages {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetLastAssistantText {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SetSessionName {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        name: String,
    },
    GetMessages {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetCommands {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// A command type this build does not model. Decoding succeeds; the caller
    /// keeps the stream alive rather than failing the whole record (AC5).
    #[serde(other)]
    Unknown,
}

/// The body every [`Response`] variant shares: `id`/`success`/`error` are on
/// each response, and `data` is the per-command payload, kept raw until a
/// consuming slice types it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// A response to a [`Command`], discriminated on `command`.
///
/// The outer `type: "response"` is constant, so it is not modelled as a field:
/// responses are decoded off the child's stdout and never sent back, and a
/// second tag would only have to be kept in sync. `command` is the second tag
/// (`docs/rpc.md`), which is why `#[serde(other)]` sits here rather than on a
/// single flat record type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum Response {
    Prompt(ResponseBody),
    Steer(ResponseBody),
    FollowUp(ResponseBody),
    Abort(ResponseBody),
    NewSession(ResponseBody),
    GetState(ResponseBody),
    SetModel(ResponseBody),
    CycleModel(ResponseBody),
    GetAvailableModels(ResponseBody),
    SetThinkingLevel(ResponseBody),
    CycleThinkingLevel(ResponseBody),
    SetSteeringMode(ResponseBody),
    SetFollowUpMode(ResponseBody),
    Compact(ResponseBody),
    SetAutoCompaction(ResponseBody),
    SetAutoRetry(ResponseBody),
    AbortRetry(ResponseBody),
    Bash(ResponseBody),
    AbortBash(ResponseBody),
    GetSessionStats(ResponseBody),
    ExportHtml(ResponseBody),
    SwitchSession(ResponseBody),
    Fork(ResponseBody),
    Clone(ResponseBody),
    GetForkMessages(ResponseBody),
    GetLastAssistantText(ResponseBody),
    SetSessionName(ResponseBody),
    GetMessages(ResponseBody),
    GetCommands(ResponseBody),
    /// The `command:"parse"` failure arm and any command this build does not
    /// model. Malformed input produces a response without a request id
    /// (`docs/rpc.md`), so the client must route it somewhere other than the
    /// id map (AC5).
    #[serde(other)]
    Unknown,
}

impl Response {
    /// The shared body, when the response has one.
    pub fn body(&self) -> Option<&ResponseBody> {
        match self {
            Self::Unknown => None,
            Self::Prompt(b)
            | Self::Steer(b)
            | Self::FollowUp(b)
            | Self::Abort(b)
            | Self::NewSession(b)
            | Self::GetState(b)
            | Self::SetModel(b)
            | Self::CycleModel(b)
            | Self::GetAvailableModels(b)
            | Self::SetThinkingLevel(b)
            | Self::CycleThinkingLevel(b)
            | Self::SetSteeringMode(b)
            | Self::SetFollowUpMode(b)
            | Self::Compact(b)
            | Self::SetAutoCompaction(b)
            | Self::SetAutoRetry(b)
            | Self::AbortRetry(b)
            | Self::Bash(b)
            | Self::AbortBash(b)
            | Self::GetSessionStats(b)
            | Self::ExportHtml(b)
            | Self::SwitchSession(b)
            | Self::Fork(b)
            | Self::Clone(b)
            | Self::GetForkMessages(b)
            | Self::GetLastAssistantText(b)
            | Self::SetSessionName(b)
            | Self::GetMessages(b)
            | Self::GetCommands(b) => Some(b),
        }
    }
}

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
    },
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
    MessageUpdate {
        message: Value,
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
    BashExecutionUpdate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// An event type this build does not model (e.g. `agent_settled`, which
    /// the pinned pi documents nowhere). Decoding succeeds; a closed enum would
    /// hard-error the stream on exactly the events the epic renders.
    #[serde(other)]
    Unknown,
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

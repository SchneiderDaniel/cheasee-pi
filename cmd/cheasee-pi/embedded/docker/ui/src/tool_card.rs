//! The pure tool-card reducer: one [`ToolCard`] per `toolCallId`.
//!
//! pi streams a bash tool by re-sending a **full snapshot** of its output on
//! every `tool_execution_update` (throttled to ~100 ms), never a delta, so an
//! update must *replace* the body — appending would duplicate the output on
//! every tick. Bodies are `(TextContent | ImageContent)[]` and the first update
//! can be empty, so [`content_text`] joins the text parts and skips everything
//! else instead of indexing `[0].text`.
//!
//! The card lives in the durable transcript (see [`crate::stream`]); the
//! browser-initiated inline shell (`bash_execution_update`, keyed by command
//! id) is a separate surface with a disjoint id-space and never reaches here.

use serde_json::Value;

use crate::stream::bounded;

/// A tool call's lifecycle. `Running` until `tool_execution_end` reports
/// success or error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolStatus {
    #[default]
    Running,
    Done,
    Error,
}

impl ToolStatus {
    pub fn label(self) -> &'static str {
        match self {
            ToolStatus::Running => "running",
            ToolStatus::Done => "done",
            ToolStatus::Error => "error",
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            ToolStatus::Running => "running",
            ToolStatus::Done => "done",
            ToolStatus::Error => "error",
        }
    }
}

/// One tool call as the transcript renders it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCard {
    pub tool_call_id: String,
    pub name: String,
    pub args: String,
    pub output: String,
    pub status: ToolStatus,
    pub truncated: bool,
}

impl ToolCard {
    /// A card opened by `tool_execution_start`.
    pub fn start(tool_call_id: &str, name: &str, args: &Value) -> Self {
        Self {
            tool_call_id: tool_call_id.to_string(),
            name: name.to_string(),
            args: args_text(args),
            output: String::new(),
            status: ToolStatus::Running,
            truncated: false,
        }
    }

    /// Apply a `tool_execution_update`. `partialResult` is a full snapshot, so
    /// the output is replaced wholesale. Returns whether anything changed.
    pub fn update(&mut self, args: &Value, partial_result: &Value) -> bool {
        let mut changed = false;
        let args = args_text(args);
        if self.args != args {
            self.args = args;
            changed = true;
        }
        let (text, truncated) = bounded(content_text(partial_result));
        if self.output != text || self.truncated != truncated {
            self.output = text;
            self.truncated = truncated;
            changed = true;
        }
        changed
    }

    /// Apply a `tool_execution_end`: the result is authoritative and the state
    /// becomes [`ToolStatus::Done`] or [`ToolStatus::Error`].
    pub fn end(&mut self, result: &Value, is_error: bool) -> bool {
        let (text, truncated) = bounded(content_text(result));
        let status = if is_error {
            ToolStatus::Error
        } else {
            ToolStatus::Done
        };
        let mut changed = false;
        if self.output != text || self.truncated != truncated {
            self.output = text;
            self.truncated = truncated;
            changed = true;
        }
        if self.status != status {
            self.status = status;
            changed = true;
        }
        changed
    }
}

/// The text of a tool result body. Accepts `{content: [parts]}` (the wire
/// shape) or a bare array of parts; joins text parts with a newline and skips
/// non-text parts (images) and empty/missing content.
pub fn content_text(value: &Value) -> String {
    let parts = value
        .get("content")
        .and_then(Value::as_array)
        .or_else(|| value.as_array());
    match parts {
        Some(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        None => value.as_str().map(str::to_string).unwrap_or_default(),
    }
}

/// Render tool arguments as one line of text. `null`/absent args are empty.
fn args_text(args: &Value) -> String {
    match args {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

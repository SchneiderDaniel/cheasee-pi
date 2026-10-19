use super::*;

pub(super) fn text_row(kind: BlockKind, content_index: u32, text: String, truncated: bool) -> RowKind {
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

pub(super) fn block_kind(raw: &str) -> Option<BlockKind> {
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
pub(super) fn row_kinds_from_message(message: &Value) -> Vec<RowKind> {
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
pub(super) fn floor_char_boundary(mut index: usize, text: &str) -> usize {
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
pub(super) fn usage_from_value(value: &Value) -> Option<Usage> {
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

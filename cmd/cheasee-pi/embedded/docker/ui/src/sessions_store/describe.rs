//! The session row's display text, as one pure rule.
//!
//! Pi's `/resume` list renders `session.name ?? session.firstMessage`
//! (`session-selector.js`, `buildSessionInfo` in the pinned 1.0.2 tree), so the
//! sidecar's session list shows the same thing: the session name when it has
//! one, else the first user message. Everything is computed here — the JSONL
//! parser supplies the raw name and first message, the wire DTO carries the
//! finished string, and the panel only decides the `id` fallback when there is
//! no description at all.
//!
//! Pi's `(no messages)` placeholder is deliberately not replicated: `None`
//! lets the panel fall back to the id, which is already visible and more
//! identifying than a shared placeholder.

/// Longest description the server sends. A first user message is often a
/// paragraph; the list only needs enough text to identify the session.
pub const MAX_DESCRIPTION_CHARS: usize = 120;

/// The row's display text: the name when it has one, else the first user
/// message, `None` when neither survives normalization.
pub fn describe(name: Option<&str>, first_message: Option<&str>) -> Option<String> {
    normalize(name).or_else(|| normalize(first_message))
}

/// Control chars and whitespace runs become single spaces and the ends are
/// trimmed, then the result is capped at [`MAX_DESCRIPTION_CHARS`] characters.
/// `None` when nothing is left — a whitespace-only name or message is not a
/// description.
fn normalize(text: Option<&str>) -> Option<String> {
    let text = text?;
    let collapsed = collapse(text);
    if collapsed.is_empty() {
        return None;
    }
    Some(truncate(&collapsed))
}

/// A control char (C0 and DEL) or a whitespace run collapses to one space;
/// leading and trailing runs are dropped, so the result is already trimmed.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.chars() {
        if is_control(ch) || ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push(ch);
    }
    out
}

fn is_control(ch: char) -> bool {
    let code = ch as u32;
    code <= 0x1f || code == 0x7f
}

/// Truncate by characters, never by bytes: slicing a multi-byte boundary would
/// panic on any CJK or emoji prompt.
fn truncate(text: &str) -> String {
    if text.chars().count() <= MAX_DESCRIPTION_CHARS {
        return text.to_string();
    }
    text.chars().take(MAX_DESCRIPTION_CHARS).collect()
}

#[cfg(test)]
mod tests;

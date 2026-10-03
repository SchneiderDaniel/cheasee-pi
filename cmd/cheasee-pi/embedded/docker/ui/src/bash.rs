//! Bash streaming output: chunk -> line reassembly, pure and transport-free.
//!
//! pi emits one [`crate::protocol::Event::BashExecutionUpdate`] per raw
//! stdout/stderr chunk from the child (`onChunk`), not per line. Rendering each
//! chunk as a line would split or merge lines, so [`BashLog`] holds a
//! partial-line buffer and only emits whole lines. [`BashLogs`] is the one
//! place command-id -> stream routing happens, so concurrent commands cannot
//! cross streams.
//!
//! The line/byte caps mirror pi's own `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`:
//! once a log is truncated the view shows a terminal state — pi writes the full
//! copy to a container-local `fullOutputPath` the browser cannot fetch, so
//! "view full output" is deliberately not offered.

use std::collections::HashMap;

/// pi's `DEFAULT_MAX_LINES`: after this many lines output is truncated.
pub const MAX_LINES: usize = 2000;
/// pi's `DEFAULT_MAX_BYTES`: after this many bytes output is truncated.
pub const MAX_BYTES: usize = 50 * 1024;

/// One command's reassembled output. Pure: no transport, no reactive runtime,
/// so the chunk-assembly test runs fast.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BashLog {
    lines: Vec<String>,
    /// Bytes of the line not yet terminated by a newline.
    pending: String,
    bytes: usize,
    truncated: bool,
    finished: bool,
}

impl BashLog {
    /// Append one raw chunk, emitting every complete line it contains. An empty
    /// chunk is a no-op; a truncated or finished log ignores further input.
    pub fn push_chunk(&mut self, chunk: &str) {
        if chunk.is_empty() || self.truncated || self.finished {
            return;
        }
        self.bytes += chunk.len();
        self.pending.push_str(chunk);
        self.drain_lines();
        if self.bytes > MAX_BYTES {
            self.truncated = true;
        }
    }

    /// Flush the pending partial line (the barrier between chunks is EOF).
    pub fn finish(&mut self) {
        if self.truncated || self.finished {
            return;
        }
        self.finished = true;
        if self.pending.is_empty() {
            return;
        }
        if self.lines.len() >= MAX_LINES {
            self.truncated = true;
            return;
        }
        self.lines.push(std::mem::take(&mut self.pending));
    }

    fn drain_lines(&mut self) {
        while let Some(pos) = self.pending.find('\n') {
            if self.lines.len() >= MAX_LINES {
                self.truncated = true;
                return;
            }
            let line: String = self.pending.drain(..=pos).collect();
            self.lines
                .push(line.trim_end_matches('\n').trim_end_matches('\r').to_string());
        }
    }

    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    /// The trailing line not yet terminated by a newline, if any.
    pub fn pending(&self) -> &str {
        &self.pending
    }

    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }
}

/// Per-command logs keyed by the `bash` command's id. The map is the only
/// id -> stream join point, so a chunk for `b1` can never land in `b2`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BashLogs {
    logs: HashMap<String, BashLog>,
    order: Vec<String>,
}

impl BashLogs {
    /// Append a chunk to `id`'s log, creating it on first sight.
    pub fn push(&mut self, id: &str, chunk: &str) {
        if !self.logs.contains_key(id) {
            self.order.push(id.to_string());
        }
        self.logs.entry(id.to_string()).or_default().push_chunk(chunk);
    }

    /// Mark `id`'s log finished, flushing its partial line.
    pub fn finish(&mut self, id: &str) {
        if let Some(log) = self.logs.get_mut(id) {
            log.finish();
        }
    }

    pub fn get(&self, id: &str) -> Option<&BashLog> {
        self.logs.get(id)
    }

    /// Command ids in first-seen order, for stable rendering.
    pub fn ids(&self) -> &[String] {
        &self.order
    }

    pub fn is_empty(&self) -> bool {
        self.logs.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AC4: a chunk boundary is not a line boundary. The partial-line buffer
    /// joins `foo` + `bar\n` into one line.
    #[test]
    fn bash_chunks_join_into_whole_lines() {
        let mut log = BashLog::default();
        log.push_chunk("foo");
        assert!(log.lines().is_empty());
        assert_eq!(log.pending(), "foo");
        log.push_chunk("bar\n");
        assert_eq!(log.lines(), &["foobar"]);
        assert_eq!(log.pending(), "");
    }

    /// AC4: a chunk carrying several lines emits them, keeping the final
    /// partial one pending.
    #[test]
    fn bash_one_chunk_can_carry_many_lines() {
        let mut log = BashLog::default();
        log.push_chunk("a\nb");
        assert_eq!(log.lines(), &["a"]);
        assert_eq!(log.pending(), "b");
    }

    #[test]
    fn bash_finish_flushes_the_partial_line() {
        let mut log = BashLog::default();
        log.push_chunk("no newline");
        log.finish();
        assert_eq!(log.lines(), &["no newline"]);
        assert!(log.is_finished());
        // After finish the log is immutable.
        log.push_chunk("late");
        assert_eq!(log.lines(), &["no newline"]);
    }

    /// AC4: two concurrent commands never cross streams.
    #[test]
    fn bash_logs_route_by_id() {
        let mut logs = BashLogs::default();
        logs.push("b1", "one\n");
        logs.push("b2", "two\n");
        logs.push("b1", "uno\n");
        assert_eq!(logs.get("b1").unwrap().lines(), &["one", "uno"]);
        assert_eq!(logs.get("b2").unwrap().lines(), &["two"]);
        assert_eq!(logs.ids(), ["b1", "b2"]);
    }

    /// AC4: the 2001st line trips `truncated` with the count pinned at the cap.
    #[test]
    fn bash_truncates_at_the_line_cap() {
        let mut log = BashLog::default();
        for i in 0..=MAX_LINES {
            log.push_chunk(&format!("line {i}\n"));
        }
        assert!(log.is_truncated());
        assert_eq!(log.lines().len(), MAX_LINES);
    }

    #[test]
    fn bash_truncates_at_the_byte_cap() {
        let mut log = BashLog::default();
        log.push_chunk(&"x".repeat(MAX_BYTES + 1));
        assert!(log.is_truncated());
    }

    #[test]
    fn bash_empty_chunks_are_no_ops() {
        let mut log = BashLog::default();
        log.push_chunk("");
        assert!(log.lines().is_empty());
        assert_eq!(log.pending(), "");
    }

    /// AC4: interleaved chunks on one id append in arrival order.
    #[test]
    fn bash_interleaved_chunks_append_in_order() {
        let mut logs = BashLogs::default();
        logs.push("b1", "1\n");
        logs.push("b1", "2\n");
        logs.push("b2", "x\n");
        logs.push("b1", "3\n");
        assert_eq!(logs.get("b1").unwrap().lines(), &["1", "2", "3"]);
    }
}

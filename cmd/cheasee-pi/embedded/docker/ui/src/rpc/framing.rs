//! Strict JSONL framing for the pi child's pipes (`docs/rpc.md`, "Framing").
//!
//! pi's framing rules, verbatim:
//!
//! * split records on LF (`\n`) **only**;
//! * accept optional `\r\n` input by stripping a trailing `\r`;
//! * never use a generic line reader that treats Unicode separators as
//!   newlines — Node's `readline` is explicitly not protocol-compliant because
//!   it also splits on `U+2028`/`U+2029`, which are valid raw inside JSON
//!   strings.
//!
//! This module owns record boundaries and nothing else: no correlation, no
//! serde typing. It works on raw bytes, because the two failure classes AC5
//! separates are only distinguishable at this level — "these bytes are not
//! UTF-8" is a transport fault, "these bytes are not JSON" is a protocol
//! fault, and a `BufReader::lines()`/`LinesCodec` pipeline collapses both into
//! one `InvalidData` error.
//!
//! A Linux pipe is a byte stream with no message boundaries, so a record can
//! arrive split across reads or several records can arrive in one read. The
//! reader is therefore a state machine over `fill_buf`/`consume`, never a
//! write-per-record assumption.

use std::io;

use serde::Serialize;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// Hard cap on one record, in bytes. The child's stdout is untrusted input
/// (the `pi` binary is pinned to `latest`), so a peer that never sends LF must
/// not grow the accumulator without bound. 8 MiB is far above any observed
/// record (the largest are base64 image payloads) and far below memory
/// pressure.
pub const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;

/// Why a record could not be produced. The variants deliberately keep
/// transport faults (`Io`, `NotUtf8`, `TooLong`) distinct from protocol faults,
/// which the client raises separately as JSON parse errors.
#[derive(Debug)]
pub enum FramingError {
    /// The underlying stream failed.
    Io(io::Error),
    /// The record's bytes are not valid UTF-8. A transport fault, not a JSON
    /// one: the caller must not report it as a parse failure.
    NotUtf8,
    /// The record exceeded [`MAX_RECORD_BYTES`] before its LF arrived.
    TooLong { limit: usize },
    /// The stream ended mid-record. The tail is *not* delivered as a record —
    /// AC5's kill-the-child case ends here, and a silently delivered partial
    /// record would be worse than a surfaced error.
    UnterminatedTail { bytes: usize },
}

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "child stdout read failed: {err}"),
            Self::NotUtf8 => write!(f, "record is not valid UTF-8"),
            Self::TooLong { limit } => {
                write!(f, "record exceeded the {limit}-byte limit before its LF")
            }
            Self::UnterminatedTail { bytes } => {
                write!(f, "child stdout ended mid-record ({bytes} bytes without LF)")
            }
        }
    }
}

impl std::error::Error for FramingError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            _ => None,
        }
    }
}

// `io::Error` is not `Clone`, so the fan-out message cannot derive `Clone` on
// `FramingError`. Reconstructing the `Io` arm preserves its kind and message,
// which is all a `ProtocolMessage` consumer renders.
impl Clone for FramingError {
    fn clone(&self) -> Self {
        match self {
            Self::Io(err) => Self::Io(io::Error::new(err.kind(), err.to_string())),
            Self::NotUtf8 => Self::NotUtf8,
            Self::TooLong { limit } => Self::TooLong { limit: *limit },
            Self::UnterminatedTail { bytes } => Self::UnterminatedTail { bytes: *bytes },
        }
    }
}

impl From<io::Error> for FramingError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

/// LF-only record splitter over any [`AsyncBufRead`].
///
/// Returns raw bytes: UTF-8 validity is the caller's explicit choice, so a
/// byte-level fault can never be reported as a JSON fault.
pub struct JsonlReader<R> {
    inner: R,
    partial: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> JsonlReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            partial: Vec::new(),
        }
    }

    /// The next record's bytes, without its LF and without a single trailing
    /// CR. `Ok(None)` means the stream ended cleanly on a record boundary.
    pub async fn next_record(&mut self) -> Result<Option<Vec<u8>>, FramingError> {
        loop {
            // Only LF ends a record. `U+2028`/`U+2029` are ordinary bytes here,
            // which is exactly what a generic line reader gets wrong.
            let (lf_at, consumed) = {
                let available = self.inner.fill_buf().await?;
                if available.is_empty() {
                    return if self.partial.is_empty() {
                        // Ended on a boundary: no phantom trailing record.
                        Ok(None)
                    } else {
                        Err(FramingError::UnterminatedTail {
                            bytes: self.partial.len(),
                        })
                    };
                }
                match available.iter().position(|&b| b == b'\n') {
                    Some(at) => {
                        if self.partial.len() + at > MAX_RECORD_BYTES {
                            return Err(FramingError::TooLong {
                                limit: MAX_RECORD_BYTES,
                            });
                        }
                        self.partial.extend_from_slice(&available[..at]);
                        (true, at + 1)
                    }
                    None => {
                        if self.partial.len() + available.len() > MAX_RECORD_BYTES {
                            return Err(FramingError::TooLong {
                                limit: MAX_RECORD_BYTES,
                            });
                        }
                        self.partial.extend_from_slice(available);
                        (false, available.len())
                    }
                }
            };
            self.inner.consume(consumed);

            if lf_at {
                let mut record = std::mem::take(&mut self.partial);
                // Exactly one trailing CR, per pi's strip-one rule: a record
                // that genuinely ends in `\r\r` keeps one.
                if record.last() == Some(&b'\r') {
                    record.pop();
                }
                return Ok(Some(record));
            }
        }
    }

    /// Give back the underlying stream, e.g. to close it deliberately.
    pub fn into_inner(self) -> R {
        self.inner
    }

    /// [`Self::next_record`] plus the UTF-8 check, for callers that want the
    /// two faults told apart without writing the conversion themselves.
    pub async fn next_record_str(&mut self) -> Result<Option<String>, FramingError> {
        match self.next_record().await? {
            None => Ok(None),
            Some(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| FramingError::NotUtf8),
        }
    }
}

/// Serialize one record and terminate it with a single LF — pi's
/// `serializeJsonLine` counterpart. Nothing else is appended, so concatenated
/// records re-read as the same records.
pub fn encode_record<T: Serialize>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests;

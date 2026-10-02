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
mod tests {
    use super::*;
    use std::io::Cursor;
    use tokio::io::BufReader;

    /// A reader whose `fill_buf` fails once, for the `Io` taxonomy check.
    struct Failing;

    impl tokio::io::AsyncRead for Failing {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            _: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Err(io::Error::other("boom")))
        }
    }

    fn reader(bytes: &[u8]) -> JsonlReader<BufReader<Cursor<Vec<u8>>>> {
        JsonlReader::new(BufReader::new(Cursor::new(bytes.to_vec())))
    }

    async fn records(bytes: &[u8]) -> Vec<String> {
        let mut r = reader(bytes);
        let mut out = Vec::new();
        while let Some(rec) = r.next_record_str().await.unwrap() {
            out.push(rec);
        }
        out
    }

    /// AC1: `U+2028` is legal raw inside a JSON string (RFC 8259 §7 requires
    /// escaping only `"`, `\`, and the control characters). Node `readline`
    /// splits here; we must not.
    #[tokio::test]
    async fn raw_u2028_does_not_split_a_record() {
        let line = "{\"text\":\"a\u{2028}b\"}";
        let got = records(format!("{line}\n").as_bytes()).await;
        assert_eq!(got, vec![line.to_string()]);
        assert!(
            got[0].contains('\u{2028}'),
            "U+2028 must survive decoding, got {:?}",
            got[0]
        );
    }

    #[tokio::test]
    async fn raw_u2029_does_not_split_a_record() {
        let line = "{\"text\":\"a\u{2029}b\"}";
        assert_eq!(records(format!("{line}\n").as_bytes()).await, vec![line.to_string()]);
    }

    #[tokio::test]
    async fn two_records_in_one_read_keep_their_order() {
        assert_eq!(
            records(b"{\"a\":1}\n{\"b\":2}\n").await,
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
    }

    #[tokio::test]
    async fn a_record_split_across_reads_is_reassembled() {
        // `BufReader` over a `Cursor` hands out whatever the cursor has, so a
        // tiny capacity forces the split.
        let src = b"{\"a\":1}\n".to_vec();
        let mut r = JsonlReader::new(BufReader::with_capacity(3, Cursor::new(src)));
        assert_eq!(r.next_record().await.unwrap(), Some(b"{\"a\":1}".to_vec()));
        assert_eq!(r.next_record().await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_record_larger_than_the_buffer_is_not_truncated() {
        let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(9000));
        let src = format!("{body}\n").as_bytes().to_vec();
        let mut r = JsonlReader::new(BufReader::with_capacity(64, Cursor::new(src)));
        assert_eq!(
            r.next_record_str().await.unwrap().as_deref(),
            Some(body.as_str())
        );
    }

    #[tokio::test]
    async fn one_trailing_cr_is_stripped() {
        assert_eq!(records(b"{\"a\":1}\r\n").await, vec!["{\"a\":1}".to_string()]);
    }

    #[tokio::test]
    async fn only_one_trailing_cr_is_stripped() {
        assert_eq!(
            records(b"{\"a\":1}\r\r\n").await,
            vec!["{\"a\":1}\r".to_string()]
        );
    }

    #[tokio::test]
    async fn a_record_without_cr_is_unchanged() {
        assert_eq!(records(b"{\"a\":1}\n").await, vec!["{\"a\":1}".to_string()]);
    }

    #[tokio::test]
    async fn empty_stream_is_none() {
        let mut r = reader(b"");
        assert_eq!(r.next_record().await.unwrap(), None);
    }

    #[tokio::test]
    async fn stream_ending_on_a_record_boundary_is_none() {
        let mut r = reader(b"{\"a\":1}\n");
        assert_eq!(r.next_record().await.unwrap(), Some(b"{\"a\":1}".to_vec()));
        assert_eq!(r.next_record().await.unwrap(), None);
    }

    #[tokio::test]
    async fn unterminated_tail_is_an_error_not_a_record() {
        let mut r = reader(b"{\"a\":1}\n{\"b\":");
        assert_eq!(r.next_record().await.unwrap(), Some(b"{\"a\":1}".to_vec()));
        match r.next_record().await {
            Err(FramingError::UnterminatedTail { bytes }) => assert_eq!(bytes, 5),
            other => panic!("expected UnterminatedTail, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn overlong_record_without_lf_fails_promptly() {
        let src = vec![b'x'; MAX_RECORD_BYTES + 1];
        let mut r = reader(&src);
        match r.next_record().await {
            Err(FramingError::TooLong { limit }) => assert_eq!(limit, MAX_RECORD_BYTES),
            other => panic!("expected TooLong, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn non_utf8_record_is_not_a_parse_error() {
        let mut r = reader(b"\xff\xfe\n");
        match r.next_record_str().await {
            Err(FramingError::NotUtf8) => {}
            other => panic!("expected NotUtf8, got {other:?}"),
        }
        // Raw bytes stay available to a caller that wants to render them.
        let mut r = reader(b"\xff\xfe\n");
        assert_eq!(r.next_record().await.unwrap(), Some(vec![0xff, 0xfe]));
    }

    #[tokio::test]
    async fn io_failure_stays_distinct() {
        let mut r = JsonlReader::new(BufReader::new(Failing));
        match r.next_record().await {
            Err(FramingError::Io(err)) => assert_eq!(err.kind(), io::ErrorKind::Other),
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn encode_appends_exactly_one_lf_and_no_cr() {
        let bytes = encode_record(&serde_json::json!({"a": "b\r"})).unwrap();
        assert!(bytes.ends_with(b"\n"));
        assert_eq!(bytes.iter().filter(|&&b| b == b'\n').count(), 1);
        assert!(
            !bytes.contains(&b'\r'),
            "a raw CR would be stripped on read: {bytes:?}"
        );
    }

    #[tokio::test]
    async fn encode_then_read_round_trips() {
        let one = encode_record(&serde_json::json!({"a": 1})).unwrap();
        let two = encode_record(&serde_json::json!({"b": 2})).unwrap();
        let mut src = one;
        src.extend_from_slice(&two);
        assert_eq!(
            records(&src).await,
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
    }

    #[tokio::test]
    async fn encode_writes_u2028_raw_and_reads_back_as_one_record() {
        let bytes = encode_record(&serde_json::json!({"text": "a\u{2028}b"})).unwrap();
        assert_eq!(records(&bytes).await.len(), 1);
        assert!(records(&bytes).await[0].contains('\u{2028}'));
    }

    #[test]
    fn unencodable_value_surfaces_an_error() {
        // A map keyed by a non-string is not representable as JSON.
        use std::collections::BTreeMap;
        let mut map: BTreeMap<(u8, u8), u8> = BTreeMap::new();
        map.insert((1, 2), 3);
        assert!(encode_record(&map).is_err());
    }
}

use super::*;
use std::io::Cursor;
use tokio::io::BufReader;

/// A reader whose `fill_buf` fails once, for the `Io` taxonomy check.
pub(super) struct Failing;

impl tokio::io::AsyncRead for Failing {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        _: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::task::Poll::Ready(Err(io::Error::other("boom")))
    }
}

pub(super) fn reader(bytes: &[u8]) -> JsonlReader<BufReader<Cursor<Vec<u8>>>> {
    JsonlReader::new(BufReader::new(Cursor::new(bytes.to_vec())))
}

pub(super) async fn records(bytes: &[u8]) -> Vec<String> {
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


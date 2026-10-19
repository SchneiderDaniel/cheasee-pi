use super::*;

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

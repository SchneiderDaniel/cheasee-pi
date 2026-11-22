use super::*;

#[test]
fn describe_prefers_a_name_over_the_first_message() {
    assert_eq!(
        describe(Some("My plan"), Some("hi")).as_deref(),
        Some("My plan")
    );
}

#[test]
fn describe_falls_back_to_the_first_message_and_then_to_none() {
    assert_eq!(
        describe(None, Some("first user text")).as_deref(),
        Some("first user text")
    );
    assert_eq!(describe(None, None), None);
    assert_eq!(describe(Some("   "), None), None);
    assert_eq!(
        describe(Some("  "), Some("fallback")).as_deref(),
        Some("fallback"),
        "a blank name is absent, not a description"
    );
    assert_eq!(
        describe(None, Some("  \n\t ")),
        None,
        "nothing survives normalization -> no description at all"
    );
}

#[test]
fn describe_normalizes_control_chars_and_collapses_whitespace_runs() {
    assert_eq!(
        describe(None, Some("Plan\tthe\nfix \u{7f}now")).as_deref(),
        Some("Plan the fix now")
    );
    assert_eq!(
        describe(None, Some("  \n  leading and trailing  \r\n")).as_deref(),
        Some("leading and trailing")
    );
}

#[test]
fn describe_truncates_by_chars_never_by_bytes() {
    let long = "a".repeat(200);
    let description = describe(None, Some(long.as_str())).unwrap();
    assert_eq!(description.chars().count(), MAX_DESCRIPTION_CHARS);
    assert!(
        long.starts_with(description.as_str()),
        "truncation keeps a prefix of the normalized text"
    );

    let wide = "漢".repeat(130);
    let description = describe(None, Some(wide.as_str())).unwrap();
    assert_eq!(
        description.chars().count(),
        MAX_DESCRIPTION_CHARS,
        "byte slicing would panic here"
    );

    let exact = "b".repeat(MAX_DESCRIPTION_CHARS);
    let description = describe(None, Some(exact.as_str())).unwrap();
    assert_eq!(description, exact, "at the limit nothing is truncated");
}

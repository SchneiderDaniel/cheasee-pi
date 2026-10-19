use super::*;

#[test]
fn extension_ui_set_status_replaces_same_key() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("s1", "setStatus", json!({"statusKey": "my-ext", "statusText": "Turn 3 running..."}))).unwrap(),
    });
    assert_eq!(state.statuses.get().get("my-ext").map(String::as_str), Some("Turn 3 running..."));

    state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("s2", "setStatus", json!({"statusKey": "my-ext", "statusText": "idle"}))).unwrap(),
    });
    assert_eq!(state.statuses.get().get("my-ext").map(String::as_str), Some("idle"));
}

#[test]
fn extension_ui_set_widget_stores_lines_and_placement() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("w1", "setWidget", json!({"widgetKey": "w", "widgetLines": ["a"], "widgetPlacement": "aboveEditor"}))).unwrap(),
    });
    let widgets = state.widgets.get();
    let widget = widgets.get("w").expect("widget stored");
    assert_eq!(widget.lines, vec!["a".to_string()]);
    assert_eq!(widget.placement, "aboveEditor");
}

#[test]
fn extension_ui_set_title_stores_title() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("title", "setTitle", json!({"title": "New title"}))).unwrap(),
    });
    assert_eq!(state.title.get(), Some("New title".to_string()));
}

#[test]
fn extension_ui_set_editor_text_writes_draft_and_is_case_sensitive() {
    let _owner = owner();
    let (controls, state) = state_with_draft();

    state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("d1", "set_editor_text", json!({"text": "draft"}))).unwrap(),
    });
    assert_eq!(controls.draft.get(), "draft");

    // Wrong case: exact-match dispatch must ignore it, leaving the draft alone.
    state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("d2", "setEditorText", json!({"text": "clobbered"}))).unwrap(),
    });
    assert_eq!(controls.draft.get(), "draft");
}

#[test]
fn extension_ui_tui_only_methods_are_ignored() {
    let _owner = owner();
    let (controls, state) = state_with_draft();

    for method in ["custom", "setFooter", "setHeader"] {
        let changed = state.reduce_chrome(&ServerMessage::ExtensionUi {
            request: serde_json::from_value(request("x", method, json!({"text": "ignored"}))).unwrap(),
        });
        assert!(!changed, "{method} must be a no-op");
    }
    assert!(state.dialog.get().is_none());
    assert!(state.toasts.get().is_empty());
    assert!(state.statuses.get().is_empty());
    assert!(state.widgets.get().is_empty());
    assert!(state.title.get().is_none());
    assert_eq!(controls.draft.get(), "");
}

#[test]
fn extension_ui_ingest_frame_decodes_and_ignores_malformed() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    assert!(UiSlice::Chrome(&state).ingest_frame(
        r#"{"type":"extension_ui","request":{"type":"extension_ui_request","id":"f1","method":"confirm","title":"Go?"}}"#
    ));
    assert_eq!(state.dialog.get().map(|d| d.id), Some("f1".to_string()));

    assert!(!UiSlice::Chrome(&state).ingest_frame("not json"), "a malformed frame must not panic");
}

// ── Phase 5: user journey ───────────────────────────────────────────────────

#[tokio::test]
async fn extension_ui_operator_journey_confirm() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;
    let (controls, state) = state_with_draft();
    let _ = controls;

    // pi asks a blocking question; the browser shows it.
    write_record(&mut to_child, request("c1", "confirm", json!({"title": "Allow?"}))).await;
    let message = next_message(&mut received).await;
    assert!(state.reduce_chrome(&message));
    assert_eq!(state.dialog.get().unwrap().id, "c1");
    assert_eq!(session.pending_dialog().map(|r| r.id), Some("c1".to_string()));

    // The operator answers; the frame carries pi's uuid and no other shape.
    command_tx
        .send(Ok(response("c1", None, Some(true), None)))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["id"], "c1");
    assert_eq!(frame["confirmed"], true);
    state.clear_dialog();
    assert!(state.dialog.get().is_none());

    // The run continues: a following pi event still arrives.
    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    match next_message(&mut received).await {
        ServerMessage::Event { .. } => {}
        other => panic!("expected a following event, got {other:?}"),
    }

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_operator_mixed_chrome_journey() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, _session) = spawn_relay(&client, &mut to_child, &mut frames).await;
    let (controls, state) = state_with_draft();

    for raw in [
        request("n1", "notify", json!({"message": "blocked", "notifyType": "warning"})),
        request("s1", "setStatus", json!({"statusKey": "my-ext", "statusText": "Turn 3 running..."})),
        request("d1", "set_editor_text", json!({"text": "draft"})),
        request("q1", "select", json!({"title": "Pick", "options": ["a", "b"]})),
    ] {
        write_record(&mut to_child, raw).await;
        let message = next_message(&mut received).await;
        assert!(state.reduce_chrome(&message));
    }

    assert_eq!(controls.draft.get(), "draft");
    assert_eq!(state.statuses.get().get("my-ext").map(String::as_str), Some("Turn 3 running..."));
    assert_eq!(state.toasts.get().len(), 1);
    assert_eq!(state.dialog.get().map(|d| d.id), Some("q1".to_string()));

    command_tx.send(Ok(response("q1", Some("b"), None, None))).unwrap();
    state.clear_dialog();

    // Answering the dialog must not disturb the transient chrome.
    assert!(state.dialog.get().is_none());
    assert_eq!(state.toasts.get().len(), 1);
    assert_eq!(state.statuses.get().get("my-ext").map(String::as_str), Some("Turn 3 running..."));

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_reconnect_seam_keeps_pending_request() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(&mut to_child, request("keep", "editor", json!({"title": "Edit"}))).await;
    let _ = next_message(&mut received).await;

    // Unrelated traffic after the blocking request must not disturb the slot.
    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    let _ = next_message(&mut received).await;

    assert_eq!(
        session.pending_dialog().map(|r| r.id),
        Some("keep".to_string()),
        "slice 9's get_state can re-show this request"
    );

    drop(command_tx);
    let _ = relay.await;
}

// ── Phase 6: boundaries and forward-compat ──────────────────────────────────

#[tokio::test]
async fn extension_ui_duplicate_late_answer_is_tolerated() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(&mut to_child, request("q1", "select", json!({"options": ["x"]}))).await;
    let _ = next_message(&mut received).await;
    command_tx.send(Ok(response("q1", Some("x"), None, None))).unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["id"], "q1");

    // The same answer again, after the slot cleared: no panic, no second frame.
    command_tx.send(Ok(response("q1", Some("x"), None, None))).unwrap();
    assert_no_command(&mut frames).await;
    assert!(session.pending_dialog().is_none());

    drop(command_tx);
    let _ = relay.await;
}

#[test]
fn extension_ui_missing_required_fields_do_not_clear_unrelated_state() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("s1", "setStatus", json!({"statusKey": "k", "statusText": "live"}))).unwrap(),
    });
    state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("w1", "setWidget", json!({"widgetKey": "w", "widgetLines": ["a"], "widgetPlacement": "aboveEditor"}))).unwrap(),
    });

    // A malformed sibling must be ignored, not wipe the stored chrome.
    state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("s2", "setStatus", json!({"statusKey": "k"}))).unwrap(),
    });
    state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("w2", "setWidget", json!({"widgetKey": "w"}))).unwrap(),
    });

    assert_eq!(state.statuses.get().get("k").map(String::as_str), Some("live"));
    assert_eq!(state.widgets.get().get("w").map(|w| w.lines.len()), Some(1));
}

#[tokio::test]
async fn extension_ui_fire_and_forget_never_emits_a_response() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, _session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(
        &mut to_child,
        request("uuid-6", "setStatus", json!({"statusKey": "k", "statusText": "running"})),
    )
    .await;
    let _ = next_message(&mut received).await;

    // Nothing is written back for its minted uuid.
    assert_no_command(&mut frames).await;

    drop(command_tx);
    let _ = relay.await;
}

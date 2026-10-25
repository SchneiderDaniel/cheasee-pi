use super::*;

// ── Phase 1: wire envelopes decode and re-encode losslessly ─────────────────

#[test]
fn extension_ui_server_message_round_trips() {
    let raw = json!({
        "type": "extension_ui",
        "request": {
            "type": "extension_ui_request",
            "id": "uuid-1",
            "method": "select",
            "title": "Allow dangerous command?",
            "options": ["Allow", "Block"],
            "timeout": 10000
        }
    });
    // pi's record and the browser envelope share the inner shape; decode the
    // inner request first, then wrap it.
    let request: ExtensionUiRequest =
        serde_json::from_value(raw["request"].clone()).expect("request decodes");
    assert_eq!(request.id, "uuid-1");
    assert_eq!(request.method, "select");
    assert_eq!(request.params["options"][1], "Block");

    let message = ServerMessage::ExtensionUi { request };
    let encoded = serde_json::to_value(&message).unwrap();
    assert_eq!(encoded["type"], "extension_ui");
    assert_eq!(encoded["request"]["id"], "uuid-1");
    assert_eq!(encoded["request"]["method"], "select");
    assert_eq!(encoded["request"]["options"][1], "Block");
    assert_eq!(encoded["request"]["timeout"], 10000);

    let text = serde_json::to_string(&message).unwrap();
    let decoded: ServerMessage = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{text}: {e}"));
    assert_eq!(decoded, message);
}

#[test]
fn extension_ui_unknown_server_message_decodes_as_unknown() {
    let message: ServerMessage =
        serde_json::from_value(json!({"type": "a_future_envelope"})).unwrap();
    assert_eq!(message, ServerMessage::Unknown);
}

#[test]
fn extension_ui_response_shapes_serialize_with_exactly_one_key() {
    let value = serde_json::to_value(response("uuid-1", Some("Allow"), None, None)).unwrap();
    assert_eq!(value["type"], "extension_ui_response");
    assert_eq!(value["id"], "uuid-1");
    assert_eq!(value["value"], "Allow");
    assert!(value.get("confirmed").is_none(), "{value}");
    assert!(value.get("cancelled").is_none(), "{value}");

    let value = serde_json::to_value(response("uuid-2", None, Some(true), None)).unwrap();
    assert_eq!(value["confirmed"], true);
    assert!(value.get("value").is_none(), "{value}");
    assert!(value.get("cancelled").is_none(), "{value}");

    let value = serde_json::to_value(response("uuid-3", None, None, Some(true))).unwrap();
    assert_eq!(value["cancelled"], true);
    assert!(value.get("value").is_none(), "{value}");
    assert!(value.get("confirmed").is_none(), "{value}");
}

// ── Phase 2: relay forwards requests to the browser ─────────────────────────

#[tokio::test]
async fn extension_ui_relay_forwards_each_method_unmutated() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, _session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    let requests: Vec<ExtensionUiRequest> = fixture_values("extension_ui.jsonl")
        .into_iter()
        .filter(|v| v["type"] == "extension_ui_request")
        .map(|v| match serde_json::from_value::<ExtensionUI>(v.clone()) {
            Ok(ExtensionUI::ExtensionUiRequest(request)) => request,
            other => panic!("fixture is not a request: {other:?}"),
        })
        .collect();
    assert_eq!(requests.len(), 9, "captured method corpus changed");

    for expected in requests {
        // Re-attach the envelope tag the fixture line carries; `ExtensionUiRequest`
        // itself only serializes the payload (`id`, `method`, flattened params).
        let mut raw = serde_json::to_value(&expected).unwrap();
        raw.as_object_mut()
            .unwrap()
            .insert("type".into(), json!("extension_ui_request"));
        write_record(&mut to_child, raw).await;
        match next_message(&mut received).await {
            ServerMessage::ExtensionUi { request } => {
                assert_eq!(request, expected, "request was mutated in transit");
            }
            other => panic!("expected an extension UI request, got {other:?}"),
        }
    }

    drop(command_tx);
    let _ = relay.await;
}

// ── Phase 3: answer round-trip and pending state ────────────────────────────

#[tokio::test]
async fn extension_ui_answer_writes_response_and_no_command_response() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(
        &mut to_child,
        request("uuid-1", "select", json!({"title": "x", "options": ["Allow", "Block"], "timeout": 1000})),
    )
    .await;
    let _ = next_message(&mut received).await;
    assert_eq!(session.pending_dialog().unwrap().id, "uuid-1");

    command_tx
        .send(Ok(response("uuid-1", Some("Block"), None, None)))
        .unwrap();

    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "extension_ui_response");
    assert_eq!(frame["id"], "uuid-1");
    assert_eq!(frame["value"], "Block", "select answers with the option string");
    assert!(frame.get("confirmed").is_none(), "{frame}");

    assert!(session.pending_dialog().is_none(), "the slot clears on answer");
    assert_no_message(&mut received).await;

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_confirm_shapes_reach_pi() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, _session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(&mut to_child, request("c1", "confirm", json!({"title": "Go?"}))).await;
    let _ = next_message(&mut received).await;
    command_tx.send(Ok(response("c1", None, Some(true), None))).unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "extension_ui_response");
    assert_eq!(frame["id"], "c1");
    assert_eq!(frame["confirmed"], true);
    assert!(frame.get("value").is_none(), "{frame}");

    write_record(&mut to_child, request("c2", "confirm", json!({"title": "Go?"}))).await;
    let _ = next_message(&mut received).await;
    command_tx.send(Ok(response("c2", None, None, Some(true)))).unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["cancelled"], true);
    assert!(frame.get("value").is_none(), "{frame}");
    assert!(frame.get("confirmed").is_none(), "{frame}");

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_newest_blocking_replaces_pending() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(&mut to_child, request("first", "input", json!({"title": "a"}))).await;
    let _ = next_message(&mut received).await;
    write_record(&mut to_child, request("second", "select", json!({"options": ["a"]}))).await;
    let _ = next_message(&mut received).await;

    assert_eq!(
        session.pending_dialog().map(|r| r.id),
        Some("second".to_string()),
        "the newest blocking request occupies the single slot"
    );

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_non_pending_answer_writes_nothing() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    // An answer for a request that never occupied the slot (a `notify` id).
    write_record(
        &mut to_child,
        request("toast", "notify", json!({"message": "hi", "notifyType": "info"})),
    )
    .await;
    let _ = next_message(&mut received).await;
    assert!(session.pending_dialog().is_none());

    command_tx.send(Ok(response("toast", Some("Allow"), None, None))).unwrap();
    assert_no_command(&mut frames).await;
    assert_no_message(&mut received).await;

    // The relay keeps serving: a following event still arrives.
    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    match next_message(&mut received).await {
        ServerMessage::Event { .. } => {}
        other => panic!("relay stopped serving after a non-pending answer: {other:?}"),
    }

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_timeout_decodes_and_editor_has_none() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(&mut to_child, request("s", "select", json!({"options": ["a"], "timeout": 2500}))).await;
    let _ = next_message(&mut received).await;
    let pending = PendingDialog::from(&session.pending_dialog().unwrap());
    assert_eq!(pending.timeout(), Some(2500));

    write_record(&mut to_child, request("e", "editor", json!({"title": "edit"}))).await;
    let _ = next_message(&mut received).await;
    let pending = PendingDialog::from(&session.pending_dialog().unwrap());
    assert_eq!(pending.id, "e");
    assert_eq!(pending.timeout(), None, "editor never carries a timeout");

    drop(command_tx);
    let _ = relay.await;
}

#[tokio::test]
async fn extension_ui_notify_never_occupies_the_pending_slot() {
    let _owner = owner();
    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay, session) = spawn_relay(&client, &mut to_child, &mut frames).await;

    write_record(
        &mut to_child,
        request("toast", "notify", json!({"message": "blocked"})),
    )
    .await;
    let _ = next_message(&mut received).await;
    assert!(session.pending_dialog().is_none(), "notify is fire-and-forget");

    write_record(&mut to_child, request("dialog", "confirm", json!({"title": "Go?"}))).await;
    let _ = next_message(&mut received).await;
    assert_eq!(session.pending_dialog().map(|r| r.id), Some("dialog".to_string()));

    drop(command_tx);
    let _ = relay.await;
}

// ── Phase 4: client chrome state ────────────────────────────────────────────

#[test]
fn extension_ui_notify_appends_toast_and_defaults_type() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    assert!(state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("t1", "notify", json!({"message": "blocked", "notifyType": "warning"}))).unwrap()
    }));
    assert!(state.reduce_chrome(&ServerMessage::ExtensionUi {
        request: serde_json::from_value(request("t2", "notify", json!({"message": "plain"}))).unwrap()
    }));

    let toasts = state.toasts.get();
    assert_eq!(toasts.len(), 2);
    assert_eq!(toasts[0].message, "blocked");
    assert_eq!(toasts[0].notify_type, "warning");
    assert_eq!(toasts[1].notify_type, "info", "a missing notifyType defaults to info");
}

#[test]
fn extension_ui_dismiss_toast_removes_only_that_toast() {
    let _owner = owner();
    let (_controls, state) = state_with_draft();

    for (id, message) in [("t1", "one"), ("t2", "two")] {
        state.reduce_chrome(&ServerMessage::ExtensionUi {
            request: serde_json::from_value(request(id, "notify", json!({"message": message}))).unwrap(),
        });
    }
    state.dismiss_toast("t1");
    let toasts = state.toasts.get();
    assert_eq!(toasts.len(), 1);
    assert_eq!(toasts[0].id, "t2");
}

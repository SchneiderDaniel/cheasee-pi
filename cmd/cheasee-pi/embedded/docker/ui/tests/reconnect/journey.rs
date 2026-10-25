use super::*;

/// AC5 / Phase 4: `Unsubscribe` silences only that connection.
#[tokio::test]
async fn reconnect_unsubscribe_stops_only_that_sink() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("unsub");
    let session = register_live(&registry, client, store(&dir), "sess-5", Some(555));

    let sub_a = Arc::clone(&session);
    let sub_b = Arc::clone(&session);
    let (tx_a, mut rx_a, sink_a) = fake();
    let (tx_b, mut rx_b, sink_b) = fake();
    let task_a = tokio::spawn(async move { sub_a.relay(sink_a).await });
    let task_b = tokio::spawn(async move { sub_b.relay(sink_b).await });

    bind(&tx_a, &mut rx_a, &mut frames, &mut to_child, "sess-5", None).await;
    bind(&tx_b, &mut rx_b, &mut frames, &mut to_child, "sess-5", None).await;

    tx_a.send(Ok(ClientMessage::Unsubscribe {
        id: None,
        session_id: "sess-5".into(),
    }))
    .unwrap();
    // Let A process the unsubscribe before the event is emitted.
    tokio::time::sleep(Duration::from_millis(50)).await;

    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    match next_message(&mut rx_b).await {
        ServerMessage::Event { .. } => {}
        other => panic!("B must still stream, got {other:?}"),
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(200), rx_a.recv())
            .await
            .is_err(),
        "an unsubscribed connection receives no further events"
    );

    drop(tx_a);
    drop(tx_b);
    let _ = task_a.await;
    let _ = task_b.await;
}

/// Phase 4: a `Subscribe` for an id neither the registry nor the store knows
/// surfaces an error — no silent drop, no spawned child.
#[tokio::test]
async fn reconnect_unknown_session_surfaces_an_error() {
    let dir = temp_session_dir("unknown");
    let orphan = Arc::new(Session::detached(store(&dir), String::new()));
    let (tx, mut rx, sink) = fake();
    let task = tokio::spawn(async move { orphan.relay(sink).await });

    tx.send(Ok(subscribe("ghost", None))).unwrap();
    match next_message(&mut rx).await {
        ServerMessage::Error { message } => {
            assert!(message.contains("ghost"), "message = {message}")
        }
        other => panic!("expected an error, got {other:?}"),
    }

    drop(tx);
    let _ = task.await;
}

/// Phase 4: subscribing a second connection neither spawns a child nor sends a
/// `new_session`/`switch_session` command.
#[tokio::test]
async fn reconnect_second_subscriber_creates_no_child() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("second");
    let session = register_live(&registry, client, store(&dir), "sess-6", Some(666));

    for _ in 0..2 {
        let sub = Arc::clone(&session);
        let (tx, mut rx, sink) = fake();
        let task = tokio::spawn(async move { sub.relay(sink).await });
        tx.send(Ok(subscribe("sess-6", None))).unwrap();
        serve_replay(&mut frames, &mut to_child, None, json!([]), "leaf", json!({}), None).await;
        let _ = next_message(&mut rx).await;
        let _ = next_message(&mut rx).await;
        assert_eq!(registry.len(), 1, "one child for the session id");
        drop(tx);
        let _ = task.await;
    }

    // No `new_session`/`switch_session` was written while two subscribers bound.
    assert!(
        tokio::time::timeout(Duration::from_millis(200), frames.next_record_str())
            .await
            .is_err(),
        "binding a subscriber must not send a session command"
    );
}

/// AC4: after a `ui` restart there is no child; `Subscribe` replays history
/// from the JSONL with `live: false` and persists the cursor.
#[tokio::test]
async fn reconnect_childless_restart_replays_history_from_disk() {
    let dir = temp_session_dir("childless");
    let body = "{\"type\":\"session\",\"id\":\"disk1\",\"cwd\":\"/\"}\n\
{\"type\":\"message\",\"id\":\"a\",\"parentId\":null}\n\
{\"type\":\"message\",\"id\":\"b\",\"parentId\":\"a\"}\n";
    std::fs::write(dir.join("disk1_disk1.jsonl"), body).unwrap();

    let registry = Arc::new(SessionRegistry::new());
    let store = store(&dir);
    let session = Arc::new(
        Session::detached(store, "nochild".into()).with_registry(Arc::clone(&registry)),
    );
    let (tx, mut rx, sink) = fake();
    let task = tokio::spawn(async move { session.relay(sink).await });

    tx.send(Ok(subscribe("disk1", None))).unwrap();

    match next_message(&mut rx).await {
        ServerMessage::SessionState {
            live, leaf_id, state, ..
        } => {
            assert!(!live, "no child after a restart");
            assert_eq!(leaf_id.as_deref(), Some("b"));
            assert!(state.is_none());
        }
        other => panic!("expected a childless state header, got {other:?}"),
    }
    match next_message(&mut rx).await {
        ServerMessage::SessionReplay { entries, done, .. } => {
            assert_eq!(entry_ids(&entries), vec!["a", "b"]);
            assert!(done);
        }
        other => panic!("expected a replay chunk, got {other:?}"),
    }

    drop(tx);
    let _ = task.await;
}

/// Phase 7 user journey: the operator closes the laptop lid and resumes.
/// A disconnects mid-run, B stays, A reconnects with its last-seen id and sees
/// the header, the missed entries exactly once, then the live tail; the child
/// pid is unchanged throughout.
#[tokio::test]
async fn reconnect_journey_operator_resumes_after_disconnect() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("journey");
    let session = register_live(&registry, client, store(&dir), "sess-9", Some(999));

    // B is the stable subscriber that stays open.
    let sub_b = Arc::clone(&session);
    let (tx_b, mut rx_b, sink_b) = fake();
    let task_b = tokio::spawn(async move { sub_b.relay(sink_b).await });
    bind(&tx_b, &mut rx_b, &mut frames, &mut to_child, "sess-9", None).await;

    // A connects and replays from the start.
    let sub_a = Arc::clone(&session);
    let (tx_a, mut rx_a, sink_a) = fake();
    let task_a = tokio::spawn(async move { sub_a.relay(sink_a).await });
    tx_a.send(Ok(subscribe("sess-9", None))).unwrap();
    serve_replay(
        &mut frames,
        &mut to_child,
        None,
        json!([{"id": "a", "parentId": null}]),
        "a",
        json!({"isStreaming": true}),
        Some("typing"),
    )
    .await;
    match next_message(&mut rx_a).await {
        ServerMessage::SessionState { live, .. } => assert!(live),
        other => panic!("expected the header, got {other:?}"),
    }
    match next_message(&mut rx_a).await {
        ServerMessage::SessionReplay { entries, .. } => {
            assert_eq!(entry_ids(&entries), vec!["a"])
        }
        other => panic!("expected replay, got {other:?}"),
    }

    // The lid closes: A's socket dies. B keeps streaming.
    drop(tx_a);
    let _ = task_a.await;

    // A dialog becomes pending and new history is written while A is away.
    write_record(
        &mut to_child,
        json!({"type": "extension_ui_request", "id": "uuid-9", "method": "confirm", "message": "?"}),
    )
    .await;
    match next_message(&mut rx_b).await {
        ServerMessage::ExtensionUi { .. } => {}
        other => panic!("B must see the dialog, got {other:?}"),
    }

    // A reconnects with the last-seen id and catches up.
    let sub_a2 = Arc::clone(&session);
    let (tx_a2, mut rx_a2, sink_a2) = fake();
    let task_a2 = tokio::spawn(async move { sub_a2.relay(sink_a2).await });
    tx_a2.send(Ok(subscribe("sess-9", Some("a")))).unwrap();
    serve_replay(
        &mut frames,
        &mut to_child,
        Some("a"),
        json!([{"id": "b", "parentId": "a"}]),
        "b",
        json!({"isStreaming": true}),
        Some("typing"),
    )
    .await;

    match next_message(&mut rx_a2).await {
        ServerMessage::SessionState {
            pending,
            last_assistant_text,
            ..
        } => {
            assert_eq!(pending.unwrap().id, "uuid-9");
            assert_eq!(last_assistant_text.as_deref(), Some("typing"));
        }
        other => panic!("expected the reconnect header, got {other:?}"),
    }
    match next_message(&mut rx_a2).await {
        ServerMessage::SessionReplay { entries, done, .. } => {
            assert_eq!(entry_ids(&entries), vec!["b"], "no gap, no duplicate");
            assert!(done);
        }
        other => panic!("expected the missed-entry replay, got {other:?}"),
    }

    // The live tail resumes on A.
    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    for rx in [&mut rx_a2, &mut rx_b] {
        match next_message(rx).await {
            ServerMessage::Event { .. } => {}
            other => panic!("expected the resumed live tail, got {other:?}"),
        }
    }

    assert_eq!(registry.pid("sess-9"), Some(999));

    drop(tx_a2);
    drop(tx_b);
    let _ = task_a2.await;
    let _ = task_b.await;
}

/// AC2 (finding 2): the live broadcast is drained while the replay is computed,
/// so an event that the durable log already carries is not delivered twice and
/// a genuinely new event is not lost across the replay boundary.
#[tokio::test]
async fn reconnect_spool_dedupes_replayed_events_and_keeps_new_ones() {
    let (client, mut to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("spool");
    let session = register_live(&registry, client, store(&dir), "sess-spool", Some(1));

    let (tx, mut rx, sink) = fake();
    let task = tokio::spawn(async move { session.relay(sink).await });

    let replay_message = json!({"role": "assistant", "content": [{"type": "text", "text": "hi"}]});
    tx.send(Ok(subscribe("sess-spool", None))).unwrap();

    // The child sees `get_entries`; while it is in flight, pi emits one event
    // the durable log already carries and one that is genuinely new.
    let command = next_command(&mut frames).await;
    assert_eq!(command["type"], "get_entries");
    let entries_id = command["id"].as_str().unwrap().to_string();
    write_record(
        &mut to_child,
        json!({"type": "message_end", "message": replay_message.clone()}),
    )
    .await;
    write_record(&mut to_child, json!({"type": "agent_start"})).await;
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }

    write_record(
        &mut to_child,
        json!({
            "type": "response", "command": "get_entries", "success": true, "id": entries_id,
            "data": {"entries": [{"id": "a", "parentId": null, "message": replay_message}], "leafId": "a"},
        }),
    )
    .await;
    for _ in 0..2 {
        let command = next_command(&mut frames).await;
        let id = command["id"].as_str().unwrap().to_string();
        let response = match command["type"].as_str().unwrap() {
            "get_state" => json!({"type":"response","command":"get_state","success":true,"id":id,"data":{}}),
            "get_last_assistant_text" => json!({"type":"response","command":"get_last_assistant_text","success":true,"id":id,"data":{"text":null}}),
            other => panic!("unexpected replay request {other}"),
        };
        write_record(&mut to_child, response).await;
    }

    // Header, then the replay containing `a`, then only the *new* live event.
    match next_message(&mut rx).await {
        ServerMessage::SessionState { .. } => {}
        other => panic!("expected a state header, got {other:?}"),
    }
    match next_message(&mut rx).await {
        ServerMessage::SessionReplay { entries, done, .. } => {
            assert_eq!(entry_ids(&entries), vec!["a"]);
            assert!(done);
        }
        other => panic!("expected a replay chunk, got {other:?}"),
    }
    match next_message(&mut rx).await {
        ServerMessage::Event { event } => assert!(matches!(event, Event::AgentStart)),
        other => panic!("expected the spooled new event, got {other:?}"),
    }
    assert!(
        tokio::time::timeout(QUIET, rx.recv()).await.is_err(),
        "the replayed message_end must not be delivered a second time"
    );

    drop(tx);
    let _ = task.await;
}

/// Finding 3: subscribing to a session absent from the live registry keeps the
/// live command client, so a following `ResumeSession` still reaches pi, and the
/// registry is re-keyed to the resumed session.
#[tokio::test]
async fn reconnect_detached_subscribe_can_still_resume() {
    let (client, _to_child, mut frames) = harness();
    let registry = Arc::new(SessionRegistry::new());
    let dir = temp_session_dir("resume");
    let cwd = dir.to_string_lossy().into_owned();
    std::fs::write(
        dir.join("aaaa.jsonl"),
        format!("{{\"type\":\"session\",\"id\":\"aaaa\",\"cwd\":{cwd:?}}}\n"),
    )
    .unwrap();
    let store = store(&dir);
    let live = register_live(&registry, client, Arc::clone(&store), "live-1", Some(7));

    let (tx, mut rx, sink) = fake();
    let task = tokio::spawn(async move { live.relay(sink).await });

    // Subscribe to the on-disk session (not the live one): a child-less replay.
    tx.send(Ok(subscribe("aaaa", None))).unwrap();
    match next_message(&mut rx).await {
        ServerMessage::SessionState { live, .. } => assert!(!live, "file replay"),
        other => panic!("expected a child-less header, got {other:?}"),
    }
    let _ = next_message(&mut rx).await; // replay chunk

    // Resume the on-disk session: it must reach pi over the live command client.
    tx.send(Ok(ClientMessage::ResumeSession {
        id: None,
        session_id: "aaaa".into(),
        mode: Some("resume".into()),
        entry_id: None,
    }))
    .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "switch_session");
    match next_message(&mut rx).await {
        ServerMessage::SessionAction {
            success,
            session_id,
            ..
        } => {
            assert!(success, "resume must reach the live child");
            assert_eq!(session_id, "aaaa");
        }
        other => panic!("expected a session action, got {other:?}"),
    }
    // The registry now maps the resumed id to the same live child.
    assert_eq!(registry.pid("aaaa"), Some(7), "the binding was re-keyed");

    drop(tx);
    let _ = task.await;
}

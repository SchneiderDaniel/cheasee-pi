/// AC1/AC2/AC3 journey: the relay answers harness commands locally — list scans
/// the shared dir, resume resolves a validated in-dir path, a claim refuses the
/// attach, and stop aborts then marker-kills the exact child.
#[tokio::test]
async fn controls_journey_session_list_resume_and_stop() {
    use cheasee_pi_ui::pi_process::PidRegistry;
    use cheasee_pi_ui::sessions_store::SessionsStore;

    let (client, _to_child, mut frames) = harness();
    let dir = std::env::temp_dir().join(format!(
        "cheasee-pi-ui-controls-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let cwd = dir.to_string_lossy().into_owned();
    std::fs::write(
        dir.join("aaaa.jsonl"),
        format!("{{\"type\":\"session\",\"id\":\"aaaa\",\"cwd\":{cwd:?}}}\n"),
    )
    .unwrap();
    let registry = Arc::new(PidRegistry::new());
    let store = Arc::new(SessionsStore::new(
        dir.as_path(),
        dir.join(".cheasee-inuse"),
        Arc::clone(&registry),
    ));

    let (command_tx, mut received, sink) = fake();
    let session = Arc::new(Session::with_store(Arc::clone(&client), Some(store)));
    let relay = tokio::spawn(async move { session.relay(sink).await });

    // List: answered locally, never forwarded to pi.
    command_tx
        .send(Ok(ClientMessage::ListSessions {
            id: Some("c1".into()),
        }))
        .unwrap();
    match next_message(&mut received).await {
        ServerMessage::SessionList { id, sessions } => {
            assert_eq!(id.as_deref(), Some("c1"));
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].id, "aaaa");
            assert!(!sessions[0].in_use);
        }
        other => panic!("expected a session list, got {other:?}"),
    }

    // Resume: the store resolves the path and sends switch_session to pi.
    command_tx
        .send(Ok(ClientMessage::ResumeSession {
            id: None,
            session_id: "aaaa".into(),
            mode: Some("resume".into()),
            entry_id: None,
        }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "switch_session");
    assert_eq!(
        frame["sessionPath"].as_str().unwrap(),
        dir.join("aaaa.jsonl").to_string_lossy()
    );
    match next_message(&mut received).await {
        ServerMessage::SessionAction {
            success,
            session_id,
            ..
        } => {
            assert!(success);
            assert_eq!(session_id, "aaaa");
        }
        other => panic!("expected a session action, got {other:?}"),
    }

    // A terminal claim refuses the attach.
    std::fs::create_dir_all(dir.join(".cheasee-inuse")).unwrap();
    std::fs::write(dir.join(".cheasee-inuse").join("aaaa"), b"{}").unwrap();
    command_tx
        .send(Ok(ClientMessage::ResumeSession {
            id: None,
            session_id: "aaaa".into(),
            mode: Some("resume".into()),
            entry_id: None,
        }))
        .unwrap();
    match next_message(&mut received).await {
        ServerMessage::SessionAction {
            success, error, ..
        } => {
            assert!(!success);
            assert!(error.unwrap().contains("in use"));
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    std::fs::remove_file(dir.join(".cheasee-inuse").join("aaaa")).unwrap();

    // Stop with no registered child: abort is sent, and the miss is surfaced.
    command_tx
        .send(Ok(ClientMessage::StopSession {
            id: None,
            session_id: "aaaa".into(),
        }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "abort");
    match next_message(&mut received).await {
        ServerMessage::SessionAction { success, error, .. } => {
            assert!(!success);
            assert!(error.unwrap().contains("no live child"));
        }
        other => panic!("expected a stop action, got {other:?}"),
    }

    drop(command_tx);
    let _ = relay.await;
}

/// AC1–AC4 journey: one live relay session drives the whole slice — a prompt,
/// streamed text, a streaming tool card, an extension error, more text, a
/// threshold compaction and an auto-retry.
///
/// The tool card and the extension error are durable transcript rows in stream
/// order; the compaction banner and the retry pill are ephemeral control
/// chrome. An `extension_error` must not break the stream, so the text written
/// after it still appends.
#[tokio::test]
async fn widgets_journey_tool_compaction_retry_in_one_session() {
    use cheasee_pi_ui::controls::CompactionPhase;
    use cheasee_pi_ui::stream::{ChatState, Marker, RowKind};
    use cheasee_pi_ui::tool_card::ToolStatus;

    let (client, mut to_child, mut frames) = harness();
    let (command_tx, mut received, relay) = spawn_relay(&client, &mut to_child, &mut frames).await;
    let controls = controls();
    let chat = {
        let owner = Owner::new();
        owner.set();
        std::mem::forget(owner);
        ChatState::new()
    };

    // The prompt round trip is also the handshake: pi is subscribed to events by
    // the time it answers, so every event below is forwarded rather than lost.
    command_tx
        .send(Ok(ClientMessage::Prompt {
            id: None,
            message: "list the files".into(),
            streaming_behavior: None,
        }))
        .unwrap();
    let frame = next_command(&mut frames).await;
    assert_eq!(frame["type"], "prompt");
    write_record(
        &mut to_child,
        json!({"type":"response","command":"prompt","success":true,"id":frame["id"].as_str().unwrap(),"data":{"disposition":"started"}}),
    )
    .await;
    let _ = next_message(&mut received).await;

    for event in [
        json!({"type":"agent_start"}),
        json!({"type":"turn_start"}),
        json!({"type":"message_start","message":{"role":"assistant"}}),
        json!({"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"On it."}}),
        json!({"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls -la"}}),
        json!({"type":"tool_execution_update","toolCallId":"call_1","toolName":"bash","args":{"command":"ls -la"},"partialResult":{"content":[{"type":"text","text":"partial"}]}}),
        json!({"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"total 48"}]},"isError":false}),
        json!({"type":"extension_error","extensionPath":"/ext/ui.ts","event":"tool_call","error":"boom"}),
        json!({"type":"message_start","message":{"role":"assistant"}}),
        json!({"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Done."}}),
        json!({"type":"compaction_start","reason":"threshold"}),
        json!({"type":"compaction_end","reason":"threshold","aborted":false,"willRetry":false}),
        json!({"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529"}),
        json!({"type":"auto_retry_end","success":true,"attempt":2}),
    ] {
        write_record(&mut to_child, event.clone()).await;
        let message = next_message(&mut received).await;
        assert!(
            matches!(&message, ServerMessage::Event { .. }),
            "the relay forwards {event} as an event"
        );
        chat.reduce_transcript(&message);
        controls.reduce_controls(&message);
    }
    chat.flush_now();

    // AC2: the run and turn boundaries are marked, in order.
    let markers: Vec<Marker> = chat
        .rows
        .get()
        .iter()
        .filter_map(|r| match r.kind {
            RowKind::Marker(marker) => Some(marker),
            _ => None,
        })
        .collect();
    assert_eq!(markers, vec![Marker::RunStart, Marker::TurnStart]);

    // AC1/AC4: text, the tool card, the extension error, then the stream keeps
    // going — the error is a row, not the end of the run.
    let transcript: Vec<&str> = chat
        .rows
        .get()
        .iter()
        .filter(|row| !matches!(row.kind, RowKind::Marker(_)))
        .map(|row| match row.kind {
            RowKind::Text(_) => "text",
            RowKind::Tool(_) => "tool",
            RowKind::ExtensionError(_) => "extension-error",
            RowKind::Thinking(_) => "thinking",
            RowKind::Marker(_) => "marker",
        })
        .collect();
    assert_eq!(transcript, ["text", "tool", "extension-error", "text"]);
    assert!(
        chat.rows.get().windows(2).all(|pair| pair[1].id > pair[0].id),
        "row ids are monotonic"
    );

    let card = chat
        .rows
        .get()
        .iter()
        .find_map(|row| row.kind.as_tool().cloned())
        .expect("a tool card row");
    assert_eq!(card.name, "bash");
    assert_eq!(
        card.output, "total 48",
        "the end result replaces the streamed snapshot"
    );
    assert_eq!(card.status, ToolStatus::Done);

    // AC3: the banner is labelled from `compaction_end.reason` and is finished;
    // the successful `auto_retry_end` cleared the pill.
    let compaction = controls.compaction.get().expect("a compaction banner");
    assert_eq!(compaction.label(), "Auto-compacting…");
    assert!(matches!(
        compaction.phase,
        CompactionPhase::Finished { aborted: false, .. }
    ));
    assert!(controls.retry.get().is_none());

    drop(command_tx);
    let _ = relay.await;
}

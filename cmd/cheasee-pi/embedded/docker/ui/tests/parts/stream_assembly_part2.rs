/// Session envelopes: the harness commands carry ids (not paths), and the
/// server row never leaks a host path or the process marker.
#[test]
fn stream_session_envelopes_round_trip() {
    use cheasee_pi_ui::bridge::SessionRow;

    let list = ClientMessage::ListSessions {
        id: Some("c1".into()),
    };
    let value = serde_json::to_value(&list).unwrap();
    assert_eq!(value["type"], "list_sessions");
    assert_eq!(
        serde_json::from_value::<ClientMessage>(value).unwrap(),
        list
    );

    let resume = ClientMessage::ResumeSession {
        id: None,
        session_id: "abc".into(),
        mode: Some("fork".into()),
        entry_id: Some("e1".into()),
    };
    let value = serde_json::to_value(&resume).unwrap();
    assert_eq!(value["type"], "resume_session");
    assert_eq!(value["sessionId"], "abc");
    assert_eq!(value["mode"], "fork");
    assert_eq!(value["entryId"], "e1");
    assert_eq!(
        serde_json::from_value::<ClientMessage>(value).unwrap(),
        resume
    );

    let stop = ClientMessage::StopSession {
        id: None,
        session_id: "abc".into(),
    };
    assert_eq!(serde_json::to_value(&stop).unwrap()["type"], "stop_session");

    let row = SessionRow {
        id: "abc".into(),
        name: Some("My session".into()),
        modified: 7,
        created: None,
        message_count: 3,
        in_use: false,
        unavailable: false,
    };
    let message = ServerMessage::SessionList {
        id: None,
        sessions: vec![row],
    };
    let value = serde_json::to_value(&message).unwrap();
    assert_eq!(value["type"], "session_list");
    assert_eq!(value["sessions"][0]["messageCount"], 3);
    let serialized = value.to_string();
    assert!(
        !serialized.contains("\"path\""),
        "the session row must never carry a host path: {serialized}"
    );
    assert!(
        !serialized.contains("CHEASEE_SESSION_ID"),
        "the session row must never carry the process marker: {serialized}"
    );
    assert_eq!(
        serde_json::from_value::<ServerMessage>(value).unwrap(),
        message
    );

    let action = ServerMessage::SessionAction {
        id: None,
        session_id: "abc".into(),
        success: false,
        error: Some("in use".into()),
    };
    assert_eq!(serde_json::to_value(&action).unwrap()["success"], false);
}

/// AC2/AC4: replay entries are folded into the transcript history and
/// deduplicated by stable entry id, so a reconnect shows history exactly once
/// (rather than ignoring the replay frames entirely).
#[test]
fn stream_replay_entries_are_folded_and_deduplicated() {
    let owner = Owner::new();
    owner.set();
    let state = ChatState::new();

    let entries = vec![
        json!({"id": "u1", "message": {"role": "user", "content": "hello"}}),
        json!({"id": "a1", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi there"}]}}),
    ];
    assert!(state.reduce_transcript(&ServerMessage::SessionReplay {
        id: None,
        session_id: "s".into(),
        entries: entries.clone(),
        done: false,
    }));
    assert_eq!(state.rows.get().len(), 2);
    assert_eq!(texts(&state.rows.get())[0], (0, "hello".to_string()));
    assert_eq!(texts(&state.rows.get())[1], (0, "hi there".to_string()));

    // The same replay again is a no-op: dedupe is by stable entry id.
    assert!(!state.reduce_transcript(&ServerMessage::SessionReplay {
        id: None,
        session_id: "s".into(),
        entries,
        done: true,
    }));
    assert_eq!(state.rows.get().len(), 2, "no duplicate rows");
}

/// AC1/AC5: replay parses pi's actual camel-case `toolCall` content type and
/// pairs its `toolResult` by `toolCallId` into one named card (history must not
/// lose the tool name/args, nor leave a nameless standalone card).
#[test]
fn stream_replay_pairs_camel_case_tool_call_and_result() {
    let owner = Owner::new();
    owner.set();
    let state = ChatState::new();
    let entries = vec![
        json!({"id": "a1", "message": {"role": "assistant", "content": [
            {"type": "toolCall", "id": "call_1", "name": "bash", "arguments": {"command": "ls"}}
        ]}}),
        json!({"id": "t1", "message": {"role": "toolResult", "toolCallId": "call_1",
            "toolName": "bash", "content": [{"type": "text", "text": "total 48"}], "isError": false}}),
    ];
    state.reduce_transcript(&ServerMessage::SessionReplay {
        id: None,
        session_id: "s".into(),
        entries,
        done: true,
    });

    let rows = state.rows.get();
    assert_eq!(rows.len(), 1, "call and result fold to one card");
    let card = rows[0].kind.as_tool().expect("tool row");
    assert_eq!(card.tool_call_id, "call_1");
    assert_eq!(card.name, "bash");
    assert!(card.args.contains("ls"), "args preserved: {}", card.args);
    assert_eq!(card.output, "total 48");
    assert_eq!(card.status, cheasee_pi_ui::tool_card::ToolStatus::Done);
}

/// Audit regression: a persisted `isError: true` result must replay as an error
/// card, not silently as success.
#[test]
fn stream_replay_error_result_keeps_error_status() {
    let owner = Owner::new();
    owner.set();
    let state = ChatState::new();
    let entries = vec![
        json!({"id": "a1", "message": {"role": "assistant", "content": [
            {"type": "toolCall", "id": "call_1", "name": "bash", "arguments": {"command": "boom"}}
        ]}}),
        json!({"id": "t1", "message": {"role": "toolResult", "toolCallId": "call_1",
            "toolName": "bash", "content": [{"type": "text", "text": "command failed"}], "isError": true}}),
    ];
    state.reduce_transcript(&ServerMessage::SessionReplay {
        id: None,
        session_id: "s".into(),
        entries,
        done: true,
    });

    let rows = state.rows.get();
    assert_eq!(rows.len(), 1);
    let card = rows[0].kind.as_tool().expect("tool row");
    assert_eq!(card.status, cheasee_pi_ui::tool_card::ToolStatus::Error);
    assert_eq!(card.output, "command failed");
}

/// AC1: tool execution events become durable rows between text rows.
#[test]
fn stream_tool_events_become_rows_between_text() {
    let owner = Owner::new();
    owner.set();
    let state = ChatState::new();
    let event = |event| ServerMessage::Event { event };

    state.reduce_transcript(&event(delta(0, "before")));
    state.reduce_transcript(&event(Event::ToolExecutionStart {
        tool_call_id: "call_1".into(),
        tool_name: "bash".into(),
        args: json!({"command": "ls"}),
    }));
    state.reduce_transcript(&event(Event::ToolExecutionUpdate {
        tool_call_id: "call_1".into(),
        tool_name: "bash".into(),
        args: json!({"command": "ls"}),
        partial_result: json!({"content": [{"type": "text", "text": "par"}]}),
    }));
    state.reduce_transcript(&event(Event::ToolExecutionUpdate {
        tool_call_id: "call_1".into(),
        tool_name: "bash".into(),
        args: json!({"command": "ls"}),
        partial_result: json!({"content": [{"type": "text", "text": "partial"}]}),
    }));
    state.reduce_transcript(&event(Event::ToolExecutionEnd {
        tool_call_id: "call_1".into(),
        tool_name: "bash".into(),
        result: json!({"content": [{"type": "text", "text": "total 48"}]}),
        is_error: false,
    }));
    state.reduce_transcript(&event(Event::MessageStart { message: json!({}) }));
    state.reduce_transcript(&event(delta(0, "after")));

    let rows = state.rows.get();
    let kinds: Vec<&str> = rows
        .iter()
        .map(|r| match r.kind {
            RowKind::Text(_) => "text",
            RowKind::Tool(_) => "tool",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, vec!["text", "tool", "text"]);
    // The streaming snapshots replaced, never appended.
    let card = rows[1].kind.as_tool().unwrap();
    assert_eq!(card.output, "total 48");
    assert_eq!(card.status, cheasee_pi_ui::tool_card::ToolStatus::Done);
}

/// AC2: run/turn boundaries emit marker rows.
#[test]
fn stream_turns_emit_markers() {
    let mut assembler = Assembler::default();
    assembler.reduce_event(&Event::AgentStart);
    assembler.reduce_event(&Event::TurnStart);
    assembler.reduce_event(&Event::AgentEnd {
        messages: vec![],
        will_retry: None,
    });
    let markers: Vec<Marker> = assembler
        .rows()
        .iter()
        .filter_map(|r| match r.kind {
            RowKind::Marker(m) => Some(m),
            _ => None,
        })
        .collect();
    assert_eq!(
        markers,
        vec![Marker::RunStart, Marker::TurnStart, Marker::RunEnd]
    );
}

/// AC5: replay and live rows share one monotonic id-space and render in order.
#[test]
fn stream_rows_render_history_then_live_in_one_key_space() {
    let owner = Owner::new();
    owner.set();
    let state = ChatState::new();
    state.reduce_transcript(&ServerMessage::SessionReplay {
        id: None,
        session_id: "s".into(),
        entries: vec![json!({"id": "u1", "message": {"role": "user", "content": "hi"}})],
        done: false,
    });
    state.reduce_transcript(&ServerMessage::Event {
        event: delta(0, "live"),
    });
    let rows = state.rows.get();
    assert_eq!(rows.len(), 2);
    assert!(
        rows[1].id > rows[0].id,
        "history and live share one key-space"
    );
}

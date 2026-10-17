    /// Audit regression: an `extension_error` arriving after a text delta but
    /// before `message_end` must not be reordered — the finalized text row is
    /// reconciled in place, so the transcript stays chronological.
    #[test]
    fn extension_error_before_message_end_keeps_chronology() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::MessageStart { message: json!({}) });
        a.reduce_event(&delta(0, "streaming"));
        a.reduce_event(&Event::ExtensionError {
            extension_path: "/e.ts".into(),
            event: "tool_call".into(),
            error: "boom".into(),
        });
        a.reduce_event(&Event::MessageEnd {
            message: json!({
                "role": "assistant",
                "content": [{"type": "text", "text": "final"}]
            }),
        });
        let kinds: Vec<&str> = a
            .rows()
            .iter()
            .map(|r| match r.kind {
                RowKind::Text(_) => "text",
                RowKind::ExtensionError(_) => "error",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["text", "error"]);
        assert_eq!(a.rows()[0].kind.as_text().unwrap().text, "final");
        assert!(a.rows().windows(2).all(|w| w[1].id > w[0].id));
    }

    /// Phase 3: an extension error is a row and the stream continues.
    #[test]
    fn extension_error_is_a_row_and_stream_continues() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::ExtensionError {
            extension_path: "/e.ts".into(),
            event: "tool_call".into(),
            error: "boom".into(),
        });
        assert!(matches!(a.rows()[0].kind, RowKind::ExtensionError(_)));
        assert!(a.reduce_event(&delta(0, "still alive")));
        assert_eq!(a.rows().len(), 2);
    }

    /// Phase 3: an empty `agent_end` still marks its boundary.
    #[test]
    fn empty_agent_end_still_marks_boundary() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::AgentEnd {
            messages: vec![],
            will_retry: None,
        });
        assert!(matches!(a.rows()[0].kind, RowKind::Marker(Marker::RunEnd)));
    }

    /// Phase 5: replay pairs a tool call with its result (one row, no duplicate).
    #[test]
    fn replay_pairs_tool_call_with_tool_result() {
        let mut a = Assembler::default();
        a.apply_replay(&[
            json!({"id": "a1", "message": {"role": "assistant", "content": [
                {"type": "toolcall", "id": "call_1", "name": "bash", "arguments": {"command": "ls"}}
            ]}}),
            json!({"id": "t1", "message": {"role": "toolResult", "toolCallId": "call_1",
                "content": [{"type": "text", "text": "total 48"}]}}),
        ]);
        assert_eq!(a.history().len(), 1);
        let card = a.history()[0].kind.as_tool().unwrap();
        assert_eq!(card.tool_call_id, "call_1");
        assert_eq!(card.output, "total 48");
        assert_eq!(card.status, ToolStatus::Done);
    }

    /// Phase 5: replay is idempotent by entry id.
    #[test]
    fn replay_is_idempotent_by_entry_id() {
        let entries = vec![
            json!({"id": "u1", "message": {"role": "user", "content": "hello"}}),
            json!({"id": "a1", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}}),
        ];
        let mut a = Assembler::default();
        assert!(a.apply_replay(&entries));
        assert!(!a.apply_replay(&entries));
        assert_eq!(a.history().len(), 2);
    }

    /// Phase 5: a result-less tool call renders a running card without panic.
    #[test]
    fn replay_tool_call_without_result_does_not_panic() {
        let mut a = Assembler::default();
        a.apply_replay(&[
            json!({"id": "a1", "message": {"role": "assistant", "content": [
                {"type": "toolcall", "id": "call_1", "name": "bash", "arguments": {}}
            ]}}),
        ]);
        assert_eq!(a.history().len(), 1);
        assert_eq!(
            a.history()[0].kind.as_tool().unwrap().status,
            ToolStatus::Running
        );
        assert!(a.history()[0].kind.as_tool().unwrap().output.is_empty());
    }

    /// Phase 5: history renders before the live run and is not reset by a
    /// `message_start`.
    #[test]
    fn rows_render_history_then_live() {
        let owner = leptos::prelude::Owner::new();
        owner.set();
        let state = ChatState::new();
        state.reduce_transcript(&ServerMessage::SessionReplay {
            id: None,
            session_id: "s".into(),
            entries: vec![json!({"id": "u1", "message": {"role": "user", "content": "hi"}})],
            done: false,
        });
        assert_eq!(state.rows.get().len(), 1);
        state.reduce_transcript(&ServerMessage::Event {
            event: Event::MessageStart { message: json!({}) },
        });
        state.reduce_transcript(&ServerMessage::Event {
            event: delta(0, "live"),
        });
        assert_eq!(state.rows.get().len(), 2);
        assert_eq!(state.rows.get()[0].kind.as_text().unwrap().text, "hi");
        assert_eq!(state.rows.get()[1].kind.as_text().unwrap().text, "live");
    }

    /// Phase 5: the same `toolCallId` folded from replay (the SSR pass) and
    /// reduced from live `tool_execution_*` (the hydrate pass) yields the same
    /// card shape, so history and live rows cannot diverge on hydration.
    #[test]
    fn replay_and_live_agree_on_tool_shape() {
        let mut replayed = Assembler::default();
        replayed.apply_replay(&[
            json!({"id": "a1", "message": {"role": "assistant", "content": [
                {"type": "toolcall", "id": "call_1", "name": "bash", "arguments": {"command": "ls"}}
            ]}}),
            json!({"id": "t1", "message": {"role": "toolResult", "toolCallId": "call_1",
                "content": [{"type": "text", "text": "total 48"}]}}),
        ]);

        let mut live = Assembler::default();
        live.reduce_event(&Event::ToolExecutionStart {
            tool_call_id: "call_1".into(),
            tool_name: "bash".into(),
            args: json!({"command": "ls"}),
        });
        live.reduce_event(&Event::ToolExecutionEnd {
            tool_call_id: "call_1".into(),
            tool_name: "bash".into(),
            result: json!({"content": [{"type": "text", "text": "total 48"}]}),
            is_error: false,
        });

        assert_eq!(replayed.history().len(), 1);
        assert_eq!(live.rows().len(), 1);
        assert_eq!(
            replayed.history()[0].kind.as_tool().unwrap(),
            live.rows()[0].kind.as_tool().unwrap(),
            "replay and live tool cards must have the same shape"
        );
    }

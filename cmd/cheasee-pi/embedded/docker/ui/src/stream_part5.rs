    use super::*;
    use crate::protocol::Event;
    use serde_json::json;

    fn delta(index: u32, delta: &str) -> Event {
        Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "text_delta", "contentIndex": index, "delta": delta}),
            usage: None,
        }
    }

    fn thinking_delta(index: u32, delta: &str) -> Event {
        Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "thinking_delta", "contentIndex": index, "delta": delta}),
            usage: None,
        }
    }

    fn texts(assembler: &Assembler) -> Vec<(u32, String)> {
        assembler
            .rows()
            .iter()
            .filter_map(|row| {
                row.kind
                    .as_text()
                    .map(|b| (b.content_index, b.text.clone()))
            })
            .collect()
    }

    #[test]
    fn deltas_append_in_order() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::MessageStart { message: json!({}) });
        assert!(a.reduce_event(&delta(0, "Hello")));
        assert!(a.reduce_event(&delta(0, ", ")));
        a.reduce_event(&delta(0, "world"));
        assert_eq!(texts(&a), vec![(0, "Hello, world".to_string())]);
        assert!(matches!(a.rows()[0].kind, RowKind::Text(_)));
    }

    /// AC2: rows are keyed by `contentIndex`, so interleaved thinking and
    /// text do not merge into one row.
    #[test]
    fn interleaved_blocks_are_grouped_by_content_index() {
        let mut a = Assembler::default();
        a.reduce_event(&delta(0, "answer"));
        a.reduce_event(&thinking_delta(1, "hmm"));
        a.reduce_event(&delta(0, "!"));
        a.reduce_event(&thinking_delta(1, "?"));
        assert_eq!(
            texts(&a),
            vec![(0, "answer!".to_string()), (1, "hmm?".to_string())]
        );
        assert!(matches!(a.rows()[1].kind, RowKind::Thinking(_)));
    }

    /// AC2/AC3: `text_end.content` is authoritative — it replaces the
    /// assembled deltas rather than concatenating.
    #[test]
    fn text_end_replaces_the_delta_buffer() {
        let mut a = Assembler::default();
        a.reduce_event(&delta(0, "Hel"));
        a.reduce_event(&delta(0, "lo wor"));
        a.reduce_event(&Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "text_end", "contentIndex": 0, "content": "Hello world"}),
            usage: None,
        });
        assert_eq!(texts(&a), vec![(0, "Hello world".to_string())]);
    }

    /// AC3: `message_end.message` replaces the whole assembled partial, and a
    /// thinking row is rendered separately from text.
    #[test]
    fn message_end_is_authoritative_and_splits_thinking() {
        let mut a = Assembler::default();
        a.reduce_event(&delta(0, "partial that is wrong"));
        a.reduce_event(&Event::MessageEnd {
            message: json!({
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "let me think"},
                    {"type": "text", "text": "final answer"}
                ],
                "usage": {"input": 7, "output": 3}
            }),
        });
        assert_eq!(
            texts(&a),
            vec![
                (0, "let me think".to_string()),
                (1, "final answer".to_string())
            ]
        );
        assert!(matches!(a.rows()[0].kind, RowKind::Thinking(_)));
        assert!(matches!(a.rows()[1].kind, RowKind::Text(_)));
        assert_eq!(a.usage().input, 7);
        assert!(a.usage().available);
    }

    /// `message_end` is authoritative: a trailing `message_update` for the same
    /// message must not append to the final text, and the next `message_start`
    /// re-opens the message for a new run.
    #[test]
    fn trailing_delta_after_message_end_is_ignored_until_next_message_start() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::MessageStart { message: json!({}) });
        a.reduce_event(&delta(0, "partial"));
        a.reduce_event(&Event::MessageEnd {
            message: json!({
                "role": "assistant",
                "content": [{"type": "text", "text": "final"}]
            }),
        });
        // A stray delta after the authoritative end cannot corrupt the text.
        assert!(!a.reduce_event(&delta(0, " CORRUPT")));
        assert_eq!(texts(&a), vec![(0, "final".to_string())]);
        // The next message start re-opens assembly; earlier rows are kept.
        assert!(a.reduce_event(&Event::MessageStart { message: json!({}) }));
        assert!(a.reduce_event(&delta(0, "second")));
        assert_eq!(
            texts(&a),
            vec![(0, "final".to_string()), (0, "second".to_string())]
        );
    }

    /// AC4: usage is cumulative — a later snapshot replaces the earlier one
    /// instead of summing.
    #[test]
    fn usage_is_replaced_not_accumulated() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "text_delta", "contentIndex": 0, "delta": "x"}),
            usage: Some(json!({"input": 10, "output": 2, "cost": {"total": 0.01}})),
        });
        a.reduce_event(&Event::MessageUpdate {
            message: None,
            assistant_message_event: json!({"type": "text_delta", "contentIndex": 0, "delta": "y"}),
            usage: Some(json!({"input": 10, "output": 5, "cost": {"total": 0.02}})),
        });
        let usage = a.usage();
        assert_eq!(usage.input, 10, "input must not be double counted");
        assert_eq!(usage.output, 5);
        assert_eq!(usage.cost_total, 0.02);
    }

    /// AC5: the streaming indicator clears on `agent_settled`, not `agent_end`.
    #[test]
    fn settled_clears_streaming_but_agent_end_does_not() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::AgentStart);
        assert!(a.status().is_streaming());
        a.reduce_event(&Event::AgentEnd {
            messages: vec![],
            will_retry: Some(true),
        });
        assert_eq!(
            a.status(),
            StreamStatus::Streaming,
            "agent_end may still be retried"
        );
        assert_eq!(a.will_retry(), Some(true));
        assert!(a.reduce_event(&Event::AgentSettled));
        assert_eq!(a.status(), StreamStatus::Settled);
    }

    #[test]
    fn live_text_is_bounded() {
        let mut a = Assembler::default();
        for _ in 0..(MAX_LIVE_TEXT / 10 + 2) {
            a.reduce_event(&delta(0, "0123456789"));
        }
        let body = a.rows()[0].kind.as_text().unwrap();
        assert!(body.truncated);
        assert!(body.text.len() <= MAX_LIVE_TEXT);
    }

    /// The delta-only pi >=0.84 record (no `message`, no `partial`) reaches the
    /// assembler — the decode regression the research flagged.
    #[test]
    fn delta_only_message_update_reaches_the_assembler() {
        let event: Event = serde_json::from_value(json!({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "hi"}
        }))
        .unwrap();
        let mut a = Assembler::default();
        assert!(a.reduce_event(&event));
        assert_eq!(texts(&a), vec![(0, "hi".to_string())]);
    }

    /// AC5: a rejected prompt response is surfaced, not swallowed.
    #[test]
    fn chat_state_surfaces_rejected_prompt() {
        // Signals need a reactive owner to allocate into.
        let owner = leptos::prelude::Owner::new();
        owner.set();
        let state = ChatState::new();
        assert!(state.reduce_transcript(&ServerMessage::CommandResponse {
            id: None,
            command: "prompt".into(),
            success: false,
            error: Some("agent is streaming; specify streamingBehavior".into()),
            disposition: None,
            data: None,
        }));
        assert!(state.notice.get().unwrap().contains("streamingBehavior"));
    }

    /// Phase 1: two messages append; the second does not clear the first.
    #[test]
    fn rows_are_append_only_across_turns() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::MessageStart { message: json!({}) });
        a.reduce_event(&delta(0, "first"));
        a.reduce_event(&Event::MessageStart { message: json!({}) });
        a.reduce_event(&delta(0, "second"));
        assert_eq!(texts(&a).len(), 2);
    }

    /// Phase 1: ids are strictly increasing and pairwise distinct.
    #[test]
    fn row_ids_are_monotonic_and_unique() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::AgentStart);
        a.reduce_event(&delta(0, "x"));
        a.reduce_event(&Event::TurnEnd {
            message: json!({}),
            tool_results: vec![],
        });
        a.reduce_event(&Event::ToolExecutionStart {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
        });
        let mut seen = std::collections::HashSet::new();
        let mut last = None;
        for row in a.rows() {
            assert!(seen.insert(row.id), "duplicate id {}", row.id);
            if let Some(prev) = last {
                assert!(row.id > prev, "ids must increase");
            }
            last = Some(row.id);
        }
    }

    /// Phase 1: identical sequences produce identical `(id, kind)` rows — the
    /// SSR/hydrate parity seed.
    #[test]
    fn rows_are_deterministic_for_identical_sequences() {
        let events = vec![
            Event::AgentStart,
            delta(0, "hello"),
            Event::ToolExecutionStart {
                tool_call_id: "c".into(),
                tool_name: "bash".into(),
                args: json!({}),
            },
            Event::ExtensionError {
                extension_path: "/e.ts".into(),
                event: "ev".into(),
                error: "boom".into(),
            },
        ];
        let run = || {
            let mut a = Assembler::default();
            for event in &events {
                a.reduce_event(event);
            }
            a.rows().to_vec()
        };
        assert_eq!(run(), run());
    }

    /// Phase 1: defaults are empty — hydration-safe.
    #[test]
    fn default_assembler_has_no_rows() {
        let a = Assembler::default();
        assert!(a.rows().is_empty());
        assert!(a.history().is_empty());
        let owner = leptos::prelude::Owner::new();
        owner.set();
        let state = ChatState::new();
        assert!(state.rows.get().is_empty());
    }

    /// Phase 2: streaming tool snapshots replace, never append.
    #[test]
    fn tool_update_replaces_snapshot_never_appends() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::ToolExecutionStart {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
        });
        a.reduce_event(&Event::ToolExecutionUpdate {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
            partial_result: json!({"content": [{"type": "text", "text": "par"}]}),
        });
        a.reduce_event(&Event::ToolExecutionUpdate {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
            partial_result: json!({"content": [{"type": "text", "text": "partial"}]}),
        });
        assert_eq!(a.rows().len(), 1);
        assert_eq!(a.rows()[0].kind.as_tool().unwrap().output, "partial");
        assert_eq!(
            a.rows()[0].kind.as_tool().unwrap().status,
            ToolStatus::Running
        );
    }

    /// Phase 2: end marks done/error and replaces the body.
    #[test]
    fn tool_end_marks_done_or_error() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::ToolExecutionStart {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
        });
        a.reduce_event(&Event::ToolExecutionEnd {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            result: json!({"content": [{"type": "text", "text": "total 48"}]}),
            is_error: false,
        });
        let card = a.rows()[0].kind.as_tool().unwrap();
        assert_eq!(card.output, "total 48");
        assert_eq!(card.status, ToolStatus::Done);

        let mut b = Assembler::default();
        b.reduce_event(&Event::ToolExecutionStart {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
        });
        b.reduce_event(&Event::ToolExecutionEnd {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            result: json!({"content": [{"type": "text", "text": "boom"}]}),
            is_error: true,
        });
        assert_eq!(
            b.rows()[0].kind.as_tool().unwrap().status,
            ToolStatus::Error
        );
    }

    /// Phase 2: tool events interleave between text rows.
    #[test]
    fn tool_events_become_rows_between_text() {
        let mut a = Assembler::default();
        a.reduce_event(&delta(0, "before"));
        a.reduce_event(&Event::ToolExecutionStart {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            args: json!({}),
        });
        a.reduce_event(&Event::ToolExecutionEnd {
            tool_call_id: "c".into(),
            tool_name: "bash".into(),
            result: json!({"content": []}),
            is_error: false,
        });
        a.reduce_event(&Event::MessageStart { message: json!({}) });
        a.reduce_event(&delta(0, "after"));
        let kinds: Vec<&str> = a
            .rows()
            .iter()
            .map(|r| match r.kind {
                RowKind::Text(_) => "text",
                RowKind::Tool(_) => "tool",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["text", "tool", "text"]);
        assert!(a.rows().windows(2).all(|w| w[1].id > w[0].id));
    }

    /// Phase 2: the browser bash id-space is disjoint — no tool row.
    #[test]
    fn bash_update_does_not_create_a_tool_row() {
        let owner = leptos::prelude::Owner::new();
        owner.set();
        let state = ChatState::new();
        state.reduce_transcript(&ServerMessage::Event {
            event: Event::BashExecutionUpdate {
                id: Some("b1".into()),
                delta: Some("out\n".into()),
                extra: serde_json::Map::new(),
            },
        });
        assert!(state.rows.get().is_empty());
    }

    /// Phase 3: run/turn boundaries each append a distinct marker.
    #[test]
    fn turn_and_run_boundaries_emit_markers() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::AgentStart);
        a.reduce_event(&Event::TurnStart);
        a.reduce_event(&Event::TurnEnd {
            message: json!({}),
            tool_results: vec![],
        });
        a.reduce_event(&Event::AgentEnd {
            messages: vec![],
            will_retry: None,
        });
        let markers: Vec<Marker> = a
            .rows()
            .iter()
            .filter_map(|r| match r.kind {
                RowKind::Marker(m) => Some(m),
                _ => None,
            })
            .collect();
        assert_eq!(
            markers,
            vec![
                Marker::RunStart,
                Marker::TurnStart,
                Marker::TurnEnd,
                Marker::RunEnd
            ]
        );
    }

    /// Phase 3: markers interleave chronologically with text.
    #[test]
    fn markers_interleave_chronologically() {
        let mut a = Assembler::default();
        a.reduce_event(&Event::AgentStart);
        a.reduce_event(&delta(0, "x"));
        a.reduce_event(&Event::TurnEnd {
            message: json!({}),
            tool_results: vec![],
        });
        let kinds: Vec<&str> = a
            .rows()
            .iter()
            .map(|r| match r.kind {
                RowKind::Marker(Marker::RunStart) => "run-start",
                RowKind::Text(_) => "text",
                RowKind::Marker(Marker::TurnEnd) => "turn-end",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["run-start", "text", "turn-end"]);
    }


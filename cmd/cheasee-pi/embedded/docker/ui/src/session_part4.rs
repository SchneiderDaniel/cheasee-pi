#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use crate::bridge::StreamingBehavior;
    use crate::protocol::Event;
    use crate::rpc::framing::{encode_record, JsonlReader};
    use tokio::io::{AsyncWriteExt, BufReader, DuplexStream};

    const BOUND: Duration = Duration::from_secs(2);

    type Frames = JsonlReader<BufReader<DuplexStream>>;

    struct FakeSink {
        commands: mpsc::UnboundedReceiver<Result<ClientMessage, String>>,
        sent: mpsc::UnboundedSender<ServerMessage>,
    }

    impl ClientSink for FakeSink {
        async fn send_text(&mut self, text: String) -> Result<(), ()> {
            let message: ServerMessage = serde_json::from_str(&text).map_err(|_| ())?;
            let _ = self.sent.send(message);
            Ok(())
        }

        async fn recv(&mut self) -> Option<Result<ClientMessage, String>> {
            self.commands.recv().await
        }
    }

    /// A fake browser wired to two channels: commands in, frames out.
    fn fake() -> (
        mpsc::UnboundedSender<Result<ClientMessage, String>>,
        mpsc::UnboundedReceiver<ServerMessage>,
        FakeSink,
    ) {
        let (command_tx, commands) = mpsc::unbounded_channel();
        let (sent, received) = mpsc::unbounded_channel();
        (command_tx, received, FakeSink { commands, sent })
    }

    fn harness() -> (Arc<RpcClient>, DuplexStream, Frames) {
        let (stdout_tx, stdout_rx) = tokio::io::duplex(1 << 20);
        let (stdin_tx, from_child) = tokio::io::duplex(1 << 20);
        let client = Arc::new(RpcClient::new(Box::new(stdout_rx), Box::new(stdin_tx)));
        (client, stdout_tx, JsonlReader::new(BufReader::new(from_child)))
    }

    async fn write_record(to_child: &mut DuplexStream, value: Value) {
        to_child
            .write_all(&encode_record(&value).unwrap())
            .await
            .unwrap();
        to_child.flush().await.unwrap();
    }

    async fn next_command(frames: &mut Frames) -> Value {
        let raw = tokio::time::timeout(BOUND, frames.next_record_str())
            .await
            .expect("command written within 2s")
            .expect("frame read")
            .expect("frame present");
        serde_json::from_str(&raw).expect("command frame is JSON")
    }

    async fn next_message(received: &mut mpsc::UnboundedReceiver<ServerMessage>) -> ServerMessage {
        tokio::time::timeout(BOUND, received.recv())
            .await
            .expect("a server message within 2s")
            .expect("browser channel open")
    }

    /// Subscribe the harness connection and drain its header + replay. The relay
    /// starts unbound, so events only reach a bound connection.
    async fn bind(
        command_tx: &mpsc::UnboundedSender<Result<ClientMessage, String>>,
        received: &mut mpsc::UnboundedReceiver<ServerMessage>,
        frames: &mut Frames,
        to_child: &mut DuplexStream,
    ) {
        command_tx
            .send(Ok(ClientMessage::Subscribe {
                id: None,
                session_id: String::new(),
                since: None,
            }))
            .unwrap();
        for _ in 0..3 {
            let command = next_command(frames).await;
            let id = command["id"].as_str().unwrap().to_string();
            let response = match command["type"].as_str().unwrap() {
                "get_entries" => serde_json::json!({"type":"response","command":"get_entries","success":true,"id":id,"data":{"entries":[],"leafId":null}}),
                "get_state" => serde_json::json!({"type":"response","command":"get_state","success":true,"id":id,"data":{}}),
                "get_last_assistant_text" => serde_json::json!({"type":"response","command":"get_last_assistant_text","success":true,"id":id,"data":{"text":null}}),
                other => panic!("unexpected binding request {other}"),
            };
            write_record(to_child, response).await;
        }
        let _ = next_message(received).await; // SessionState
        let _ = next_message(received).await; // SessionReplay
    }

    /// AC1 + AC5: a prompt is forwarded as a pi `prompt` command and both its
    /// response and the pi events around it reach the browser.
    #[tokio::test]
    async fn relay_forwards_events_and_command_responses() {
        let (client, mut to_child, mut frames) = harness();
        let (command_tx, mut received, sink) = fake();
        let session = Arc::new(Session::new(Arc::clone(&client)));
        let relay = tokio::spawn(async move { session.relay(sink).await });

        bind(&command_tx, &mut received, &mut frames, &mut to_child).await;

        command_tx
            .send(Ok(ClientMessage::Prompt {
                id: None,
                message: "hi".into(),
                streaming_behavior: Some(StreamingBehavior::Steer),
            }))
            .unwrap();

        let frame = next_command(&mut frames).await;
        assert_eq!(frame["type"], "prompt");
        assert_eq!(frame["message"], "hi");
        assert_eq!(frame["streamingBehavior"], "steer");
        let id = frame["id"].as_str().unwrap().to_string();

        // A pi event emitted while the prompt is in flight is relayed.
        write_record(&mut to_child, serde_json::json!({"type": "agent_start"})).await;
        match next_message(&mut received).await {
            ServerMessage::Event { event } => assert!(matches!(event, Event::AgentStart)),
            other => panic!("expected an event, got {other:?}"),
        }

        write_record(
            &mut to_child,
            serde_json::json!({"type": "response", "command": "prompt", "success": true, "id": id, "data": {"disposition": "started"}}),
        )
        .await;
        match next_message(&mut received).await {
            ServerMessage::CommandResponse {
                success,
                command,
                disposition,
                ..
            } => {
                assert!(success);
                assert_eq!(command, "prompt");
                assert_eq!(disposition.as_deref(), Some("started"));
            }
            other => panic!("expected a command response, got {other:?}"),
        }

        drop(command_tx);
        let _ = relay.await;
    }

    /// AC5: `success:false` is relayed, not swallowed.
    #[tokio::test]
    async fn relay_surfaces_a_rejected_command() {
        let (client, mut to_child, mut frames) = harness();
        let (command_tx, mut received, sink) = fake();
        let session = Arc::new(Session::new(Arc::clone(&client)));
        let relay = tokio::spawn(async move { session.relay(sink).await });

        command_tx.send(Ok(ClientMessage::Abort { id: None })).unwrap();
        let frame = next_command(&mut frames).await;
        let id = frame["id"].as_str().unwrap().to_string();
        write_record(
            &mut to_child,
            serde_json::json!({"type": "response", "command": "abort", "success": false, "error": "nope", "id": id}),
        )
        .await;

        match next_message(&mut received).await {
            ServerMessage::CommandResponse { success, error, .. } => {
                assert!(!success);
                assert_eq!(error.as_deref(), Some("nope"));
            }
            other => panic!("expected a rejection, got {other:?}"),
        }

        drop(command_tx);
        let _ = relay.await;
    }

    /// The `Unknown` client envelope is ignored rather than forwarded.
    #[test]
    fn unknown_client_messages_are_dropped() {
        assert!(to_command(ClientMessage::Unknown).is_none());
    }

    /// AC1–AC5: every control maps to exactly one pi command variant and wire
    /// `type`; the browser vocabulary is curated, never a raw passthrough.
    #[test]
    fn to_command_maps_every_control_to_its_pi_vocabulary() {
        let cases: Vec<(ClientMessage, &str)> = vec![
            (ClientMessage::ClearQueue { id: None }, "clear_queue"),
            (ClientMessage::GetState { id: None }, "get_state"),
            (
                ClientMessage::GetAvailableModels { id: None },
                "get_available_models",
            ),
            (
                ClientMessage::SetModel {
                    id: None,
                    provider: "anthropic".into(),
                    model_id: "claude".into(),
                },
                "set_model",
            ),
            (ClientMessage::CycleModel { id: None }, "cycle_model"),
            (
                ClientMessage::GetAvailableThinkingLevels { id: None },
                "get_available_thinking_levels",
            ),
            (
                ClientMessage::SetThinkingLevel {
                    id: None,
                    level: "high".into(),
                },
                "set_thinking_level",
            ),
            (
                ClientMessage::CycleThinkingLevel { id: None },
                "cycle_thinking_level",
            ),
            (
                ClientMessage::GetSessionStats { id: None },
                "get_session_stats",
            ),
            (
                ClientMessage::Compact {
                    id: None,
                    custom_instructions: None,
                },
                "compact",
            ),
            (
                ClientMessage::SetAutoCompaction {
                    id: None,
                    enabled: true,
                },
                "set_auto_compaction",
            ),
            (
                ClientMessage::SetAutoRetry {
                    id: None,
                    enabled: false,
                },
                "set_auto_retry",
            ),
            (ClientMessage::AbortRetry { id: None }, "abort_retry"),
            (
                ClientMessage::Bash {
                    id: "b1".into(),
                    command: "echo hi".into(),
                    exclude_from_context: None,
                },
                "bash",
            ),
            (ClientMessage::AbortBash { id: None }, "abort_bash"),
        ];
        for (message, expected) in cases {
            let routed = to_command(message).expect("control is routable");
            assert_eq!(routed.name, expected);
            let value = serde_json::to_value(&routed.command).unwrap();
            assert_eq!(value["type"], expected, "{expected} wire type");
        }
    }

    /// AC2: `set_model` / `set_thinking_level` carry their payload in pi's
    /// camelCase field names.
    #[test]
    fn to_command_carries_control_payloads() {
        let routed = to_command(ClientMessage::SetModel {
            id: None,
            provider: "anthropic".into(),
            model_id: "claude".into(),
        })
        .unwrap();
        let value = serde_json::to_value(&routed.command).unwrap();
        assert_eq!(value["provider"], "anthropic");
        assert_eq!(value["modelId"], "claude");

        let routed = to_command(ClientMessage::SetThinkingLevel {
            id: None,
            level: "high".into(),
        })
        .unwrap();
        let value = serde_json::to_value(&routed.command).unwrap();
        assert_eq!(value["level"], "high");

        let routed = to_command(ClientMessage::Compact {
            id: Some("c1".into()),
            custom_instructions: Some("be brief".into()),
        })
        .unwrap();
        let value = serde_json::to_value(&routed.command).unwrap();
        assert_eq!(value["customInstructions"], "be brief");
        assert_eq!(routed.browser_id.as_deref(), Some("c1"));
    }

    /// AC4: bash is the one control whose browser id is also the wire id, so
    /// `bash_execution_update` ids can be matched to it.
    #[test]
    fn to_command_routes_bash_through_the_browser_id() {
        let routed = to_command(ClientMessage::Bash {
            id: "b1".into(),
            command: "echo hi".into(),
            exclude_from_context: Some(true),
        })
        .unwrap();
        assert_eq!(routed.name, "bash");
        assert!(routed.preserve_id, "bash must keep the browser id on the wire");
        assert_eq!(routed.browser_id.as_deref(), Some("b1"));
        let value = serde_json::to_value(&routed.command).unwrap();
        assert_eq!(value["excludeFromContext"], true);
    }

    /// Only bash preserves the caller id; an ordinary command still lets the
    /// client mint `req_N` (asserted end-to-end by
    /// `relay_echoes_the_browser_command_id`).
    #[test]
    fn to_command_does_not_preserve_ids_for_non_bash_controls() {
        let routed = to_command(ClientMessage::ClearQueue {
            id: Some("c1".into()),
        })
        .unwrap();
        assert!(!routed.preserve_id);
    }

    /// The relay echoes the *browser's* correlation id, not pi's generated
    /// `req_N`, so a client with concurrent commands can still correlate.
    #[tokio::test]
    async fn relay_echoes_the_browser_command_id() {
        let (client, mut to_child, mut frames) = harness();
        let (command_tx, mut received, sink) = fake();
        let session = Arc::new(Session::new(Arc::clone(&client)));
        let relay = tokio::spawn(async move { session.relay(sink).await });

        command_tx
            .send(Ok(ClientMessage::Prompt {
                id: Some("browser-1".into()),
                message: "hi".into(),
                streaming_behavior: None,
            }))
            .unwrap();
        let frame = next_command(&mut frames).await;
        let pi_id = frame["id"].as_str().unwrap().to_string();
        assert_ne!(pi_id, "browser-1", "pi stamps its own id");
        write_record(
            &mut to_child,
            serde_json::json!({"type": "response", "command": "prompt", "success": true, "id": pi_id}),
        )
        .await;

        match next_message(&mut received).await {
            ServerMessage::CommandResponse { id, .. } => {
                assert_eq!(id.as_deref(), Some("browser-1"));
            }
            other => panic!("expected a command response, got {other:?}"),
        }

        drop(command_tx);
        let _ = relay.await;
    }

    /// A malformed client frame is surfaced to the browser, not silently
    /// dropped.
    #[tokio::test]
    async fn relay_surfaces_a_malformed_client_frame() {
        let (client, _to_child, _frames) = harness();
        let (command_tx, mut received, sink) = fake();
        let session = Arc::new(Session::new(Arc::clone(&client)));
        let relay = tokio::spawn(async move { session.relay(sink).await });

        command_tx.send(Err("expected value".into())).unwrap();
        match next_message(&mut received).await {
            ServerMessage::Error { message } => {
                assert!(message.contains("malformed client frame"), "{message}");
            }
            other => panic!("expected an error frame, got {other:?}"),
        }

        drop(command_tx);
        let _ = relay.await;
    }

    /// A framing fault on the child pipe reaches the browser as an error.
    #[test]
    fn frame_errors_become_server_errors() {
        let message = to_server_message(
            ProtocolMessage::Frame(crate::rpc::framing::FramingError::NotUtf8),
            &Mutex::new(None),
        );
        assert!(matches!(message, Some(ServerMessage::Error { .. })));
    }
}


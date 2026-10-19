use super::*;

/// AC5: malformed input produces a response without a request id, so it
/// cannot travel through the id map.
#[tokio::test]
async fn parse_failure_response_routes_to_the_parse_sink() {
    let (client, mut to_child, _from_child) = harness();
    let mut events = client.events();

    write_record(
        &mut to_child,
        json!({"type":"response","command":"parse","success":false,"error":"Failed to parse command: Unexpected token"}),
    )
    .await;
    match next_event(&mut events).await {
        ProtocolMessage::ParseError { error, .. } => {
            assert!(error.contains("Unexpected token"), "error = {error}")
        }
        other => panic!("expected ParseError, got {other:?}"),
    }
}

/// AC5: a bad line is surfaced and the reader keeps going.
#[tokio::test]
async fn malformed_json_is_surfaced_and_the_stream_continues() {
    let (client, mut to_child, _from_child) = harness();
    let mut events = client.events();

    to_child.write_all(b"{not json\n").await.unwrap();
    to_child.flush().await.unwrap();
    match next_event(&mut events).await {
        ProtocolMessage::ParseError { raw, .. } => assert_eq!(raw, "{not json"),
        other => panic!("expected ParseError, got {other:?}"),
    }

    write_record(&mut to_child, json!({"type":"agent_start"})).await;
    assert!(matches!(
        next_event(&mut events).await,
        ProtocolMessage::Session(Event::AgentStart)
    ));
}

#[tokio::test]
async fn unknown_event_type_is_forwarded_not_fatal() {
    let (client, mut to_child, _from_child) = harness();
    let mut events = client.events();

    // A genuinely unmodelled event type (`agent_settled` is now modelled).
    write_record(&mut to_child, json!({"type":"future_event"})).await;
    match next_event(&mut events).await {
        ProtocolMessage::Unknown(value) => assert_eq!(value["type"], "future_event"),
        other => panic!("expected Unknown, got {other:?}"),
    }

    write_record(&mut to_child, json!({"type":"agent_start"})).await;
    assert!(matches!(
        next_event(&mut events).await,
        ProtocolMessage::Session(Event::AgentStart)
    ));
}

/// AC2 hazard: `bash_execution_update` repeats the originating `bash`
/// command's id, and must not be consumed as that command's response.
#[tokio::test]
async fn bash_execution_update_repeating_a_pending_id_is_not_a_response() {
    let (client, mut to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);
    let mut events = client.events();

    let c = Arc::clone(&client);
    let pending = tokio::spawn(async move {
        c.request(&Command::Bash {
            id: None,
            command: "ls".into(),
            exclude_from_context: None,
        })
        .await
    });
    let frame = next_frame(&mut frames).await;
    let id = frame["id"].as_str().unwrap().to_string();

    write_record(
        &mut to_child,
        json!({"type":"bash_execution_update","id":id,"output":"partial"}),
    )
    .await;
    match next_event(&mut events).await {
        ProtocolMessage::Session(Event::BashExecutionUpdate { id: Some(got), .. }) => {
            assert_eq!(got, id)
        }
        other => panic!("expected a BashExecutionUpdate event, got {other:?}"),
    }
    assert!(
        !pending.is_finished(),
        "the session event resolved the pending bash command"
    );

    write_record(
        &mut to_child,
        json!({"type":"response","command":"bash","success":true,"id":id}),
    )
    .await;
    assert!(matches!(pending.await.unwrap().unwrap(), Response::Bash(_)));
}

/// The id map must be empty after a resolution: a duplicate response with
/// the same id has nothing left to consume.
#[tokio::test]
async fn a_resolved_id_never_outlives_its_resolution() {
    let (client, mut to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);
    let mut events = client.events();

    let c = Arc::clone(&client);
    let pending = tokio::spawn(async move { c.request(&abort_cmd()).await });
    next_frame(&mut frames).await;
    write_record(
        &mut to_child,
        json!({"type":"response","command":"abort","success":true,"id":"req_1"}),
    )
    .await;
    assert!(pending.await.unwrap().is_ok());

    write_record(
        &mut to_child,
        json!({"type":"response","command":"abort","success":true,"id":"req_1"}),
    )
    .await;
    assert!(matches!(
        next_event(&mut events).await,
        ProtocolMessage::Unknown(_)
    ));
}

/// A caller that goes away must not panic the resolver.
#[tokio::test]
async fn a_dropped_caller_does_not_break_the_reader() {
    let (client, mut to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);
    let mut events = client.events();

    let c = Arc::clone(&client);
    let pending = tokio::spawn(async move { c.request(&abort_cmd()).await });
    next_frame(&mut frames).await;
    pending.abort();
    let _ = pending.await;

    write_record(
        &mut to_child,
        json!({"type":"response","command":"abort","success":true,"id":"req_1"}),
    )
    .await;
    // The reader survives the failed send and keeps dispatching.
    write_record(&mut to_child, json!({"type":"agent_start"})).await;
    assert!(matches!(
        next_event(&mut events).await,
        ProtocolMessage::Session(Event::AgentStart)
    ));
}

/// Extension UI is a sub-protocol: pi's uuid is echoed, never correlated
/// through the command id map.
#[tokio::test]
async fn extension_ui_request_is_answered_with_the_pi_uuid() {
    let (client, mut to_child, from_child) = harness();
    let mut frames = frames(from_child);
    let mut events = client.events();

    write_record(
        &mut to_child,
        json!({"type":"extension_ui_request","id":"uuid-1","method":"select","title":"Allow?","options":["Allow","Block"],"timeout":10000}),
    )
    .await;
    match next_event(&mut events).await {
        ProtocolMessage::ExtensionUi(ExtensionUI::ExtensionUiRequest(req)) => {
            assert_eq!(req.id, "uuid-1");
            assert_eq!(req.method, "select");
            assert_eq!(req.params["options"][1], "Block");
        }
        other => panic!("expected an extension UI request, got {other:?}"),
    }

    client
        .send(&ExtensionUI::ExtensionUiResponse(ExtensionUiResponse {
            id: "uuid-1".into(),
            value: Some("Allow".into()),
            confirmed: None,
            cancelled: None,
        }))
        .await
        .unwrap();

    let frame = next_frame(&mut frames).await;
    assert_eq!(frame["type"], "extension_ui_response");
    assert_eq!(frame["id"], "uuid-1");
    assert_eq!(frame["value"], "Allow");
}

// ── Phase 4: lifecycle, exit, separation (AC4, AC5) ────────────────────

#[tokio::test]
async fn stdout_eof_rejects_pending_requests() {
    let (client, to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);

    let c = Arc::clone(&client);
    let pending = tokio::spawn(async move { c.request(&abort_cmd()).await });
    next_frame(&mut frames).await;

    // Child stdout closes: this is the exit signal the client watches.
    drop(to_child);

    let err = timeout(BOUND, pending)
        .await
        .expect("a rejected request must not hang")
        .unwrap()
        .unwrap_err();
    assert!(matches!(err, RpcError::ChildGone), "got {err:?}");
}

/// Audit fix: once stdout hits EOF the client is terminal. A later request
/// must fail fast, not be written to a stdin nobody answers and hang — the
/// child's stdin stays open here precisely to exercise that.
#[tokio::test]
async fn request_after_stdout_eof_fails_fast_instead_of_hanging() {
    let (client, to_child, child_stdin) = harness();
    drop(to_child); // stdout EOF
    let _child_stdin = child_stdin; // keep stdin writable

    let err = timeout(BOUND, client.request(&abort_cmd()))
        .await
        .expect("a request after stdout EOF must not hang")
        .unwrap_err();
    assert!(matches!(err, RpcError::ChildGone), "got {err:?}");
}

/// Audit fix: invalid UTF-8 is a transport framing fault, not a JSON parse
/// error. It surfaces as `Frame`, and it is not fatal: the reader
/// continues to the next record.
#[tokio::test]
async fn non_utf8_record_is_surfaced_as_a_framing_fault() {
    let (client, mut to_child, _from_child) = harness();
    let mut events = client.events();

    to_child.write_all(b"\xff\xfe\n").await.unwrap();
    to_child.flush().await.unwrap();
    match next_event(&mut events).await {
        ProtocolMessage::Frame(FramingError::NotUtf8) => {}
        other => panic!("expected Frame(NotUtf8), got {other:?}"),
    }

    // Not fatal: the next well-formed record is still delivered.
    write_record(&mut to_child, json!({"type":"agent_start"})).await;
    assert!(matches!(
        next_event(&mut events).await,
        ProtocolMessage::Session(Event::AgentStart)
    ));
}

#[tokio::test]
async fn stdin_write_failure_rejects_pending_requests() {
    let (client, _to_child, from_child) = harness();
    let client = Arc::new(client);
    let mut frames = frames(from_child);

    let c = Arc::clone(&client);
    let pending = tokio::spawn(async move { c.request(&abort_cmd()).await });
    next_frame(&mut frames).await;

    // Drop the reading half of the client's stdin: the next write EPIPEs.
    drop(frames.into_inner());

    let err = timeout(BOUND, client.request(&abort_cmd()))
        .await
        .expect("a failed write must not hang")
        .unwrap_err();
    assert!(matches!(err, RpcError::ChildGone), "got {err:?}");

    // The failed write also rejected the request already in flight,
    // instead of leaving it pending forever.
    let err = timeout(BOUND, pending)
        .await
        .expect("a rejected pending request must not hang")
        .unwrap()
        .unwrap_err();
    assert!(matches!(err, RpcError::ChildGone), "got {err:?}");
}

#[tokio::test]
async fn shutdown_closes_stdin_and_later_requests_error() {
    let (client, to_child, mut from_child) = harness();

    client.shutdown().await;
    let err = timeout(BOUND, client.request(&abort_cmd()))
        .await
        .expect("a request after shutdown must not hang")
        .unwrap_err();
    assert!(matches!(err, RpcError::ChildGone), "got {err:?}");

    // Stdin is closed: the reading half sees EOF, not a record.
    let mut raw = Vec::new();
    from_child.read_to_end(&mut raw).await.unwrap();
    assert!(raw.is_empty(), "shutdown must not write a record: {raw:?}");
    drop(to_child);
}

/// AC4: stdout carries protocol records only. The shim writes one record to
/// stdout and one diagnostic to stderr; the client must see only the
/// former, and `pi_process` must have retained the latter.
#[tokio::test]
async fn shim_stdout_is_protocol_only_and_stderr_is_diagnostics() {
    let (mut child, client) = spawn_shim(
        "ac4",
        "#!/bin/sh\n\
         printf '{\"type\":\"agent_start\"}\\n'\n\
         printf 'DIAG-MARKER\\n' 1>&2\n\
         cat\n",
    )
    .await;
    let mut events = client.events();

    assert!(matches!(
        next_event(&mut events).await,
        ProtocolMessage::Session(Event::AgentStart)
    ));
    assert!(
        wait_for_stderr(&child, "DIAG-MARKER").await,
        "stderr was not drained: {:?}",
        child.stderr_snapshot()
    );
    assert_quiet(&mut events).await;

    child.kill();
    let _ = child.wait().await;
}

/// AC5: a bad line does not kill the process or the reader.
#[tokio::test]
async fn shim_malformed_line_then_valid_line_keeps_the_stream_alive() {
    let (mut child, client) = spawn_shim(
        "malformed",
        "#!/bin/sh\n\
         printf 'oops\\n'\n\
         printf '{\"type\":\"agent_start\"}\\n'\n\
         cat\n",
    )
    .await;
    let mut events = client.events();

    assert!(matches!(
        next_event(&mut events).await,
        ProtocolMessage::ParseError { .. }
    ));
    assert!(matches!(
        next_event(&mut events).await,
        ProtocolMessage::Session(Event::AgentStart)
    ));

    child.kill();
    let _ = child.wait().await;
}

/// The operator journey from the issue: kill the child mid-record and the
/// UI reports a child-exit error instead of freezing.
#[tokio::test]
async fn killed_child_rejects_pending_requests_instead_of_freezing() {
    let (mut child, client) = spawn_shim(
        "killed",
        "#!/bin/sh\n\
         printf '{\"type\":\"agent_st'\n\
         sleep 30\n",
    )
    .await;
    let client = Arc::new(client);
    let mut events = client.events();

    let c = Arc::clone(&client);
    let pending = tokio::spawn(async move { c.request(&abort_cmd()).await });

    // Let the request reach the (never reading) shim's pipe.
    tokio::time::sleep(Duration::from_millis(100)).await;
    child.kill();

    let err = timeout(BOUND, pending)
        .await
        .expect("a killed child must not hang a pending request")
        .unwrap()
        .unwrap_err();
    assert!(matches!(err, RpcError::ChildGone), "got {err:?}");

    // The unterminated tail is surfaced as a transport framing fault,
    // never delivered as a record.
    match next_event(&mut events).await {
        ProtocolMessage::Frame(FramingError::UnterminatedTail { .. }) => {}
        other => panic!("expected a surfaced framing fault, got {other:?}"),
    }

    let _ = child.wait().await;
}

#[tokio::test]
async fn spawn_failure_surfaces_an_io_error() {
    let spec = PiSpec {
        program: PathBuf::from("/nonexistent/pi-binary"),
        args: vec![],
    };
    let err = spawn(&spec, &ChildEnv::none(), "sess-missing")
        .err()
        .expect("spawning a nonexistent program must fail");
    assert!(
        !err.to_string().is_empty(),
        "a failed spawn must carry a message"
    );
}

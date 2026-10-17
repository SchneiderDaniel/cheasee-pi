/// Translate a browser command into pi's vocabulary.
fn to_command(message: ClientMessage) -> Option<Routed> {
    match message {
        ClientMessage::Prompt {
            id,
            message,
            streaming_behavior,
        } => Some(Routed::browser(
            Command::Prompt {
                id: None,
                message,
                images: None,
                streaming_behavior: streaming_behavior.map(|b| b.as_wire().to_string()),
            },
            "prompt",
            id,
        )),
        ClientMessage::Steer { id, message } => Some(Routed::browser(
            Command::Steer {
                id: None,
                message,
                images: None,
            },
            "steer",
            id,
        )),
        ClientMessage::FollowUp { id, message } => Some(Routed::browser(
            Command::FollowUp {
                id: None,
                message,
                images: None,
            },
            "follow_up",
            id,
        )),
        ClientMessage::Abort { id } => Some(Routed::browser(Command::Abort { id: None }, "abort", id)),
        ClientMessage::ClearQueue { id } => Some(Routed::browser(
            Command::ClearQueue { id: None },
            "clear_queue",
            id,
        )),
        ClientMessage::GetState { id } => {
            Some(Routed::browser(Command::GetState { id: None }, "get_state", id))
        }
        ClientMessage::GetAvailableModels { id } => Some(Routed::browser(
            Command::GetAvailableModels { id: None },
            "get_available_models",
            id,
        )),
        ClientMessage::SetModel {
            id,
            provider,
            model_id,
        } => Some(Routed::browser(
            Command::SetModel {
                id: None,
                provider,
                model_id,
            },
            "set_model",
            id,
        )),
        ClientMessage::CycleModel { id } => Some(Routed::browser(
            Command::CycleModel { id: None },
            "cycle_model",
            id,
        )),
        ClientMessage::GetAvailableThinkingLevels { id } => Some(Routed::browser(
            Command::GetAvailableThinkingLevels { id: None },
            "get_available_thinking_levels",
            id,
        )),
        ClientMessage::SetThinkingLevel { id, level } => Some(Routed::browser(
            Command::SetThinkingLevel { id: None, level },
            "set_thinking_level",
            id,
        )),
        ClientMessage::CycleThinkingLevel { id } => Some(Routed::browser(
            Command::CycleThinkingLevel { id: None },
            "cycle_thinking_level",
            id,
        )),
        ClientMessage::GetSessionStats { id } => Some(Routed::browser(
            Command::GetSessionStats { id: None },
            "get_session_stats",
            id,
        )),
        ClientMessage::Compact {
            id,
            custom_instructions,
        } => Some(Routed::browser(
            Command::Compact {
                id: None,
                custom_instructions,
            },
            "compact",
            id,
        )),
        ClientMessage::SetAutoCompaction { id, enabled } => Some(Routed::browser(
            Command::SetAutoCompaction { id: None, enabled },
            "set_auto_compaction",
            id,
        )),
        ClientMessage::SetAutoRetry { id, enabled } => Some(Routed::browser(
            Command::SetAutoRetry { id: None, enabled },
            "set_auto_retry",
            id,
        )),
        ClientMessage::AbortRetry { id } => Some(Routed::browser(
            Command::AbortRetry { id: None },
            "abort_retry",
            id,
        )),
        ClientMessage::Bash {
            id,
            command,
            exclude_from_context,
        } => Some(Routed {
            command: Command::Bash {
                id: None,
                command,
                exclude_from_context,
            },
            name: "bash",
            browser_id: Some(id),
            preserve_id: true,
        }),
        ClientMessage::AbortBash { id } => Some(Routed::browser(
            Command::AbortBash { id: None },
            "abort_bash",
            id,
        )),
        // Handled by `respond_extension_ui` directly: it never maps to a pi
        // command and never produces a command response.
        ClientMessage::ExtensionUiResponse { .. } => None,
        // Handled by the store (`handle_local_session`), never forwarded.
        ClientMessage::ListSessions { .. }
        | ClientMessage::ResumeSession { .. }
        | ClientMessage::StopSession { .. } => None,
        // Handled by the relay's binding state machine, never forwarded to pi.
        ClientMessage::Subscribe { .. } | ClientMessage::Unsubscribe { .. } => None,
        ClientMessage::Unknown => None,
    }
}

/// Map a pi record to what the browser should see. A blocking extension UI
/// request also occupies the session's single pending slot (AC2).
fn to_server_message(
    message: ProtocolMessage,
    pending: &Mutex<Option<ExtensionUiRequest>>,
) -> Option<ServerMessage> {
    match message {
        ProtocolMessage::Session(event) => Some(ServerMessage::Event { event }),
        ProtocolMessage::Frame(err) => Some(ServerMessage::Error {
            message: err.to_string(),
        }),
        ProtocolMessage::ParseError { raw, error } => Some(ServerMessage::Notice {
            kind: "parse_error".to_string(),
            detail: format!("{error} (raw: {raw})"),
        }),
        ProtocolMessage::ExtensionUi(ExtensionUI::ExtensionUiRequest(request)) => {
            if is_blocking(&request.method) {
                // Newest wins: pi defines no queue, so the slot is replaced.
                *pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(request.clone());
            }
            Some(ServerMessage::ExtensionUi { request })
        }
        // An `extension_ui_response` from pi is not ours to render, and an
        // unmodelled record carries nothing this slice renders.
        ProtocolMessage::ExtensionUi(_) | ProtocolMessage::Unknown(_) => None,
    }
}


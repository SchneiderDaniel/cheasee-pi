    /// Pair a replayed `toolResult` with the `toolCall` row it answers, by
    /// `toolCallId`. Falls back to a standalone card when the call was never
    /// folded. The persisted `isError` flag decides the status, so a failed
    /// historical call is not misrepresented as success.
    fn fold_tool_result(&mut self, message: &Value) -> bool {
        let tool_call_id = message
            .get("toolCallId")
            .or_else(|| message.get("tool_call_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let is_error = message
            .get("isError")
            .or_else(|| message.get("is_error"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let status = if is_error {
            ToolStatus::Error
        } else {
            ToolStatus::Done
        };
        let (output, truncated) = bounded(content_text(message));
        if let Some(row) = self.history.iter_mut().rev().find(|r| {
            r.kind
                .as_tool()
                .is_some_and(|c| c.tool_call_id == tool_call_id)
        }) {
            if let RowKind::Tool(card) = &mut row.kind {
                card.output = output;
                card.truncated = truncated;
                card.status = status;
                return true;
            }
        }
        let card = ToolCard {
            tool_call_id,
            name: String::new(),
            args: String::new(),
            output,
            status,
            truncated,
        };
        let id = self.alloc_id();
        self.history.push(Row {
            id,
            kind: RowKind::Tool(card),
        });
        true
    }

    pub fn usage(&self) -> Usage {
        self.usage.clone()
    }

    pub fn status(&self) -> StreamStatus {
        self.status
    }

    pub fn will_retry(&self) -> Option<bool> {
        self.will_retry
    }

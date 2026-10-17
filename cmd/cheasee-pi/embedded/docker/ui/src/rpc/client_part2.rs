impl RpcReplaySource {
    pub fn new(client: Arc<RpcClient>) -> Self {
        Self { client }
    }

    /// The in-flight assistant text. `Ok(None)` is reserved for a *valid* null
    /// (`data.text: null`, i.e. nothing is streaming); a failed request, a
    /// missing body, or a `success:false` response is an error, never `None`.
    async fn text(&self) -> Result<Option<String>, ReplayError> {
        let response = self
            .client
            .request(&Command::GetLastAssistantText { id: None })
            .await
            .map_err(|err| ReplayError::Failed(format!("get_last_assistant_text: {err}")))?;
        let body = response
            .body()
            .ok_or_else(|| ReplayError::Failed("get_last_assistant_text returned no body".into()))?;
        if !body.success {
            return Err(ReplayError::Failed(
                body.error
                    .clone()
                    .unwrap_or_else(|| "get_last_assistant_text failed".into()),
            ));
        }
        Ok(body
            .data
            .as_ref()
            .and_then(|data| data.get("text"))
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    /// The raw `get_state` payload. A failed request is surfaced; `Ok(None)` is
    /// only for a valid absence of data.
    async fn state(&self) -> Result<Option<Value>, ReplayError> {
        let response = self
            .client
            .request(&Command::GetState { id: None })
            .await
            .map_err(|err| ReplayError::Failed(format!("get_state: {err}")))?;
        let body = response
            .body()
            .ok_or_else(|| ReplayError::Failed("get_state returned no body".into()))?;
        if !body.success {
            return Err(ReplayError::Failed(
                body.error
                    .clone()
                    .unwrap_or_else(|| "get_state failed".into()),
            ));
        }
        // A valid `null` payload means "no state"; only a failed request errors.
        Ok(body.data.clone().filter(|data| !data.is_null()))
    }
}

impl ReplaySource for RpcReplaySource {
    fn replay<'a>(
        &'a self,
        since: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ReplayData, ReplayError>> {
        Box::pin(async move {
            let command = Command::GetEntries {
                id: None,
                since: since.map(str::to_string),
            };
            let response = self
                .client
                .request(&command)
                .await
                .map_err(|err| ReplayError::Failed(err.to_string()))?;
            let body = response
                .body()
                .ok_or_else(|| ReplayError::Failed("get_entries returned no body".into()))?;
            if !body.success {
                let message = body
                    .error
                    .clone()
                    .unwrap_or_else(|| "get_entries failed".into());
                return Err(if message.starts_with("Entry not found") {
                    ReplayError::CursorInvalid(message)
                } else {
                    ReplayError::Failed(message)
                });
            }
            let data = body.data.clone().unwrap_or(Value::Null);
            // A malformed payload must not read as a successful empty replay
            // (that would hide a real gap). An explicitly empty array is fine.
            let entries = data
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| {
                    ReplayError::Failed("get_entries returned no entries array".into())
                })?;
            let leaf_id = data
                .get("leafId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let state = self.state().await?;
            let last_assistant_text = self.text().await?;
            Ok(ReplayData {
                entries,
                leaf_id,
                state,
                last_assistant_text,
                live: true,
            })
        })
    }
}


#[cfg(all(test, feature = "ssr"))]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use leptos::prelude::LeptosOptions;
    use tower::ServiceExt;

    use super::server;

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    /// A temp site dir carrying an `assets/` sub-dir, unique per call.
    fn site_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cheasee-ui-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        dir
    }

    /// Install the global executor the SSR render ticks on. Idempotent: later
    /// calls return `AlreadySet`, which is fine because `tokio::spawn` binds to
    /// whichever runtime is current at spawn time.
    fn init_executor() {
        let _ = any_spawner::Executor::init_tokio();
    }

    fn options(site: &std::path::Path) -> LeptosOptions {
        LeptosOptions::builder()
            .output_name("cheasee-pi-ui")
            .site_root(site.to_str().unwrap())
            .site_pkg_dir("assets")
            .build()
    }

    /// Router state with no spawned child, for routing/SSR tests.
    fn app(site: &std::path::Path) -> axum::Router {
        server::router(server::AppState::without_child(options(site)))
    }

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn health_returns_ok_json() {
        init_executor();
        let app = app(&site_dir());
        let res = app.oneshot(get("/health")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let content_type = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            content_type.starts_with("application/json"),
            "health content-type = {content_type}"
        );
        let body = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        assert_eq!(&body[..], br#"{"status":"ok"}"#);
    }

    #[tokio::test]
    async fn root_serves_hydration_shell() {
        init_executor();
        let app = app(&site_dir());
        let res = app.oneshot(get("/")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let content_type = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            content_type.starts_with("text/html"),
            "root content-type = {content_type}"
        );
        let body = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
        let html = String::from_utf8_lossy(&body);
        // Hydration bootstrap marker + the counter/echo mount points.
        assert!(html.contains("rel=\"modulepreload\""), "no hydration bootstrap: {html}");
        assert!(html.contains("cheasee-pi control center"), "no shell heading: {html}");
        assert!(html.contains("Send"), "no echo control: {html}");
        assert!(html.contains("/assets/"), "no hashed asset path: {html}");
    }

    #[tokio::test]
    async fn assets_are_hashed_and_cached() {
        init_executor();
        let site = site_dir();
        std::fs::write(site.join("assets/cheasee-pi-ui.js"), "console.log(1)").unwrap();
        std::fs::write(site.join("assets/cheasee-pi-ui.wasm"), b"\0asm").unwrap();
        let app = app(&site);

        let res = app.clone().oneshot(get("/assets/cheasee-pi-ui.js")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get("cache-control").unwrap(),
            "public, max-age=31536000, immutable"
        );

        let res = app.clone().oneshot(get("/assets/cheasee-pi-ui.wasm")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get("content-type").unwrap(),
            "application/wasm"
        );

        let res = app.oneshot(get("/assets/missing.js")).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn ws_without_upgrade_is_rejected() {
        init_executor();
        let app = app(&site_dir());
        let res = app.oneshot(get("/ws")).await.unwrap();
        assert!(
            res.status().is_client_error(),
            "/ws without upgrade headers must be 4xx, got {}",
            res.status()
        );
    }

    /// No child: the relay reports the state instead of leaving the browser
    /// hanging.
    #[tokio::test]
    async fn ws_without_child_reports_an_error_frame() {
        use futures_util::StreamExt;

        init_executor();
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = app(&site_dir());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
            .await
            .unwrap();
        let frame = socket.next().await.unwrap().unwrap();
        let message: cheasee_pi_ui::bridge::ServerMessage =
            serde_json::from_str(frame.to_text().unwrap()).unwrap();
        match message {
            cheasee_pi_ui::bridge::ServerMessage::Error { message } => {
                assert!(message.contains("no pi child"), "message = {message}")
            }
            other => panic!("expected an error frame, got {other:?}"),
        }
    }

    /// AC1/AC2: a browser prompt reaches the child, and the pi event and
    /// response reach the browser over the same connection. Drives a real
    /// upgrade over a loopback socket with a fake child behind a real
    /// `RpcClient`.
    #[tokio::test]
    async fn ws_relays_commands_and_pi_events() {
        use futures_util::{SinkExt, StreamExt};
        use tokio::io::{AsyncWriteExt, BufReader};
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        use cheasee_pi_ui::bridge::{ClientMessage, ServerMessage};
        use cheasee_pi_ui::rpc::{encode_record, JsonlReader};

        init_executor();
        let bound = std::time::Duration::from_secs(2);

        // A fake pi child: we write its stdout events, and read the commands
        // the client writes to its stdin.
        let (mut child_stdout, stdout_rx) = tokio::io::duplex(1 << 16);
        let (client_stdin, child_stdin) = tokio::io::duplex(1 << 16);
        let client = Arc::new(cheasee_pi_ui::rpc::RpcClient::new(
            Box::new(stdout_rx),
            Box::new(client_stdin),
        ));
        let mut commands = JsonlReader::new(BufReader::new(child_stdin));

        let state = server::AppState {
            options: options(&site_dir()),
            spawn: Arc::new(server::SpawnState {
                registry: Arc::new(cheasee_pi_ui::pi_process::PidRegistry::new()),
                pid: Some(1),
                session_id: "sess-ws".to_string(),
                env_var_names: Vec::new(),
                has_provider_keys: true,
                source: cheasee_pi_ui::auth::AuthSource::Missing,
                auth_error: None,
                rpc: Some(client),
                store: Arc::new(cheasee_pi_ui::sessions_store::SessionsStore::new(
                    cheasee_pi_ui::pi_process::SESSION_DIR,
                    std::path::Path::new(cheasee_pi_ui::pi_process::SESSION_DIR).join(".cheasee-inuse"),
                    Arc::new(cheasee_pi_ui::pi_process::PidRegistry::new()),
                )),
                sessions: Arc::new(cheasee_pi_ui::session::SessionRegistry::new()),
            }),
        };

        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, server::router(state)).await;
        });

        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
            .await
            .unwrap();

        // The relay starts unbound: subscribe first so events are delivered.
        let subscribe = ClientMessage::Subscribe {
            id: None,
            session_id: String::new(),
            since: None,
        };
        socket
            .send(WsMessage::Text(serde_json::to_string(&subscribe).unwrap()))
            .await
            .unwrap();
        for _ in 0..3 {
            let frame = tokio::time::timeout(bound, commands.next_record_str())
                .await
                .expect("replay command written")
                .unwrap()
                .unwrap();
            let command: serde_json::Value = serde_json::from_str(&frame).unwrap();
            let id = command["id"].as_str().unwrap().to_string();
            let response = match command["type"].as_str().unwrap() {
                "get_entries" => serde_json::json!({"type":"response","command":"get_entries","success":true,"id":id,"data":{"entries":[],"leafId":null}}),
                "get_state" => serde_json::json!({"type":"response","command":"get_state","success":true,"id":id,"data":{}}),
                "get_last_assistant_text" => serde_json::json!({"type":"response","command":"get_last_assistant_text","success":true,"id":id,"data":{"text":null}}),
                other => panic!("unexpected replay request {other}"),
            };
            child_stdout
                .write_all(&encode_record(&response).unwrap())
                .await
                .unwrap();
            child_stdout.flush().await.unwrap();
        }
        // Drain the `SessionState` header and the terminal replay frame.
        for _ in 0..2 {
            let frame = tokio::time::timeout(bound, socket.next())
                .await
                .expect("subscribe frame")
                .unwrap()
                .unwrap();
            let _ = serde_json::from_str::<ServerMessage>(frame.to_text().unwrap()).unwrap();
        }

        let prompt = ClientMessage::Prompt {
            id: None,
            message: "count to 3".to_string(),
            streaming_behavior: None,
        };
        socket
            .send(WsMessage::Text(serde_json::to_string(&prompt).unwrap()))
            .await
            .unwrap();

        let frame = tokio::time::timeout(bound, commands.next_record_str())
            .await
            .expect("command written")
            .unwrap()
            .unwrap();
        let command: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(command["type"], "prompt");
        assert_eq!(command["message"], "count to 3");
        let id = command["id"].as_str().unwrap().to_string();

        // A pi event while the prompt is in flight is relayed to the browser.
        child_stdout
            .write_all(&encode_record(&serde_json::json!({"type": "agent_start"})).unwrap())
            .await
            .unwrap();
        child_stdout.flush().await.unwrap();
        let frame = tokio::time::timeout(bound, socket.next())
            .await
            .expect("event frame")
            .unwrap()
            .unwrap();
        match serde_json::from_str::<ServerMessage>(frame.to_text().unwrap()).unwrap() {
            ServerMessage::Event { .. } => {}
            other => panic!("expected an event, got {other:?}"),
        }

        // The prompt response is relayed back too.
        child_stdout
            .write_all(
                &encode_record(&serde_json::json!({
                    "type": "response",
                    "command": "prompt",
                    "success": true,
                    "id": id,
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        child_stdout.flush().await.unwrap();
        let frame = tokio::time::timeout(bound, socket.next())
            .await
            .expect("response frame")
            .unwrap()
            .unwrap();
        match serde_json::from_str::<ServerMessage>(frame.to_text().unwrap()).unwrap() {
            ServerMessage::CommandResponse { success, command, .. } => {
                assert!(success);
                assert_eq!(command, "prompt");
            }
            other => panic!("expected a command response, got {other:?}"),
        }
    }

    /// The child-debug surface reports the recorded pid and the child env var
    /// *names* only — never values (mirrors Go's `redactEnvValue`; AC2's
    /// "log env var names only" rule holds from the start).
    #[tokio::test]
    async fn debug_child_reports_pid_and_env_names_only() {
        init_executor();
        let state = server::AppState {
            options: options(&site_dir()),
            spawn: Arc::new(server::SpawnState {
                registry: Arc::new(cheasee_pi_ui::pi_process::PidRegistry::new()),
                pid: Some(4242),
                session_id: "sess-test".to_string(),
                env_var_names: vec!["OPENAI_API_KEY".to_string(), "PATH".to_string()],
                has_provider_keys: true,
                source: cheasee_pi_ui::auth::AuthSource::Config,
                auth_error: None,
                rpc: None,
                store: Arc::new(cheasee_pi_ui::sessions_store::SessionsStore::new(
                    cheasee_pi_ui::pi_process::SESSION_DIR,
                    std::path::Path::new(cheasee_pi_ui::pi_process::SESSION_DIR).join(".cheasee-inuse"),
                    Arc::new(cheasee_pi_ui::pi_process::PidRegistry::new()),
                )),
                sessions: Arc::new(cheasee_pi_ui::session::SessionRegistry::new()),
            }),
        };
        let res = server::router(state).oneshot(get("/debug/child")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["pid"], 4242);
        assert_eq!(json["session_id"], "sess-test");
        assert_eq!(json["has_provider_keys"], true);
        assert_eq!(json["auth_source"], "config");
        assert_eq!(json["rpc_client"], false);
        assert_eq!(
            json["env_var_names"],
            serde_json::json!(["OPENAI_API_KEY", "PATH"])
        );
        // Names only: no value-bearing key exists on this surface.
        assert!(json.get("env").is_none(), "debug surface must not expose env values");
        assert!(
            json.get("env_vars").is_none(),
            "debug surface must not expose env values"
        );
    }
}

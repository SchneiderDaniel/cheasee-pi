//! Axum composition root (server target, feature `ssr`).
//!
//! Humble adapters only: routing, headers, and the bind. No business decisions
//! live here — the view is `cheasee_pi_ui::shell` + `app::App`, the transport
//! is the `ws` module.

#[cfg(feature = "ssr")]
mod server {
    use axum::{
        body::Body,
        extract::{
            ws::{Message, WebSocket, WebSocketUpgrade},
            State,
        },
        http::{header, HeaderValue, Request},
        response::{IntoResponse, Json, Response},
        routing::{get, get_service},
        Router,
    };
    use leptos::prelude::*;
    use serde_json::json;
    use std::sync::Arc;
    use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

    use cheasee_pi_ui::bridge::{ClientMessage, ServerMessage};
    use cheasee_pi_ui::{auth, pi_process, rpc, session, shell};

    /// The fixed in-container listen port. The compose mapping publishes it to
    /// the host loopback; keep it in sync with that mapping's container side.
    pub const PORT: u16 = 3000;

    const CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

    /// Everything the composition root learned about the spawned `pi` child:
    /// the pid registry that owns it, the child's pid, and the auth state the
    /// `/debug/child` surface reports. Never holds secret values in a form the
    /// HTTP layer can expose — only env var *names*.
    pub struct SpawnState {
        pub registry: pi_process::PidRegistry,
        pub pid: Option<u32>,
        pub session_id: String,
        pub env_var_names: Vec<String>,
        pub has_provider_keys: bool,
        pub source: auth::AuthSource,
        pub auth_error: Option<String>,
        /// The RPC client over the child's pipes, when the spawn succeeded.
        /// Constructing it here is the composition root's whole job: no
        /// protocol logic lives in this file.
        pub rpc: Option<Arc<rpc::RpcClient>>,
    }

    /// Router state. `Arc` so the pid registry ownership is shared, not copied,
    /// across axum's per-request state clones.
    #[derive(Clone)]
    pub struct AppState {
        pub options: LeptosOptions,
        pub spawn: Arc<SpawnState>,
    }

    impl AppState {
        /// Router state with no spawned child — for tests that only exercise
        /// routing and SSR.
        #[cfg(test)]
        pub fn without_child(options: LeptosOptions) -> Self {
            Self {
                options,
                spawn: Arc::new(SpawnState {
                    registry: pi_process::PidRegistry::new(),
                    pid: None,
                    session_id: String::new(),
                    env_var_names: Vec::new(),
                    has_provider_keys: false,
                    source: auth::AuthSource::Missing,
                    auth_error: None,
                    rpc: None,
                }),
            }
        }
    }

    /// Resolve the provider env from the mounted auth.json, spawn
    /// `pi --mode rpc`, and build the router state.
    ///
    /// Neither a missing/malformed auth.json nor a failed spawn is fatal: the
    /// UI must still come up and report a clear "no provider keys" state (AC4),
    /// mirroring `runUpE`'s warning.
    pub fn bootstrap(options: LeptosOptions) -> AppState {
        let (child_env, auth_error) = match auth::load_child_env() {
            Ok(env) => (env, None),
            Err(err) => {
                eprintln!(
                    "cheasee-pi-ui: WARNING: {err}; continuing with no provider keys"
                );
                (auth::ChildEnv::none(), Some(err.to_string()))
            }
        };

        if !child_env.has_provider_keys {
            eprintln!("  \u{26a0} No provider keys found. Models may not be available.");
            eprintln!("  \u{2139} Use: cheasee-pi auth add <provider>");
        }

        let session_id = new_session_id();
        let spec = pi_process::PiSpec::default();
        let env_var_names = pi_process::child_env_var_names(&child_env);
        let registry = pi_process::PidRegistry::new();
        let has_provider_keys = child_env.has_provider_keys;
        let source = child_env.source;

        let mut rpc: Option<Arc<rpc::RpcClient>> = None;
        let pid = match pi_process::spawn(&spec, &child_env, &session_id) {
            Ok(mut child) => {
                let pid = child.pid;
                // Session marker is a child-identity token (CodeQL: S6311);
                // it is exposed via /debug/child, never echoed to the log.
                eprintln!(
                    "cheasee-pi-ui: spawned {} (pid {pid})",
                    spec.program.display()
                );
                // Hand the protocol pipes to the client before the child goes
                // into the registry: stdout has exactly one reader (AC4).
                rpc = child
                    .take_io()
                    .map(rpc::RpcClient::from_child_io)
                    .map(Arc::new);
                registry.insert(session_id.clone(), child);
                Some(pid)
            }
            Err(err) => {
                eprintln!("cheasee-pi-ui: WARNING: could not spawn pi RPC child: {err}");
                None
            }
        };

        AppState {
            options,
            spawn: Arc::new(SpawnState {
                registry,
                pid,
                session_id,
                env_var_names,
                has_provider_keys,
                source,
                auth_error,
                rpc,
            }),
        }
    }

    /// A short unique session marker injected as `CHEASEE_SESSION_ID`, mirroring
    /// Go's `newSessionID` (hex, no dashes). Slice 8's marker-kill scans for it.
    fn new_session_id() -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        format!("{:016x}", nanos ^ (u64::from(std::process::id()) << 32))
    }

    fn auth_source_name(source: auth::AuthSource) -> &'static str {
        match source {
            auth::AuthSource::Config => "config",
            auth::AuthSource::Legacy => "legacy",
            auth::AuthSource::Missing => "missing",
        }
    }

    /// Liveness probe for the compose healthcheck.
    async fn health() -> impl IntoResponse {
        Json(json!({ "status": "ok" }))
    }

    /// Upgrade and hand the socket to the per-connection relay.
    async fn ws_handler(
        State(state): State<AppState>,
        ws: WebSocketUpgrade,
    ) -> impl IntoResponse {
        let rpc = state.spawn.rpc.clone();
        ws.on_upgrade(move |socket| handle_socket(socket, rpc))
    }

    /// One browser connection over the shared pi child. The relay is
    /// `session::relay` — this adapter only builds the transport sink.
    async fn handle_socket(socket: WebSocket, rpc: Option<Arc<rpc::RpcClient>>) {
        let Some(rpc) = rpc else {
            // No child: tell the browser instead of leaving it hanging. The
            // UI must still come up and report the state (AC4).
            let mut socket = socket;
            let message = ServerMessage::Error {
                message: "no pi child is running".to_string(),
            };
            if let Ok(text) = serde_json::to_string(&message) {
                let _ = socket.send(Message::Text(text.into())).await;
            }
            return;
        };
        session::Session::new(rpc).relay(WsSink { socket }).await;
    }

    /// The axum WebSocket as `session::ClientSink`: text frames carry the
    /// [`ClientMessage`]/[`ServerMessage`] envelope.
    struct WsSink {
        socket: WebSocket,
    }

    impl session::ClientSink for WsSink {
        async fn send_text(&mut self, text: String) -> Result<(), ()> {
            self.socket
                .send(Message::Text(text.into()))
                .await
                .map_err(|_| ())
        }

        async fn recv(&mut self) -> Option<Result<ClientMessage, String>> {
            loop {
                match self.socket.recv().await {
                    Some(Ok(Message::Text(text))) => match serde_json::from_str(&text) {
                        Ok(message) => return Some(Ok(message)),
                        // A malformed client frame must not kill the
                        // connection; surface it so the browser learns its
                        // command was not accepted, then keep reading.
                        Err(err) => return Some(Err(err.to_string())),
                    },
                    Some(Ok(Message::Close(_))) | None => return None,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => return None,
                }
            }
        }
    }

    /// Debug surface for the spawned child: its PID and the child env var
    /// *names* only (mirrors Go's `redactEnvValue`). Secret values are never
    /// returned — `/proc/<pid>/environ` is the only other observable surface
    /// and is uid-restricted.
    async fn debug_child(State(state): State<AppState>) -> impl IntoResponse {
        let spawn = &state.spawn;
        Json(json!({
            "pid": spawn.pid,
            "session_id": spawn.session_id,
            "child_count": spawn.registry.len(),
            "has_provider_keys": spawn.has_provider_keys,
            "auth_source": auth_source_name(spawn.source),
            "auth_error": spawn.auth_error,
            "env_var_names": spawn.env_var_names,
            "rpc_client": spawn.rpc.is_some(),
        }))
    }

    /// SSR entry: stream the hydrated shell for `/`.
    async fn root(State(state): State<AppState>, request: Request<Body>) -> Response<Body> {
        let context_options = state.options.clone();
        let shell_options = state.options.clone();
        let handler = leptos_axum::render_app_to_stream_with_context(
            move || provide_context(context_options.clone()),
            move || shell(shell_options.clone()),
        );
        handler(request).await
    }

    /// Build the router. Separate from `main` so tests can drive it via
    /// `tower::ServiceExt::oneshot` without binding a port.
    pub fn router(state: AppState) -> Router {
        let assets_dir = std::path::Path::new(state.options.site_root.as_ref())
            .join(state.options.site_pkg_dir.as_ref());
        let assets = get_service(ServeDir::new(assets_dir)).layer(
            SetResponseHeaderLayer::overriding(
                header::CACHE_CONTROL,
                HeaderValue::from_static(CACHE_CONTROL),
            ),
        );

        Router::new()
            .route("/", get(root))
            .route("/health", get(health))
            .route("/ws", get(ws_handler))
            .route("/debug/child", get(debug_child))
            // axum 0.8 path syntax: nest strips the prefix, so the hashed
            // bundles are served from `/assets/<file>` (AC2).
            .nest_service("/assets", assets)
            .with_state(state)
    }
}

#[cfg(feature = "ssr")]
use leptos::prelude::get_configuration;
#[cfg(feature = "ssr")]
use server::PORT;

#[cfg(feature = "ssr")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The no-router SSR path bypasses leptos_axum's `generate_route_list`,
    // which is where it would otherwise install the global executor.
    any_spawner::Executor::init_tokio()
        .map_err(|e| format!("init leptos async executor: {e:?}"))?;

    let options = get_configuration(None)?.leptos_options;

    // Resolve the provider env from the mounted auth.json and spawn the pi RPC
    // child before serving (AC1/AC3/AC4). A missing auth.json or a failed
    // spawn warns; the UI still serves.
    let state = server::bootstrap(options);

    // Bind all interfaces inside the container: the host reaches this process
    // through docker's published DNAT port, and a loopback bind is unreachable
    // from there. Host-side reachability stays the compose mapping's job.
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", PORT)).await?;
    axum::serve(listener, server::router(state)).await?;
    Ok(())
}

#[cfg(not(feature = "ssr"))]
fn main() {}

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
                registry: cheasee_pi_ui::pi_process::PidRegistry::new(),
                pid: Some(1),
                session_id: "sess-ws".to_string(),
                env_var_names: Vec::new(),
                has_provider_keys: true,
                source: cheasee_pi_ui::auth::AuthSource::Missing,
                auth_error: None,
                rpc: Some(client),
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
                registry: cheasee_pi_ui::pi_process::PidRegistry::new(),
                pid: Some(4242),
                session_id: "sess-test".to_string(),
                env_var_names: vec!["OPENAI_API_KEY".to_string(), "PATH".to_string()],
                has_provider_keys: true,
                source: cheasee_pi_ui::auth::AuthSource::Config,
                auth_error: None,
                rpc: None,
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

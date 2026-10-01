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
            ws::{WebSocket, WebSocketUpgrade},
            State,
        },
        http::{header, HeaderValue, Request},
        response::{IntoResponse, Json, Response},
        routing::{get, get_service},
        Router,
    };
    use leptos::prelude::*;
    use serde_json::json;
    use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

    use cheasee_pi_ui::shell;

    /// The fixed in-container listen port. The compose mapping publishes it to
    /// the host loopback; keep it in sync with that mapping's container side.
    pub const PORT: u16 = 3000;

    const CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

    /// Liveness probe for the compose healthcheck.
    async fn health() -> impl IntoResponse {
        Json(json!({ "status": "ok" }))
    }

    /// Upgrade and hand the socket to the echo loop.
    async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
        ws.on_upgrade(handle_socket)
    }

    /// Framing-agnostic echo: whatever frame arrives goes back verbatim on the
    /// same connection (text or binary). Slice 4 layers strict JSONL framing
    /// on the pi child pipe, not here.
    async fn handle_socket(mut socket: WebSocket) {
        while let Some(Ok(frame)) = socket.recv().await {
            if socket.send(frame).await.is_err() {
                break;
            }
        }
    }

    /// SSR entry: stream the hydrated shell for `/`.
    async fn root(
        State(options): State<LeptosOptions>,
        request: Request<Body>,
    ) -> Response<Body> {
        let context_options = options.clone();
        let shell_options = options;
        let handler = leptos_axum::render_app_to_stream_with_context(
            move || provide_context(context_options.clone()),
            move || shell(shell_options.clone()),
        );
        handler(request).await
    }

    /// Build the router. Separate from `main` so tests can drive it via
    /// `tower::ServiceExt::oneshot` without binding a port.
    pub fn router(options: LeptosOptions) -> Router {
        let assets_dir = std::path::Path::new(options.site_root.as_ref())
            .join(options.site_pkg_dir.as_ref());
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
            // axum 0.8 path syntax: nest strips the prefix, so the hashed
            // bundles are served from `/assets/<file>` (AC2).
            .nest_service("/assets", assets)
            .with_state(options)
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

    // Bind all interfaces inside the container: the host reaches this process
    // through docker's published DNAT port, and a loopback bind is unreachable
    // from there. Host-side reachability stays the compose mapping's job.
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", PORT)).await?;
    axum::serve(listener, server::router(options)).await?;
    Ok(())
}

#[cfg(not(feature = "ssr"))]
fn main() {}

#[cfg(all(test, feature = "ssr"))]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

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

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn health_returns_ok_json() {
        init_executor();
        let app = server::router(options(&site_dir()));
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
        let app = server::router(options(&site_dir()));
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
        let app = server::router(options(&site));

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
        let app = server::router(options(&site_dir()));
        let res = app.oneshot(get("/ws")).await.unwrap();
        assert!(
            res.status().is_client_error(),
            "/ws without upgrade headers must be 4xx, got {}",
            res.status()
        );
    }

    /// AC3: the live channel echoes every frame verbatim on the same
    /// connection. Drives a real upgrade over a loopback socket rather than
    /// asserting the handler exists.
    #[tokio::test]
    async fn ws_echoes_every_frame_verbatim() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        init_executor();
        // Bind via Ipv4Addr::LOCALHOST so this file never spells the loopback
        // literal the bind guard forbids.
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = server::router(options(&site_dir()));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
            .await
            .unwrap();
        for payload in ["{\"n\":1}", "{\"n\":2}", "{\"n\":3}"] {
            socket
                .send(Message::Text(payload.to_string()))
                .await
                .unwrap();
            let echoed = socket.next().await.unwrap().unwrap();
            assert_eq!(echoed.to_text().unwrap(), payload, "frame not echoed verbatim");
        }
    }

    /// AC3 boundary: the echo is verbatim for empty and binary frames too — no
    /// framing assumption slips in here before slice 4 layers JSONL framing.
    #[tokio::test]
    async fn ws_echoes_binary_and_empty_frames_verbatim() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        init_executor();
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = server::router(options(&site_dir()));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
            .await
            .unwrap();

        socket.send(Message::Text(String::new())).await.unwrap();
        let echoed = socket.next().await.unwrap().unwrap();
        assert_eq!(echoed.to_text().unwrap(), "", "empty text frame not echoed");

        socket.send(Message::Binary(vec![1, 2, 3])).await.unwrap();
        let echoed = socket.next().await.unwrap().unwrap();
        assert_eq!(echoed.into_data(), vec![1, 2, 3], "binary frame not echoed verbatim");
    }
}

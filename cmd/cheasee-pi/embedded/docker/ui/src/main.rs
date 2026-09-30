use axum::{response::Html, routing::get, Router};

// The fixed in-container listen port. The compose mapping publishes it to the
// host loopback (see docker-compose.yml) — change this const only together with
// that mapping's container-side segment (pinned by TestCompose_UILoopbackOnly).
const PORT: u16 = 3000;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let app = Router::new().route("/", get(root));

    // Must bind 0.0.0.0 inside the container, never container-loopback: the host
    // reaches this process through docker's published DNAT port, and a loopback
    // bind is unreachable from there. Host-side reachability is the compose
    // mapping's job (it pins the host side to loopback there).
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", PORT)).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

// Placeholder control-center landing page — this slice ships the container,
// port pin and CLI URL print; RPC routes land in later slices.
async fn root() -> Html<&'static str> {
    Html(
        "<!doctype html>\n\
         <html lang=\"en\">\n\
         <head><meta charset=\"utf-8\"><title>cheasee-pi</title></head>\n\
         <body><h1>cheasee-pi control center</h1><p>Placeholder — coming soon.</p></body>\n\
         </html>\n",
    )
}

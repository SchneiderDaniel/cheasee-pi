//! cheasee-pi web control center — Leptos hydrate app.
//!
//! cargo-leptos builds this crate twice: as a wasm `cdylib` (feature
//! `hydrate`) exposing [`hydrate`], and as an `rlib` (feature `ssr`) consumed
//! by the Axum composition root in `src/main.rs`.

pub mod app;
pub mod protocol;
pub mod retry;

// Server-only (ssr): auth.json resolution and the spawned `pi` RPC child.
// Gated on `ssr` because both use `tokio::process`/`std`, which the wasm32
// hydrate build must not link.
#[cfg(feature = "ssr")]
pub mod auth;
#[cfg(feature = "ssr")]
pub mod pi_process;

// Browser-only transport. Gated so the server target never links web-sys.
#[cfg(feature = "hydrate")]
pub mod ws;

use app::App;
use leptos::prelude::*;
use leptos_meta::{HashedStylesheet, MetaTags};

/// The server-rendered document shell, and the only place a hydrated app may
/// put head-level bootstrap.
///
/// `HydrationScripts` injects the wasm bootstrap and `HashedStylesheet` emits
/// the cargo-leptos content-hashed CSS link; both need `LeptosOptions`, which
/// is in scope here and nowhere else. Omitting either yields a 200 that never
/// becomes interactive.
pub fn shell(options: LeptosOptions) -> impl IntoView {
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
                <HydrationScripts options=options.clone()/>
                <HashedStylesheet options=options/>
                <MetaTags/>
            </head>
            <body>
                <App/>
            </body>
        </html>
    }
}

/// Browser entry point. Called by the bootstrap injected by
/// `HydrationScripts`; takes over the server-rendered DOM.
#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    console_error_panic_hook::set_once();
    leptos::mount::hydrate_body(app::App);
}

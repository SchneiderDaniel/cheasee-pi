//! Test-only fixtures for the UI crate.
//!
//! Gated `cfg(all(test, feature = "ssr"))` (see `lib.rs`): never reachable
//! from a production, hydrate, or wasm build.

use std::path::PathBuf;

/// A fresh, empty directory under `std::env::temp_dir()`, distinct on every
/// call (pid + monotonic sequence) so parallel tests never share state.
pub fn unique_temp_dir(prefix: &str) -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

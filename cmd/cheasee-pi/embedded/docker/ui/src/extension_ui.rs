//! Browser-side extension UI state: the blocking dialog plus the fire-and-forget
//! chrome (`notify` toast, `setStatus`/`setWidget`/`setTitle`, `set_editor_text`).
//!
//! Split out of `controls` because it has a different lifecycle: this state is
//! rendered by `components/dialog.rs` and `components/status.rs` and is **not**
//! feature-gated, so the `ssr` integration tests can import it. It reduces the
//! same `ServerMessage` the WS adapter feeds every other state.
//!
//! Dispatch is by exact method string, deliberately: `set_editor_text` is
//! snake_case while `setStatus`/`setWidget`/`setTitle` are camelCase, and a
//! normalised lookup would silently drop one. An unknown method is ignored —
//! pi can add one without a client release (`protocol::ExtensionUiRequest`).
//!
//! Pending-dialog *policy*: the newest blocking request replaces the slot (pi
//! defines no queue). The shared per-session slot that survives a reconnect
//! lives server-side in [`crate::session::Session`]; this is the per-browser
//! view of it.

use std::collections::BTreeMap;

use leptos::prelude::*;
use serde_json::{Map, Value};

use crate::bridge::ServerMessage;
use crate::protocol::ExtensionUiRequest;

/// The blocking dialog methods. These occupy the single pending slot; every
/// other method is fire-and-forget.
pub fn is_blocking(method: &str) -> bool {
    matches!(method, "select" | "confirm" | "input" | "editor")
}

/// A blocking request awaiting an answer.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingDialog {
    pub id: String,
    pub method: String,
    pub params: Map<String, Value>,
}

impl PendingDialog {
    /// The request's `timeout` in milliseconds, if pi set one. `editor` never
    /// carries one, and `JSON.stringify` drops `undefined`, so `None` is the
    /// normal path, not an error.
    pub fn timeout(&self) -> Option<u64> {
        self.params.get("timeout").and_then(Value::as_u64)
    }
}

impl From<&ExtensionUiRequest> for PendingDialog {
    fn from(request: &ExtensionUiRequest) -> Self {
        Self {
            id: request.id.clone(),
            method: request.method.clone(),
            params: request.params.clone(),
        }
    }
}

/// A transient `notify` toast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toast {
    pub id: String,
    pub message: String,
    /// `info` | `warning` | `error`; defaults to `info`.
    pub notify_type: String,
}

/// A `setWidget` chrome region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WidgetChrome {
    pub lines: Vec<String>,
    pub placement: String,
}

/// The extension-UI signals the dialog/toast components read.
#[derive(Clone, Copy)]
pub struct ExtensionUiState {
    /// The one blocking dialog shown at a time (AC2).
    pub dialog: RwSignal<Option<PendingDialog>>,
    pub toasts: RwSignal<Vec<Toast>>,
    pub statuses: RwSignal<BTreeMap<String, String>>,
    pub widgets: RwSignal<BTreeMap<String, WidgetChrome>>,
    pub title: RwSignal<Option<String>>,
    /// The composer draft, injected from [`crate::controls::ControlsState`] so
    /// `set_editor_text` writes the same signal the input reads.
    draft: RwSignal<String>,
}

impl ExtensionUiState {
    pub fn new(draft: RwSignal<String>) -> Self {
        Self {
            dialog: RwSignal::new(None),
            toasts: RwSignal::new(Vec::new()),
            statuses: RwSignal::new(BTreeMap::new()),
            widgets: RwSignal::new(BTreeMap::new()),
            title: RwSignal::new(None),
            draft,
        }
    }

    /// Reduce one server message. Returns whether anything visible changed.
    pub fn apply(&self, message: &ServerMessage) -> bool {
        match message {
            ServerMessage::ExtensionUi { request } => self.apply_request(request),
            _ => false,
        }
    }

    /// Decode and reduce one WS frame. A malformed frame is left to the
    /// transcript state; it must not blank the chrome.
    pub fn ingest_frame(&self, text: &str) -> bool {
        match serde_json::from_str::<ServerMessage>(text) {
            Ok(message) => self.apply(&message),
            Err(_) => false,
        }
    }

    /// Remove one toast by its request id. A missing id is a no-op.
    pub fn dismiss_toast(&self, id: &str) {
        self.toasts.update(|toasts| toasts.retain(|toast| toast.id != id));
    }

    /// Clear the pending dialog. The UI calls this when it dispatches an
    /// answer: the response produces no command response to correlate, so the
    /// dialog closes optimistically (the server's pending slot clears too).
    pub fn clear_dialog(&self) {
        self.dialog.set(None);
    }

    fn apply_request(&self, request: &ExtensionUiRequest) -> bool {
        if is_blocking(&request.method) {
            self.dialog.set(Some(PendingDialog::from(request)));
            return true;
        }
        match request.method.as_str() {
            "notify" => {
                let Some(message) = text_param(request, "message") else {
                    return false;
                };
                let notify_type = text_param(request, "notifyType").unwrap_or_else(|| "info".to_string());
                self.toasts.update(|toasts| {
                    toasts.push(Toast {
                        id: request.id.clone(),
                        message,
                        notify_type,
                    })
                });
                true
            }
            "setStatus" => {
                let (Some(key), Some(text)) = (
                    text_param(request, "statusKey"),
                    text_param(request, "statusText"),
                ) else {
                    // Missing text: leave the stored status alone, don't blank it.
                    return false;
                };
                self.statuses.update(|map| {
                    map.insert(key, text);
                });
                true
            }
            "setWidget" => {
                let Some(key) = text_param(request, "widgetKey") else {
                    return false;
                };
                let Some(lines) = request.params.get("widgetLines").and_then(Value::as_array) else {
                    return false;
                };
                let lines: Vec<String> = lines
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect();
                let placement = text_param(request, "widgetPlacement")
                    .unwrap_or_else(|| "aboveEditor".to_string());
                self.widgets.update(|map| {
                    map.insert(key, WidgetChrome { lines, placement });
                });
                true
            }
            "setTitle" => {
                let Some(title) = text_param(request, "title") else {
                    return false;
                };
                self.title.set(Some(title));
                true
            }
            "set_editor_text" => {
                let Some(text) = text_param(request, "text") else {
                    return false;
                };
                self.draft.set(text);
                true
            }
            // TUI-only (`custom`, `setFooter`, `setHeader`) and any future
            // method: ignored without a panic and without a response (AC5).
            _ => false,
        }
    }
}

fn text_param(request: &ExtensionUiRequest, key: &str) -> Option<String> {
    request.params.get(key).and_then(Value::as_str).map(str::to_string)
}

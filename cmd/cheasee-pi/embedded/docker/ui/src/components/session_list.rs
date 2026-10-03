//! Session list panel: renders the workspace sessions the server scanned and
//! dispatches resume/fork/clone/stop. Presentation only — the server owns path
//! resolution and the in-use guard, and never sends a host path to the browser.

use leptos::prelude::*;

use crate::app::ConnectionStatus;
use crate::bridge::{ClientMessage, ServerMessage, SessionRow};
use crate::components::dispatch;

/// Reactive session-list state. Lives for the whole app; the WS adapter feeds it
/// each `session_list`/`session_action` frame.
#[derive(Clone, Copy)]
pub struct SessionListState {
    pub rows: RwSignal<Vec<SessionRow>>,
    pub error: RwSignal<Option<String>>,
}

impl Default for SessionListState {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionListState {
    pub fn new() -> Self {
        Self {
            rows: RwSignal::new(Vec::new()),
            error: RwSignal::new(None),
        }
    }

    /// Reduce one server frame. Returns whether anything changed.
    pub fn apply(&self, message: &ServerMessage) -> bool {
        match message {
            ServerMessage::SessionList { sessions, .. } => {
                self.rows.set(sessions.clone());
                true
            }
            ServerMessage::SessionAction {
                session_id,
                success,
                error,
                ..
            } => {
                if *success {
                    self.error.set(None);
                } else {
                    // A refused attach or a failed stop is user-visible, never a
                    // silent no-op.
                    self.error.set(Some(error.clone().unwrap_or_else(|| {
                        format!("session {session_id} action failed")
                    })));
                }
                true
            }
            _ => false,
        }
    }

    /// Decode and reduce one WS text frame; a non-session frame is a no-op.
    pub fn ingest_frame(&self, text: &str) -> bool {
        match serde_json::from_str::<ServerMessage>(text) {
            Ok(message) => self.apply(&message),
            Err(_) => false,
        }
    }
}

/// The session list panel with its resume/clone/stop controls.
#[component]
pub fn SessionList(status: RwSignal<ConnectionStatus>) -> impl IntoView {
    let sessions = expect_context::<SessionListState>();

    let refresh = move |_| dispatch(ClientMessage::ListSessions { id: None }, status);
    let resume = move |session_id: String| {
        // Open the session in the transcript: bind the connection and replay
        // from the persisted cursor (AC1/AC2). Browser-only transport, so it is
        // compiled only for the hydrate target.
        #[cfg(feature = "hydrate")]
        {
            crate::ws::subscribe(session_id.clone(), None, status);
        }
        dispatch(
            ClientMessage::ResumeSession {
                id: None,
                session_id,
                mode: Some("resume".to_string()),
                entry_id: None,
            },
            status,
        );
    };
    let clone = move |session_id: String| {
        dispatch(
            ClientMessage::ResumeSession {
                id: None,
                session_id,
                mode: Some("clone".to_string()),
                entry_id: None,
            },
            status,
        );
    };
    let stop = move |session_id: String| {
        dispatch(ClientMessage::StopSession { id: None, session_id }, status);
    };

    view! {
        <section class="sessions">
            <h2>"sessions"</h2>
            <button class="refresh-sessions" on:click=refresh>"Refresh"</button>
            <Show when=move || sessions.error.get().is_some()>
                <p class="session-error">
                    {move || sessions.error.get().unwrap_or_default()}
                </p>
            </Show>
            <ul class="session-list">
                {move || {
                    sessions
                        .rows
                        .get()
                        .into_iter()
                        .map(|row| {
                            let id = row.id.clone();
                            let resume_id = row.id.clone();
                            let clone_id = row.id.clone();
                            let stop_id = row.id.clone();
                            let blocked = row.in_use || row.unavailable;
                            let title = row
                                .name
                                .clone()
                                .filter(|name| !name.is_empty())
                                .unwrap_or_else(|| row.id.clone());
                            let meta = format!("{} msgs", row.message_count);
                            view! {
                                <li class="session-row" data-session-id=id>
                                    <span class="session-name">{title}</span>
                                    <span class="session-meta">{meta}</span>
                                    <button
                                        class="resume"
                                        disabled=blocked
                                        on:click=move |_| resume(resume_id.clone())
                                    >
                                        "Resume"
                                    </button>
                                    <button
                                        class="clone"
                                        disabled=row.unavailable
                                        on:click=move |_| clone(clone_id.clone())
                                    >
                                        "Clone"
                                    </button>
                                    <button
                                        class="stop"
                                        on:click=move |_| stop(stop_id.clone())
                                    >
                                        "Stop"
                                    </button>
                                </li>
                            }
                        })
                        .collect_view()
                }}
            </ul>
        </section>
    }
}

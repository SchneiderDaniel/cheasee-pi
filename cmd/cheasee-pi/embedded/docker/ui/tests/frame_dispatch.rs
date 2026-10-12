//! Frame dispatcher behavior: routing each frame to the one slice that owns it,
//! the three `SessionState` reconnect routes, the malformed-frame policy, and
//! the single-decode fan-out the browser transport (`ws.rs`) uses.
//!
//! Every test is `frame_`-prefixed so `cargo test frame` reaches it.

use cheasee_pi_ui::bridge::{ServerMessage, SessionRow};
use cheasee_pi_ui::components::session_list::SessionListState;
use cheasee_pi_ui::controls::ControlsState;
use cheasee_pi_ui::extension_ui::ExtensionUiState;
use cheasee_pi_ui::frame::{fan_out, UiSlice};
use cheasee_pi_ui::protocol::ExtensionUiRequest;
use cheasee_pi_ui::stream::ChatState;
use leptos::prelude::{Get, Owner};
use serde_json::{json, Map, Value};

/// A reactive owner that outlives the test's signals.
fn owner() -> Owner {
    let owner = Owner::new();
    owner.set();
    owner
}

/// The four slices the transport fans one frame into, in `ws.rs` order.
fn slices<'a>(
    state: &'a ChatState,
    controls: &'a ControlsState,
    chrome: &'a ExtensionUiState,
    sessions: &'a SessionListState,
) -> [UiSlice<'a>; 4] {
    [
        UiSlice::Transcript(state),
        UiSlice::Controls(controls),
        UiSlice::Chrome(chrome),
        UiSlice::Sessions(sessions),
    ]
}

fn encode(message: &ServerMessage) -> String {
    serde_json::to_string(message).unwrap()
}

fn session_row() -> SessionRow {
    SessionRow {
        id: "abc".into(),
        name: Some("My session".into()),
        modified: 7,
        created: None,
        message_count: 3,
        in_use: false,
        unavailable: false,
    }
}

/// The reconnect header the server sends on subscribe; each field is optional.
fn reconnect_header(
    state: Option<Value>,
    pending: Option<ExtensionUiRequest>,
    cursor_invalid: bool,
) -> ServerMessage {
    ServerMessage::SessionState {
        id: None,
        session_id: "sess-1".into(),
        live: true,
        leaf_id: None,
        state,
        pending,
        last_assistant_text: None,
        cursor_invalid,
    }
}

fn confirm_request(id: &str) -> ExtensionUiRequest {
    ExtensionUiRequest {
        id: id.into(),
        method: "confirm".into(),
        params: Map::new(),
    }
}

// ─── Routing: each frame reaches its owning slice and nothing else ─────────

#[test]
fn frame_dispatcher_routes_session_list_to_sessions_only() {
    let _owner = owner();
    let state = ChatState::new();
    let controls = ControlsState::new();
    let chrome = ExtensionUiState::new(controls.draft);
    let sessions = SessionListState::new();
    let frame = encode(&ServerMessage::SessionList {
        id: None,
        sessions: vec![session_row()],
    });

    assert!(UiSlice::Sessions(&sessions).ingest_frame(&frame));
    assert_eq!(sessions.rows.get().len(), 1);

    for slice in [
        UiSlice::Transcript(&state),
        UiSlice::Controls(&controls),
        UiSlice::Chrome(&chrome),
    ] {
        assert!(!slice.ingest_frame(&frame), "session list must not reach another slice");
    }
    assert!(state.notice.get().is_none());
}

#[test]
fn frame_dispatcher_routes_session_state_to_controls_only() {
    let _owner = owner();
    let state = ChatState::new();
    let controls = ControlsState::new();
    let chrome = ExtensionUiState::new(controls.draft);
    let sessions = SessionListState::new();
    let frame = encode(&reconnect_header(
        Some(json!({"autoCompactionEnabled": true, "isCompacting": false})),
        None,
        false,
    ));

    assert!(UiSlice::Controls(&controls).ingest_frame(&frame));
    assert_eq!(controls.auto_compaction.get(), Some(true));

    for slice in [
        UiSlice::Transcript(&state),
        UiSlice::Chrome(&chrome),
        UiSlice::Sessions(&sessions),
    ] {
        assert!(!slice.ingest_frame(&frame), "state must not reach another slice");
    }
    assert!(state.notice.get().is_none());
    assert!(chrome.dialog.get().is_none());
}

#[test]
fn frame_dispatcher_routes_session_state_pending_to_chrome_only() {
    let _owner = owner();
    let state = ChatState::new();
    let controls = ControlsState::new();
    let chrome = ExtensionUiState::new(controls.draft);
    let sessions = SessionListState::new();
    let frame = encode(&reconnect_header(None, Some(confirm_request("uuid-1")), false));

    assert!(UiSlice::Chrome(&chrome).ingest_frame(&frame));
    assert_eq!(chrome.dialog.get().map(|d| d.id), Some("uuid-1".to_string()));

    for slice in [
        UiSlice::Transcript(&state),
        UiSlice::Controls(&controls),
        UiSlice::Sessions(&sessions),
    ] {
        assert!(!slice.ingest_frame(&frame), "pending dialog must not reach another slice");
    }
    assert!(state.notice.get().is_none());
}

#[test]
fn frame_dispatcher_routes_invalid_cursor_to_transcript_only() {
    let _owner = owner();
    let state = ChatState::new();
    let controls = ControlsState::new();
    let chrome = ExtensionUiState::new(controls.draft);
    let sessions = SessionListState::new();
    let frame = encode(&reconnect_header(None, None, true));

    assert!(UiSlice::Transcript(&state).ingest_frame(&frame));
    assert!(
        state.notice.get().unwrap().contains("cursor was unknown"),
        "an invalid cursor must surface the replay notice"
    );

    for slice in [
        UiSlice::Controls(&controls),
        UiSlice::Chrome(&chrome),
        UiSlice::Sessions(&sessions),
    ] {
        assert!(!slice.ingest_frame(&frame), "cursor notice must not reach another slice");
    }
}

// ─── Malformed frames ──────────────────────────────────────────────────────

#[test]
fn frame_dispatcher_malformed_transcript_frame_sets_notice() {
    let _owner = owner();
    let state = ChatState::new();
    let chrome = ExtensionUiState::new(ControlsState::new().draft);

    assert!(UiSlice::Transcript(&state).ingest_frame("not json"));
    assert!(
        state.notice.get().unwrap().starts_with("malformed server frame"),
        "the transcript must surface a malformed frame, never kill the connection"
    );
    assert!(!UiSlice::Chrome(&chrome).ingest_frame("not json"), "other slices are a silent no-op");
}

// ─── Fan-out: one decode, then every slice ─────────────────────────────────

#[test]
fn frame_dispatcher_fan_out_applies_a_frame_to_every_slice() {
    let _owner = owner();
    let state = ChatState::new();
    let controls = ControlsState::new();
    let chrome = ExtensionUiState::new(controls.draft);
    let sessions = SessionListState::new();
    let frame = encode(&reconnect_header(
        Some(json!({"autoCompactionEnabled": true})),
        Some(confirm_request("uuid-1")),
        true,
    ));

    let decoded = fan_out(&slices(&state, &controls, &chrome, &sessions), &frame);
    assert!(decoded.is_some(), "a valid frame decodes once for the whole fan-out");
    assert_eq!(controls.auto_compaction.get(), Some(true));
    assert_eq!(chrome.dialog.get().map(|d| d.id), Some("uuid-1".to_string()));
    assert!(state.notice.get().is_some());
    assert!(sessions.rows.get().is_empty());
}

#[test]
fn frame_dispatcher_fan_out_keeps_malformed_frames_out_of_every_slice() {
    let _owner = owner();
    let state = ChatState::new();
    let controls = ControlsState::new();
    let chrome = ExtensionUiState::new(controls.draft);
    let sessions = SessionListState::new();

    let decoded = fan_out(&slices(&state, &controls, &chrome, &sessions), "not json");
    assert!(decoded.is_none(), "a malformed frame has nothing to fan out");
    assert!(state.notice.get().unwrap().starts_with("malformed server frame"));
    assert!(chrome.dialog.get().is_none());
    assert!(sessions.rows.get().is_empty());
    assert!(controls.notice.get().is_none());
}

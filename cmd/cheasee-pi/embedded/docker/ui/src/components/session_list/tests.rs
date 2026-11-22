use super::*;
use leptos::prelude::{Get, Owner};

/// Signals need a reactive owner to allocate into. The caller binds it as
/// `_owner` so it outlives (and drops after) the state under test.
fn owner() -> Owner {
    let owner = Owner::new();
    owner.set();
    owner
}

fn row(description: Option<&str>) -> SessionRow {
    SessionRow {
        id: "abc123".into(),
        name: description.map(str::to_string),
        description: description.map(str::to_string),
        modified: 7,
        created: None,
        message_count: 2,
        in_use: false,
        unavailable: false,
    }
}

#[test]
fn session_title_shows_the_server_description() {
    assert_eq!(session_title(&row(Some("Plan the fix"))), "Plan the fix");
}

#[test]
fn session_title_falls_back_to_the_id_when_undescribed() {
    assert_eq!(session_title(&row(None)), "abc123");
}

/// A blank description is only reachable through a server bug; the panel must
/// still show something identifiable rather than an empty title.
#[test]
fn session_title_falls_back_to_the_id_on_a_blank_description() {
    assert_eq!(session_title(&row(Some(""))), "abc123");
    assert_eq!(session_title(&row(Some("   "))), "abc123");
}

#[test]
fn reduce_sessions_keeps_the_description_intact() {
    let _owner = owner();
    let state = SessionListState::new();
    assert!(state.reduce_sessions(&ServerMessage::SessionList {
        id: None,
        sessions: vec![row(Some("Plan the fix"))],
        instances: Vec::new(),
    }));
    assert_eq!(
        state.rows.get()[0].description.as_deref(),
        Some("Plan the fix")
    );
}

#[test]
fn reduce_sessions_surfaces_a_failed_action_and_leaves_the_rows_untouched() {
    let _owner = owner();
    let state = SessionListState::new();
    state.reduce_sessions(&ServerMessage::SessionList {
        id: None,
        sessions: vec![row(Some("Plan the fix"))],
        instances: Vec::new(),
    });

    assert!(state.reduce_sessions(&ServerMessage::SessionAction {
        id: None,
        session_id: "abc123".into(),
        success: false,
        error: Some("session abc123 is in use by another process".into()),
    }));
    assert_eq!(
        state.error.get().as_deref(),
        Some("session abc123 is in use by another process")
    );
    assert_eq!(state.rows.get().len(), 1);
    assert_eq!(
        state.rows.get()[0].description.as_deref(),
        Some("Plan the fix")
    );
}

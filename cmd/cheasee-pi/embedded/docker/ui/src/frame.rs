//! UI frame dispatcher: decodes a server frame once and fans it out to the
//! four UI state slices.
//!
//! Owns the decode + malformed-frame policy so the transport (`ws.rs`) and the
//! integration tests share one path instead of each slice re-parsing a frame.

use crate::bridge::ServerMessage;
use crate::components::session_list::SessionListState;
use crate::controls::ControlsState;
use crate::extension_ui::ExtensionUiState;
use crate::stream::ChatState;

/// Decode one WS text frame. `None` means malformed; a bad frame must never
/// kill the connection.
pub fn decode_server_frame(text: &str) -> Option<ServerMessage> {
    serde_json::from_str(text).ok()
}

/// Decode one WS text frame and fan it out to every slice — the transport's
/// single frame path. Returns the decoded message for the caller's reconnect
/// bookkeeping; `None` means malformed, which only the transcript surfaces.
pub fn fan_out(slices: &[UiSlice<'_>], text: &str) -> Option<ServerMessage> {
    match decode_server_frame(text) {
        Some(message) => {
            for slice in slices {
                slice.reduce(&message);
            }
            Some(message)
        }
        None => {
            // Re-decode only to carry serde's diagnostic into the notice.
            if let Err(err) = serde_json::from_str::<ServerMessage>(text) {
                for slice in slices {
                    if let UiSlice::Transcript(state) = slice {
                        state.note_malformed_frame(&err);
                    }
                }
            }
            None
        }
    }
}

/// One UI state slice a decoded frame can be reduced into.
pub enum UiSlice<'a> {
    Transcript(&'a ChatState),
    Controls(&'a ControlsState),
    Chrome(&'a ExtensionUiState),
    Sessions(&'a SessionListState),
}

impl UiSlice<'_> {
    /// Reduce an already-decoded frame into this slice.
    pub fn reduce(&self, message: &ServerMessage) -> bool {
        match self {
            UiSlice::Transcript(state) => state.reduce_transcript(message),
            UiSlice::Controls(state) => state.reduce_controls(message),
            UiSlice::Chrome(state) => state.reduce_chrome(message),
            UiSlice::Sessions(state) => state.reduce_sessions(message),
        }
    }

    /// Decode and reduce one WS text frame into this slice. A malformed frame
    /// is surfaced by the transcript slice and silently ignored elsewhere.
    pub fn ingest_frame(&self, text: &str) -> bool {
        match serde_json::from_str::<ServerMessage>(text) {
            Ok(message) => self.reduce(&message),
            Err(err) => match self {
                UiSlice::Transcript(state) => state.note_malformed_frame(&err),
                _ => false,
            },
        }
    }
}

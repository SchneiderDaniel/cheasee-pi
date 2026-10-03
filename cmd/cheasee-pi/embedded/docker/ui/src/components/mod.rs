//! UI components. Split by feature: `message` renders the transcript,
//! `controls`/`queue`/`bash` render the mid-run control surface, and
//! `dialog`/`status` render the extension UI overlay and toast/chrome.

pub mod banners;
pub mod bash;
pub mod controls;
pub mod dialog;
pub mod message;
pub mod queue;
pub mod session_list;
pub mod status;
pub mod tool_card;

use leptos::prelude::*;

use crate::app::ConnectionStatus;
use crate::bridge::ClientMessage;

/// Send one control command. The browser socket only exists in the hydrate
/// build; SSR still renders the button (a click cannot happen on the server).
pub(crate) fn dispatch(message: ClientMessage, status: RwSignal<ConnectionStatus>) {
    let _ = send(message, status);
}

/// Like [`dispatch`], but reports whether the frame actually left the socket, so
/// a caller can retain state that a failed send did not deliver.
pub(crate) fn dispatch_delivered(message: ClientMessage, status: RwSignal<ConnectionStatus>) -> bool {
    send(message, status)
}

fn send(message: ClientMessage, status: RwSignal<ConnectionStatus>) -> bool {
    #[cfg(feature = "hydrate")]
    {
        crate::ws::send(message, status)
    }
    #[cfg(not(feature = "hydrate"))]
    {
        let _ = (message, status);
        true
    }
}

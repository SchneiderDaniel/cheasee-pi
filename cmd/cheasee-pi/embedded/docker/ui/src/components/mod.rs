//! UI components. Split by feature: `message` renders the transcript,
//! `controls`/`queue`/`bash` render the mid-run control surface.

pub mod bash;
pub mod controls;
pub mod message;
pub mod queue;

use leptos::prelude::*;

use crate::app::ConnectionStatus;
use crate::bridge::ClientMessage;

/// Send one control command. The browser socket only exists in the hydrate
/// build, so the send is compiled in there; SSR still renders the button (a
/// click cannot happen on the server).
pub(crate) fn dispatch(message: ClientMessage, status: RwSignal<ConnectionStatus>) {
    #[cfg(feature = "hydrate")]
    {
        crate::ws::send(message, status);
    }
    #[cfg(not(feature = "hydrate"))]
    {
        let _ = (message, status);
    }
}

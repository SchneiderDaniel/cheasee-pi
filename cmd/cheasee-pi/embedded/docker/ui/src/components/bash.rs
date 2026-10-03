//! The inline-shell panel: one block per [`crate::bash::BashLog`], keyed by the
//! originating command id.
//!
//! Stop is global on purpose: pi's `abort_bash` aborts **every** running
//! command (`abortBash()` iterates all controllers), so the button is labelled
//! as such rather than pretending to target one id. `truncated` is a terminal
//! state — pi writes the full copy to a container-local path the browser cannot
//! fetch, so no "view full output" action is offered.

use leptos::prelude::*;

use crate::app::ConnectionStatus;
use crate::bridge::ClientMessage;
use crate::components::dispatch;
use crate::controls::ControlsState;

#[component]
pub fn BashPanel(status: RwSignal<ConnectionStatus>) -> impl IntoView {
    let controls = expect_context::<ControlsState>();
    let stop = move |_| dispatch(ClientMessage::AbortBash { id: None }, status);

    // AC4: the browser owns the command id and it goes on the wire verbatim
    // (see `session::to_command`), so `bash_execution_update` events can be
    // routed back to this block without the relay minting an id.
    let command = RwSignal::new(String::new());
    let next_id = RwSignal::new(0u64);
    let run = move |_| {
        let text = command.get();
        if text.trim().is_empty() {
            return;
        }
        let id = next_id.get_untracked() + 1;
        next_id.set(id);
        dispatch(
            ClientMessage::Bash {
                id: format!("bash-{id}"),
                command: text,
                exclude_from_context: None,
            },
            status,
        );
        command.set(String::new());
    };

    view! {
        <section class="bash">
            <h2>"shell"</h2>
            <div class="bash-input">
                <input
                    type="text"
                    placeholder="run a shell command"
                    prop:value=command
                    on:input=move |ev| command.set(event_target_value(&ev))
                />
                <button class="bash-run" on:click=run>"Run"</button>
            </div>
            {move || {
                let logs = controls.bash.get();
                if logs.is_empty() {
                    return view! { <p class="bash-empty">"no shell output"</p> }.into_any();
                }
                logs
                    .ids()
                    .iter()
                    .map(|id| {
                        let log = logs
                            .get(id)
                            .cloned()
                            .expect("id came from the same log map");
                        let output = log.lines().join("\n");
                        let pending = log.pending().to_string();
                        let truncated = log.is_truncated();
                        view! {
                            <div class="bash-block">
                                <p class="bash-command">{format!("$ {id}")}</p>
                                <pre class="bash-output">{output}</pre>
                                {(!pending.is_empty())
                                    .then(|| view! { <pre class="bash-pending">{pending.clone()}</pre> })}
                                {truncated
                                    .then(|| view! { <p class="bash-truncated">"output truncated"</p> })}
                            </div>
                        }
                        .into_any()
                    })
                    .collect_view()
                    .into_any()
            }}
            <button class="bash-stop" on:click=stop>
                "stop all running shell commands"
            </button>
        </section>
    }
}

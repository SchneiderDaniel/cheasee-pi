//! Read-only peer-instance discovery snapshot.
//!
//! The CLI owns instance identity, docker liveness and the host filesystem: it
//! writes ONE snapshot file and bind-mounts it read-only into this container
//! (compose `ui` service). This module only decodes that file — there is
//! deliberately no docker client and no host-path resolution here, because the
//! sidecar must never gain a host or daemon view (`docs/security.md`).

use crate::bridge::InstanceRow;

/// In-container path of the CLI-written snapshot (the compose mount target).
pub const SNAPSHOT_PATH: &str = "/run/cheaseepi/instances.json";

/// Env override, set by the compose file. Same value as [`SNAPSHOT_PATH`]; the
/// override exists so a local run can point at a different snapshot.
pub const SNAPSHOT_ENV: &str = "CHEASEEPI_INSTANCES";

/// Load the peer-instance snapshot.
///
/// A missing file is an empty list: the CLI may not have written it yet, and a
/// sidecar with no peers is a valid state. Anything else — an unreadable file or
/// a payload that does not decode — is reported on stderr and still degrades to
/// an empty list, because a broken discovery file must never take the control
/// center down; silence is what would hide the fault.
pub fn load() -> Vec<InstanceRow> {
    let path = std::env::var(SNAPSHOT_ENV).unwrap_or_else(|_| SNAPSHOT_PATH.to_string());
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                eprintln!("instance snapshot {path}: {err}");
            }
            return Vec::new();
        }
    };
    match serde_json::from_str::<Vec<InstanceRow>>(&raw) {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!("instance snapshot {path}: {err}");
            Vec::new()
        }
    }
}

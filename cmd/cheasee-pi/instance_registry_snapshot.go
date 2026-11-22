package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// ──────────────────────────────────────────────
// Instance snapshot (the sidecar-facing read-only view)
//
// The ui service has neither host nor docker access, so discovery reaches it as
// a FILE the CLI writes, compose bind-mounted read-only: one JSON row per live
// instance; liveness is resolved on the host at write time.
// ──────────────────────────────────────────────

// instanceSnapshotPath is the file the CLI writes for the ui sidecars and the
// compose file bind-mounts read-only into the `ui` service.
func instanceSnapshotPath() (string, error) {
	state, err := instanceStateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(state, "instances.json"), nil
}

// instanceSnapshotRow is one snapshot entry the ui service renders: the peer's
// key, label and UI port plus the liveness resolved at write time.
type instanceSnapshotRow struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	UIPort  string `json:"uiPort"`
	Running bool   `json:"running"`
}

// writeInstanceSnapshot publishes the read-only view of every registered
// instance to path — the file the compose `ui` service bind-mounts. Liveness is
// resolved from `docker ps -a` at write time (a registry file can survive a host
// crash); a container that no longer exists is dropped.
//
// A failing resolution invalidates the previously published view instead of
// leaving it in place: once the registry/docker state is unknown, every row
// still held is a claim the CLI can no longer support, so a running row would
// hand the operator a dead link. The file becomes an empty list ("no instance
// available"); the fault is returned — fail closed, never silent.
//
// The file is rewritten in place rather than replaced: the ui service binds the
// FILE, so a rename would swap the inode out from under the running container,
// freezing it on the stale content.
func writeInstanceSnapshot(ctx context.Context, reg InstanceRegistry, path string) error {
	rows, err := liveSnapshotRows(ctx, reg)
	if err != nil {
		return invalidateStaleSnapshot(path, err)
	}
	return writeSnapshotRows(path, rows)
}

// liveSnapshotRows resolves one row per registered instance whose container
// still exists on the host.
func liveSnapshotRows(ctx context.Context, reg InstanceRegistry) ([]instanceSnapshotRow, error) {
	records, err := reg.List()
	if err != nil {
		return nil, err
	}
	return snapshotRowsForRecords(ctx, records)
}

// snapshotRowsForRecords pairs the records to the liveness probe, dropping the
// records whose container is gone: the record is stale (host crash, manual rm)
// so a stale record must not surface as an available instance.
func snapshotRowsForRecords(ctx context.Context, records []InstanceRecord) ([]instanceSnapshotRow, error) {
	states, err := registeredContainerStates(ctx, records)
	if err != nil {
		return nil, err
	}
	rows := make([]instanceSnapshotRow, 0, len(records))
	for _, rec := range records {
		state, exists := states[rec.liveContainerName()]
		if !exists {
			continue
		}
		rows = append(rows, instanceSnapshotRow{
			Key:     rec.Key,
			Label:   rec.Label,
			UIPort:  rec.UIPort,
			Running: state == "running",
		})
	}
	return rows, nil
}

// invalidateStaleSnapshot clears an already-published snapshot before the
// resolution fault is returned, so the sidecar stops advertising instances the
// CLI can no longer confirm.
func invalidateStaleSnapshot(path string, cause error) error {
	if err := invalidateInstanceSnapshot(path); err != nil {
		return fmt.Errorf("%w (stale snapshot %s could not be invalidated: %v)", cause, path, err)
	}
	return cause
}

// invalidateInstanceSnapshot rewrites an existing snapshot as an empty list. A
// target that was never written is left unwritten: there is no stale claim to
// correct; fabricating one would put a file where no view was published.
func invalidateInstanceSnapshot(path string) error {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("stat instance snapshot %s: %w", path, err)
	}
	return writeEmptyInstanceSnapshot(path)
}

// registeredContainerStates probes the docker state of every recorded instance
// in one `docker ps -a`. No record needs no docker round trip: a start before
// the first record must not depend on the daemon for the snapshot to exist.
func registeredContainerStates(ctx context.Context, records []InstanceRecord) (map[string]string, error) {
	if len(records) == 0 {
		return map[string]string{}, nil
	}
	names := make([]string, 0, len(records))
	for _, rec := range records {
		names = append(names, rec.liveContainerName())
	}
	return containerStates(ctx, names)
}

// writeSnapshotRows encodes the rows as indented JSON and rewrites path in
// place, creating the state directory on demand.
func writeSnapshotRows(path string, rows []instanceSnapshotRow) error {
	data, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		return fmt.Errorf("encode instance snapshot: %w", err)
	}
	return writeSnapshotFile(path, append(data, '\n'))
}

// writeSnapshotFile writes the snapshot bytes, creating the state directory on
// demand.
func writeSnapshotFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create instance state dir for %s: %w", path, err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write instance snapshot %s: %w", path, err)
	}
	return nil
}

// writeEmptyInstanceSnapshot publishes an empty snapshot so the ui service's
// bind-mount target exists as a file.
func writeEmptyInstanceSnapshot(path string) error {
	return writeSnapshotFile(path, []byte("[]\n"))
}

// refreshInstanceSnapshot writes the shared snapshot from the host registry.
func refreshInstanceSnapshot(ctx context.Context, reg InstanceRegistry) error {
	path, err := instanceSnapshotPath()
	if err != nil {
		return err
	}
	return writeInstanceSnapshot(ctx, reg, path)
}

// ensureInstanceSnapshot materialises the snapshot BEFORE compose creates the
// ui container: bind-mounting a non-existent source makes docker create a
// DIRECTORY there, which would permanently shadow the file.
//
// A registry fault does not block the start: an empty snapshot is published so
// the mount target stays a FILE, and the returned error reports the fault to the
// caller, which warns. Discovery is additive — refusing to start a working
// session over a peer's corrupt record would be the worse trade.
func ensureInstanceSnapshot(ctx context.Context) error {
	path, err := instanceSnapshotPath()
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(path); statErr == nil {
		// Already published: the mount target is valid and the content is
		// refreshed after the stack is up.
		return nil
	}
	reg, err := hostInstanceRegistry()
	if err != nil {
		return err
	}
	if err := writeInstanceSnapshot(ctx, reg, path); err != nil {
		if fallback := writeEmptyInstanceSnapshot(path); fallback != nil {
			return fmt.Errorf("%w (and the empty snapshot could not be written: %v)", err, fallback)
		}
		return err
	}
	return nil
}

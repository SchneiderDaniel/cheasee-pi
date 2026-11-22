package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ──────────────────────────────────────────────
// Instance registry (cross-instance discovery)
//
// A sidecar can only see its own workspace's sessions: the compose stack mounts
// ONE host folder, and the ui service has neither a host nor a docker view
// (docs/security.md). Discovery therefore starts at the CLI — the only layer
// that owns container identity, docker liveness and a host filesystem view —
// which records every running stack under <stateDir>/instances/<key>.json and
// publishes a read-only snapshot for the sidecars to render.
//
// The registry is version-independent (no cliVersion segment): a host running
// two CLI versions still has one set of live instances.
// ──────────────────────────────────────────────

// InstanceRecord is one running stack as discovered by a peer sidecar. It
// carries labels and ports only: never a host path (the snapshot is readable by
// every sidecar container on the host).
type InstanceRecord struct {
	Key          string `json:"key"`
	Label        string `json:"label"`
	UIPort       string `json:"uiPort"`
	CodeflowPort string `json:"codeflowPort"`
	StartedAt    string `json:"startedAt"`
}

// InstanceRegistry is the discovery port owned by the CLI application layer. It
// imports no docker types: implementations decide where records live.
type InstanceRegistry interface {
	Record(InstanceRecord) error
	Remove(key string) error
	List() ([]InstanceRecord, error)
}

// instanceKeyCharset is the docker/compose-safe key contract. Validating on
// write is what keeps a malformed or hostile key (e.g. "../escape") from
// escaping the registry directory.
var instanceKeyCharset = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// instanceStateDir is the host state directory shared by every CLI version:
// <user cache>/cheasee-pi. Deliberately NOT CacheDir() — that path is keyed by
// cliVersion, and a peer on another version is still a live instance.
func instanceStateDir() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("user cache dir: %w", err)
	}
	return filepath.Join(base, "cheasee-pi"), nil
}

// instanceRegistryDir is the directory holding one <key>.json per running
// stack.
func instanceRegistryDir() (string, error) {
	state, err := instanceStateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(state, "instances"), nil
}

// instanceSnapshotPath is the file the CLI writes for the ui sidecars and the
// compose file bind-mounts read-only into the `ui` service.
func instanceSnapshotPath() (string, error) {
	state, err := instanceStateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(state, "instances.json"), nil
}

// fileInstanceRegistry is the file adapter: one JSON file per instance key. One
// file per key means concurrent records for different workspaces never contend;
// each write is a temp file + rename, so a reader never observes a partial
// record.
type fileInstanceRegistry struct {
	dir string
}

// newFileInstanceRegistry returns the file-backed registry rooted at dir.
func newFileInstanceRegistry(dir string) InstanceRegistry {
	return fileInstanceRegistry{dir: dir}
}

// Record writes one instance record, creating the registry directory on demand.
// A record with an invalid key or an unwritable directory is an error — never a
// silent skip, because a missing record is exactly the reported bug.
func (r fileInstanceRegistry) Record(rec InstanceRecord) error {
	if !instanceKeyCharset.MatchString(rec.Key) {
		return fmt.Errorf("instance key %q is not a valid docker-safe key", rec.Key)
	}
	if err := os.MkdirAll(r.dir, 0o755); err != nil {
		return fmt.Errorf("create instance registry %s: %w", r.dir, err)
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("encode instance record %s: %w", rec.Key, err)
	}
	data = append(data, '\n')
	// Temp name deliberately free of the .json suffix: a crash left-over is
	// then never enumerated as a record.
	tmp, err := os.CreateTemp(r.dir, "."+rec.Key+"-")
	if err != nil {
		return fmt.Errorf("create instance record %s: %w", rec.Key, err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("write instance record %s: %w", rec.Key, err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("close instance record %s: %w", rec.Key, err)
	}
	if err := os.Rename(tmpName, filepath.Join(r.dir, rec.Key+".json")); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("commit instance record %s: %w", rec.Key, err)
	}
	return nil
}

// Remove deletes one record. Idempotent: an unknown key (or a missing registry
// directory) is a no-op, so `down` on a workspace that was never registered
// still succeeds.
func (r fileInstanceRegistry) Remove(key string) error {
	if !instanceKeyCharset.MatchString(key) {
		return fmt.Errorf("instance key %q is not a valid docker-safe key", key)
	}
	if err := os.Remove(filepath.Join(r.dir, key+".json")); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove instance record %s: %w", key, err)
	}
	return nil
}

// List returns every record in key order. A missing directory is an empty
// registry; an unreadable or corrupt record is an error naming the file — a
// silent skip would under-count the instances, which is the reported symptom.
func (r fileInstanceRegistry) List() ([]InstanceRecord, error) {
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read instance registry %s: %w", r.dir, err)
	}
	records := make([]InstanceRecord, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(r.dir, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read instance record %s: %w", entry.Name(), err)
		}
		var rec InstanceRecord
		if err := json.Unmarshal(data, &rec); err != nil {
			return nil, fmt.Errorf("read instance record %s: %w", entry.Name(), err)
		}
		records = append(records, rec)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Key < records[j].Key })
	return records, nil
}

// containerNameFromKey maps an instance key onto its agent container name. The
// snapshot needs it because a record deliberately stores no docker object.
func containerNameFromKey(key string) string {
	return "cheasee-pi-" + truncateSlug(key, 51)
}

// instanceLabel is the peer-facing display name: the repo slug plus the
// worktree folder name. It never carries a host path.
func instanceLabel(workspaceRoot string) string {
	slug := repoSlug(workspaceRoot)
	if slug == "" {
		slug = "workspace"
	}
	base := filepath.Base(filepath.Clean(workspaceRoot))
	if base == "" || base == slug || base == "." || base == string(filepath.Separator) {
		return slug
	}
	return slug + " (" + base + ")"
}

// recordInstance persists the discovery record for a started workspace. Port
// resolution failures surface: a record without a port would link the operator
// at nothing.
func recordInstance(ctx context.Context, reg InstanceRegistry, root string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	uiPortValue, err := uiHostPort(root)
	if err != nil {
		return fmt.Errorf("resolve UI port for the instance registry: %w", err)
	}
	codeflowPortValue, err := codeflowHostPort(root)
	if err != nil {
		return fmt.Errorf("resolve CodeFlow port for the instance registry: %w", err)
	}
	return reg.Record(InstanceRecord{
		Key:          instanceKey(root),
		Label:        instanceLabel(root),
		UIPort:       uiPortValue,
		CodeflowPort: codeflowPortValue,
		StartedAt:    time.Now().UTC().Format(time.RFC3339),
	})
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
// crash), a container that no longer exists is dropped, and a failing probe
// writes nothing: a stale snapshot would lie about the host.
//
// The file is rewritten in place rather than replaced: the ui service binds the
// FILE, so a rename would swap the inode out from under the running container
// and freeze it on the stale content.
func writeInstanceSnapshot(ctx context.Context, reg InstanceRegistry, path string) error {
	records, err := reg.List()
	if err != nil {
		return err
	}
	// No registered instance needs no docker round trip: the snapshot is
	// genuinely empty, and a start before the first record must not depend on
	// the daemon for the file to exist.
	states := map[string]string{}
	if len(records) > 0 {
		names := make([]string, 0, len(records))
		for _, rec := range records {
			names = append(names, containerNameFromKey(rec.Key))
		}
		if states, err = containerStates(ctx, names); err != nil {
			return err
		}
	}
	rows := make([]instanceSnapshotRow, 0, len(records))
	for _, rec := range records {
		state, exists := states[containerNameFromKey(rec.Key)]
		if !exists {
			// The container is gone: the record is stale (host crash, manual
			// rm). A stale record must not surface as an available instance.
			continue
		}
		rows = append(rows, instanceSnapshotRow{
			Key:     rec.Key,
			Label:   rec.Label,
			UIPort:  rec.UIPort,
			Running: state == "running",
		})
	}
	data, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		return fmt.Errorf("encode instance snapshot: %w", err)
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create instance state dir for %s: %w", path, err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write instance snapshot %s: %w", path, err)
	}
	return nil
}

// refreshInstanceSnapshot writes the shared snapshot from the host registry.
func refreshInstanceSnapshot(ctx context.Context, reg InstanceRegistry) error {
	path, err := instanceSnapshotPath()
	if err != nil {
		return err
	}
	return writeInstanceSnapshot(ctx, reg, path)
}

// hostInstanceRegistry opens the host-wide registry.
func hostInstanceRegistry() (InstanceRegistry, error) {
	dir, err := instanceRegistryDir()
	if err != nil {
		return nil, err
	}
	return newFileInstanceRegistry(dir), nil
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

// writeEmptyInstanceSnapshot publishes an empty snapshot so the ui service's
// bind-mount target exists as a file.
func writeEmptyInstanceSnapshot(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create instance state dir for %s: %w", path, err)
	}
	if err := os.WriteFile(path, []byte("[]\n"), 0o644); err != nil {
		return fmt.Errorf("write instance snapshot %s: %w", path, err)
	}
	return nil
}

// registerRunningInstance records this workspace and refreshes the snapshot so
// peer sidecars (and this one) list it.
func registerRunningInstance(ctx context.Context, root string) error {
	reg, err := hostInstanceRegistry()
	if err != nil {
		return err
	}
	if err := recordInstance(ctx, reg, root); err != nil {
		return err
	}
	return refreshInstanceSnapshot(ctx, reg)
}

// deregisterInstance removes this workspace's record and refreshes the snapshot
// so peers stop listing a stack that is gone.
func deregisterInstance(ctx context.Context, root string) error {
	reg, err := hostInstanceRegistry()
	if err != nil {
		return err
	}
	if err := reg.Remove(instanceKey(root)); err != nil {
		return err
	}
	return refreshInstanceSnapshot(ctx, reg)
}

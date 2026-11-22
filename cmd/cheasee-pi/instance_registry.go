package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// ──────────────────────────────────────────────
// Instance registry (cross-instance discovery)
//
// A sidecar can only see its own workspace's sessions: the compose stack mounts
// ONE host folder, and the ui service has neither a host nor a docker view
// (docs/security.md). Discovery therefore starts at the CLI — the only layer
// that owns container identity, docker liveness and a host filesystem view —
// which records every running stack under <stateDir>/instances/<key>.json and
// publishes a read-only snapshot for the sidecars to render
// (instance_registry_snapshot.go).
//
// The registry is version-independent (no cliVersion segment): a host running
// two CLI versions still has one set of live instances.
// ──────────────────────────────────────────────

// InstanceRecord is one running stack as discovered by a peer sidecar. It
// carries labels, ports and one container name: never a host path (the snapshot
// is readable by every sidecar container on the host).
//
// AgentContainer is the container name the run actually used — `start --name`
// overrides the key-derived default, and a liveness probe against the derived
// name would then report a live instance as gone. Absent (a record written
// before the field existed) means the derived default; see liveContainerName.
type InstanceRecord struct {
	Key            string `json:"key"`
	Label          string `json:"label"`
	UIPort         string `json:"uiPort"`
	CodeflowPort   string `json:"codeflowPort"`
	StartedAt      string `json:"startedAt"`
	AgentContainer string `json:"agentContainer,omitempty"`
}

// liveContainerName is the container whose docker state decides whether a
// record is still an instance: the name the run used, falling back to the
// key-derived default for records written before the field existed.
func (r InstanceRecord) liveContainerName() string {
	if r.AgentContainer != "" {
		return r.AgentContainer
	}
	return containerNameFromKey(r.Key)
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
		rec, err := r.read(entry.Name())
		if err != nil {
			return nil, err
		}
		records = append(records, rec)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Key < records[j].Key })
	return records, nil
}

// read decodes one record file, naming it in every failure: an unreadable or
// corrupt record must surface, never shrink the listing silently.
func (r fileInstanceRegistry) read(name string) (InstanceRecord, error) {
	var rec InstanceRecord
	data, err := os.ReadFile(filepath.Join(r.dir, name))
	if err != nil {
		return rec, fmt.Errorf("read instance record %s: %w", name, err)
	}
	if err := json.Unmarshal(data, &rec); err != nil {
		return rec, fmt.Errorf("read instance record %s: %w", name, err)
	}
	return rec, nil
}

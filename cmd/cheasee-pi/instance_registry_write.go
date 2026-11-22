package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// ──────────────────────────────────────────────
// Registry write path
//
// One file per instance key plus a temp-file+rename commit: a reader never
// observes a partial record, and two workspaces writing at the same time never
// contend for one lock.
// ──────────────────────────────────────────────

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
	return r.commit(rec.Key, append(data, '\n'))
}

// commit publishes one encoded record atomically: temp file, write, close, then
// rename onto <key>.json. The temp name deliberately lacks the .json suffix, so
// a crash leftover is never enumerated as a record.
func (r fileInstanceRegistry) commit(key string, data []byte) error {
	tmp, err := os.CreateTemp(r.dir, "."+key+"-")
	if err != nil {
		return fmt.Errorf("create instance record %s: %w", key, err)
	}
	tmpName := tmp.Name()
	if err := writeCloseRemove(tmp, data); err != nil {
		return fmt.Errorf("write instance record %s: %w", key, err)
	}
	if err := os.Rename(tmpName, filepath.Join(r.dir, key+".json")); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("commit instance record %s: %w", key, err)
	}
	return nil
}

// writeCloseRemove completes the temp-file write, removing it on any failure so
// the registry directory never accumulates partial files.
func writeCloseRemove(tmp *os.File, data []byte) error {
	name := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

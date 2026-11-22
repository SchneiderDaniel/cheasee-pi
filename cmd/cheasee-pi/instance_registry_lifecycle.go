package main

import (
	"context"
	"fmt"
	"time"
)

// ──────────────────────────────────────────────
// Registry lifecycle on start and stop
//
// The start use case records this workspace's instance and refreshes the shared
// snapshot; the stop use case removes the record. Both are best-effort at the
// call sites (a working session must not be refused over a registry fault) but
// never silent: every fault reaches the operator.
// ──────────────────────────────────────────────

// hostInstanceRegistry opens the host-wide registry.
func hostInstanceRegistry() (InstanceRegistry, error) {
	dir, err := instanceRegistryDir()
	if err != nil {
		return nil, err
	}
	return newFileInstanceRegistry(dir), nil
}

// recordInstance persists the discovery record for a started workspace. Port
// resolution failures surface: a record without a port would link the operator
// at nothing.
func recordInstance(ctx context.Context, reg InstanceRegistry, root string) error {
	if err := ctx.Err(); err != nil {
		return err
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

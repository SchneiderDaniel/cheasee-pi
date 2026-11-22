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

// recordInstance persists the discovery record for a started workspace.
// agentContainer is the container name the run actually used (`start --name`
// overrides the derived default); it is what the sidecar probes for liveness.
// Port resolution failures surface: a record without a port would link the
// operator at nothing.
func recordInstance(ctx context.Context, reg InstanceRegistry, root, agentContainer string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	uiPortValue, codeflowPortValue, err := publishedInstancePorts(ctx, root)
	if err != nil {
		return err
	}
	if agentContainer == "" {
		agentContainer = containerName(root)
	}
	return reg.Record(InstanceRecord{
		Key:            instanceKey(root),
		Label:          instanceLabel(root),
		UIPort:         uiPortValue,
		CodeflowPort:   codeflowPortValue,
		StartedAt:      time.Now().UTC().Format(time.RFC3339),
		AgentContainer: agentContainer,
	})
}

// publishedInstancePorts resolves both sidecar host ports for the record the
// way publishResolvedPorts resolves them for the printed hints: the port the
// running container actually published (`docker port`) first, then the
// settings/env/derive+probe chain.
//
// Registration happens AFTER the stack is up, so this workspace's own sidecars
// already hold their binds — the probe reports those live binds as occupancy
// and shifts to the next free port. A record built from the probe alone would
// therefore link the operator at a port no sidecar listens on (the #2155 audit
// finding); `docker port` is authoritative exactly there.
func publishedInstancePorts(ctx context.Context, root string) (uiPortValue, codeflowPortValue string, err error) {
	uiPortValue, err = resolveUIHostPort(ctx, root)
	if err != nil {
		return "", "", fmt.Errorf("resolve UI port for the instance registry: %w", err)
	}
	if bound, boundErr := codeflowBoundPort(ctx, root); boundErr == nil {
		return uiPortValue, bound, nil
	}
	codeflowPortValue, err = codeflowHostPort(root)
	if err != nil {
		return "", "", fmt.Errorf("resolve CodeFlow port for the instance registry: %w", err)
	}
	return uiPortValue, codeflowPortValue, nil
}

// registerRunningInstance records this workspace and refreshes the snapshot so
// peer sidecars (and this one) list it.
func registerRunningInstance(ctx context.Context, root, agentContainer string) error {
	reg, err := hostInstanceRegistry()
	if err != nil {
		return err
	}
	if err := recordInstance(ctx, reg, root, agentContainer); err != nil {
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

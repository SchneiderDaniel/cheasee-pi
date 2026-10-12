package main

import (
	"context"
	"fmt"
	"hash/fnv"
	"net"
	"os"
	"slices"
	"strconv"
	"strings"
)

// ──────────────────────────────────────────────
// Sidecar host ports (CodeFlow + UI)
// ──────────────────────────────────────────────

// codeflowPortBase is the low end of the derived per-repo CodeFlow port
// range; codeflowPortRange spans 1024 ports so fnv32(slug)%1024 lands in
// [8470, 9493]. Deterministic per repo → parallel workspaces get stable,
// usually-distinct ports; the probe + next-free fallback below absorbs
// birthday collisions, and CODEFLOW_PORT / docker.codeflowPort are the
// explicit escapes.
const (
	codeflowPortBase  = 8470
	codeflowPortRange = 1024
)

// uiPortBase is the low end of the derived per-repo UI host port range. The
// 1024-wide band sits disjoint from (and above) CodeFlow's [8470, 9493], so
// the two sidecars of one workspace can never resolve to the same port. Width
// is a power of two (2³² mod 1024 == 0 → no FNV skew) and the top stays below
// the Linux ephemeral floor (32768), so a derived UI port is never an
// ephemeral allocation. PI_UI_PORT / docker.uiPort are the explicit escapes.
const (
	uiPortBase  = 9500
	uiPortRange = 1024
)

// portProbe checks whether a host TCP port on loopback is free to bind; a
// package-var seam so tests can simulate occupancy/exhaustion without binding
// sockets.
var portProbe = func(port int) error {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return err
	}
	return l.Close()
}

// portSpec is the shared resolver for a sidecar's host port. Both sidecars
// follow one precedence — cheasee-settings.json field > process env var >
// derived base+fnv32(repoSlug)%span, probed with next-free fallback — and one
// `docker port <container> <containerPort>/tcp` bound-port read; only the
// constants and the service label differ.
type portSpec struct {
	base, span    int
	envVar        string                        // process env escape hatch (e.g. CODEFLOW_PORT)
	service       string                        // error-text label (e.g. "CodeFlow")
	containerPort string                        // in-container port probed via `docker port`
	settingsPort  func(*CheaseeSettings) string // per-repo settings field
	containerName func(string) string           // container name for `docker port`
}

// codeflowPort is the CodeFlow sidecar's port spec. Its band sits below the
// UI band, so the two sidecars of one workspace can never resolve to the same
// port.
var codeflowPort = portSpec{
	base:          codeflowPortBase,
	span:          codeflowPortRange,
	envVar:        "CODEFLOW_PORT",
	service:       "CodeFlow",
	containerPort: "8470",
	settingsPort:  func(s *CheaseeSettings) string { return s.Docker.CodeflowPort },
	containerName: codeflowContainerName,
}

// uiPort is the UI sidecar's port spec.
var uiPort = portSpec{
	base:          uiPortBase,
	span:          uiPortRange,
	envVar:        "PI_UI_PORT",
	service:       "UI",
	containerPort: "3000",
	settingsPort:  func(s *CheaseeSettings) string { return s.Docker.UIPort },
	containerName: uiContainerName,
}

// hostPort resolves the host port for a workspace: the settings field
// (explicit per-repo config) > the process env var (passed through untouched)
// > derived base+fnv32(repoSlug)%span, probed with next-free fallback. Range
// exhaustion fails closed with an actionable error naming the env var.
func (p portSpec) hostPort(workspaceRoot string) (string, error) {
	if port := p.explicitPort(workspaceRoot); port != "" {
		return port, nil
	}
	start := p.base + int(fnv32(repoSlug(workspaceRoot))%uint32(p.span))
	for port := start; port < p.base+p.span; port++ {
		if portProbe(port) == nil {
			return strconv.Itoa(port), nil
		}
	}
	return "", fmt.Errorf("no free host port in [%d, %d] for the %s service — stop another workspace or set %s explicitly", p.base, p.base+p.span-1, p.service, p.envVar)
}

// explicitPort resolves ONLY the explicit host port for a workspace — settings
// field > process env var — returning "" when the port would be
// derived+probed. The codeflow drift check compares only explicit ports: a
// derived port is runtime allocation (probe occupancy shifts with no config
// change), so comparing it against the live bind would false-positive.
func (p portSpec) explicitPort(workspaceRoot string) string {
	if s, err := LoadCheaseeSettings(workspaceRoot); err == nil {
		if port := p.settingsPort(s); port != "" {
			return port
		}
	}
	return os.Getenv(p.envVar)
}

// boundPort resolves the host port the running sidecar actually published,
// via `docker port`. Authoritative over the probe in hostPort: on a re-up the
// sidecar already holds its bind, and the probe treats that live bind as
// occupancy and shifts to the next free port — printing a URL that points at
// nothing. Falls back to derive+probe in the caller on any docker error
// (first up, stopped sidecar).
func (p portSpec) boundPort(ctx context.Context, workspaceRoot string) (string, error) {
	name := p.containerName(workspaceRoot)
	out, err := runCommandContext(ctx, "docker", "port", name, p.containerPort+"/tcp").Output()
	if err != nil {
		return "", err
	}
	// "0.0.0.0:8938" | "127.0.0.1:8938" | "[::]:8938" — the host port is
	// the last colon segment.
	host := strings.TrimSpace(string(out))
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[i+1:]
	}
	if host == "" {
		return "", fmt.Errorf("docker port: no published host port for %s", name)
	}
	return host, nil
}

// codeflowHostPort is a thin delegation to the CodeFlow spec (test seam
// name preserved).
func codeflowHostPort(workspaceRoot string) (string, error) {
	return codeflowPort.hostPort(workspaceRoot)
}

// explicitCodeflowPort is a thin delegation to the CodeFlow spec (test seam
// name preserved); it never probes.
func explicitCodeflowPort(workspaceRoot string) string {
	return codeflowPort.explicitPort(workspaceRoot)
}

// codeflowBoundPort is a thin delegation to the CodeFlow spec (test seam
// name preserved).
func codeflowBoundPort(ctx context.Context, workspaceRoot string) (string, error) {
	return codeflowPort.boundPort(ctx, workspaceRoot)
}

// uiContainerName follows the repo-slug scheme for the UI sidecar service.
func uiContainerName(workspaceRoot string) string {
	return "ui-" + truncateSlug(repoSlug(workspaceRoot), 54)
}

// uiHostPort is a thin delegation to the UI spec (test seam name
// preserved).
func uiHostPort(workspaceRoot string) (string, error) { return uiPort.hostPort(workspaceRoot) }

// uiBoundPort is a thin delegation to the UI spec (test seam name
// preserved).
func uiBoundPort(ctx context.Context, workspaceRoot string) (string, error) {
	return uiPort.boundPort(ctx, workspaceRoot)
}

// resolveUIHostPort resolves the UI host port for the start path, bound-first
// and single-resolution: the port the running sidecar actually published
// (`docker port`) > uiHostPort's settings/env/derive+probe chain. One value
// feeds the compose env, the `ℹ UI:` hint, and the PI_UI_PORT exec env, so
// all three always agree. Resolution failure returns uiHostPort's verbatim
// error so the caller's `⚠ UI port:` line is byte-identical to the
// unmerged branches.
func resolveUIHostPort(ctx context.Context, workspaceRoot string) (string, error) {
	if port, err := uiBoundPort(ctx, workspaceRoot); err == nil {
		return port, nil
	}
	return uiHostPort(workspaceRoot)
}

// fnv32 is the FNV-1a 32-bit hash used for the deterministic port offset.
func fnv32(s string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(s))
	return h.Sum32()
}

// stripEnvKeys returns env minus the given KEY= entries — derived CLI values
// are authoritative, and duplicate KEY= entries resolve nondeterministically
// across libc/exec builds.
func stripEnvKeys(env []string, keys ...string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		key, _, ok := strings.Cut(kv, "=")
		if ok && slices.Contains(keys, key) {
			continue
		}
		out = append(out, kv)
	}
	return out
}

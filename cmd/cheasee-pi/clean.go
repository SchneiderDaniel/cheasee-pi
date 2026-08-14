package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

var cleanCmd = &cobra.Command{
	Use:   "clean",
	Short: "Remove all Cheasee-Pi containers and prune Docker garbage (dangling images + build cache)",
	Long: `Remove every Cheasee-Pi container (all repositories), kill orphaned pi
processes inside the running ones, and prune dangling Docker images and
build cache from old rebuilds.

Containers are enumerated by compose project: every container belonging to a
cheasee-pi project (the per-repo project cheasee-pi-<repo> plus the legacy
shared project cheasee-pi — main container and codeflow sidecar alike) is
removed. Other containers are never touched.

Pi processes orphaned by disconnected docker exec sessions accumulate RAM.
The orphan scan runs against each running Cheasee-Pi container first; only
processes reparented to PID 1 (orphans) are killed — interactive sessions
are NOT affected. Dangling images and build cache (intermediate layers) are
pruned. Use 'cheasee-pi start' to start a fresh session after cleaning.

Examples:
  cheasee-pi clean               # remove all cheasee-pi containers + prune Docker garbage`,
	DisableAutoGenTag: true,
	RunE:              runCleanE,
}

func init() {
	rootCmd.AddCommand(cleanCmd)
}

// cleanContainer is one Cheasee-Pi compose container discovered by clean.
type cleanContainer struct {
	name    string
	running bool
}

// cheaseePiContainers enumerates every container belonging to a cheasee-pi
// compose project (project "cheasee-pi" or "cheasee-pi-<repo>"): all workspace
// containers — main + codeflow sidecar — plus the legacy shared container.
// One docker ps -a format line per container; containers without the compose
// project label (plain docker run) are never matched.
func cheaseePiContainers() ([]cleanContainer, error) {
	cmd := execCommand("docker", "ps", "-a", "--format", `{{.Names}}\t{{.State}}\t{{index .Labels "com.docker.compose.project"}}`)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}
	var found []cleanContainer
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) != 3 {
			continue
		}
		name, state, project := parts[0], parts[1], parts[2]
		if project == "" || !strings.HasPrefix(project, "cheasee-pi") {
			continue
		}
		found = append(found, cleanContainer{name: name, running: state == "running"})
	}
	return found, nil
}

func runCleanE(cmd *cobra.Command, _ []string) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}

	containers, err := cheaseePiContainers()
	if err != nil {
		return fmt.Errorf("enumerate containers: %w", err)
	}

	// Orphan scan first: kills pi processes reparented to PID 1 in every
	// running Cheasee-Pi container (the same scan start runs pre-exec).
	killed := 0
	for _, c := range containers {
		if !c.running {
			continue
		}
		n, err := scanOrphans(ctx, c.name, 0, false)
		if err != nil {
			return fmt.Errorf("orphan scan %s: %w", c.name, err)
		}
		killed += len(n)
	}
	if killed > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Killed %d orphaned pi process(es)\n", killed)
	} else if len(containers) > 0 {
		fmt.Fprintf(os.Stderr, "  ℹ No orphaned pi processes found\n")
	}

	// Remove every discovered container; a container vanishing between
	// enumeration and removal (No such container) is tolerated.
	var rmErrs []string
	for _, c := range containers {
		cmd := execCommand("docker", "rm", "-f", c.name)
		out, err := cmd.CombinedOutput()
		if err != nil && !strings.Contains(string(out), "No such container") {
			rmErrs = append(rmErrs, fmt.Sprintf("%s: %v", c.name, err))
		}
	}
	if len(containers) > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Removed %d Cheasee-Pi container(s)\n", len(containers))
	} else {
		fmt.Fprintf(os.Stderr, "  ℹ No Cheasee-Pi containers found\n")
	}
	if len(rmErrs) > 0 {
		return fmt.Errorf("docker rm: %s", strings.Join(rmErrs, "; "))
	}

	pruneDanglingImages()
	pruneBuildCache()

	return nil
}

// pruneDanglingImages removes all dangling (<none>:<none>) Docker images.
// Tagged/in-use images are never affected.
func pruneDanglingImages() {
	ls := execCommand("docker", "images", "--filter", "dangling=true", "-q")
	out, err := ls.Output()
	if err != nil || len(out) == 0 {
		return
	}
	cmd := execCommand("docker", "image", "prune", "-f")
	if _, err := cmd.Output(); err != nil {
		return
	}
	fmt.Fprintf(os.Stderr, "  ✓ Pruned dangling Docker images\n")
}

// pruneBuildCache removes the Docker buildx build cache.
// Safe to run unconditionally — fast when empty.
func pruneBuildCache() {
	cmd := execCommand("docker", "buildx", "prune", "-f")
	if _, err := cmd.Output(); err == nil {
		fmt.Fprintf(os.Stderr, "  ✓ Pruned Docker build cache\n")
	}
}

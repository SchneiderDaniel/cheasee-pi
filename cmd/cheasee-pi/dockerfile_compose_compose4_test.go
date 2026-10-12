package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestCompose_ResolvedProjectAndImageRefs(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "my_repo.v2")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}

	composeEnvForTest(t, root)
	project := composeProjectName(root)
	if project != "cheasee-pi-my-repo-v2" {
		t.Errorf("composeProjectName = %q, want the sanitized cheasee-pi-my-repo-v2", project)
	}
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`).MatchString(project) {
		t.Errorf("project name %q violates the compose ≥v2.17 charset", project)
	}
	if strings.ContainsAny(project, "_.") {
		t.Errorf("project name %q must not carry _ or . (compose normalizes them away)", project)
	}
	if got := cheaseeImageRef(root); got != project+"-cheasee-pi" {
		t.Errorf("cheaseeImageRef = %q, want %q", got, project+"-cheasee-pi")
	}
	// The ui service has no image: key, so Compose auto-names it <project>-ui.
	if got := project + "-ui"; got != "cheasee-pi-my-repo-v2-ui" {
		t.Errorf("ui auto-image ref = %q, want cheasee-pi-my-repo-v2-ui", got)
	}
}

// TestCompose_LoopbackMatrix (AC2): each service pins its published host side
// to loopback via its own mechanism — ui a literal, codeflow a
// `${CODEFLOW_HOST_IP:-127.0.0.1}` seam. The mechanism travels per row so a
// shared helper can never assume one variable name.

func TestCompose_LoopbackMatrix(t *testing.T) {
	content := readCompose(t)
	rows := []struct {
		service       string
		hostVar       string // "" = literal, no host-IP seam (ui)
		portVar       string
		containerPort string
	}{
		{service: "ui", hostVar: "", portVar: "PI_UI_PORT", containerPort: "3000"},
		{service: "codeflow", hostVar: "CODEFLOW_HOST_IP", portVar: "CODEFLOW_PORT", containerPort: "8470"},
	}
	for _, tc := range rows {
		t.Run(tc.service, func(t *testing.T) {
			t.Setenv(tc.portVar, "")
			if tc.hostVar != "" {
				t.Setenv(tc.hostVar, "")
			}
			spec := renderedServicePort(t, renderComposeInterpolation(t, content), tc.service)
			if v := loopbackHostViolation(spec); v != "" {
				t.Errorf("%s default port %q violates loopback: %s", tc.service, spec, v)
			}
			if !strings.HasSuffix(spec, ":"+tc.containerPort) {
				t.Errorf("%s container side must stay %s, got %q", tc.service, tc.containerPort, spec)
			}

			// An explicit host port override survives the loopback pin.
			t.Setenv(tc.portVar, "9000")
			spec = renderedServicePort(t, renderComposeInterpolation(t, content), tc.service)
			if v := loopbackHostViolation(spec); v != "" {
				t.Errorf("%s override port %q violates loopback: %s", tc.service, spec, v)
			}
			want := "127.0.0.1:9000:" + tc.containerPort
			if spec != want {
				t.Errorf("%s override port = %q, want %q", tc.service, spec, want)
			}

			if tc.hostVar != "" {
				// Documented opt-in: 0.0.0.0 restores all-interfaces.
				t.Setenv(tc.hostVar, "0.0.0.0")
				if got := renderedServicePort(t, renderComposeInterpolation(t, content), tc.service); !strings.HasPrefix(got, "0.0.0.0:") {
					t.Errorf("%s must honor its explicit all-interfaces opt-in, got %q", tc.service, got)
				}
			} else {
				// ui has no opt-in seam: the raw block must never carry one.
				idx := strings.Index(content, "\n  ui:")
				if idx < 0 {
					t.Fatal("ui service block not found")
				}
				for _, forbidden := range []string{"PI_UI_HOST_IP", "0.0.0.0"} {
					if strings.Contains(content[idx:], forbidden) {
						t.Errorf("ui block must not contain %q (loopback is a hard invariant)", forbidden)
					}
				}
			}
		})
	}

	// cheasee-pi publishes nothing — the two sidecars are the only host ingress.
	if _, ok := composeService(t, renderComposeInterpolation(t, content), "cheasee-pi")["ports"]; ok {
		t.Error("cheasee-pi service must declare no ports")
	}
}

// TestCompose_LoopbackGuardRejectsAllInterfaces guards the guard: the helper
// must fail loudly on an all-interfaces bind (the "break the loopback pin"
// validation step) and accept a correct spec, so it is never a vacuous pass.

func TestCompose_LoopbackGuardRejectsAllInterfaces(t *testing.T) {
	if loopbackHostViolation("0.0.0.0:9000:3000") == "" {
		t.Error("loopbackHostViolation must reject 0.0.0.0")
	}
	if loopbackHostViolation("127.0.0.1:9000:3000") != "" {
		t.Error("loopbackHostViolation must accept 127.0.0.1")
	}
}

// TestCompose_ReadyMarkerHealthcheck (AC3): the cheasee-pi healthcheck still
// gates on the entrypoint's /tmp/.cheasee-pi-ready marker, and codeflow
// declares no healthcheck (so `up --wait` cannot sequence AC3 off codeflow).

func TestCompose_ReadyMarkerHealthcheck(t *testing.T) {
	svc := composeService(t, readCompose(t), "cheasee-pi")
	hc, ok := svc["healthcheck"].(map[string]any)
	if !ok {
		t.Fatalf("cheasee-pi healthcheck missing, got %v", svc["healthcheck"])
	}
	joined := fmt.Sprint(hc["test"].([]any)...)
	if !strings.Contains(joined, "test -f /tmp/.cheasee-pi-ready") {
		t.Errorf("cheasee-pi healthcheck must gate on the ready marker, got %q", joined)
	}
	if _, ok := composeService(t, readCompose(t), "codeflow")["healthcheck"]; ok {
		t.Error("codeflow must declare no healthcheck (its absence is what makes --wait unreliable)")
	}
}

package main

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestUiHostPort_rangeExhaustedFailsClosed(t *testing.T) {
	t.Setenv("PI_UI_PORT", "")
	saved := portProbe
	portProbe = func(p int) error { return fmt.Errorf("in use") }
	t.Cleanup(func() { portProbe = saved })

	_, err := uiHostPort(filepath.Join(t.TempDir(), "ws"))
	if err == nil {
		t.Fatal("range exhaustion must fail closed with an error")
	}
	if !strings.Contains(err.Error(), "PI_UI_PORT") {
		t.Errorf("error must name the remedy (PI_UI_PORT), got %v", err)
	}
}

func TestUiContainerName(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	want := "ui-" + truncateSlug(repoSlug(root), 54)
	if got := uiContainerName(root); got != want {
		t.Errorf("uiContainerName = %q, want %q", got, want)
	}
	if uiContainerName(root) == codeflowContainerName(root) {
		t.Error("ui and codeflow container names must differ")
	}
	// Over-long slug truncates to <=57 chars and gains a hashed suffix.
	long := filepath.Join(t.TempDir(), strings.Repeat("a", 70))
	got := uiContainerName(long)
	if len(got) > 57 {
		t.Errorf("over-long slug must truncate to <=57 chars (ui- + 54), got %d (%q)", len(got), got)
	}
	if !regexp.MustCompile(`-[0-9a-f]{6}$`).MatchString(got) {
		t.Errorf("over-long slug must gain a hashed suffix, got %q", got)
	}
}

func TestUiBoundPort_queriesDockerPort(t *testing.T) {
	root := filepath.Join(t.TempDir(), "ws")
	var gotName, gotArg, gotProto string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "port" {
			gotName, gotArg, gotProto = name, arg[1], arg[2]
		}
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("127.0.0.1:8938\n"), nil }}
	})
	got, err := uiBoundPort(context.Background(), root)
	if err != nil {
		t.Fatalf("uiBoundPort: %v", err)
	}
	if got != "8938" {
		t.Errorf("must return the published host port, got %q", got)
	}
	if gotName != "docker" || gotArg != uiContainerName(root) || gotProto != "3000/tcp" {
		t.Errorf("must query the UI container port, got docker %q arg %q proto %q", gotName, gotArg, gotProto)
	}
}

func TestUiBoundPort_ipv6AndAllInterfaces(t *testing.T) {
	for _, out := range []string{"[::]:8938\n", "0.0.0.0:8938\n"} {
		stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(out), nil }}
		})
		got, err := uiBoundPort(context.Background(), filepath.Join(t.TempDir(), "ws"))
		if err != nil {
			t.Fatalf("uiBoundPort(%q): %v", out, err)
		}
		if got != "8938" {
			t.Errorf("bind %q must parse the host port, got %q", out, got)
		}
	}
}

func TestUiBoundPort_errorsFallThrough(t *testing.T) {
	for _, out := range []struct {
		name    string
		output  []byte
		cmdErr  error
		wantErr bool
	}{
		{"docker fails", nil, fmt.Errorf("container stopped"), true},
		{"empty output", nil, nil, true},
	} {
		t.Run(out.name, func(t *testing.T) {
			stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
				return &mockCmd{outputFn: func() ([]byte, error) { return out.output, out.cmdErr }}
			})
			if _, err := uiBoundPort(context.Background(), filepath.Join(t.TempDir(), "ws")); out.wantErr && err == nil {
				t.Fatal("expected an error (caller falls back to derive+probe)")
			}
		})
	}
}

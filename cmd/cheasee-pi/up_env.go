package main

import (
	"context"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
)

// buildEnvFlags collects the env vars to inject into the container: provider
// keys from auth.json resolved through ProviderToEnvVar, the --api-key
// override, and passthrough env vars from the current process. Provider names
// flow in sorted order so alias collisions (claude + anthropic →
// ANTHROPIC_API_KEY) resolve deterministically (last write wins).
func buildEnvFlags(ctx context.Context) (map[string]string, error) {
	envMap := make(map[string]string)

	// 1. Provider keys from auth.json
	repo := &fileRepository{}
	providers, err := repo.ListProviders(ctx)
	if err != nil {
		return nil, fmt.Errorf("read auth.json: %w", err)
	}

	for _, provider := range slices.Sorted(maps.Keys(providers)) {
		key := providers[provider]
		envVar := ProviderToEnvVar(provider)
		if envVar == "" {
			// Unknown provider — pass as-is
			envVar = strings.ToUpper(provider) + "_API_KEY"
		}
		envMap[envVar] = key
	}

	// 2. --api-key flag overrides OPENCODE_API_KEY
	if upAPIKey != "" {
		envMap["OPENCODE_API_KEY"] = upAPIKey
	}

	// 3. Passthrough known env vars from current process (auth.json wins)
	for _, envVar := range AllEnvVarNames() {
		if _, ok := envMap[envVar]; ok {
			continue
		}
		if val := os.Getenv(envVar); val != "" {
			envMap[envVar] = val
		}
	}

	// 4. GitHub token. The container's GH_TOKEN must be the credential
	// cheasee-pi init/--reauth minted into auth.json — its scope list
	// (repo, read:org, project, workflow) is what the supervisor needs for
	// the project-board status moves and workflow-file pushes. A GH_TOKEN
	// exported in the host shell or
	// gh's own credential (gh auth token) may predate the project scope and
	// silently strip that permission, so auth.json wins when present; fall
	// back to the process env, then gh's credential store.
	// ponytail: single-precedence if-chain; revisit if multiple GitHub
	// identities per host become a real use case.
	if tok, err := repo.GitHubToken(ctx); err == nil && tok != "" {
		envMap["GH_TOKEN"] = tok
	} else if val := os.Getenv("GH_TOKEN"); val != "" {
		envMap["GH_TOKEN"] = val
	} else if token, err := extractGHToken(); err == nil && token != "" {
		envMap["GH_TOKEN"] = token
	}

	return envMap, nil
}

// redactEnvValue shortens a secret for dry-run output: values longer than
// 8 chars show the first and last 4 chars; shorter values print in full.
func redactEnvValue(v string) string {
	if len(v) > 8 {
		return v[:4] + "..." + v[len(v)-4:]
	}
	return v
}

func extractGHToken() (string, error) {
	out, err := runCommandContext(context.Background(), "gh", "auth", "token").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// execArgs builds docker exec args that run pi directly in the given
// container working directory (e.g. /workspaces/main or /workspaces/main/sub).
// On disconnect, docker exec sends SIGKILL to the container's pid 1,
// which propagates to pi and all its children — no wrapper needed.
func execArgs(env map[string]string, name, target string) []string {
	// Sorted keys keep the -e flag order deterministic (Go map iteration
	// order is randomized by spec).
	args := []string{"exec"}
	for _, envVar := range slices.Sorted(maps.Keys(env)) {
		args = append(args, "-e", envVar+"="+env[envVar])
	}
	args = append(args,
		"-it",
		"--user", "agentuser",
		"-w", target,
		name,
		"/usr/bin/pi", "--approve",
	)
	return args
}

// execPIContainer runs docker exec with the injected env in the container
// working directory target. Package-var seam (newRepository/runCommandContext
// pattern): tests override it to observe the non-dry-run exec without a real
// docker daemon.
var execPIContainer = func(name string, env map[string]string, target string) error {
	args := execArgs(env, name, target)

	cmd := runCommandContext(context.Background(), "docker", args...)
	cmd.SetStdin(os.Stdin)
	cmd.SetStdout(os.Stdout)
	cmd.SetStderr(os.Stderr)

	return cmd.Run()
}

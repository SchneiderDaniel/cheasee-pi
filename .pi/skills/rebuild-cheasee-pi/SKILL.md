---
name: rebuild-cheasee-pi
description: "Build the cheasee-pi Go binary inside the Docker container then install it on the host. Runs embed + build, copies to ignore/, installs to ~/.local/bin/. Use after any Go source change."
metadata:
  scope: cheasee-pi-repo-only
  dependencies: docker, container-running
---

# Rebuild — cheasee-pi binary

Builds the Go binary inside the running `cheasee-pi` container (only place with Go toolchain) and installs it on the host.

## When to use

- After editing any `.go` file in `cmd/cheasee-pi/`
- After changing embedded files via `make embed`
- When `cheasee-pi --help` shows stale command list (missing `down`, `stop`, etc.)

## Process

### Step 1 — Build inside container

```bash
docker exec -w /workspaces/main cheasee-pi bash -c "make embed && go build -o cheasee-pi ./cmd/cheasee-pi/"
```

The binary lands at `./cheasee-pi` (bind-mounted from container to host).

### Step 2 — Copy to ignore/ (temp archive)

```bash
cp ./cheasee-pi ignore/cheasee-pi
```

### Step 3 — Install on host

```bash
cp ./cheasee-pi ~/.local/bin/cheasee-pi
```

### Step 4 — Verify

```bash
./cheasee-pi --help
```

Check that expected commands (`down`, `start`, `clean`, `auth`) appear.

## Run tests before build (optional)

```bash
docker exec -w /workspaces/main cheasee-pi make test
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `make: go: not found` | Go only inside container. Run build via `docker exec`. |
| `container cheasee-pi not running` | Start it: `cheasee-pi start` or `bash docker/run-pi.sh` |
| `~/.local/bin/ not in PATH` | Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc` |

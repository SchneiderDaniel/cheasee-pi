# Cheasee-Pi Makefile
# ====================

# ──────────────────────────────────────────────
# Single normal repo invariant (no git submodules)
# ──────────────────────────────────────────────

.PHONY: check-no-submodules

check-no-submodules:
	@bash scripts/check-no-submodules.sh

# ──────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────

.PHONY: build

build:
	go build ./cmd/cheasee-pi/

# ──────────────────────────────────────────────
# Test
# ──────────────────────────────────────────────

.PHONY: test test-embed

test:
	go test ./cmd/cheasee-pi/ -count=1

test-embed: test

# Cheasee-Pi Makefile
# ====================

# ──────────────────────────────────────────────
# Docker tree: sync cmd/cheasee-pi/embedded/docker/ → docker/
# Single source of truth is cmd/cheasee-pi/embedded/docker/
# (real files there are required by //go:embed embedded in embed.go).
# docker/ at repo root is a generated build artifact for the dev-facing
# compose workflow — run `make docker-tree` on a fresh clone before
# compose-from-repo-root. docker/-only extras (test/, docker-compose.legacy.yml)
# stay tracked and are never touched by the sync.
# ──────────────────────────────────────────────

DOCKER_TREE_SRC := cmd/cheasee-pi/embedded/docker

.PHONY: docker-tree check-docker

docker-tree:
	@find $(DOCKER_TREE_SRC) -type f ! -name '*.pyc' | while read -r src; do \
		rel="$${src#$(DOCKER_TREE_SRC)/}"; \
		dest="docker/$$rel"; \
		mkdir -p "$$(dirname "$$dest")"; \
		cp "$$src" "$$dest" || exit 1; \
	done
	@echo "Synced docker/ from $(DOCKER_TREE_SRC)/."

check-docker:
	@count=$$(find $(DOCKER_TREE_SRC) -type f ! -name '*.pyc' | wc -l); \
	if [ "$$count" -eq 0 ]; then \
		echo "ERROR: no files found under $(DOCKER_TREE_SRC)/" >&2; \
		exit 1; \
	fi; \
	tmp=$$(mktemp); \
	find $(DOCKER_TREE_SRC) -type f ! -name '*.pyc' | while read -r src; do \
		rel="$${src#$(DOCKER_TREE_SRC)/}"; \
		dest="docker/$$rel"; \
		if [ ! -f "$$dest" ]; then \
			echo "ERROR: $$dest is missing (run 'make docker-tree')" >> "$$tmp"; \
		elif ! cmp -s "$$src" "$$dest"; then \
			echo "ERROR: $$dest differs from $$src (run 'make docker-tree')" >> "$$tmp"; \
		fi; \
	done; \
	if [ -s "$$tmp" ]; then cat "$$tmp" >&2; rm -f "$$tmp"; exit 1; fi; \
	rm -f "$$tmp"; \
	echo "docker/ matches $(DOCKER_TREE_SRC)/."

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

test-embed: check-docker test

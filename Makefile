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
# Pi resource tree: sync .pi/ → cmd/cheasee-pi/embedded/pi-resources/
# Single source of truth is the repo's .pi/ tracked resources (skills,
# prompts, extensions, themes + package.json/tsconfig.json). State dirs
# (agent/, context/, sessions/, git/, venvs) never bake into the image.
# The tree is embedded via //go:embed (embed.go) and staged into the
# image at /opt/cheasee-pi by the CLI extractor — run `make pi-tree`
# when .pi/ resource content changes; CI enforces with `make check-pi`.
# ──────────────────────────────────────────────

PI_TREE_SRC := .pi
PI_TREE_DEST := cmd/cheasee-pi/embedded/pi-resources
PI_TREE_DIRS := skills prompts extensions themes
PI_TREE_FILES := package.json tsconfig.json
# Project-local extensions whose hooks load from the gitignored .pi/git
# vendored clone (absent on CI/fresh clones). Never baked: the baked copy
# cannot work there, and a failed extension load kills pi's boot. The
# mounted repo still provides the extension when the clone is present.
PI_TREE_SKIP := extensions/ponytail

.PHONY: pi-tree check-pi

pi-tree:
	@rm -rf $(PI_TREE_DEST)
	@mkdir -p $(PI_TREE_DEST)/.pi
	@for d in $(PI_TREE_DIRS); do \
		cp -aL $(PI_TREE_SRC)/$$d $(PI_TREE_DEST)/.pi/ || exit 1; \
	done
	@for f in $(PI_TREE_FILES); do \
		cp -a $(PI_TREE_SRC)/$$f $(PI_TREE_DEST)/.pi/ || exit 1; \
	done
	@for f in package.json package-lock.json; do \
		cp -a $$f $(PI_TREE_DEST)/ || exit 1; \
	done
	@for s in $(PI_TREE_SKIP); do \
		rm -rf $(PI_TREE_DEST)/.pi/$$s || exit 1; \
	done
	@echo "Synced pi-resources from $(PI_TREE_SRC)/ to $(PI_TREE_DEST)/ (symlinks dereferenced)."

check-pi:
	@if [ ! -d "$(PI_TREE_DEST)/.pi" ]; then \
		echo "ERROR: $(PI_TREE_DEST)/.pi missing (run 'make pi-tree')" >&2; \
		exit 1; \
	fi; \
	tmp=$$(mktemp); \
	for d in $(PI_TREE_DIRS); do \
		if [ ! -d "$(PI_TREE_DEST)/.pi/$$d" ]; then \
			echo "ERROR: $(PI_TREE_DEST)/.pi/$$d missing (run 'make pi-tree')" >> "$$tmp"; \
			continue; \
		fi; \
		( \
			cd "$(CURDIR)/$(PI_TREE_SRC)/$$d" && \
			skip="$$(for s in $(PI_TREE_SKIP); do case "$$s" in $$d/*) printf '%s\n' "$${s#$$d/}";; esac; done)"; \
			if [ -n "$$skip" ]; then pat="^\./$${skip}(/|$$)"; else pat='^$$'; fi; \
			find . -type f | grep -v -E "$$pat" | while IFS= read -r f; do \
				cmp -s "$$f" "$(CURDIR)/$(PI_TREE_DEST)/.pi/$$d/$$f" || \
					echo "ERROR: $(PI_TREE_DEST)/.pi/$$d/$$f differs from source (run 'make pi-tree')" >> "$$tmp"; \
			done; \
			find . -type l | grep -v -E "$$pat" | while IFS= read -r l; do \
				resolved="$$(readlink -f "$$l" 2>/dev/null)"; \
				dest="$(CURDIR)/$(PI_TREE_DEST)/.pi/$$d/$$l"; \
				if [ -L "$$dest" ]; then \
					echo "ERROR: $(PI_TREE_DEST)/.pi/$$d/$$l is still a symlink (run 'make pi-tree' — dereferences)" >> "$$tmp"; \
				elif [ -d "$$resolved" ]; then \
					diff -r "$$resolved" "$$dest" >/dev/null 2>&1 || \
						echo "ERROR: symlink target $(PI_TREE_DEST)/.pi/$$d/$$l differs (run 'make pi-tree')" >> "$$tmp"; \
				elif [ -f "$$resolved" ]; then \
					cmp -s "$$resolved" "$$dest" || \
						echo "ERROR: symlink target $(PI_TREE_DEST)/.pi/$$d/$$l differs (run 'make pi-tree')" >> "$$tmp"; \
				elif [ ! -e "$$dest" ]; then \
					echo "ERROR: $(PI_TREE_DEST)/.pi/$$d/$$l missing from baked tree (run 'make pi-tree' where .pi/git is present)" >> "$$tmp"; \
				fi; \
			done; \
		); \
	done; \
	for f in $(PI_TREE_FILES); do \
		if ! cmp -s "$(PI_TREE_SRC)/$$f" "$(PI_TREE_DEST)/.pi/$$f"; then \
			echo "ERROR: $(PI_TREE_DEST)/.pi/$$f differs from $(PI_TREE_SRC)/$$f (run 'make pi-tree')" >> "$$tmp"; \
		fi; \
	done; \
	for f in package.json package-lock.json; do \
		if ! cmp -s "$$f" "$(PI_TREE_DEST)/$$f"; then \
			echo "ERROR: $(PI_TREE_DEST)/$$f differs from repo $$f (run 'make pi-tree')" >> "$$tmp"; \
		fi; \
	done; \
	find "$(PI_TREE_DEST)/.pi" -type l | while IFS= read -r l; do \
		echo "ERROR: $(PI_TREE_DEST)/.pi/$$l is a symlink — pi-tree must dereference (run 'make pi-tree')" >> "$$tmp"; \
	done; \
	if [ -s "$$tmp" ]; then cat "$$tmp" >&2; rm -f "$$tmp"; exit 1; fi; \
	rm -f "$$tmp"; \
	echo "pi-resources matches $(PI_TREE_SRC)/."

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

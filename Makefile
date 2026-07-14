# Cheasee-Pi Makefile
# ====================

# ──────────────────────────────────────────────
# Embed: sync docker/ → cmd/cheasee-pi/embedded/
# ──────────────────────────────────────────────

EMBEDDED_DIR := cmd/cheasee-pi/embedded
EMBEDDED_FILES := $(EMBEDDED_DIR)/docker-compose.yml $(EMBEDDED_DIR)/Dockerfile $(EMBEDDED_DIR)/entrypoint.sh
SOURCE_FILES := docker/docker-compose.yml docker/Dockerfile docker/entrypoint.sh

.PHONY: embed check-embed

embed: $(EMBEDDED_FILES)

$(EMBEDDED_DIR)/docker-compose.yml: docker/docker-compose.yml
	cp $< $@

$(EMBEDDED_DIR)/Dockerfile: docker/Dockerfile
	cp $< $@

$(EMBEDDED_DIR)/entrypoint.sh: docker/entrypoint.sh
	cp $< $@

check-embed:
	@echo "Checking embedded files match docker/ source..."
	@for f in docker-compose.yml Dockerfile entrypoint.sh; do \
		if ! cmp -s docker/$$f $(EMBEDDED_DIR)/$$f; then \
			echo "ERROR: $(EMBEDDED_DIR)/$$f differs from docker/$$f"; \
			echo "Run 'make embed' to sync."; \
			exit 1; \
		fi; \
	done
	@echo "All embedded files match docker/ source."

# ──────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────

.PHONY: build

build: embed
	go build ./cmd/cheasee-pi/

# ──────────────────────────────────────────────
# Test
# ──────────────────────────────────────────────

.PHONY: test test-embed

test:
	go test ./cmd/cheasee-pi/ -count=1

test-embed: check-embed test

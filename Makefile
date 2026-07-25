# Cheasee-Pi Makefile
# ====================

# ──────────────────────────────────────────────
# Embed: sync docker/ → cmd/cheasee-pi/embedded/docker/
# Single source of truth for Dockerfile is docker/Dockerfile.
# ──────────────────────────────────────────────

EMBEDDED_DIR := cmd/cheasee-pi/embedded
EMBEDDED_DOCKER_DIR := $(EMBEDDED_DIR)/docker
EMBEDDED_FILES := \
	$(EMBEDDED_DOCKER_DIR)/Dockerfile \
	$(EMBEDDED_DOCKER_DIR)/docker-compose.yml \
	$(EMBEDDED_DOCKER_DIR)/entrypoint.sh \
	$(EMBEDDED_DOCKER_DIR)/run-pi.sh \
	$(EMBEDDED_DOCKER_DIR)/stop-pi.sh

.PHONY: embed check-embed

embed: $(EMBEDDED_FILES)

$(EMBEDDED_DOCKER_DIR)/Dockerfile: docker/Dockerfile | $(EMBEDDED_DOCKER_DIR)
	cp $< $@

$(EMBEDDED_DOCKER_DIR)/docker-compose.yml: docker/docker-compose.yml | $(EMBEDDED_DOCKER_DIR)
	cp $< $@

$(EMBEDDED_DOCKER_DIR)/entrypoint.sh: docker/entrypoint.sh | $(EMBEDDED_DOCKER_DIR)
	cp $< $@

$(EMBEDDED_DOCKER_DIR)/run-pi.sh: docker/run-pi.sh | $(EMBEDDED_DOCKER_DIR)
	cp $< $@

$(EMBEDDED_DOCKER_DIR)/stop-pi.sh: docker/stop-pi.sh | $(EMBEDDED_DOCKER_DIR)
	cp $< $@

$(EMBEDDED_DOCKER_DIR):
	mkdir -p $(EMBEDDED_DOCKER_DIR)/lib

check-embed:
	@echo "Checking embedded files match docker/ source..."
	@for f in Dockerfile docker-compose.yml entrypoint.sh run-pi.sh stop-pi.sh; do \
		if ! cmp -s docker/$$f $(EMBEDDED_DOCKER_DIR)/$$f; then \
			echo "ERROR: $(EMBEDDED_DOCKER_DIR)/$$f differs from docker/$$f"; \
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

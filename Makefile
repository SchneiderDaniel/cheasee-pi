# Cheasee-Pi Makefile
# ====================

# ──────────────────────────────────────────────
# Embed: sync docker/ → cmd/cheasee-pi/embedded/docker/
# Single source of truth for Dockerfile is docker/Dockerfile.
# ──────────────────────────────────────────────

EMBEDDED_DIR := cmd/cheasee-pi/embedded
EMBEDDED_DOCKER_DIR := $(EMBEDDED_DIR)/docker
EMBEDDED_PI_GUARDIAN_DIR := $(EMBEDDED_DIR)/cmd/pi-guardian
EMBEDDED_FILES := \
	$(EMBEDDED_DOCKER_DIR)/Dockerfile \
	$(EMBEDDED_DOCKER_DIR)/docker-compose.yml \
	$(EMBEDDED_DOCKER_DIR)/entrypoint.sh \
	$(EMBEDDED_DOCKER_DIR)/run-pi.sh \
	$(EMBEDDED_DOCKER_DIR)/stop-pi.sh \
	$(EMBEDDED_DOCKER_DIR)/lib/auth-env.sh \
	$(EMBEDDED_PI_GUARDIAN_DIR)/main.go \
	$(EMBEDDED_PI_GUARDIAN_DIR)/main_test.go

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

$(EMBEDDED_DOCKER_DIR)/lib/auth-env.sh: docker/lib/auth-env.sh | $(EMBEDDED_DOCKER_DIR)
	cp $< $@

# pi-guardian source: embed into Cheasee-Pi binary so `cheasee-pi init`
# extracts it to <workdir>/cmd/pi-guardian/. Dockerfile's COPY cmd/pi-guardian/
# then finds it during docker compose build.
$(EMBEDDED_PI_GUARDIAN_DIR)/main.go: cmd/pi-guardian/main.go | $(EMBEDDED_PI_GUARDIAN_DIR)
	cp $< $@

$(EMBEDDED_PI_GUARDIAN_DIR)/main_test.go: cmd/pi-guardian/main_test.go | $(EMBEDDED_PI_GUARDIAN_DIR)
	cp $< $@

$(EMBEDDED_DOCKER_DIR):
	mkdir -p $(EMBEDDED_DOCKER_DIR)/lib

$(EMBEDDED_PI_GUARDIAN_DIR):
	mkdir -p $@

check-embed:
	@echo "Checking embedded files match docker/ source..."
	@for f in Dockerfile docker-compose.yml entrypoint.sh run-pi.sh stop-pi.sh lib/auth-env.sh; do \
		if ! cmp -s docker/$$f $(EMBEDDED_DOCKER_DIR)/$$f; then \
			echo "ERROR: $(EMBEDDED_DOCKER_DIR)/$$f differs from docker/$$f"; \
			echo "Run 'make embed' to sync."; \
			exit 1; \
		fi; \
	done
	@for f in main.go main_test.go; do \
		if ! cmp -s cmd/pi-guardian/$$f $(EMBEDDED_PI_GUARDIAN_DIR)/$$f; then \
			echo "ERROR: $(EMBEDDED_PI_GUARDIAN_DIR)/$$f differs from cmd/pi-guardian/$$f"; \
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

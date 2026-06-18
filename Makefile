# Makefile for Cheasee-Pi — Docker workflow (Linux)
# Targets: up (build+start), shell (enter container), pi (launch agent)
# See: https://tech.davis-hansson.com/p/make/

SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

.PHONY: up shell pi

# Build and start the Cheasee-Pi container
up:
	@if ! command -v docker &>/dev/null; then \
		echo "Error: Docker not found on PATH."; \
		echo "Install Docker from: https://docs.docker.com/get-docker/"; \
		echo ""; \
		echo "After installing, ensure your user is in the 'docker' group:"; \
		echo "  sudo usermod -aG docker \$$USER && newgrp docker"; \
		exit 1; \
	fi
	@if ! command -v jq &>/dev/null; then \
		echo "Error: jq is required but not found on PATH."; \
		echo "Install from: https://jqlang.github.io/jq/download/"; \
		exit 1; \
	fi
	@CHEASEEPI_MEMORY=$$(jq -r '.docker.memory // "4G"' .pi/settings.json); \
	export CHEASEEPI_MEMORY; \
	CHEASEEPI_CPUS=$$(jq -r '.docker.cpus // "2.0"' .pi/settings.json); \
	export CHEASEEPI_CPUS; \
	HOST_UID=$$(id -u); \
	export HOST_UID; \
	HOST_GID=$$(id -g); \
	export HOST_GID
	@echo "Starting cheasee-pi container..."
	docker compose -f docker/docker-compose.yml up -d --build

# Open a bash shell inside the running container
shell:
	@if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^cheasee-pi$$'; then \
		echo "Container cheasee-pi not running. Run 'make up' first."; \
		exit 1; \
	fi
	docker exec -it cheasee-pi /bin/bash

# Launch the pi agent inside the container (with splash loading screen)
pi:
	@if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^cheasee-pi$$'; then \
		echo "Container cheasee-pi not running. Run 'make up' first."; \
		exit 1; \
	fi
	# Use startup wrapper for splash integration during extension loading
	docker exec -it cheasee-pi /bin/bash -c 'cd /workspaces/main && node --experimental-strip-types src/start-pi.ts'

#!/bin/bash
set -e

# ------------------------------------------------------------------
# Cheasee-Pi — Docker Compose orchestration wrapper
#
# Single entry point to build, start, and enter the cheasee-pi
# container with workspace mounts and resource limits configured
# via the project's settings file.
#
# Usage:
#   ./cheasee-pi.sh
# ------------------------------------------------------------------

# --- Help --------------------------------------------------------------
show_help() {
    cat <<EOF
Usage: ./cheasee-pi.sh [options]

Options:
  -k, --api-key <key>   Set API key for this session (not saved to disk)
  -a, --attach          Attach to running container (skip startup checks)
  --configure           Interactive setup: choose providers, enter keys, save to shell profile
  --rebuild             Force rebuild even if container is already running
  --clean               Kill orphaned pi/node processes inside container
  -h, --help            Show this help
EOF
    exit 0
}

# --- Resource check: prompt if container exceeds threshold -------------
check_container_resources() {
    local threshold=80
    local stats container_name
    container_name="cheasee-pi"

    stats=$(docker stats "$container_name" --no-stream --format '{{.CPUPerc}}|{{.MemPerc}}' 2>/dev/null) || return 0

    local cpu_raw mem_raw
    cpu_raw=$(echo "$stats" | cut -d'|' -f1 | tr -d '%' | tr ',' '.')
    mem_raw=$(echo "$stats" | cut -d'|' -f2 | tr -d '%' | tr ',' '.')

    # CPU as fraction of allocated cores, capped at 100%
    # docker stats CPUPerc shows usage relative to total host CPUs
    # (e.g., 200% = 2 cores on 8-core host). Divide by allocated
    # cores to get a 0-100% reading of budget used.
    local allocated_cpus
    allocated_cpus=$(jq -r '.docker.cpus // "2.0"' .pi/settings.json 2>/dev/null || echo "2.0")
    local cpu_pct
    cpu_pct=$(echo "scale=2; $cpu_raw / $allocated_cpus" | bc -l 2>/dev/null || echo "$cpu_raw")
    # Cap at 100
    cpu_pct=$(echo "if ($cpu_pct > 100) 100 else $cpu_pct" | bc -l 2>/dev/null || echo "$cpu_pct")

    # Cap mem at 100 too
    mem_pct=$(echo "if ($mem_raw > 100) 100 else $mem_raw" | bc -l 2>/dev/null || echo "$mem_raw")

    # Integer for threshold comparison
    local cpu_int="${cpu_pct%.*}"
    local mem_int="${mem_pct%.*}"
    [ -z "$cpu_int" ] && cpu_int=0
    [ -z "$mem_int" ] && mem_int=0

    echo ""
    echo "Container resource usage:"
    echo "  CPU: ${cpu_pct}% (of ${allocated_cpus} core(s))"
    echo "  RAM: ${mem_pct}%"

    if [ "$cpu_int" -gt "$threshold" ] || [ "$mem_int" -gt "$threshold" ]; then
        echo ""
        echo "Resource usage exceeds ${threshold}% threshold!"
        echo ""
        read -r -p "Continue? [Y/n]: " choice
        case "$choice" in
            n|N|q|Q) echo "Aborting."; exit 1 ;;
            *)       echo "Continuing..." ;;
        esac
    fi
    echo ""
}

# --- Parse args ---------------------------------------------------------
API_KEY=""
CLEAN=false
CONFIGURE=false
REBUILD=false
ATTACH=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        -k|--api-key)
            API_KEY="$2"
            shift 2
            ;;
        -a|--attach)
            ATTACH=true
            shift
            ;;
        --clean)
            CLEAN=true
            shift
            ;;
        --configure)
            CONFIGURE=true
            shift
            ;;
        --rebuild)
            REBUILD=true
            shift
            ;;
        -h|--help)
            show_help
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            ;;
    esac
done

# --- Cleanup mode: kill orphaned pi/node processes --------------------
# Kills pi/node processes that have no active PID marker file.
# Session marker files are created by the interactive session launcher.
if [ "$CLEAN" = true ]; then
    docker exec cheasee-pi bash -c '
      # Collect active PIDs from marker files
      active=""
      for f in /tmp/pi-active-*; do
        [ -f "$f" ] && active="$active $(cat "$f" 2>/dev/null)"
      done
      # Kill pi/node processes not in active list
      for f in /proc/[0-9]*/comm; do
        c=$(< "$f")
        case "$c" in
          pi|node)
            pid="${f%/comm}"; pid="${pid##*/}"
            case " $active " in *" $pid "*) ;; *) kill -9 "$pid" 2>/dev/null || true ;; esac
            ;;
        esac
      done
      # Remove stale marker files
      for f in /tmp/pi-active-*; do
        [ -f "$f" ] && pid=$(cat "$f" 2>/dev/null) && ! kill -0 "$pid" 2>/dev/null && rm -f "$f" 2>/dev/null || true
      done
    ' 2>/dev/null || { echo "Container not running."; exit 1; }
    echo "Cleaned up orphaned pi/node processes."
    exit 0
fi

# --- Detect shell profile ---------------------------------------------
detect_profile() {
    if [ -n "$ZSH_VERSION" ] || [ -f "$HOME/.zshrc" ]; then
        echo "$HOME/.zshrc"
    elif [ -n "$BASH_VERSION" ] || [ -f "$HOME/.bashrc" ]; then
        echo "$HOME/.bashrc"
    else
        echo "$HOME/.profile"
    fi
}

# --- Parse provider list from pi --help ---------------------------------
parse_providers() {
    pi --help 2>/dev/null | awk '/^Environment Variables:/{flag=1; next} flag && /^  [A-Z]/' | grep -i 'api.key' | sed 's/  //'
}

fallback_providers=$(cat <<'FALLBACK'
OPENAI_API_KEY - OpenAI GPT API key
ANTHROPIC_API_KEY - Anthropic Claude API key
OPENCODE_API_KEY - OpenCode Zen/OpenCode Go API key
DEEPSEEK_API_KEY - DeepSeek API key
GEMINI_API_KEY - Google Gemini API key
FALLBACK
)

# --- Interactive provider chooser ---------------------------------------
run_configure() {
    local PROFILE
    PROFILE=$(detect_profile)

    echo "Configuring API keys for pi providers..."
    echo "Shell profile: $PROFILE"
    echo ""

    local PROVIDERS
    PROVIDERS=$(parse_providers)
    [ -z "$PROVIDERS" ] && PROVIDERS="$fallback_providers"

    # Build arrays
    local VARS=() DESCS=()
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        local var desc
        var=$(echo "$line" | awk '{print $1}')
        desc=$(echo "$line" | sed 's/^[A-Z_]* - //')
        VARS+=("$var")
        DESCS+=("$desc")
    done <<< "$PROVIDERS"

    # Helper: check if a key exists in auth.json for any provider
    has_auth_key() {
        local envvar="$1"
        [ -f "$HOME/.pi/agent/auth.json" ] || return 1
        jq -e "to_entries[] | select(.value.key != null) as \$e | \$e.key" "$HOME/.pi/agent/auth.json" >/dev/null 2>&1
        # Map envvar back to provider names and check
        local providers
        case "$envvar" in
            OPENCODE_API_KEY)     providers='"opencode-go","opencode"' ;;
            OPENAI_API_KEY)       providers='"openai"' ;;
            ANTHROPIC_API_KEY)    providers='"anthropic","claude"' ;;
            DEEPSEEK_API_KEY)     providers='"deepseek"' ;;
            GEMINI_API_KEY)       providers='"gemini","google"' ;;
            *)                    return 1 ;;
        esac
        jq -e "[keys[] | select(. == $providers) | . as \$p | .[\$p].key | length > 0] | any" "$HOME/.pi/agent/auth.json" >/dev/null 2>&1
    }

    echo "Available providers:"
    for i in "${!VARS[@]}"; do
        local var="${VARS[$i]}" desc="${DESCS[$i]}" status=""
        if [ -n "${!var}" ]; then
            status="(already set)"
        elif grep -q "^export $var=" "$PROFILE" 2>/dev/null; then
            status="(already saved)"
        elif has_auth_key "$var"; then
            status="(in ~/.pi/agent/auth.json)"
        fi
        echo "  [$((i+1))] $var  $desc $status"
    done

    echo ""
    echo "Enter numbers (e.g., '1 3 5'), 'all', or 'q':"
    read -r -p "> " selection
    [ "$selection" = "q" ] && exit 0
    [ "$selection" = "all" ] && selection=$(seq 1 ${#VARS[@]})

    # Collect keys and write profile
    local HEADER_WRITTEN=false
    local ENV_EXPORTS=""
    for num in $selection; do
        local idx=$((num - 1))
        [ "$idx" -lt 0 ] || [ "$idx" -ge "${#VARS[@]}" ] && continue
        local var="${VARS[$idx]}" desc="${DESCS[$idx]}"

        [ -n "${!var}" ] && echo "$var already set — skipping." && continue
        grep -q "^export $var=" "$PROFILE" 2>/dev/null && echo "$var already saved — skipping." && continue

        echo ""
        read -r -p "Key for $var ($desc): " key
        [ -z "$key" ] && echo "Skipping $var." && continue

        export "$var=$key"
        ENV_EXPORTS="$ENV_EXPORTS export $var=$key"

        if [ "$HEADER_WRITTEN" = false ]; then
            echo "" >> "$PROFILE"
            echo "# --- cheasee-pi API keys (added $(date +%Y-%m-%d)) ---" >> "$PROFILE"
            HEADER_WRITTEN=true
        fi
        echo "export $var=$key" >> "$PROFILE"
        echo "Saved $var to $PROFILE"
    done

    echo ""
    echo "Keys saved to $PROFILE"
    echo ""
}

# --- Configure mode (explicit) -------------------------------------------
if [ "$CONFIGURE" = true ]; then
    run_configure
    exit 0
fi

# --- Attach mode: fast path for extra terminals ------------------------
# Skips all startup checks (pi-version, gh auth, API key prompts).
# Relies on API keys already set in shell environment.
if [ "$ATTACH" = true ]; then
    if ! command -v docker &>/dev/null; then
        echo "Error: Docker not found."
        exit 1
    fi
    if ! docker ps --filter name=cheasee-pi --format '{{.Names}}' 2>/dev/null | grep -q cheasee-pi; then
        echo "Error: cheasee-pi container is not running."
        echo "Start it first with: ./cheasee-pi.sh"
        exit 1
    fi

    # Extract gh token from host keyring if not already in env
    if [ -z "${GH_TOKEN:-}" ] && command -v gh &>/dev/null; then
        GH_TOKEN_EXTRACTED=$(gh auth token 2>/dev/null || true)
        if [ -n "$GH_TOKEN_EXTRACTED" ]; then
            export GH_TOKEN="$GH_TOKEN_EXTRACTED"
        fi
        unset GH_TOKEN_EXTRACTED
    fi

    # Build env passthrough from current shell env (fast, no auth.json parse)
    DOCKER_ENV=""
    for var in OPENAI_API_KEY ANTHROPIC_API_KEY OPENCODE_API_KEY DEEPSEEK_API_KEY GEMINI_API_KEY \
               ANT_LING_API_KEY AZURE_OPENAI_API_KEY NVIDIA_API_KEY GROQ_API_KEY \
               CEREBRAS_API_KEY XAI_API_KEY FIREWORKS_API_KEY TOGETHER_API_KEY \
               OPENROUTER_API_KEY AI_GATEWAY_API_KEY MISTRAL_API_KEY MINIMAX_API_KEY \
               MOONSHOT_API_KEY KIMI_API_KEY CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID \
               GH_TOKEN; do
        if [ -n "${!var}" ]; then
            DOCKER_ENV="$DOCKER_ENV -e $var=${!var}"
        fi
    done

    check_container_resources

    exec docker exec $DOCKER_ENV -it --user agentuser cheasee-pi /bin/bash -c 'cd /workspaces/main && clear && pi --approve "$@"' --
fi

# --- Step 1: Assert docker is on PATH ---------------------------------
if ! command -v docker &>/dev/null; then
    echo "Error: Docker not found on PATH."
    echo "Install Docker from: https://docs.docker.com/get-docker/"
    echo ""
    echo "After installing, ensure your user is in the 'docker' group:"
    echo "  sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
fi

# --- Step 2: Read resource limits from .pi/settings.json --------------
if ! command -v jq &>/dev/null; then
    echo "Error: jq is required but not found on PATH."
    echo "Install from: https://jqlang.github.io/jq/download/"
    exit 1
fi

CHEASEEPI_MEMORY=$(jq -r '.docker.memory // "2G"' .pi/settings.json)
CHEASEEPI_CPUS=$(jq -r '.docker.cpus // "2.0"' .pi/settings.json)

export CHEASEEPI_MEMORY
export CHEASEEPI_CPUS

# --- Step 3: Resolve API key -------------------------------------------
# Priority: --api-key flag > env vars already set > configure interactively

PROVIDER=$(jq -r '.defaultProvider // "opencode-go"' .pi/settings.json)

# --- Helper: map provider name to env var -----------------------------
provider_to_envvar() {
    case "$1" in
        opencode-go|opencode)  echo "OPENCODE_API_KEY" ;;
        openai*)               echo "OPENAI_API_KEY" ;;
        anthropic*|claude*)    echo "ANTHROPIC_API_KEY" ;;
        deepseek*)             echo "DEEPSEEK_API_KEY" ;;
        gemini*|google*)       echo "GEMINI_API_KEY" ;;
        groq*)                 echo "GROQ_API_KEY" ;;
        mistral*)              echo "MISTRAL_API_KEY" ;;
        openrouter*)           echo "OPENROUTER_API_KEY" ;;
        *)                     echo "" ;;
    esac
}

# --- Read keys from ~/.pi/agent/auth.json if exists -----------------
AUTH_JSON="$HOME/.pi/agent/auth.json"
if [ -f "$AUTH_JSON" ]; then
    # Extract all provider keys from auth.json and export as env vars
    while IFS= read -r provider; do
        [ -z "$provider" ] && continue
        key=$(jq -r ".\"$provider\".key // empty" "$AUTH_JSON")
        if [ -n "$key" ]; then
            envvar=$(provider_to_envvar "$provider")
            if [ -n "$envvar" ] && [ -z "${!envvar}" ]; then
                export "$envvar=$key"
            fi
        fi
    done <<< "$(jq -r 'keys[]' "$AUTH_JSON" 2>/dev/null)"
fi

ALL_VARS=(OPENAI_API_KEY ANTHROPIC_API_KEY OPENCODE_API_KEY DEEPSEEK_API_KEY GEMINI_API_KEY)
HAVE_ANY=false

# Check if container already running — skip interactive prompts on subsequent calls
FIRST_RUN=true
if docker ps --filter name=cheasee-pi --format '{{.Names}}' 2>/dev/null | grep -q cheasee-pi; then
    FIRST_RUN=false
fi

if [ -n "$API_KEY" ]; then
    export OPENCODE_API_KEY="$API_KEY"
    HAVE_ANY=true
    echo "Found API keys: OPENCODE_API_KEY (from --api-key)"
else
    FOUND=""
    for var in "${ALL_VARS[@]}"; do
        if [ -n "${!var}" ]; then
            val="${!var}"
            masked="${val:0:4}...${val: -4}"
            FOUND="$FOUND\n  $var  $masked"
            HAVE_ANY=true
        fi
    done
    if [ "$HAVE_ANY" = true ]; then
        echo -e "Found API keys:$FOUND"
    fi
fi

if [ "$HAVE_ANY" = false ] && [ "$FIRST_RUN" = true ]; then
    echo "No API keys configured yet."
    echo ""
    run_configure
fi

# After configure (or if keys existed), verify default provider has a key
DEFAULT_VAR=""
case "$PROVIDER" in
    opencode-go|opencode) DEFAULT_VAR="OPENCODE_API_KEY" ;;
    openai*)               DEFAULT_VAR="OPENAI_API_KEY" ;;
    anthropic*|claude*)    DEFAULT_VAR="ANTHROPIC_API_KEY" ;;
    deepseek*)             DEFAULT_VAR="DEEPSEEK_API_KEY" ;;
    gemini*|google*)       DEFAULT_VAR="GEMINI_API_KEY" ;;
    *)                     DEFAULT_VAR="OPENCODE_API_KEY" ;;
esac

if [ -z "${!DEFAULT_VAR}" ]; then
    echo "Warning: default provider '$PROVIDER' needs key \$DEFAULT_VAR."
    echo "The container will launch, but API calls may fail."
    echo "Run 'source $(detect_profile)' or restart your shell."
fi

# --- Step 4: Export host identity -------------------------------------
export HOST_UID
HOST_UID=$(id -u)
export HOST_GID
HOST_GID=$(id -g)

# --- Step 4b: Export host git identity for container commits -----------
# Supervisor extension does git commit inside container. Use host identity
# so commits show the actual user. Falls back to Cheasee-Pi if unset.
export HOST_GIT_NAME
HOST_GIT_NAME=$(git config user.name 2>/dev/null || echo "Cheasee-Pi")
export HOST_GIT_EMAIL
HOST_GIT_EMAIL=$(git config user.email 2>/dev/null || echo "cheasee-pi@localhost")

# --- Step 4c: Write .env for docker-compose -------------------------------
# docker-compose reads docker/.env automatically when in the same directory.
# This ensures direct `docker compose` commands (without the wrapper) have
# the correct host identity variables and don't trigger "variable not set"
# warnings. Updated on every run so git identity changes are picked up.
cat > "$(dirname "$0")/docker/.env" <<ENVEOF
# Cheasee-Pi environment — auto-generated by cheasee-pi.sh
# docker-compose reads this file automatically when in the same directory.
HOST_UID=$HOST_UID
HOST_GID=$HOST_GID
HOST_GIT_NAME=$HOST_GIT_NAME
HOST_GIT_EMAIL=$HOST_GIT_EMAIL
ENVEOF

# --- Step 5: Check if container already running, rebuild only if needed ---
PI_VERSION=$(npm view @earendil-works/pi-coding-agent version 2>/dev/null || echo "latest")
export PI_VERSION

CONTAINER_RUNNING=false
if docker ps --filter name=cheasee-pi --format '{{.Names}}' 2>/dev/null | grep -q cheasee-pi; then
    CONTAINER_RUNNING=true
fi

if [ "$CONTAINER_RUNNING" = true ] && [ "$REBUILD" = false ]; then
    # Container alive — skip compose, just attach
    INSTALLED_PI=$(docker exec cheasee-pi pi --version 2>/dev/null || echo "?")
    if [ "$INSTALLED_PI" != "$PI_VERSION" ] && [ "$INSTALLED_PI" != "?" ]; then
        echo "Warning: container pi $INSTALLED_PI, latest is $PI_VERSION."
        echo "  Run './cheasee-pi.sh --rebuild' to upgrade."
    fi
    echo "Reusing running container cheasee-pi..."

    check_container_resources
else
    # --- Mutual exclusion: prevent concurrent docker compose up ------------
    exec 200>/tmp/cheasee-pi.lock
    flock -n 200 || {
        echo "Another cheasee-pi.sh instance is starting the container. Waiting..."
        flock 200
    }
    trap 'rm -f /tmp/cheasee-pi.lock' EXIT

    echo "Starting cheasee-pi container (pi $PI_VERSION)..."

    # Remove old container before rebuild to avoid orphan conflicts
    docker rm -f cheasee-pi 2>/dev/null || true

    docker compose -f docker/docker-compose.yml up -d --build

    # Prune dangling images left from previous builds
    docker image prune -f || true
fi

# --- Step 6a: Extract gh token from host keyring for container use ---
# gh 2.95+ stores tokens in system keyring (libsecret) on Linux.
# Container has no keyring daemon, so hosts.yml never gets the token.
# Extract via host's gh and pass as GH_TOKEN env var instead.
# gh reads GH_TOKEN natively -- no file needed.
if [ -z "${GH_TOKEN:-}" ] && command -v gh &>/dev/null; then
    GH_TOKEN_EXTRACTED=$(gh auth token 2>/dev/null || true)
    if [ -n "$GH_TOKEN_EXTRACTED" ]; then
        export GH_TOKEN="$GH_TOKEN_EXTRACTED"
        GH_USER=$(gh api user --jq '.login' 2>/dev/null || echo "?")
        echo "gh token: extracted for $GH_USER from host keyring"
    fi
    unset GH_TOKEN_EXTRACTED GH_USER
fi

# --- Step 6b: Verify gh CLI auth inside container ---------------------
REQUIRED_SCOPES=("repo" "project" "workflow")
MISSING_SCOPES=()
GH_AUTH_OUTPUT=$(docker exec ${GH_TOKEN:+-e GH_TOKEN="$GH_TOKEN"} --user agentuser cheasee-pi gh auth status 2>&1) || true
if echo "$GH_AUTH_OUTPUT" | grep -q "not logged in\|not authenticated\|auth.*required\|HTTP 401"; then
    # Check if token was extracted but still fails inside container
    if [ -n "${GH_TOKEN:-}" ]; then
        echo "Warning: gh CLI auth via GH_TOKEN failed inside container (may need container restart)."
    else
        echo "Warning: gh CLI not authenticated inside container."
        echo "  Run on your host (not in container):"
        echo "    gh auth login -s repo,project,workflow"
        echo "  Then re-run this script."
    fi
elif echo "$GH_AUTH_OUTPUT" | grep -q "Token scopes:"; then
    SCOPES_LINE=$(echo "$GH_AUTH_OUTPUT" | grep "Token scopes:")
    for scope in "${REQUIRED_SCOPES[@]}"; do
        if ! echo "$SCOPES_LINE" | grep -q "'$scope'"; then
            MISSING_SCOPES+=("$scope")
        fi
    done
    if [ ${#MISSING_SCOPES[@]} -gt 0 ]; then
        SCOPES_STR=$(
            IFS=,
            echo "${MISSING_SCOPES[*]}"
        )
        echo "Warning: gh token missing scopes: $SCOPES_STR"
        echo "  Run on your host:"
        echo "    gh auth login -s repo,project,workflow"
        echo "  Then re-run this script."
    fi
fi

# --- Step 7: Build env passthrough for docker exec ---------------------
DOCKER_ENV=""
for var in OPENAI_API_KEY ANTHROPIC_API_KEY OPENCODE_API_KEY DEEPSEEK_API_KEY GEMINI_API_KEY \
           ANT_LING_API_KEY AZURE_OPENAI_API_KEY NVIDIA_API_KEY GROQ_API_KEY \
           CEREBRAS_API_KEY XAI_API_KEY FIREWORKS_API_KEY TOGETHER_API_KEY \
           OPENROUTER_API_KEY AI_GATEWAY_API_KEY MISTRAL_API_KEY MINIMAX_API_KEY \
           MOONSHOT_API_KEY KIMI_API_KEY CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID \
           GH_TOKEN; do
    if [ -n "${!var}" ]; then
        DOCKER_ENV="$DOCKER_ENV -e $var=${!var}"
    fi
done

# --- Step 8: Ensure npm dependencies are installed ---------------------
# Extensions need proper-lockfile, typescript, shell-quote, typebox, vscode-jsonrpc
# from the workspace package.json. These are only available after npm install.
# Run it synchronously here (not relying on the entrypoint) so pi doesn't
# start before all modules are ready. Idempotent — npm is fast when nothing changed.
echo "Ensuring workspace npm dependencies…"
docker exec --user agentuser cheasee-pi \
    bash -c 'cd /workspaces/main && npm install --no-audit --no-fund' \
    || echo "Warning: npm install failed (non-fatal — extensions may not load)"

# --- Step 9: Verify all extension prerequisites are available -----------
# Checks system binaries and npm packages that extensions depend on.
# This does not abort — all errors are warnings so the session can
# still start (developers can fix missing items later).
#
# To add a new check, add an entry to one of the arrays below.
echo "Verifying extension prerequisites…"

docker exec --user agentuser cheasee-pi bash -c '
  any_missing=false

  # ── System binaries that extensions expect in PATH ──
  bins="rtk rg ast-grep python3 pip3 node npm gh git jq fd eslint prettier ctags"
  for b in $bins; do
    if ! command -v "$b" &>/dev/null; then
      echo "  ⚠️  MISSING: $b not found in PATH"
      any_missing=true
    fi
  done

  # ── npm packages from package.json that extensions import ──
  pkgs="proper-lockfile typebox shell-quote typescript vscode-jsonrpc"
  for p in $pkgs; do
    if [ ! -d "/workspaces/main/node_modules/$p" ]; then
      echo "  ⚠️  MISSING: $p not in node_modules"
      any_missing=true
    fi
  done

  if [ "$any_missing" = false ]; then
    echo "  ✓ All extension prerequisites are satisfied"
  fi
' || echo "Warning: health check could not complete"

# --- Step 9b: Sync extension packages to latest ------------------------
# Keeps packages from settings.json up to date so "Package Updates
# Available" nag never shows. Idempotent — fast when nothing changed.
echo "Syncing extension packages…"
docker exec --user agentuser cheasee-pi \
    bash -c 'cd /workspaces/main && pi update --extensions --approve 2>&1' \
    || echo "Warning: pi update --extensions failed (non-fatal)"

# --- Step 10: Launch interactive pi session ---------------------------
# Writes PID marker before exec so cleanup can distinguish active sessions
# from stale orphans (crashed/disconnected docker exec sessions).
docker exec $DOCKER_ENV -it --user agentuser cheasee-pi /bin/bash -c '
  echo $$ > /tmp/pi-active-$$
  cd /workspaces/main && clear && exec pi --approve "$@"
' --

# Cleanup: kill pi/node processes without an active PID marker file
# (exec replaced bash with pi, preserving the PID — so the marker is valid).
docker exec cheasee-pi bash -c '
  active=""
  for f in /tmp/pi-active-*; do
    [ -f "$f" ] && active="$active $(cat "$f" 2>/dev/null)"
  done
  for f in /proc/[0-9]*/comm; do
    c=$(< "$f")
    case "$c" in
      pi|node)
        pid="${f%/comm}"; pid="${pid##*/}"
        case " $active " in *" $pid "*) ;; *) kill -9 "$pid" 2>/dev/null || true ;; esac
        ;;
    esac
  done
  # Remove stale marker files (process no longer exists)
  for f in /tmp/pi-active-*; do
    [ -f "$f" ] && pid=$(cat "$f" 2>/dev/null) && ! kill -0 "$pid" 2>/dev/null && rm -f "$f" 2>/dev/null || true
  done
' 2>/dev/null || true

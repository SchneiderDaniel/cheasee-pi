#!/bin/bash
set -e

# --- Mutual exclusion: prevent concurrent instances --------------------
exec 200>/tmp/cheasee-pi.lock
flock -n 200 || {
    echo "Another cheasee-pi.sh instance is running. Waiting..."
    flock 200
}
trap 'rm -f /tmp/cheasee-pi.lock' EXIT

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

    local cpu_usage mem_usage
    cpu_usage=$(echo "$stats" | cut -d'|' -f1 | tr -d '%' | tr ',' '.')
    mem_usage=$(echo "$stats" | cut -d'|' -f2 | tr -d '%' | tr ',' '.')

    # Strip decimal for integer comparison
    local cpu_int="${cpu_usage%.*}"
    local mem_int="${mem_usage%.*}"
    [ -z "$cpu_int" ] && cpu_int=0
    [ -z "$mem_int" ] && mem_int=0

    echo ""
    echo "Container resource usage:"
    echo "  CPU:  ${cpu_usage}%"
    echo "  RAM:  ${mem_usage}%"

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

    # Build env passthrough from current shell env (fast, no auth.json parse)
    DOCKER_ENV=""
    for var in OPENAI_API_KEY ANTHROPIC_API_KEY OPENCODE_API_KEY DEEPSEEK_API_KEY GEMINI_API_KEY \
               ANT_LING_API_KEY AZURE_OPENAI_API_KEY NVIDIA_API_KEY GROQ_API_KEY \
               CEREBRAS_API_KEY XAI_API_KEY FIREWORKS_API_KEY TOGETHER_API_KEY \
               OPENROUTER_API_KEY AI_GATEWAY_API_KEY MISTRAL_API_KEY MINIMAX_API_KEY \
               MOONSHOT_API_KEY KIMI_API_KEY CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID; do
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
    echo "Starting cheasee-pi container (pi $PI_VERSION)..."
    docker compose -f docker/docker-compose.yml up -d --build
fi

# --- Step 6: Verify gh CLI auth ----------------------------------------
REQUIRED_SCOPES=("repo" "project" "workflow")
MISSING_SCOPES=()
GH_AUTH_OUTPUT=$(docker exec --user agentuser cheasee-pi gh auth status 2>&1) || true
if echo "$GH_AUTH_OUTPUT" | grep -q "not logged in\|not authenticated\|auth.*required\|HTTP 401"; then
    echo "Warning: gh CLI not authenticated inside container."
    echo "  Run on your host (not in container):"
    echo "    gh auth login -s repo,project,workflow"
    echo "  Then re-run this script."
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
           MOONSHOT_API_KEY KIMI_API_KEY CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID; do
    if [ -n "${!var}" ]; then
        DOCKER_ENV="$DOCKER_ENV -e $var=${!var}"
    fi
done

# --- Step 8: Launch interactive pi session ----------------------------
# Clear terminal to hide build/check output, then launch pi
docker exec $DOCKER_ENV -it --user agentuser cheasee-pi /bin/bash -c 'cd /workspaces/main && clear && pi --approve "$@"' --

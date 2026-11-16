#!/usr/bin/env bash
set -euo pipefail

KIT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$KIT_DIR/../.." && pwd)"

usage() {
	cat <<'EOF'
Usage: run.sh [--use-dist] [--print-command] [--help] [pi-bolt options...] [prompt]

Runs Pi-Bolt in isolated headless worker mode with a temporary
PI_CODING_AGENT_DIR populated from examples/worker/agent/ and
examples/worker/extensions/worker-guard.ts.

Options:
  --use-dist       Run packages/coding-agent/dist/cli.js directly with bun.
  --print-command  Print the resolved command and exit without running it.
  --help, -h       Show this help text and exit.

Environment:
  PI_BOLT_BIN      Override the pi-bolt binary path.
EOF
}

resolve_pi_bin() {
	if [ -n "${PI_BOLT_BIN:-}" ]; then
		printf '%s\n' "$PI_BOLT_BIN"
		return 0
	fi
	if command -v pi-bolt >/dev/null 2>&1; then
		command -v pi-bolt
		return 0
	fi
	if [ -x "$HOME/.local/bin/pi-bolt" ]; then
		printf '%s\n' "$HOME/.local/bin/pi-bolt"
		return 0
	fi
	echo "error: pi-bolt not found on PATH or at \$HOME/.local/bin/pi-bolt (set PI_BOLT_BIN)" >&2
	exit 127
}

PRINT_COMMAND=0
USE_DIST=0
HAS_MODE=0
FORWARD_ARGS=()

while [ "$#" -gt 0 ]; do
	case "$1" in
		--help|-h)
			usage
			exit 0
			;;
		--print-command)
			PRINT_COMMAND=1
			shift
			continue
			;;
		--use-dist)
			USE_DIST=1
			shift
			continue
			;;
		--)
			FORWARD_ARGS+=("$@")
			break
			;;
		--mode)
			if [ "$#" -lt 2 ] || [ -z "$2" ] || [[ "$2" == -* ]]; then
				echo "error: --mode requires a value (text, json, rpc, acp, or mcp)" >&2
				exit 2
			fi
			HAS_MODE=1
			FORWARD_ARGS+=(--mode "$2")
			shift 2
			continue
			;;
		--mode=*)
			mode_value="${1#--mode=}"
			if [ -z "$mode_value" ]; then
				echo "error: --mode requires a value (text, json, rpc, acp, or mcp)" >&2
				exit 2
			fi
			HAS_MODE=1
			FORWARD_ARGS+=(--mode "$mode_value")
			shift
			continue
			;;
	esac
	FORWARD_ARGS+=("$1")
	shift
done

TMP_AGENT=""
# shellcheck disable=SC2329
cleanup() {
	if [ -n "$TMP_AGENT" ] && [ -d "$TMP_AGENT" ]; then
		rm -rf "$TMP_AGENT"
	fi
}
trap cleanup EXIT

TMP_AGENT="$(mktemp -d "${TMPDIR:-/tmp}/pi-worker-XXXXXX")"
mkdir -p "$TMP_AGENT/extensions"
cp "$KIT_DIR/agent/models.json" "$TMP_AGENT/models.json"
cp "$KIT_DIR/agent/settings.json" "$TMP_AGENT/settings.json"
cp "$KIT_DIR/extensions/worker-guard.ts" "$TMP_AGENT/extensions/worker-guard.ts"

if [ "$USE_DIST" -eq 1 ]; then
	DIST_CLI="$REPO_ROOT/packages/coding-agent/dist/cli.js"
	if [ "$PRINT_COMMAND" -eq 0 ]; then
		if ! command -v bun >/dev/null 2>&1; then
			echo "error: bun not found on PATH (required for --use-dist)" >&2
			exit 127
		fi
		if [ ! -f "$DIST_CLI" ]; then
			echo "error: $DIST_CLI not found (build packages/coding-agent first)" >&2
			exit 1
		fi
	fi
	CMD=(
		bun
		"$DIST_CLI"
		-p
	)
else
	PI_BIN="$(resolve_pi_bin)"
	CMD=(
		"$PI_BIN"
		-p
	)
fi
if [ "$HAS_MODE" -eq 0 ]; then
	CMD+=(--mode text)
fi
CMD+=(
	--no-session
	--no-context-files
	--no-skills
	--no-prompt-templates
	--no-extensions
	-e "$TMP_AGENT/extensions/worker-guard.ts"
	--append-system-prompt "$KIT_DIR/prompt.md"
)
if [ "${#FORWARD_ARGS[@]}" -gt 0 ]; then
	CMD+=("${FORWARD_ARGS[@]}")
fi

if [ "$PRINT_COMMAND" -eq 1 ]; then
	printf 'PI_CODING_AGENT_DIR=%q ' "$TMP_AGENT"
	printf '%q ' "${CMD[@]}"
	printf '\n'
	exit 0
fi

status=0
PI_CODING_AGENT_DIR="$TMP_AGENT" "${CMD[@]}" || status=$?
exit "$status"

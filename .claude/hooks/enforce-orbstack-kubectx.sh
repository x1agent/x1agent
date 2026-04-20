#!/bin/bash
# PreToolUse guard that blocks any kubectl/helm/devspace/kubectx command
# in this project unless it is unambiguously targeting the local OrbStack
# cluster. Belt-and-suspenders on top of the env.KUBECONFIG default set
# in .claude/settings.json: catches --kubeconfig= overrides,
# `kubectl config use-context <other>`, and anything that explicitly
# flips the active kube target.
#
# Exits 0 = allow, 2 = block (Claude sees the stderr and won't retry).

set -euo pipefail

INPUT="$(cat)"

TOOL_NAME="$(printf '%s' "$INPUT" | /usr/bin/jq -r '.tool_name // empty' 2>/dev/null || true)"
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

CMD="$(printf '%s' "$INPUT" | /usr/bin/jq -r '.tool_input.command // empty' 2>/dev/null || true)"
if [[ -z "$CMD" ]]; then
  exit 0
fi

ALLOWED_KCFG="${HOME}/.orbstack/k8s/config.yml"

reject() {
  echo "BLOCKED by .claude/hooks/enforce-orbstack-kubectx.sh: $1" >&2
  echo "Allowed kubeconfig: $ALLOWED_KCFG (orbstack only)" >&2
  echo "If you need a different cluster, run it outside this project." >&2
  exit 2
}

# --- Normalize the command for inspection ---
# 1. Strip heredoc bodies so example text inside git commit messages,
#    README writes, etc. isn't matched against.
# 2. Strip single- and double-quoted strings for the same reason.
# What's left is the "executable" shape of the command.
normalize() {
  python3 - "$1" <<'PY'
import re, sys
s = sys.argv[1]
# Strip heredocs: <<'DELIM' ... DELIM and <<DELIM ... DELIM (also <<-)
s = re.sub(r"<<-?\s*'([^']+)'(.*?)\n\1", "", s, flags=re.DOTALL)
s = re.sub(r'<<-?\s*"([^"]+)"(.*?)\n\2', "", s, flags=re.DOTALL)
s = re.sub(r"<<-?\s*([A-Za-z_][A-Za-z0-9_]*)(.*?)\n\1", "", s, flags=re.DOTALL)
# Strip single-quoted strings
s = re.sub(r"'[^']*'", "''", s)
# Strip double-quoted strings (simple; not shell-perfect but good enough)
s = re.sub(r'"(?:[^"\\]|\\.)*"', '""', s)
print(s)
PY
}

NORM="$(normalize "$CMD" 2>/dev/null || printf '%s' "$CMD")"

# Short-circuit if the normalized command doesn't mention any
# cluster-facing tool as a command word.
TOOL_RE='(^|[[:space:]]|;|\||&|\()(kubectl|kubectx|kubens|helm|devspace|skaffold|tilt)([[:space:]]|$|/)'
if ! printf '%s' "$NORM" | grep -qE "$TOOL_RE"; then
  exit 0
fi

# --- Rule 1: explicit --kubeconfig / --context flags ---
if printf '%s' "$NORM" | grep -qE -- '--kubeconfig[= ][^ ]*'; then
  KCFG_ARG="$(printf '%s' "$NORM" | sed -nE 's/.*--kubeconfig[= ]([^ ]+).*/\1/p' | head -1)"
  if [[ "$KCFG_ARG" != "$ALLOWED_KCFG" ]]; then
    reject "explicit --kubeconfig=$KCFG_ARG is not the orbstack config"
  fi
fi

if printf '%s' "$NORM" | grep -qE -- '--context[= ][^ ]+'; then
  CTX_ARG="$(printf '%s' "$NORM" | sed -nE 's/.*--context[= ]([^ ]+).*/\1/p' | head -1)"
  if [[ "$CTX_ARG" != "orbstack" ]]; then
    reject "explicit --context=$CTX_ARG is not orbstack"
  fi
fi

# --- Rule 2: config use-context / kubectx flipping the active target ---
if printf '%s' "$NORM" | grep -qE '(kubectl config use-context|kubectx)[[:space:]]+[^[:space:]]+'; then
  TARGET="$(printf '%s' "$NORM" | sed -nE 's/.*(kubectl config use-context|kubectx)[[:space:]]+([^[:space:]&;|]+).*/\2/p' | head -1)"
  if [[ "$TARGET" != "orbstack" ]]; then
    reject "attempted context switch to '$TARGET' — only 'orbstack' is allowed here"
  fi
fi

# --- Rule 3: effective KUBECONFIG must be the orbstack file ---
EFFECTIVE_KCFG="${KUBECONFIG:-$HOME/.kube/config}"
if [[ "$EFFECTIVE_KCFG" != "$ALLOWED_KCFG" ]]; then
  reject "KUBECONFIG=$EFFECTIVE_KCFG is not the orbstack config; .claude/settings.json env should have set this to $ALLOWED_KCFG"
fi

exit 0

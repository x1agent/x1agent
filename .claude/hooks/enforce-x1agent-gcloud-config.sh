#!/bin/bash
# PreToolUse guard that blocks any gcloud / gsutil / bq / firebase command
# in this project unless it is unambiguously targeting the x1agent
# gcloud configuration. Belt-and-suspenders on top of the
# CLOUDSDK_ACTIVE_CONFIG_NAME env in .claude/settings.json: catches
# --configuration=, --project=, --account= overrides that would silently
# swap to a different account or GCP project.
#
# The expected configuration name is the literal "x1agent". The user
# creates it once via:
#   gcloud config configurations create x1agent
#   gcloud config configurations activate x1agent
#   gcloud config set account c.toivola@gmail.com
#   gcloud config set project <x1agent-gcp-project-id>
#
# The actual account email + project ID stay in the local gcloud
# configuration file (~/.config/gcloud/configurations/config_x1agent),
# never in this repo.
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

ALLOWED_CONFIG="x1agent"
ALLOWED_ACCOUNT_DOMAIN="gmail.com"   # informational only; not enforced

reject() {
  echo "BLOCKED by .claude/hooks/enforce-x1agent-gcloud-config.sh: $1" >&2
  echo "Allowed gcloud configuration: $ALLOWED_CONFIG" >&2
  echo "If you need a different project, run it outside this directory." >&2
  exit 2
}

# --- Normalize the command for inspection ---
# Same approach as the kubectl hook: strip heredocs and quoted strings
# so example text (commit messages, README writes) doesn't false-trip.
normalize() {
  python3 - "$1" <<'PY'
import re, sys
s = sys.argv[1]
s = re.sub(r"<<-?\s*'([^']+)'(.*?)\n\1", "", s, flags=re.DOTALL)
s = re.sub(r'<<-?\s*"([^"]+)"(.*?)\n\2', "", s, flags=re.DOTALL)
s = re.sub(r"<<-?\s*([A-Za-z_][A-Za-z0-9_]*)(.*?)\n\1", "", s, flags=re.DOTALL)
s = re.sub(r"'[^']*'", "''", s)
s = re.sub(r'"(?:[^"\\]|\\.)*"', '""', s)
print(s)
PY
}

NORM="$(normalize "$CMD" 2>/dev/null || printf '%s' "$CMD")"

# Short-circuit if the command doesn't invoke any GCP-facing tool.
TOOL_RE='(^|[[:space:]]|;|\||&|\()(gcloud|gsutil|bq|firebase)([[:space:]]|$|/)'
if ! printf '%s' "$NORM" | grep -qE "$TOOL_RE"; then
  exit 0
fi

# --- Rule 1: no explicit configuration override to a different name ---
if printf '%s' "$NORM" | grep -qE -- '--configuration[= ][^ ]+'; then
  CFG_ARG="$(printf '%s' "$NORM" | sed -nE 's/.*--configuration[= ]([^ ]+).*/\1/p' | head -1)"
  if [[ "$CFG_ARG" != "$ALLOWED_CONFIG" ]]; then
    reject "explicit --configuration=$CFG_ARG is not '$ALLOWED_CONFIG'"
  fi
fi

# --- Rule 2: gcloud config configurations activate <other> is forbidden ---
# Switching the active configuration on the filesystem persists across
# shells and breaks the assumption other tooling relies on.
if printf '%s' "$NORM" | grep -qE 'gcloud[[:space:]]+config[[:space:]]+configurations[[:space:]]+activate[[:space:]]+[^[:space:]]+'; then
  TARGET="$(printf '%s' "$NORM" | sed -nE 's/.*gcloud[[:space:]]+config[[:space:]]+configurations[[:space:]]+activate[[:space:]]+([^[:space:]&;|]+).*/\1/p' | head -1)"
  if [[ "$TARGET" != "$ALLOWED_CONFIG" ]]; then
    reject "attempted 'gcloud config configurations activate $TARGET' — only '$ALLOWED_CONFIG' is allowed here"
  fi
fi

# --- Rule 3: gcloud config configurations delete x1agent is forbidden ---
if printf '%s' "$NORM" | grep -qE "gcloud[[:space:]]+config[[:space:]]+configurations[[:space:]]+delete[[:space:]]+$ALLOWED_CONFIG([[:space:]]|$|;|&|\|)"; then
  reject "refusing to delete the '$ALLOWED_CONFIG' gcloud configuration from this directory"
fi

# --- Rule 4: --project=<other> on a gcloud/gsutil/bq command ---
# Allowed only if it matches the configuration's bound project. We can't
# read the project from inside the hook without forking gcloud (slow), so
# instead we forbid setting --project explicitly. The configuration's
# bound project is the source of truth.
if printf '%s' "$NORM" | grep -qE -- '--project[= ][^ ]+'; then
  PROJ_ARG="$(printf '%s' "$NORM" | sed -nE 's/.*--project[= ]([^ ]+).*/\1/p' | head -1)"
  EXPECTED_PROJECT="${X1AGENT_GCLOUD_PROJECT:-}"
  if [[ -n "$EXPECTED_PROJECT" ]]; then
    if [[ "$PROJ_ARG" != "$EXPECTED_PROJECT" ]]; then
      reject "explicit --project=$PROJ_ARG does not match X1AGENT_GCLOUD_PROJECT=$EXPECTED_PROJECT"
    fi
  else
    reject "explicit --project=$PROJ_ARG: set X1AGENT_GCLOUD_PROJECT in .env.local to whitelist a project, or drop the flag and let configuration '$ALLOWED_CONFIG' supply it"
  fi
fi

# --- Rule 5: --account=<other> ---
# Same rationale as project. The configuration owns the binding.
if printf '%s' "$NORM" | grep -qE -- '--account[= ][^ ]+'; then
  ACCT_ARG="$(printf '%s' "$NORM" | sed -nE 's/.*--account[= ]([^ ]+).*/\1/p' | head -1)"
  EXPECTED_ACCOUNT="${X1AGENT_GCLOUD_ACCOUNT:-}"
  if [[ -n "$EXPECTED_ACCOUNT" ]]; then
    if [[ "$ACCT_ARG" != "$EXPECTED_ACCOUNT" ]]; then
      reject "explicit --account=$ACCT_ARG does not match X1AGENT_GCLOUD_ACCOUNT=$EXPECTED_ACCOUNT"
    fi
  else
    reject "explicit --account=$ACCT_ARG: set X1AGENT_GCLOUD_ACCOUNT in .env.local to whitelist an account, or drop the flag and let configuration '$ALLOWED_CONFIG' supply it"
  fi
fi

# --- Rule 6: effective CLOUDSDK_ACTIVE_CONFIG_NAME must be x1agent ---
# Mirrors the kubectl hook's KUBECONFIG check. .claude/settings.json env
# block sets this; if it's been unset or pointed elsewhere, refuse.
EFFECTIVE_CFG="${CLOUDSDK_ACTIVE_CONFIG_NAME:-}"
if [[ -z "$EFFECTIVE_CFG" ]]; then
  reject "CLOUDSDK_ACTIVE_CONFIG_NAME is unset; .claude/settings.json env should have set it to '$ALLOWED_CONFIG'"
fi
if [[ "$EFFECTIVE_CFG" != "$ALLOWED_CONFIG" ]]; then
  reject "CLOUDSDK_ACTIVE_CONFIG_NAME=$EFFECTIVE_CFG is not '$ALLOWED_CONFIG'"
fi

exit 0

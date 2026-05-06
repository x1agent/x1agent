#!/usr/bin/env bash
# Probe every mcp_url in the curated seed list and report status.
# Same logic as .github/workflows/mcp-url-liveness.yml, runnable
# locally for spot-checks.
#
#   ./deploy/scripts/probe-mcp-urls.sh
#
# Exit code: 0 if every URL responds 200/401/403/405 (alive); 1 if
# any URL is dead (404/410/5xx/DNS).

set -euo pipefail

SEED="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/packages/app/src/features/mcp/seed.ts"
if [[ ! -f "$SEED" ]]; then
  echo "[probe-mcp] seed file not found: $SEED" >&2
  exit 2
fi

urls=$(grep -E '^\s+mcp_url:\s*"https?://' "$SEED" \
  | sed -E 's/.*mcp_url:\s*"([^"]+)".*/\1/')

dead=()
for u in $urls; do
  code=$(curl -sIL --max-time 10 -o /dev/null -w "%{http_code}" "$u" || echo "000")
  case "$code" in
    200|401|403|405) printf "  alive  %-3s  %s\n" "$code" "$u" ;;
    *)               printf "  DEAD   %-3s  %s\n" "$code" "$u" ; dead+=("$u (HTTP $code)") ;;
  esac
done

if [[ ${#dead[@]} -gt 0 ]]; then
  echo
  echo "[probe-mcp] ${#dead[@]} dead URL(s):" >&2
  for d in "${dead[@]}"; do echo "  - $d" >&2; done
  exit 1
fi
echo
echo "[probe-mcp] all URLs alive."

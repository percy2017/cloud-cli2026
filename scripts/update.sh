#!/usr/bin/env bash
# scripts/update.sh — single source of truth for "git pull" on the VPS.
#
# Background: this project pins Node 22 (`/opt/node22/bin/node`) while the
# host's `/usr/bin/node` is Node 24. PM2 already runs the server with Node 22
# via `ecosystem.config.cjs#exec_interpreter`, but `npm install` from a normal
# shell picks up Node 24 from PATH and recompiles every native module
# (better-sqlite3, node-pty, bcrypt, sharp) against the Node 24 ABI. PM2 then
# crashes on `dlopen` with ERR_DLOPEN_FAILED.
#
# This script forces /opt/node22/bin to the front of PATH and `cd`'s into the
# project root before running anything npm/git-related, so the natives stay
# aligned with the runtime no matter who shells in.
#
# Usage:
#   ./scripts/update.sh              # git pull + npm ci + rebuild + restart
#   ./scripts/update.sh --no-pull    # skip git pull (local edits)
#   ./scripts/update.sh --no-build   # skip dist rebuild
#   ./scripts/update.sh --no-restart # leave PM2 alone
#   ./scripts/update.sh --hard       # blow away node_modules before ci
#
# Exits non-zero on any failed step so a cron / CI caller can detect.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Resolve project root and the pinned Node binary.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd)"

# Honor an explicit override, then fall back to the .env pin, then a hard-coded
# default. We don't trust the caller's `node` because that's the whole point
# of this script.
if [[ -n "${NODE_BINARY:-}" ]]; then
  PINNED_NODE="$NODE_BINARY"
elif [[ -f "$PROJECT_ROOT/.env" ]] && grep -qE '^NODE_BINARY=' "$PROJECT_ROOT/.env"; then
  PINNED_NODE="$(grep -E '^NODE_BINARY=' "$PROJECT_ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
else
  PINNED_NODE="/opt/node22/bin/node"
fi

# Pull the bin dir out of the pinned binary so npm and node-gyp use the same
# Node ABI as the PM2 runtime.
PINNED_BIN_DIR="$(dirname -- "$PINNED_NODE")"

if [[ ! -x "$PINNED_NODE" ]]; then
  echo "✗ Pinned Node not found or not executable: $PINNED_NODE"
  echo "  Set NODE_BINARY in .env or export NODE_BINARY=/path/to/node-22 and retry."
  exit 1
fi

# This is the critical line. Everything below sees Node 22 + its npm + its
# node-gyp, regardless of the caller's PATH.
export PATH="$PINNED_BIN_DIR:$PATH"
export NODE_BINARY="$PINNED_NODE"

# ---------------------------------------------------------------------------
# 1. Parse flags.
# ---------------------------------------------------------------------------
DO_PULL=1
DO_BUILD=1
DO_RESTART=1
HARD_RESET=0
for arg in "$@"; do
  case "$arg" in
    --no-pull)     DO_PULL=0 ;;
    --no-build)    DO_BUILD=0 ;;
    --no-restart)  DO_RESTART=0 ;;
    --hard)        HARD_RESET=1 ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "✗ Unknown flag: $arg"
      echo "  Use --no-pull | --no-build | --no-restart | --hard | --help"
      exit 1
      ;;
  esac
done

cd "$PROJECT_ROOT"

echo "═══════════════════════════════════════════════════════════════"
echo "  CloudCLI update — project root: $PROJECT_ROOT"
echo "  Pinned Node:   $PINNED_NODE ($("$PINNED_NODE" -v))"
echo "  npm:           $(npm -v)"
echo "  PATH head:     $(echo "$PATH" | tr ':' '\n' | head -3 | tr '\n' ' ' | sed 's/ $//')"
echo "═══════════════════════════════════════════════════════════════"

# ---------------------------------------------------------------------------
# 2. Sanity check the system node at login so we fail loud and early.
# ---------------------------------------------------------------------------
SYSTEM_NODE="$(command -v node || true)"
if [[ -n "$SYSTEM_NODE" && "$SYSTEM_NODE" != "$PINNED_NODE" ]]; then
  SYSTEM_VER="$("$SYSTEM_NODE" -v 2>/dev/null || echo unknown)"
  echo ""
  echo "  ⚠ Detected system Node at: $SYSTEM_NODE ($SYSTEM_VER)"
  echo "    The system node is NOT on PATH for this script — npm and node-gyp"
  echo "    below will use $PINNED_NODE only. Verify with 'which node' after."
fi

# ---------------------------------------------------------------------------
# 3. (optional) git pull
# ---------------------------------------------------------------------------
if [[ "$DO_PULL" -eq 1 ]]; then
  if [[ -d .git ]]; then
    echo ""
    echo "→ git pull"
    git pull --rebase --autostash
  else
    echo ""
    echo "→ not a git checkout — skipping pull (use --no-pull to silence)"
  fi
fi

# ---------------------------------------------------------------------------
# 4. (optional) hard reset node_modules
# ---------------------------------------------------------------------------
if [[ "$HARD_RESET" -eq 1 ]]; then
  echo ""
  echo "→ hard reset: rm -rf node_modules"
  rm -rf node_modules
fi

# ---------------------------------------------------------------------------
# 5. npm ci. Uses lockfile, doesn't touch package.json — what you committed is
#    what you get. Triggers postinstall (fix-server-native-modules.js) which
#    rebuilds natives against the pinned Node.
# ---------------------------------------------------------------------------
if [[ -f package-lock.json ]]; then
  echo ""
  echo "→ npm ci"
  npm ci --no-audit --no-fund
else
  echo ""
  echo "→ npm install (no lockfile found — package-lock.json is missing)"
  npm install --no-audit --no-fund
fi

# ---------------------------------------------------------------------------
# 6. Belt-and-suspenders: explicitly run the native-module fix in case the
#    postinstall hook got skipped (e.g. NPM_CONFIG_IGNORE_SCRIPTS=true).
# ---------------------------------------------------------------------------
echo ""
echo "→ npm run fix:native (explicit, in case postinstall was skipped)"
npm run fix:native --silent

# ---------------------------------------------------------------------------
# 7. (optional) build
# ---------------------------------------------------------------------------
if [[ "$DO_BUILD" -eq 1 ]]; then
  echo ""
  echo "→ npm run build"
  npm run build
fi

# ---------------------------------------------------------------------------
# 8. (optional) pm2 restart + health check
# ---------------------------------------------------------------------------
if [[ "$DO_RESTART" -eq 1 ]]; then
  echo ""
  echo "→ pm2 restart cloud-cli2026"
  pm2 restart cloud-cli2026
  # Give the server a moment to bind its port.
  sleep 2

  # Health check — read SERVER_PORT from .env, fall back to 3030/3333.
  PORT=3030
  if [[ -f .env ]] && grep -qE '^SERVER_PORT=' .env; then
    PORT="$(grep -E '^SERVER_PORT=' .env | head -1 | cut -d= -f2- | tr -d ' ' | head -1)"
  fi
  echo ""
  echo "→ health check on http://127.0.0.1:${PORT}/health"
  HTTP_CODE="$(curl -s -o /tmp/cloudcli-health.json -w '%{http_code}' "http://127.0.0.1:${PORT}/health" || echo 000)"
  if [[ "$HTTP_CODE" == "200" ]]; then
    echo "  ✓ HTTP 200 — $(cat /tmp/cloudcli-health.json)"
  else
    echo "  ✗ HTTP $HTTP_CODE — server did not come up healthy"
    echo "  Last 30 error log lines:"
    tail -30 /root/.pm2/logs/cloud-cli2026-error-*.log 2>/dev/null | tail -30 | sed 's/^/    /'
    exit 1
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✓ Update complete"
echo "═══════════════════════════════════════════════════════════════"

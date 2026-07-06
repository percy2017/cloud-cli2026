#!/usr/bin/env bash
#
# Recompile native module bindings for installed plugins.
# Wrapper around scripts/fix-plugin-native-modules.js for shell callers.
#
# Usage:
#   ./scripts/fix-plugin-native-modules.sh              # rebuild all plugins
#   ./scripts/fix-plugin-native-modules.sh web-terminal # rebuild one plugin
#   ./scripts/fix-plugin-native-modules.sh --dry-run    # show what would run
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/fix-plugin-native-modules.js" "$@"
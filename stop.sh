#!/bin/zsh
#
# Stop the adapter and unload the launchd job so KeepAlive cannot resurrect it.
set -euo pipefail

label="com.codex.responses-adapter"

if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
  echo "adapter stopped (${label})"
else
  echo "${label} is not loaded"
fi

remaining="$(lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${remaining}" ]]; then
  echo "warning: port 8787 is still held by PID(s): ${remaining}" >&2
fi

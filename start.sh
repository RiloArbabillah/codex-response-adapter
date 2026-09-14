#!/bin/zsh
#
# Start (or restart) the adapter through launchd. This never starts a second
# copy: an orphan node process holding port 8787 is what caused the
# EADDRINUSE restart storm that filled launchd.stderr.log.
set -euo pipefail

adapter_dir="${0:A:h}"
label="com.codex.responses-adapter"
plist="${HOME}/Library/LaunchAgents/${label}.plist"

if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/${label}"
else
  launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "${plist}" >/dev/null 2>&1 || launchctl load -w "${plist}"
fi

for _ in {1..30}; do
  if curl -fsS --max-time 1 http://127.0.0.1:8787/health >/dev/null 2>&1; then
    echo "adapter ready on http://127.0.0.1:8787 (${label})"
    exit 0
  fi
  sleep 0.2
done

echo "adapter failed to become healthy; see ${adapter_dir}/launchd.stderr.log" >&2
exit 1

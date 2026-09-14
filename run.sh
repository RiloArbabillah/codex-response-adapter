#!/bin/zsh
#
# Launchd entrypoint: rotate oversized logs, then exec the adapter so the
# process keeps its own exit codes (and no orphan nohup copy of the server).
set -euo pipefail

adapter_dir="${0:A:h}"
max_bytes=$(( ${CODEX_ADAPTER_LOG_MAX_MB:-32} * 1024 * 1024 ))

# Rotating before exec re-opens the log files below, so launchd's inherited
# descriptors never keep writing into the rotated file.
for name in launchd.stdout.log launchd.stderr.log; do
  target="${adapter_dir}/${name}"
  [[ -f "${target}" ]] || continue
  size="$(stat -f%z "${target}" 2>/dev/null || echo 0)"
  if (( size > max_bytes )); then
    mv -f "${target}.1" "${target}.2" 2>/dev/null || true
    mv -f "${target}" "${target}.1"
  fi
done

node_bin="${CODEX_ADAPTER_NODE:-/Users/macbook/.local/bin/node}"
if [[ ! -x "${node_bin}" ]]; then
  node_bin="$(command -v node)"
fi

exec "${node_bin}" "${adapter_dir}/server.mjs" \
  >>"${adapter_dir}/launchd.stdout.log" \
  2>>"${adapter_dir}/launchd.stderr.log"

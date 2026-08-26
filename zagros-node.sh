#!/usr/bin/env bash
set -Eeuo pipefail
[[ ${EUID:-$(id -u)} == 0 ]] || { echo "run as root" >&2; exit 1; }
url=${ZAGROS_NODE_CLI_URL:-https://raw.githubusercontent.com/ZagrosGM/zagros-scripts/main/zagros-node}
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"
install -m 0755 "$tmp" /usr/local/bin/zagros-node
exec /usr/local/bin/zagros-node "${@:-help}"

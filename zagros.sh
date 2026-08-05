#!/usr/bin/env bash
# =============================================================================
#  Zagros — one-command installer bootstrap
#
#  Usage:
#    sudo bash -c "$(curl -fsSL \
#      https://raw.githubusercontent.com/ZagrosGM/zagros-scripts/main/zagros.sh)" \
#      -- install [--database sqlite|mysql|mariadb|postgresql] [--version <tag>]
#
#  This file is intentionally thin: it fetches the full management CLI
#  (`zagros`) matching the requested source ref and hands control to it, so
#  ALL logic lives in one place (`zagros`), versioned and testable.
#
#  Environment overrides:
#    ZAGROS_SCRIPTS_REF   git ref (branch/tag/sha) of zagros-scripts to use
# =============================================================================
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/ZagrosGM/zagros-scripts"
REF="${ZAGROS_SCRIPTS_REF:-main}"

err() { printf '\033[0;31m[✗]\033[0m %s\n' "$*" >&2; exit 1; } \
    2>/dev/null || { printf '[x] %s\n' "$*" >&2; exit 1; }
inf() { printf '\033[0;34m[*]\033[0m %s\n' "$*" 2>/dev/null || printf '[*] %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || err "run as root: sudo bash -c \"\$(curl -fsSL $REPO_RAW/$REF/zagros.sh)\" -- install"
command -v curl >/dev/null 2>&1 || err "'curl' is required (apt/dnf/yum install curl)"

command="${1:-install}"
[[ $# -gt 0 ]] && shift
case "$command" in install) ;; uninstall) ;; *) err "usage: ... -- install|uninstall [options]" ;; esac

tmp="$(mktemp /tmp/zagros-cli.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

inf "Fetching the Zagros CLI (ref: $REF)"
curl -fsSL "$REPO_RAW/$REF/zagros" -o "$tmp" || err "could not download the CLI from $REPO_RAW/$REF/zagros"
chmod 0755 "$tmp"

# ZAGROS_CLI_SELF lets the installer copy exactly this downloaded file into
# place instead of fetching it again.
export ZAGROS_CLI_SELF="$tmp"
exec "$tmp" "$command" "$@"

#!/usr/bin/env bash
# =============================================================================
#  Zagros — one-command installer bootstrap
#
#  Usage:
#    sudo bash -c "$(curl -fsSL \
#      https://raw.githubusercontent.com/ZagrosGM/zagros-scripts/main/zagros.sh)" \
#      -- install [--database sqlite|mysql|mariadb|postgresql] [--version <tag>]
#    sudo bash -c "$(curl -fsSL <this-url>)" -- update [--version <tag>]
#
#  Without --version the panel runs the floating `latest` image tag, which
#  the release workflow moves on every stable release; `--version vX.Y.Z`
#  pins one release.
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

# NB: a redirection on a function *definition* applies to its body, so the
# old `err() { … } 2>/dev/null` silently threw away every error this script
# prints — including "run as root". Colour is chosen once, not per call.
if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
    C_ERR=$'\033[0;31m'; C_INF=$'\033[0;34m'; C_OFF=$'\033[0m'
else
    C_ERR=""; C_INF=""; C_OFF=""
fi
err() { printf '%s[✗]%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }
inf() { printf '%s[*]%s %s\n' "$C_INF" "$C_OFF" "$*"; }

[[ "$(id -u)" -eq 0 ]] || err "run as root: sudo bash -c \"\$(curl -fsSL $REPO_RAW/$REF/zagros.sh)\" -- install"
command -v curl >/dev/null 2>&1 || err "'curl' is required (apt/dnf/yum install curl)"

command="${1:-install}"
[[ $# -gt 0 ]] && shift
case "$command" in install|update|uninstall) ;; *) err "usage: ... -- install|update|uninstall [options]" ;; esac

tmp="$(mktemp /tmp/zagros-cli.XXXXXX)"
trap 'rm -f "$tmp"' EXIT

inf "Fetching the Zagros CLI (ref: $REF)"
curl -fsSL "$REPO_RAW/$REF/zagros" -o "$tmp" || err "could not download the CLI from $REPO_RAW/$REF/zagros"
chmod 0755 "$tmp"

# ZAGROS_CLI_SELF lets the installer copy exactly this downloaded file into
# place instead of fetching it again.
export ZAGROS_CLI_SELF="$tmp"
"$tmp" "$command" "$@"

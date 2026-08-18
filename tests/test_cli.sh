#!/usr/bin/env bash
# =============================================================================
#  Zagros CLI — end-to-end logic tests against a faithful Docker test double
#
#  WHAT THIS TESTS: the real `zagros` CLI (and `zagros.sh` bootstrap) — every
#  command's argument handling, state transitions, backup/restore integrity,
#  update + rollback semantics, env rendering, JSON consumption of hostctl.
#
#  WHAT IT DOES NOT TEST: real containers pulling/running on a real VPS with
#  the real hostctl inside the real image (that is a separate environment
#  step; the Python pytest suite tests hostctl itself against the real code).
#
#  The double (tests/faked/docker) mirrors docker + compose + hostctl
#  semantics; tests/faked/curl serves the two repo scripts from the LOCAL
#  checkout while passing all other URLs to the real network.
# =============================================================================
set -u
cd "$(dirname "$0")/.." || exit 1
REPO_ROOT="$(pwd)"
export ZAGROS_TESTS_REPO_ROOT="$REPO_ROOT"

T="$(mktemp -d /tmp/zagros-cli-tests.XXXXXX)"
trap 'if (( FAIL == 0 )); then rm -rf "$T"; else printf "%s\n" "NOTE: failed run kept at $T" >&2; fi' EXIT
LOGD="$T/logs"; mkdir -p "$LOGD"

export ZAGROS_HOME="$T/opt/zagros"
export ZAGROS_DATA="$T/var/lib/zagros"
export ZAGROS_BIN="$T/bin"
export ZAGROS_LIBEXEC="$T/libexec"
export FAKE_DOCKER_STATE="$T/faked-state"
export ZAGROS_ETC="$T/etc/zagros"
export SYSTEMD_DIR="$T/systemd"
export CRON_D_DIR="$T/cron.d"
export NO_COLOR=1
export ASSUME_YES=1
export PATH="$REPO_ROOT/tests/faked:$PATH"

CLI="$REPO_ROOT/zagros"
IMAGE_REPO="ghcr.io/zagrosgm/zagros"
SH="$REPO_ROOT/zagros.sh"

PASS=0; FAIL=0; FAILED_NAMES=()
LAST_OUT=""; LAST_RC=0

run() {  # run <cmd...> → LAST_OUT / LAST_RC
    LAST_OUT="$("$@" 2>&1)"; LAST_RC=$?
    printf '=== %s (rc=%s)\n%s\n' "$*" "$LAST_RC" "$LAST_OUT" >> "$LOGD/full.log"
    return 0
}
ok()    { PASS=$((PASS+1)); printf 'ok   %-58s %s\n' "$1" "${2:-}"; }
bad()   { FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); printf 'FAIL %-58s %s\n' "$1" "${2:-}"; }
expect_rc() { # expect_rc <name> <rc> <detail?>
    local name="$1" want="$2" detail="${3:-}"
    if [[ "$LAST_RC" == "$want" ]]; then ok "$name" "$detail";
    else bad "$name" "rc=$LAST_RC want=$want :: $(printf '%s' "$LAST_OUT" | tail -n 3 | tr '\n' '|')"; fi
}
expect_out() { # expect_out <name> <substring>
    if printf '%s' "$LAST_OUT" | grep -qF -- "$2"; then ok "$1" "contains: $2";
    else bad "$1" "missing [$2] in: $(printf '%s' "$LAST_OUT" | tail -n 4 | tr '\n' '|')"; fi
}
expect_file() { [[ -e "$1" ]] && ok "$2" "$1" || bad "$2" "missing file $1"; }
expect_no_file() { [[ ! -e "$1" ]] && ok "$2" || bad "$2" "unexpected file $1"; }

reset_fake() {  # reset_fake — wipe fake docker state between scenarios
    rm -rf "$FAKE_DOCKER_STATE"; mkdir -p "$FAKE_DOCKER_STATE"
    unset FAKE_HEALTHY FAKE_DB_UPTODATE FAKE_ALEMBIC_OK FAKE_COMPOSE_PULL_OK
}

say() { printf '\n== %s\n' "$*"; }

# ----------------------------------------------------------------------------- #
say "t01 help / dispatcher / exit codes"
run bash "$CLI" help;            expect_rc "help exits 0" 0
expect_out "help lists commands" "Service lifecycle:"
run bash "$CLI" definitely-not-a-command; expect_rc "unknown command exits 2" 2
expect_out "unknown command message" "unknown command"
run bash "$SH" not-a-command;     expect_rc "bootstrap rejects unknown command" 1
PATH="/usr/bin:/bin" run bash "$SH" install; expect_rc "bootstrap demands root" 1

# ----------------------------------------------------------------------------- #
say "t02 version_gt unit semantics"
eval "$(awk '/^version_gt\(\)/,/^}/' "$CLI")"
version_gt 1.2.10 1.2.3          && ok "version_gt 1.2.10 > 1.2.3" || bad "version_gt 1.2.10 > 1.2.3"
version_gt v1.1.0 v1.0.9         && ok "version_gt v1.1.0 > v1.0.9" || bad "version_gt v1.1.0 > v1.0.9"
version_gt 1.0.1-alpha.2 1.0.1-alpha.1 && ok "version_gt alpha.2 > alpha.1" || bad "version_gt alpha.2 > alpha.1"
version_gt 1.0.0 1.0.0           && bad "version_gt equal is false" || ok "version_gt equal is false"
version_gt 1.0.0 1.0.1           && bad "version_gt lower is false" || ok "version_gt lower is false"

# ----------------------------------------------------------------------------- #
say "t03 bootstrap one-liner install (sqlite)"
reset_fake
run bash "$SH" install
expect_rc "bootstrap install rc0" 0
expect_out "install prints next steps" "Next steps:"
expect_file "$ZAGROS_HOME/docker-compose.yml" "compose file written"
expect_file "$ZAGROS_HOME/.env" ".env file written"
expect_no_file "$ZAGROS_HOME/zagros.env" "no legacy zagros.env written"
expect_file "$ZAGROS_HOME/.state/install.json" "install state recorded"
expect_file "$ZAGROS_BIN/zagros" "CLI installed to ZAGROS_BIN"
[[ "$(stat -c %a "$ZAGROS_HOME/.env")" == "600" ]] && ok ".env file is 0600" || bad ".env file is 0600"
expect_out "docker compose up ran" ""   # noop marker
grep -q 'image: ghcr.io/zagrosgm/zagros:${ZAGROS_IMAGE_TAG:-latest}' "$ZAGROS_HOME/docker-compose.yml" \
    && ok "compose image tag is env-interpolated" || bad "compose image tag is env-interpolated"
# config contract: mount-only, NO env injection on the panel service
grep -q './.env:/code/.env:ro' "$ZAGROS_HOME/docker-compose.yml" \
    && ok "compose mounts ./.env -> /code/.env (ro)" || bad "compose mounts ./.env -> /code/.env (ro)"
# TUN cores (OpenVPN/WireGuard) run inside this container: they need the
# tunnel device + NET_ADMIN or their Start dies at interface creation (the
# alpha.7 field reports: openvpn management unreachable, wg-quick failing)
grep -qE '^\s+- NET_ADMIN$' "$ZAGROS_HOME/docker-compose.yml" \
    && ok "compose grants NET_ADMIN for TUN cores" || bad "compose grants NET_ADMIN for TUN cores"
grep -q '/dev/net/tun:/dev/net/tun' "$ZAGROS_HOME/docker-compose.yml" \
    && ok "compose passes /dev/net/tun device" || bad "compose passes /dev/net/tun device"
grep -q 'env_file:' "$ZAGROS_HOME/docker-compose.yml" \
    && bad "panel service has NO env_file injection" || ok "panel service has NO env_file injection"
grep -q "open('/code/.env'" "$ZAGROS_HOME/docker-compose.yml" \
    && ok "healthcheck reads UVICORN_PORT from the mounted file" \
    || bad "healthcheck reads UVICORN_PORT from the mounted file"
grep -qE '^UVICORN_HOST=0.0.0.0$' "$ZAGROS_HOME/.env" \
    && ok "bind host 0.0.0.0 in .env" || bad "bind host 0.0.0.0 in .env"
grep -qE '^TLS_MODE=auto$' "$ZAGROS_HOME/.env" \
    && ok "TLS_MODE=auto default in .env" || bad "TLS_MODE=auto default in .env"
grep -qE '^XRAY_JSON=/var/lib/zagros/cores/xray/xray_config.json$' "$ZAGROS_HOME/.env" \
    && ok "Xray config uses persistent mounted path" || bad "Xray config uses persistent mounted path"
grep -qE '^XRAY_EXECUTABLE_PATH=/var/lib/zagros/cores/xray/bin/xray$' "$ZAGROS_HOME/.env" \
    && ok "Xray binary uses persistent mounted path" || bad "Xray binary uses persistent mounted path"
grep -qE '^ZAGROS_IMAGE_TAG=(v[0-9]|latest$)' "$ZAGROS_HOME/.env" \
    && ok "env carries resolved tag or documented 'latest' fallback (GitHub API may be rate-limited)" \
    || bad "env carries resolved release tag"
grep -qE '^ZAGROS_DATABASE_URL=sqlite:////var/lib/zagros/zagros.db$' "$ZAGROS_HOME/.env" \
    && ok "platform sqlite url" || bad "platform sqlite url"
grep -qE '^SQLALCHEMY_DATABASE_URL=sqlite:////var/lib/zagros/legacy.db$' "$ZAGROS_HOME/.env" \
    && ok "legacy sqlite url (separate file)" || bad "legacy sqlite url (separate file)"
run bash "$CLI" install; expect_rc "second install refuses" 1
expect_out "refusal explains" "already installed"


# ----------------------------------------------------------------------------- #
say "t04 status / version / health on healthy fake"
run bash "$CLI" status; expect_rc "status rc0" 0
expect_out "status shows panel" "database:"
run bash "$CLI" health; expect_rc "health rc0" 0
expect_out "health payload line" "healthy: db=sqlite"
run bash "$CLI" version; expect_rc "version rc0" 0
EXPECTED_CLI_VER=$(grep -m1 '^ZAGROS_CLI_VERSION=' "$CLI" | cut -d'"' -f2)
expect_out "version shows CLI" "zagros CLI     $EXPECTED_CLI_VER"
expect_out "version shows panel" "panel version"

# ----------------------------------------------------------------------------- #
say "t05 config show/get/set/reload/validate"
run bash "$CLI" config get UVICORN_PORT; expect_rc "config get rc0" 0
[[ "$LAST_OUT" == "8000" ]] && ok "config get value" || bad "config get value" "$LAST_OUT"
run bash "$CLI" config set XRAY_SUBSCRIPTION_PORT 2096 --force
expect_rc "config set rc0" 0
run bash "$CLI" config get XRAY_SUBSCRIPTION_PORT
[[ "$LAST_OUT" == "2096" ]] && ok "config set persisted" || bad "config set persisted" "$LAST_OUT"
INODE_BEFORE="$(stat -c %i "$ZAGROS_HOME/.env")"
run bash "$CLI" config set XRAY_SUBSCRIPTION_PATH sub2 --force
[[ "$(stat -c %i "$ZAGROS_HOME/.env")" == "$INODE_BEFORE" ]] \
    && ok "config set edits in place (same inode — mount keeps seeing it)" \
    || bad "config set edits in place (same inode — mount keeps seeing it)"
run bash "$CLI" config set XRAY_SUBSCRIPTION_PATH sub --force
run bash "$CLI" config show; expect_rc "config show rc0" 0
printf '%s' "$LAST_OUT" | grep -q '^ZAGROS_SECRET_KEY=.\{4\}….\{4\}$' \
    && ok "config show masks secrets" || bad "config show masks secrets"
run bash "$CLI" config list; expect_rc "config list alias rc0" 0
run bash "$CLI" config path
[[ "$LAST_OUT" == "$ZAGROS_HOME/.env" ]] && ok "config path prints .env" || bad "config path prints .env" "$LAST_OUT"
run bash "$CLI" config reload; expect_rc "config reload rc0" 0
run bash "$CLI" config validate; expect_rc "config validate rc0" 0
run bash "$CLI" config set TLS_MODE bogus --force
run bash "$CLI" config validate; expect_rc "validate rejects bad TLS_MODE" 1
expect_out "TLS_MODE message" "TLS_MODE invalid"
run bash "$CLI" config set TLS_MODE on --force
run bash "$CLI" config validate; expect_rc "validate demands certs when TLS_MODE=on" 1
run bash "$CLI" config set TLS_MODE auto --force
run bash "$CLI" config validate; expect_rc "validate clean after TLS revert" 0
OLD_LEGACY="$(grep '^SQLALCHEMY_DATABASE_URL=' "$ZAGROS_HOME/.env")"
sed -i 's|^SQLALCHEMY_DATABASE_URL=.*|SQLALCHEMY_DATABASE_URL=sqlite:////var/lib/zagros/zagros.db|' "$ZAGROS_HOME/.env"
run bash "$CLI" config validate; expect_rc "validate catches same-file collision" 1
expect_out "collision message" "SAME file"
sed -i "s|^SQLALCHEMY_DATABASE_URL=.*|$OLD_LEGACY|" "$ZAGROS_HOME/.env"
run bash "$CLI" config validate; expect_rc "validate clean again" 0

# ----------------------------------------------------------------------------- #
say "t06 admin management"
run bash "$CLI" create-admin --username ci-admin --password 'Sup3rSecret!' --sudo
expect_rc "create-admin rc0" 0; expect_out "created echo" "created admin: ci-admin"
run bash "$CLI" create-admin --username ci-admin --password x
expect_rc "duplicate admin rejected" 1
run bash "$CLI" reset-admin --username ci-admin --password 'N3wSecret!'
expect_rc "reset-admin rc0" 0; expect_out "reset echo" "password reset for: ci-admin"
run bash "$CLI" reset-admin --username ghost --password x
expect_rc "reset unknown admin fails" 1
run bash "$CLI" create-admin --username gen-admin
expect_rc "create-admin generates password" 0
expect_out "password shown once" "generated password"

# ----------------------------------------------------------------------------- #
say "t07 core management lifecycle"
run bash "$CLI" list-cores; expect_rc "list-cores empty rc0" 0
expect_out "empty inventory hint" "no cores installed"
run bash "$CLI" install-core xray; expect_rc "install-core xray rc0" 0
expect_out "panel reloaded after install" "core installed + panel reloaded"
run bash "$CLI" list-cores; expect_rc "list-cores rc0" 0
expect_out "xray running after panel boot" "running"
run bash "$CLI" install-core openvpn --disabled
expect_rc "install-core disabled rc0" 0
LAST_OUT="$(bash "$CLI" list-cores)"; LAST_RC=$?
printf '%s' "$LAST_OUT" | grep -E '^openvpn\s+installed\s+no' >/dev/null \
    && ok "openvpn installed+disabled" || bad "openvpn installed+disabled" "$(printf '%s' "$LAST_OUT" | tail -2 | tr '\n' '|')"
run bash "$CLI" install-core definitely-not-a-core
expect_rc "unknown core fails" 1
run bash "$CLI" reload-core xray
expect_rc "reload-core rc0 (panel-aware fallback)" 0
expect_out "panel reloaded for owned core" "restarted with it"
run bash "$CLI" update-core xray; expect_rc "update-core rc0" 0
expect_out "core version bumped" "xray → 2.0.0"
run bash "$CLI" update-core xray --version 25.8.3
expect_out "explicit core version" "xray → 25.8.3"
run bash "$CLI" sync; expect_rc "sync rc0" 0
expect_out "sync summary" "sync finished"

# ----------------------------------------------------------------------------- #
say "t08 uninstall-core dependency/panel-state semantics"
run bash "$CLI" uninstall-core openvpn
expect_rc "uninstall stopped core rc0" 0
expect_out "purged flag false" "purged=false"
run bash "$CLI" uninstall-core xray
expect_rc "uninstall running core recovers via --force reload" 0
expect_out "force path messaging" "forcing with restart"
run bash "$CLI" list-cores
printf '%s' "$LAST_OUT" | grep -q "no cores installed" \
    && ok "inventory empty after uninstall" || bad "inventory empty after uninstall" "$LAST_OUT"
run bash "$CLI" uninstall-core ghost
expect_rc "uninstall missing core fails" 1

# ----------------------------------------------------------------------------- #
say "t09 backup creates a verifiable archive"
run bash "$CLI" install-core wireguard
expect_rc "install wireguard rc0" 0
touch "$ZAGROS_DATA/wg-marker.conf"; echo test-key > "$ZAGROS_DATA/wg-marker.conf"
# SoftEther stores vpn_server.config beside its daemon. The config is durable
# upgrade/restore state; the large self-installable binaries are not.
mkdir -p "$ZAGROS_DATA/cores/softether/runtime"
printf 'declare root config state\n' > "$ZAGROS_DATA/cores/softether/runtime/vpn_server.config"
printf 'redownloadable daemon\n' > "$ZAGROS_DATA/cores/softether/runtime/vpnserver"
printf 'redownloadable admin tool\n' > "$ZAGROS_DATA/cores/softether/runtime/vpncmd"
run bash "$CLI" backup
expect_rc "backup rc0" 0
ARCHIVE="$(printf '%s' "$LAST_OUT" | grep -oE "$ZAGROS_DATA/backups/zagros-backup-[^ ]+\.tar\.gz" | head -1)"
expect_file "$ARCHIVE" "archive exists"
[[ "$(stat -c %a "$ARCHIVE")" == "600" ]] && ok "archive is 0600" || bad "archive is 0600"
X="$T/verify"; mkdir -p "$X"; tar -xzf "$ARCHIVE" -C "$X"
expect_file "$X/db/zagros.sqlite3" "platform db dump present"
expect_file "$X/db/legacy.sqlite3" "legacy db dump present"
expect_file "$X/config/.env" ".env in backup"
expect_file "$X/config/docker-compose.yml" "compose in backup"
expect_file "$X/data/panel-data.tar.gz" "panel data tarball"
expect_file "$X/manifest.meta" "manifest meta"
grep -q '^kind=zagros-full' "$X/manifest.meta" && ok "manifest kind tag" || bad "manifest kind tag"
grep -q 'cores/\*/bin' "$X/manifest.meta" && ok "exclusions recorded" || bad "exclusions recorded"
python3 - "$X" <<'PY' && ok "manifest sha256 integrity" || bad "manifest sha256 integrity"
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
mani = json.loads((root / "manifest.json").read_text())
assert mani["files"], "manifest has no files"
for f in mani["files"]:
    digest = hashlib.sha256((root / f["path"]).read_bytes()).hexdigest()
    assert digest == f["sha256"], f"checksum mismatch: {f['path']}"
PY
tar -tzf "$X/data/panel-data.tar.gz" | grep -q 'wg-marker.conf' \
    && ok "marker file inside data tarball" || bad "marker file inside data tarball"
tar -tzf "$X/data/panel-data.tar.gz" | grep -q 'zagros.db' \
    && bad "raw sqlite excluded from data tarball" || ok "raw sqlite excluded from data tarball"
tar -tzf "$X/data/panel-data.tar.gz" | grep -q 'cores/softether/runtime/vpn_server.config' \
    && ok "SoftEther server config retained in backup" \
    || bad "SoftEther server config retained in backup"
tar -tzf "$X/data/panel-data.tar.gz" | grep -q 'cores/softether/runtime/vpnserver' \
    && bad "SoftEther redownloadable binaries excluded" \
    || ok "SoftEther redownloadable binaries excluded"

# ----------------------------------------------------------------------------- #
say "t10 restore: dry-run, wrong-kind guard, real restore with mutation"
run bash "$CLI" restore "$ARCHIVE" --dry-run
expect_rc "restore dry-run rc0" 0
expect_out "dry-run reports plan" "dry-run OK — no changes made"

BAD="$T/fake-mysql-backup"; mkdir -p "$BAD"
printf 'kind=zagros-full\ndb_kind=mysql\n' > "$BAD/manifest.meta"
tar -czf "$T/mysql-kind.tar.gz" -C "$BAD" .
run bash "$CLI" restore "$T/mysql-kind.tar.gz" --yes
expect_rc "cross-engine restore refused" 1
expect_out "refusal names engines" "database kind mismatch"

rm -f "$ZAGROS_DATA/wg-marker.conf"
PLATFORM_SUM_BEFORE="$(grep -A1 . "$X/db/zagros.sqlite3" | sha256sum | cut -d' ' -f1)"
sed -i 's|^UVICORN_PORT=.*|UVICORN_PORT=9999|' "$ZAGROS_HOME/.env"
run bash "$CLI" restore latest --yes
expect_rc "restore rc0" 0
expect_out "restore completes" "restore complete"
expect_file "$ZAGROS_DATA/wg-marker.conf" "marker file restored"
grep -q '^UVICORN_PORT=8000$' "$ZAGROS_HOME/.env" \
    && ok "env restored from backup" || bad "env restored from backup"
[[ "$(sha256sum "$ZAGROS_DATA/zagros.db" | cut -d' ' -f1)" == "$PLATFORM_SUM_BEFORE" ]] \
    && ok "platform db bytes restored" || bad "platform db bytes restored"

# ----------------------------------------------------------------------------- #
say "t11 update: happy path, idempotency, failure+auto-rollback"
# Simulate an alpha.7.7 env whose Xray paths still lived in the replaceable
# container filesystem. Exact historical defaults migrate; real custom paths
# remain operator-owned.
sed -i \
    -e 's|^XRAY_JSON=.*|XRAY_JSON=./xray_config.json|' \
    -e 's|^XRAY_EXECUTABLE_PATH=.*|XRAY_EXECUTABLE_PATH=/usr/local/bin/xray|' \
    -e 's|^XRAY_ASSETS_PATH=.*|XRAY_ASSETS_PATH=/usr/local/share/xray|' \
    "$ZAGROS_HOME/.env"
# The release bootstrap must refresh an old installed CLI before update; this
# is how alpha.8.1 hosts receive the new compose healthcheck + host agent.
printf '#!/usr/bin/env bash\necho stale-cli\n' > "$ZAGROS_BIN/zagros"
chmod 0755 "$ZAGROS_BIN/zagros"
run bash "$SH" update --version v9.9.9-test
expect_rc "bootstrap update rc0" 0
grep -q 'ZAGROS_CLI_VERSION="1.0.0-alpha.8.6.1"' "$ZAGROS_BIN/zagros" \
    && ok "bootstrap update refreshed installed CLI" || bad "bootstrap update refreshed installed CLI"
expect_out "update summary" "update complete"
grep -q '^ZAGROS_IMAGE_TAG=v9.9.9-test$' "$ZAGROS_HOME/.env" \
    && ok "env tag flipped" || bad "env tag flipped"
grep -q '^XRAY_JSON=/var/lib/zagros/cores/xray/xray_config.json$' "$ZAGROS_HOME/.env" \
    && ok "update repairs persistent Xray config path" || bad "update repairs persistent Xray config path"
grep -q '^XRAY_EXECUTABLE_PATH=/var/lib/zagros/cores/xray/bin/xray$' "$ZAGROS_HOME/.env" \
    && ok "update repairs persistent Xray binary path" || bad "update repairs persistent Xray binary path"
jq -e '.result == "ok" and .to_tag == "v9.9.9-test"' "$ZAGROS_HOME/.state/last-update.json" >/dev/null \
    && ok "last-update.json records success" || bad "last-update.json records success"
grep -q 'alembic' "$FAKE_DOCKER_STATE/invocations.jsonl" \
    && ok "migration ran during update" || bad "migration ran during update"
run bash "$CLI" update --version 9.9.9-test
expect_rc "bare version accepted (v-prefix normalized)" 0

# alpha.7.4 (items 2/3): a compose rendered by an OLD template (no
# /dev/net/tun + NET_ADMIN) must be re-rendered at update time and the
# container force-recreated — else TUN cores keep dying post-update.
sed -i '/^  *- NET_ADMIN$/d; /\/dev\/net\/tun:\/dev\/net\/tun/d; /^  *cap_add:$/d; /^  *devices:$/d' \
    "$ZAGROS_HOME/docker-compose.yml"
! grep -q 'net/tun' "$ZAGROS_HOME/docker-compose.yml" \
    && ok "stale (pre-alpha.7.2) compose simulated" || bad "stale (pre-alpha.7.2) compose simulated"
run bash "$CLI" update --version v9.9.9-test --force
expect_rc "update with stale compose rc0" 0
grep -q '/dev/net/tun:/dev/net/tun' "$ZAGROS_HOME/docker-compose.yml" \
    && ok "update re-rendered compose with TUN device" || bad "update re-rendered compose with TUN device"
grep -qE '^  *- NET_ADMIN$' "$ZAGROS_HOME/docker-compose.yml" \
    && ok "update re-rendered compose with NET_ADMIN" || bad "update re-rendered compose with NET_ADMIN"
grep -q 'force-recreate' "$FAKE_DOCKER_STATE/invocations.jsonl" \
    && ok "compose change triggered --force-recreate" || bad "compose change triggered --force-recreate"
n_fr_before=$(grep -c 'force-recreate' "$FAKE_DOCKER_STATE/invocations.jsonl" || true)
run bash "$CLI" update --version v9.9.9-test --force --no-backup
expect_rc "update with converged compose rc0" 0
n_fr_after=$(grep -c 'force-recreate' "$FAKE_DOCKER_STATE/invocations.jsonl" || true)
[[ "$n_fr_after" == "$n_fr_before" ]] && ok "converged compose does not force-recreate again" \
    || bad "converged compose does not force-recreate again ($n_fr_before → $n_fr_after)"

FAKE_COMPOSE_PULL_OK=0; export FAKE_COMPOSE_PULL_OK
run bash "$CLI" update --version v8.8.8-broken
expect_rc "failed update exits non-zero" 1
expect_out "rollback announced" "rolling back"
grep -q '^ZAGROS_IMAGE_TAG=v9.9.9-test$' "$ZAGROS_HOME/.env" \
    && ok "tag rolled back to previous" || bad "tag rolled back to previous"
unset FAKE_COMPOSE_PULL_OK
run bash "$CLI" rollback --to v9.8.7-prev --yes
expect_rc "manual rollback command rc0" 0
expect_out "rollback echo" "rolled back to v9.8.7-prev"

# ----------------------------------------------------------------------------- #
say "t12 backup-service / clean / prune"
run bash "$CLI" backup-service
expect_rc "backup-service rc0" 0
expect_out "service bundle written" "service/system backup:"
ls "$ZAGROS_DATA/backups/"zagros-service-*.images.txt >/dev/null 2>&1 \
    && ok "image pin list written" || bad "image pin list written"

touch -d '3 days ago'   "$ZAGROS_DATA/backups/zagros-backup-20000101-000000Z.tar.gz"
touch -d '2 days ago'   "$ZAGROS_DATA/backups/zagros-backup-20000102-000000Z.tar.gz"
run bash "$CLI" clean --keep 2
expect_rc "clean rc0" 0
REMAINING="$(ls -1 "$ZAGROS_DATA/backups/"zagros-backup-*.tar.gz | wc -l)"
[[ "$REMAINING" -le 3 ]] && ok "clean pruned old archives ($REMAINING left)" || bad "clean pruned old archives" "$REMAINING"

docker pull ghcr.io/zagrosgm/zagros:old-tag-1 >/dev/null 2>&1
docker pull ghcr.io/zagrosgm/zagros:old-tag-2 >/dev/null 2>&1
run bash "$CLI" prune
expect_rc "prune rc0" 0
TAGS="$(docker images ghcr.io/zagrosgm/zagros --format '{{.Tag}}' | sort | tr '\n' ' ')"
printf '%s' "$TAGS" | grep -q 'old-tag-1' && bad "prune removed superseded tags" "$TAGS" \
    || ok "prune removed superseded tags" "$TAGS"

# ----------------------------------------------------------------------------- #
say "t13 migrate / lifecycle"
run bash "$CLI" migrate; expect_rc "migrate rc0" 0
run bash "$CLI" logs --no-follow; expect_rc "logs rc0" 0
run bash "$CLI" shell </dev/null; expect_rc "shell rc0" 0
run bash "$CLI" stop;    expect_rc "stop rc0" 0
run bash "$CLI" health;  expect_rc "health fails while stopped" 1
run bash "$CLI" start;   expect_rc "start rc0" 0
run bash "$CLI" restart; expect_rc "restart rc0" 0
run bash "$CLI" reload;  expect_rc "reload rc0" 0
run bash "$CLI" down;    expect_rc "down rc0" 0
run bash "$CLI" up;      expect_rc "up rc0" 0

# ----------------------------------------------------------------------------- #
say "t14 doctor (with a real listener on the panel port)"
python3 -m http.server 8000 --bind 127.0.0.1 >/dev/null 2>&1 &
HTTP_PID=$!
sleep 1
JSON_ONLY="$(bash "$CLI" doctor --json 2>"$LOGD/doctor-stderr.log")"; JSON_RC=$?
kill $HTTP_PID 2>/dev/null
[[ "$JSON_RC" == 0 ]] && ok "doctor rc0 when all green" || bad "doctor rc0 when all green" "rc=$JSON_RC"
printf '%s' "$JSON_ONLY" | jq -e . >/dev/null \
    && ok "doctor --json stdout is pure JSON" || bad "doctor --json stdout is pure JSON"
printf '%s' "$JSON_ONLY" | jq -e 'map(select(.check == "docker daemon" and .status == "OK")) | length == 1' >/dev/null \
    && ok "doctor json: docker OK" || bad "doctor json: docker OK"
printf '%s' "$JSON_ONLY" | jq -e 'map(select(.check == "database + schema" and .status == "OK")) | length == 1' >/dev/null \
    && ok "doctor json: schema OK" || bad "doctor json: schema OK"
printf '%s' "$JSON_ONLY" | jq -e 'map(select(.check | startswith("ghcr"))) | length >= 1' >/dev/null \
    && ok "doctor json: ghcr reachability checked" || bad "doctor json: ghcr reachability checked"
run bash "$CLI" down
run bash "$CLI" doctor
expect_rc "doctor exits 1 with failures" 1
run bash "$CLI" up

# ----------------------------------------------------------------------------- #
say "t15 repair fixes drift, guards the secret key"
sed -i '/^UVICORN_PORT=/d' "$ZAGROS_HOME/.env"
mkdir -p "$ZAGROS_DATA/cache"; touch -d '2 hours ago' "$ZAGROS_DATA/cache/orphan.part"
run bash "$CLI" repair
expect_rc "repair rc0" 0
expect_out "repair reconciles live core verdict" "reconciled wireguard: running"
grep -q 'force-recreate' "$FAKE_DOCKER_STATE/invocations.jsonl" \
    && ok "repair force-recreates panel for listener reconciliation" \
    || bad "repair force-recreates panel for listener reconciliation"
[[ ! -e "$ZAGROS_DATA/cache/orphan.part" ]] \
    && ok "repair invalidates stale partial cache" || bad "repair invalidates stale partial cache"
jq -e '(.studio_deferred|length)==0 and (.account_deferred|length)==0' \
    "$ZAGROS_DATA/runtime-boot-report.json" >/dev/null \
    && ok "repair consumes clean live boot report" || bad "repair consumes clean live boot report"
grep -q '^UVICORN_PORT=8000$' "$ZAGROS_HOME/.env" \
    && ok "repair re-added missing UVICORN_PORT" || bad "repair re-added missing UVICORN_PORT"
SECRET_LINE="$(grep '^ZAGROS_SECRET_KEY=' "$ZAGROS_HOME/.env")"
sed -i '/^ZAGROS_SECRET_KEY=/d' "$ZAGROS_HOME/.env"
touch "$ZAGROS_DATA/zagros.db"
run bash "$CLI" repair
expect_rc "repair with missing secret still rc0" 0
expect_out "refuses to invent key over data" "NOT inventing a new key"
grep -q '^ZAGROS_SECRET_KEY=' "$ZAGROS_HOME/.env" \
    && bad "secret left untouched" || ok "secret left untouched"
sed -i "1i $SECRET_LINE" "$ZAGROS_HOME/.env"

# ----------------------------------------------------------------------------- #
say "t16 full uninstall — single command wipes EVERYTHING (no --purge anymore)"
run bash "$CLI" uninstall --purge --yes
expect_rc "--purge flag rejected (removed contract)" 1
grep -q "no such option" <<<"$LAST_OUT" \
    && ok "--purge removal explained" || bad "--purge removal explained" "$LAST_OUT"

run bash "$CLI" uninstall --yes
expect_rc "uninstall rc0" 0
expect_no_file "$ZAGROS_HOME/docker-compose.yml" "service dir removed"
expect_no_file "$ZAGROS_HOME" "opt tree fully removed"
expect_no_file "$ZAGROS_BIN/zagros" "CLI binary removed"
expect_no_file "$ZAGROS_DATA" "data dir fully removed (no more soft uninstall)"

run bash "$CLI" install
expect_rc "reinstall rc0" 0
run bash "$CLI" uninstall --yes
expect_rc "second full uninstall rc0" 0

# ----------------------------------------------------------------------------- #
say "t16b full uninstall sweeps units/cron/cache + stray docker artifacts, spares others"
# spec's remaining categories: systemd units, cron jobs, CLI cache — plus
# stray zagros* docker resources AND other apps' resources that must SURVIVE.
reset_fake
run bash "$CLI" install
expect_rc "t16b install rc0" 0
# Production installs a root-only Panel Network agent. In this intentionally
# non-systemd sandbox the files may be installed for lifecycle verification,
# but readiness must stay fail-closed (no watcher means no .agent-ready).
run env ZAGROS_FORCE_HOST_AGENT=1 bash "$CLI" install-host-agent
expect_rc "host agent file install rc0 without systemd" 0
expect_file "$ZAGROS_LIBEXEC/zagros-host-agent" "host agent binary installed"
expect_file "$ZAGROS_LIBEXEC/zagros-ssh-accounting-agent" "SSH accounting agent installed"
[[ "$(stat -c %a "$ZAGROS_LIBEXEC/zagros-host-agent")" == "755" ]] \
    && ok "host agent binary is 0755" || bad "host agent binary is 0755"
[[ "$(stat -c %a "$ZAGROS_LIBEXEC/zagros-ssh-accounting-agent")" == "755" ]] \
    && ok "SSH accounting agent is 0755" || bad "SSH accounting agent is 0755"
expect_file "$SYSTEMD_DIR/zagros-host-agent.service" "host agent service unit installed"
expect_file "$SYSTEMD_DIR/zagros-host-agent.path" "host agent path unit installed"
expect_file "$SYSTEMD_DIR/zagros-ssh-accounting.service" "SSH accounting service unit installed"
expect_no_file "$ZAGROS_DATA/host-actions/.agent-ready" "inactive watcher has no readiness marker"
expect_out "non-systemd apply is explicitly disabled" "Panel Network Apply stays disabled"
python3 - <<'EOF'
import json, os, pathlib
sd = pathlib.Path(os.environ["FAKE_DOCKER_STATE"]); sd.mkdir(parents=True, exist_ok=True)
c = json.loads((sd / "containers.json").read_text()) if (sd / "containers.json").exists() else {}
c["zagros-rogue"] = {"running": False, "healthy": False}
(sd / "containers.json").write_text(json.dumps(c))
(sd / "volumes.json").write_text(json.dumps(["zagros_vol", "other_vol"]))
(sd / "networks.json").write_text(json.dumps(["zagros_net", "other_net"]))
EOF
mkdir -p "$SYSTEMD_DIR" "$CRON_D_DIR"
touch "$SYSTEMD_DIR/zagros-panel.service" "$CRON_D_DIR/zagros-backup"
mkdir -p "$HOME/.cache/zagros"; touch "$HOME/.cache/zagros/etag"

# refuses without confirmation (spec: summary first, then ask)
run env -u ASSUME_YES bash "$CLI" uninstall </dev/null
expect_rc "uninstall without confirmation aborts" 1
expect_out "summary printed before asking" "PERMANENTLY destroyed"
expect_out "summary covers systemd units" "systemd units:"
expect_out "summary covers cron jobs" "cron jobs:"

run bash "$CLI" uninstall --yes
expect_rc "t16b full uninstall rc0" 0
expect_out "extended verify line" "units, cron jobs"
expect_no_file "$SYSTEMD_DIR/zagros-panel.service" "systemd unit removed"
expect_no_file "$ZAGROS_LIBEXEC/zagros-host-agent" "host agent binary removed"
expect_no_file "$ZAGROS_LIBEXEC/zagros-ssh-accounting-agent" "SSH accounting agent removed"
expect_no_file "$CRON_D_DIR/zagros-backup" "cron file removed"
expect_no_file "$HOME/.cache/zagros" "CLI cache removed"
expect_no_file "$ZAGROS_DATA" "data dir removed"
python3 - <<'EOF'
import json, os, pathlib, sys
sd = pathlib.Path(os.environ["FAKE_DOCKER_STATE"])
vols = json.loads((sd / "volumes.json").read_text())
nets = json.loads((sd / "networks.json").read_text())
cons = json.loads((sd / "containers.json").read_text())
problems = []
if cons: problems.append(f"containers left: {sorted(cons)}")
if vols != ["other_vol"]: problems.append(f"volumes wrong: {vols}")
if nets != ["other_net"]: problems.append(f"networks wrong: {nets}")
if problems:
    print("LEAK: " + "; ".join(problems)); sys.exit(1)
print("stray docker resources swept; other_vol/other_net preserved")
EOF
[[ $? -eq 0 ]] && ok "stray docker artifacts swept surgically" || bad "stray docker artifacts swept surgically" "see LEAK"

# idempotent: nothing-left runs cleanly
run bash "$CLI" uninstall --yes
expect_rc "t16b repeat uninstall rc0" 0

# ----------------------------------------------------------------------------- #
say "t17 one-liner idempotency: CLI already living at ZAGROS_BIN"
# Regression (real-VPS E2E catch): the bootstrap one-liner downloads the CLI
# to $ZAGROS_BIN/zagros and THEN runs it; install must not die on GNU
# install(1) "are the same file" when src and dst share an inode.
reset_fake
install -m 0755 "$CLI" "$ZAGROS_BIN/zagros"
run bash "$ZAGROS_BIN/zagros" install
expect_rc "same-inode CLI install rc0" 0
expect_out "CLI install still logged" "CLI installed"
expect_file "$ZAGROS_HOME/.state/install.json" "install state recorded (same-inode path)"

# Regression (real-VPS E2E catch): restore's --yes must skip the prompt even
# without ASSUME_YES=1 in the environment (it was parsed but silently
# ignored; this harness masked it via the global ASSUME_YES=1).
run bash "$ZAGROS_BIN/zagros" backup >/dev/null
run env -u ASSUME_YES bash "$ZAGROS_BIN/zagros" restore latest --yes
expect_rc "restore honors --yes without ASSUME_YES" 0
expect_out "restore completes without ASSUME_YES" "restore complete"
run env -u ASSUME_YES bash "$ZAGROS_BIN/zagros" restore latest </dev/null
expect_rc "restore without confirmation aborts" 1

run bash "$ZAGROS_BIN/zagros" uninstall --yes
expect_rc "cleanup purge rc0" 0

# ----------------------------------------------------------------------------- #
say "t18 legacy zagros.env auto-migrates to .env (any command triggers it)"
reset_fake
rm -rf "$ZAGROS_HOME"; mkdir -p "$ZAGROS_HOME"
printf 'UVICORN_PORT=8123\nZAGROS_SECRET_KEY=abcdefghijklmnopqrstuvwxyz0123456789abcdef\n' \
    > "$ZAGROS_HOME/zagros.env"
chmod 644 "$ZAGROS_HOME/zagros.env"
run bash "$CLI" version
expect_rc "trigger command rc0" 0
expect_out "migration logged" "migrated legacy zagros.env"
expect_file "$ZAGROS_HOME/.env" ".env created by migration"
[[ "$(stat -c %a "$ZAGROS_HOME/.env")" == "600" ]] \
    && ok "migrated .env is 0600" || bad "migrated .env is 0600"
expect_no_file "$ZAGROS_HOME/zagros.env" "legacy file renamed away"
expect_file "$ZAGROS_HOME/zagros.env.migrated" "legacy kept as .migrated"
grep -q '^UVICORN_PORT=8123$' "$ZAGROS_HOME/.env" \
    && ok "values preserved through migration" || bad "values preserved through migration"
run bash "$CLI" version
expect_rc "second run rc0" 0
[[ -f "$ZAGROS_HOME/zagros.env.migrated" && ! -e "$ZAGROS_HOME/zagros.env" ]] \
    && ok "migration is idempotent" || bad "migration is idempotent"
# existing .env wins — a legacy file left next to it is NOT migrated over it
printf 'UVICORN_PORT=9999\n' > "$ZAGROS_HOME/zagros.env"
run bash "$CLI" version
grep -q '^UVICORN_PORT=8123$' "$ZAGROS_HOME/.env" \
    && ok "existing .env untouched when legacy reappears" \
    || bad "existing .env untouched when legacy reappears"
rm -f "$ZAGROS_HOME/zagros.env"

# ----------------------------------------------------------------------------- #
say "t19 legacy backup archive (zagros.env + injection compose) restores into .env"
reset_fake
rm -rf "$ZAGROS_HOME"
run bash "$CLI" install
expect_rc "fresh install rc0" 0
LEGARC="$T/legacy-archive"; mkdir -p "$LEGARC/config" "$LEGARC/db"
cp -a "$ZAGROS_HOME/.env" "$LEGARC/config/zagros.env"
sed -i 's|^UVICORN_PORT=.*|UVICORN_PORT=7777|' "$LEGARC/config/zagros.env"
# old-style injection compose (no /code/.env mount marker) — must normalize
printf 'services:\n  zagros:\n    env_file:\n      - zagros.env\n' \
    > "$LEGARC/config/docker-compose.yml"
touch "$ZAGROS_DATA/zagros.db"   # fake docker creates no real sqlite file
cp -a "$ZAGROS_DATA/zagros.db" "$LEGARC/db/zagros.sqlite3"
printf 'kind=zagros-full\ndb_kind=sqlite\n' > "$LEGARC/manifest.meta"
tar -czf "$T/legacy-backup.tar.gz" -C "$LEGARC" .
run bash "$CLI" restore "$T/legacy-backup.tar.gz" --yes
expect_rc "legacy archive restore rc0" 0
expect_out "legacy env restore logged" "restored into .env"
expect_out "legacy compose conversion logged" "mount-only .env design"
grep -q '^UVICORN_PORT=7777$' "$ZAGROS_HOME/.env" \
    && ok "legacy env restored INTO .env" || bad "legacy env restored INTO .env"
grep -q './.env:/code/.env:ro' "$ZAGROS_HOME/docker-compose.yml" \
    && ok "compose normalized to the mount design" || bad "compose normalized to the mount design"
grep -q 'env_file:' "$ZAGROS_HOME/docker-compose.yml" \
    && bad "no env_file injection left after normalize" || ok "no env_file injection left after normalize"
run bash "$CLI" uninstall --yes
expect_rc "t19 cleanup rc0" 0

# ----------------------------------------------------------------------------- #
say "t20 mysql install: creds ONLY in .env, compose is interpolation-only"
reset_fake
rm -rf "$ZAGROS_HOME"
run bash "$CLI" install --database mysql
expect_rc "mysql install rc0" 0
grep -qE '^ZAGROS_DB_ROOT_PASSWORD=.+$' "$ZAGROS_HOME/.env" \
    && ok "db root password lives in .env" || bad "db root password lives in .env"
grep -qE '^ZAGROS_DB_PASSWORD=.+$' "$ZAGROS_HOME/.env" \
    && ok "db password lives in .env" || bad "db password lives in .env"
grep -q '${ZAGROS_DB_USER:-zagros}' "$ZAGROS_HOME/docker-compose.yml" \
    && ok "compose interpolates db user from .env" || bad "compose interpolates db user from .env"
ROOT_PW="$(grep '^ZAGROS_DB_ROOT_PASSWORD=' "$ZAGROS_HOME/.env" | cut -d= -f2-)"
grep -qF "$ROOT_PW" "$ZAGROS_HOME/docker-compose.yml" \
    && bad "compose stays secret-free (no literal creds)" \
    || ok "compose stays secret-free (no literal creds)"
grep -q 'env_file:' "$ZAGROS_HOME/docker-compose.yml" \
    && bad "mysql stack: no env_file injection" || ok "mysql stack: no env_file injection"
grep -q './.env:/code/.env:ro' "$ZAGROS_HOME/docker-compose.yml" \
    && ok "mysql stack: .env mounted" || bad "mysql stack: .env mounted"

# ----------------------------------------------------------------------------- #
say "t21 FULL UNINSTALL: every Zagros artifact wiped + verified (containers, images, volumes, networks, dirs, CLI)"

# --- mysql stack: containers AND images (panel + db) must vanish
run bash "$CLI" uninstall --yes
expect_rc "mysql full uninstall rc0" 0
expect_out "uninstall runs full docker sweep" "containers:"
docker ps -a --format '{{.Names}}' | grep -q '^zagros' \
    && bad "no zagros containers remain (mysql)" "$(docker ps -a --format '{{.Names}}')" \
    || ok "no zagros containers remain (mysql)"
docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}' | grep -q . \
    && bad "panel images removed (mysql)" || ok "panel images removed (mysql)"
docker images --format '{{.Repository}}' | grep -qE '^(mysql|mariadb|postgres)$' \
    && bad "db images removed (mysql)" || ok "db images removed (mysql)"
expect_no_file "$ZAGROS_HOME" "opt tree gone (mysql)"
expect_no_file "$ZAGROS_DATA" "data tree gone incl. db files (mysql)"
expect_no_file "$ZAGROS_BIN/zagros" "CLI gone (mysql)"

# --- sqlite stack with installed cores + backups + stray leftovers
reset_fake
rm -rf "$ZAGROS_HOME"
run bash "$CLI" install
expect_rc "sqlite reinstall rc0" 0
run bash "$CLI" install-core sing-box
expect_rc "install a core (adds binaries + logs under data)" 0
run bash "$CLI" backup
expect_rc "backup creates artifacts under data/backups" 0
expect_file "$ZAGROS_DATA/backups" "backup dir exists pre-uninstall"
# strays the installer never tracked but a full uninstall must still sweep:
mkdir -p "$ZAGROS_DATA/stray" "$T/etc/zagros"
echo stray > "$ZAGROS_DATA/stray/left.db"
echo legacy > "$T/etc/zagros/legacy.conf"
docker volume create zagros-strayvol >/dev/null
docker network create zagros-straynet >/dev/null
docker run --name zagros-stray orphan:image >/dev/null
run bash "$CLI" uninstall --yes
expect_rc "full uninstall rc0 (sqlite, leftovers seeded)" 0
expect_out "removal summary printed" "containers:"
expect_out "removal summary printed" "images:"
expect_out "removal summary printed" "volumes:"
expect_out "removal summary printed" "networks:"
expect_out "removal summary printed" "databases"
expect_out "removal summary printed" "certificates"
expect_out "removal summary printed" "backups"
expect_out "removal summary printed" "logs"
# docker surface must be spotless
docker ps -a --format '{{.Names}}' | grep -q '^zagros' \
    && bad "no zagros containers remain (sqlite)" "$(docker ps -a --format '{{.Names}}')" \
    || ok "no zagros containers remain (sqlite)"
docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}' | grep -q . \
    && bad "panel images removed (sqlite)" || ok "panel images removed (sqlite)"
docker volume ls --format '{{.Name}}' | grep -q '^zagros' \
    && bad "no zagros volumes remain" "$(docker volume ls --format '{{.Name}}')" \
    || ok "no zagros volumes remain"
docker network ls --format '{{.Name}}' | grep -q '^zagros' \
    && bad "no zagros networks remain" "$(docker network ls --format '{{.Name}}')" \
    || ok "no zagros networks remain"
# filesystem must be spotless
expect_no_file "$ZAGROS_HOME" "opt tree gone (sqlite)"
expect_no_file "$ZAGROS_DATA" "data tree gone incl. stray file (sqlite)"
expect_no_file "$T/etc/zagros" "etc tree gone"
expect_no_file "$ZAGROS_BIN/zagros" "CLI gone (sqlite)"

# --- reinstall is truly clean (no leftovers break a fresh install)
run bash "$CLI" install
expect_rc "post-uninstall reinstall rc0" 0
expect_file "$ZAGROS_HOME/.state/install.json" "fresh install state recorded"
run bash "$CLI" uninstall --yes >/dev/null
expect_rc "final cleanup rc0" 0

# ----------------------------------------------------------------------------- #
printf '\n==============================================================\n'
printf 'CLI tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if (( FAIL > 0 )); then
    printf 'failed: %s\n' "${FAILED_NAMES[*]}"
    printf 'full log: %s\n' "$LOGD/full.log"
    exit 1
fi
printf 'ALL CLI TESTS PASSED\n'

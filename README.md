# zagros-scripts — Zagros installer & management CLI

One-command installation and full lifecycle management for the
[Zagros](https://github.com/ZagrosGM/Zagros) enterprise multi-core VPN
management platform.

* `zagros.sh` — thin bootstrap (curl → CLI → run), the one-liner entrypoint.
* `zagros` — the self-contained management CLI. Once installed it lives at
  `/usr/local/bin/zagros` and never depends on this repository being present.
* `zagros-host-agent` — the root-only systemd path worker for atomic Panel
  Network Apply, HTTPS health verification and `.env` rollback. The web
  container never receives the Docker socket.
* `install-node.sh` — the installer for a **node** server (the command the
  panel's "installer command" button produces). It lives here, not in the
  agent repository, so installing anything Zagros means fetching from one
  place.
* `zagros-node` — the node's host CLI, installed to `/usr/local/bin/zagros-node`.

Design rules: everything the CLI does is **real** (docker/compose for the
service lifecycle, `python3 -m app.platform.hostctl` inside the container for
panel operations like cores/admins/db/sync); failures surface with exit codes
and messages — nothing is simulated; and the stack is **core-agnostic**: no
core binary is baked into the image, every core self-installs its official
upstream release at runtime, and no core has a special place anywhere.

> **Status: BETA.** Suitable for evaluation and lab testing. The CLI's
> semantics are covered by an end-to-end test suite (269 assertions, kept in
> [zagros-devkit](https://github.com/ZagrosGM/zagros-devkit)) and the in-container bridge by the
> Panel's pytest suite — read *Verification* below honestly before production
> use.

---

## Quick install

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ZagrosGM/zagros-scripts/main/zagros.sh)" -- install
```

Pick a managed database engine (default: bundled SQLite):

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ZagrosGM/zagros-scripts/main/zagros.sh)" -- install --database postgresql
# options: sqlite | mysql | mariadb | postgresql
```

Then:

```bash
sudo zagros advanced create-admin --sudo   # first sudo admin
sudo zagros status                    # service, image, health, cores
sudo zagros doctor                    # full diagnostic report
sudo zagros install-core xray         # self-install an official core binary
```

### Safe update (refresh host scripts before the image)

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ZagrosGM/zagros-scripts/main/zagros.sh)" -- update
```

Using the bootstrap for an update is intentional: it installs the current CLI,
host agent and Compose contract before pulling/recreating the requested Panel
image. Calling an older installed CLI cannot retroactively add the `SYS_ADMIN`
capability required by the isolated native SoftEther client
namespaces. The stack still grants no Docker socket and no host PID namespace.

**The panel (exactly one):** `http://<server-ip>:8000/dashboard/` — the unified
Zagros dashboard. Cores, routing, outbounds, inbounds, DNS, certificates,
sessions and devices are all managed there, and the Config Studio lives
inside it as *Settings → Advanced Mode*. There is deliberately **no second
panel** (the legacy `/zagros/dashboard` and `/zagros/studio` routes were
removed and now return 404).

### What `install` does (exactly, and nothing else)

1. Installs Docker via the official `get.docker.com` script when missing
   (skip with `--no-docker-install`).
2. Writes `/opt/zagros/docker-compose.yml` (host networking, healthchecks;
   panel service + optional `zagros-db`) and `/opt/zagros/.env`
   (`0600`, generated secrets — credentials are never printed or passed on
   any command line, and the compose file itself stays secret-free).
3. Pulls `ghcr.io/zagrosgm/zagros:latest` — the floating tag the release
   workflow moves on every **stable** release — and starts the stack. Pin one
   release with `--version vX.Y.Z` (pre-releases are only reachable this way,
   or with `--channel prerelease`). `status` / `version` / `doctor` always
   print the release the running image was built from, next to the tag.
4. With mysql/mariadb/postgresql: starts the database service **first**,
   waits until it accepts connections, then provisions the second
   `zagros_legacy` database (split-schema design).
5. Starts the panel — which itself waits for the SQL server(s)
   (`ZAGROS_DB_WAIT_SECONDS`, default 180 s), migrates the schema and boots
   on the first attempt — then waits for its health (polling the dashboard
   directly, not only Docker's healthcheck cadence) and verifies the schema
   is at head.
6. Installs the CLI to `/usr/local/bin/zagros` and, on systemd hosts, activates
   `/usr/local/libexec/zagros-host-agent` plus its path unit. If systemd
   activation is unavailable, Panel Network desired state can still be saved
   and tested, but Apply remains explicitly disabled (no false-ready marker).

### Requirements

Linux (systemd or not), root, `curl`. The CLI additionally needs the Docker
Compose plugin (auto-installed with Docker), `jq`, `openssl`, `tar`; missing
ones are auto-installed from your distro packages when possible.

### Layout

| Path | Env override | Contents |
|---|---|---|
| `/opt/zagros` | `ZAGROS_HOME` | compose file, **`.env`** (THE configuration), CLI state |
| `/var/lib/zagros` | `ZAGROS_DATA` | databases (sqlite), cores, backups, logs, certs, keys |
| `/usr/local/bin` | `ZAGROS_BIN` | the `zagros` CLI |
| `/usr/local/libexec` | `ZAGROS_LIBEXEC` | root-only `zagros-host-agent` |
| `/etc/systemd/system` | `SYSTEMD_DIR` | host-agent `.service` and `.path` units |

Images come **exclusively from GHCR** (`ghcr.io/zagrosgm/zagros`). Docker Hub
is not used.

---

## Configuration (`.env` — the single source of truth)

Same operator model as Marzban, with its sharp edges removed:

* Everything lives in **one file**: `/opt/zagros/.env`. The docker compose
  project only **mounts** it into the container (`./.env:/code/.env:ro`) —
  nothing is injected into the container environment and nothing is baked
  into the image.
* **Edit → `zagros restart` applies everything.** `restart` recreates the
  panel container, which guarantees `.env` edits take effect no matter how
  the file was modified (editor renames included). No hidden caching, no
  stale settings.
* `UVICORN_HOST` is honored **verbatim** — the runtime never rewrites it
  (the historical "forced to 127.0.0.1 without TLS" trap is fixed in the
  panel).
* `TLS_MODE`: `auto` (default; TLS when both SSL files are set), `on`
  (require TLS, refuse to boot without it), `off` (force plain HTTP for
  reverse-proxy setups).
* A legacy `/opt/zagros/zagros.env` is migrated to `.env` **automatically**
  by any CLI command (and by the panel itself), kept as
  `zagros.env.migrated`. Backups created by older CLIs restore straight
  into the new layout, including conversion of the old injection-style
  compose file.

CLI cheatsheet: `zagros config show` (masked overview) ·
`zagros config get KEY` · `zagros config set KEY VALUE [--restart]` ·
`zagros config edit` ($EDITOR + restart) · `zagros config reload`
(validate + apply) · `zagros config validate` · `zagros config path`.

---

## Command reference

`zagros help` prints the short form; running `zagros` with no arguments prints
it too. Commands are split in two: the **main** ones you use to run a panel,
and **advanced** ones (`zagros advanced <command>`) for everything else.
Exit codes: `0` ok, `1` error, `2` unknown command.

Main: `up`, `down`, `restart`, `status`, `logs`, `update`, `cores`, `env`,
`backup`, `restore`, `version`, `help`.
Advanced: `install`, `uninstall`, `rollback`, `start`, `stop`, `reload`,
`shell`, `health`, `doctor`, `repair`, `migrate`, `sync`, `config`,
`create-admin`, `reset-admin`, `install-host-agent`, `backup-service`,
`clean`, `prune`. `zagros help` only *names* them; `zagros advanced help`
describes each one. Every command has ONE spelling: the advanced ones are
reached only through `zagros advanced <command>` (so `zagros create-admin`
and `zagros reset-admin` now point back to `zagros advanced …` instead of
being silently duplicated).

### Cores (`zagros cores …`)

| Command | Description |
|---|---|
| `cores` / `cores list [--json]` | Installed cores: state, version, health, capabilities. |
| `cores install <core> [--settings JSON] [--no-start]` | SELF_INSTALL an official core binary. |
| `cores update <core> [--version X]` | Update a core; `--version` pins one release (up or down). |
| `cores uninstall <core> [--purge] [--force]` | Dependency-checked removal. |
| `cores reload <core>` | Restart a single core, panel-aware. |

### Configuration (`zagros env …`)

`env` is the short way to reach the same viewer/editor as `config` — the `.env`
is the single source of truth either way.

| Command | Description |
|---|---|
| `env show` | Effective config with secrets masked (default action). |
| `env edit` | Open `.env` in `$EDITOR`, then restart to apply. |
| `env get KEY` | Print one value. |
| `env set KEY VALUE [--force] [--restart]` | Write one value in place. |
| `env validate` | Sanity-check the `.env`. |
| `env path` | Print the `.env` location. |
| `env reload` | Validate + restart — applies `.env` immediately. |

### Service lifecycle

| Command | Description |
|---|---|
| `install [--database sqlite\|mysql\|mariadb\|postgresql] [--version <tag>] [--channel stable\|prerelease] [--no-docker-install]` | One-command installation (see above). Default image tag: `latest`. |
| `update [--version <tag>] [--channel stable\|prerelease] [--no-backup] [--force] [-y]` | Pre-backup → tag/GHCR-digest check → pull → migrate → health gate → **auto-rollback on failure**. Without `--version` it follows `latest`; a failed move of `latest` rolls back to the exact release the previous image was built from. |
| `start` / `stop` | Classic service control with health wait. |
| `restart` | Recreate the panel — **always applies `.env` edits** (health gate). |
| `up` / `down` | `compose up -d` / `compose down` (data preserved). |
| `reload` | Recreate the panel container (same as `restart`). |
| `status` | Panel version, image tag, health, db kind, listeners, core table. |
| `logs [zagros\|zagros-db] [--tail N] [--no-follow]` | Service logs (follows by default). |
| `shell` | `exec` into the panel container (`bash`, falls back to `sh`). |
| `version` | CLI, image tag (with the release behind `latest`), panel version, newest release. |
| `uninstall [-y]` | **Full uninstall** — destroys everything: containers, panel+DB images, volumes, networks, systemd units, cron jobs, `/opt/zagros`, `/var/lib/zagros` (databases, backups, certificates, logs, runtime data, caches), `/etc/zagros`, the CLI and the root-only host agent. Prints a removal summary first, then verifies nothing is left (second sweep + loud failure on any survivor). |

### Operations

| Command | Description |
|---|---|
| `doctor [--json]` | Docker daemon, compose, image presence, **GHCR digest vs remote**, newest-release currency, containers, `ZAGROS_SECRET_KEY`, database + migration head, cores, nodes, certificates (≤14d expiry), disk/memory/CPU, DNS, panel port, firewall, GHCR egress. Exit 1 when any check fails; `--json` is machine-pure (stdout = JSON, humans on stderr). |
| `health` | Quick composite probe (container + panel internals: db reachable & migrated, core counts). Exit 1 when unhealthy. |
| `repair` | Safe automatic fixes: start docker, dirs & permissions, missing env keys (refuses to invent `ZAGROS_SECRET_KEY` over an existing database), pull missing image, recreate unhealthy containers, legacy DB provisioning, schema at head, CLI reinstall. |
| `clean [--keep N]` | Prune old backups (default keep 7) + staging leftovers. |
| `prune` | Docker image prune + remove superseded panel image tags (keeps current + rollback candidate). |
| `migrate` | Run `alembic upgrade head` + health verification now. |

### Backup & restore

| Command | Description |
|---|---|
| `backup [--logs]` | Full archive in `/var/lib/zagros/backups/`: database (**hot-consistent**: SQLite backup API, `mysqldump --single-transaction`, or `pg_dump -Fc`), configuration + env, `.state`, and `panel-data.tar.gz` (certificates, keys, core/driver metadata, runtime config) — excluding re-downloadable core binaries/assets and (unless `--logs`) log files. Every exclusion is recorded in `manifest.meta`; `manifest.json` carries SHA-256 of every file. Archive is `0600`. |
| `backup-service` | System-only bundle: `/opt/zagros` + CLI binary + image pin list. |
| `restore [<file>\|latest] [--dry-run] [-y]` | Verifies tar readability, engine match (refuses cross-engine), SHA-256 integrity; prints the plan; takes a **safety snapshot**; stops services; restores db + config + data; starts; re-migrates; health-checks; and **auto-rolls back to the snapshot on failure**. |
| `rollback [--to <tag>] [--backup <file>] [-y]` | Roll back to the previous image tag (from `last-update.json`) or an explicit tag; falls back to the recorded backup when the image cannot come up healthy. |

### Core management (capability-driven)

Cores (xray, sing-box, hysteria2, tuic, wireguard, openvpn, ssh, softether)
self-install their **official upstream binaries** at runtime — the CLI passes
the operation to the panel's core manager through the in-container bridge.
When a core is running under the live panel process the answer is
`PANEL_OWNED` (exit 3) and the CLI does the honest thing: reload the panel.

| Command | Description |
|---|---|
| `list-cores [--json]` | Installed cores: `STATE`, `ENABLED`, `HEALTH`, `VERSION`, `CAPABILITIES` (+ stored entries whose driver is gone). |
| `install-core <core> [--settings JSON] [--disabled] [--no-start]` | SELF_INSTALL + enable; reloads the panel to boot it unless `--no-start`. |
| `update-core <core> [--version X]` | Update the core binary through the driver; panel reload when it was running. |
| `uninstall-core <core> [--purge] [--force]` | Dependency-checked removal; running cores exit 3 → CLI retries with `--force` + panel reload. |
| `reload-core <core>` | Restart a single core (hot when the panel allows it, otherwise via safe panel reload). |
| `sync [--core X]` | Re-apply every stored account to all enabled cores through each driver's `sync_accounts` (idempotent). Per-core errors are reported, not hidden. |

### Admin & configuration

| Command | Description |
|---|---|
| `advanced create-admin [--username U] [--password P] [--sudo]` | Create a sudo/normal admin; generates a one-time-shown password when omitted. |
| `advanced reset-admin [--username U] [--password P]` | Reset an admin's password. |
| `config [show]` | Print `/opt/zagros/.env` with secrets masked (`list` is an alias; `show` is the default action). |
| `config get KEY` | Print one value. |
| `config set KEY VALUE [--force] [--restart]` | Write one value **in place** (same inode, so the bind mount stays live); guards `ZAGROS_SECRET_KEY` rotation over an existing database (`--force` to override, `--restart` to apply). |
| `config edit` | Open `.env` in `$EDITOR`, then offer to restart. |
| `config reload` | Validate + restart — applies `.env` immediately. |
| `config validate` | Catches missing keys, bad ports, invalid `TLS_MODE`, `TLS_MODE=on` without cert/key, and the P3/legacy same-SQLite-file collision. |
| `config path` | Print the `.env` location. |

---

## Node servers — `install-node.sh` and `zagros-node`

A node runs the agent image
([`zagros-node`](https://github.com/ZagrosGM/zagros-node)); the installer and
the host CLI live **here**, next to the panel's own installer. The panel hands
out the exact command — *Nodes → installer command* — and it looks like this:

```bash
curl -fsSL https://raw.githubusercontent.com/ZagrosGM/zagros-scripts/main/install-node.sh \
  | bash -s -- --panel-id panel-xxxx --token <ONE-TIME-TOKEN> \
           --name de-1 --address 203.0.113.10 --port 62050 --api-port 62051
```

What it does, and nothing else: installs Docker if it is missing, writes
`/opt/zagros-node/{.env,docker-compose.yml}`, installs the `zagros-node` CLI,
pulls the image, starts the container and prints the pairing material (node id
and certificate SHA-256) you confirm in the panel. It is idempotent, and the
one-time token is never written to disk — only its SHA-256.

Which ref the command points at is decided by the panel: the tag matching its
own version when that tag exists, otherwise `main`. Override it with
`ZAGROS_SCRIPTS_REF` (or `ZAGROS_SCRIPTS_REPO_RAW` for a fork).

```bash
# on the node, once installed
zagros-node status              # container + core lifecycle state
zagros-node cores               # cores installed on this node
zagros-node env edit            # edit the node configuration, then apply
zagros-node logs -f             # agent log stream
zagros-node update              # pull the current image and recreate
zagros-node advanced cert       # certificate paths + the pinned fingerprint
```

`zagros-node` follows the same main/advanced split as `zagros`.

---

## Database engines

| Engine | What you get |
|---|---|
| `sqlite` (default) | Platform DB + legacy DB as two **separate files** in `/var/lib/zagros` (`zagros.db`, `legacy.db`). Zero extra services. |
| `mysql` / `mariadb` | Managed `zagros-db` container (mysql:8.4 / mariadb:11.5) on host networking; databases `zagros` + `zagros_legacy` auto-provisioned. |
| `postgresql` | Managed `zagros-db` container (postgres:17); databases `zagros` + `zagros_legacy` auto-provisioned. |

Both app stacks always use two logically separate databases — the P3 platform
schema and the legacy schema define same-named tables (`admins`, `users`,
`nodes`) with different shapes, so they must never share one database.

Restores are engine-locked: a backup taken under one engine can only be
restored onto the same engine (cross-engine migration is a manual DBA task —
run `zagros backup` first regardless).

---

## Security notes

* `.env` and every backup archive are `0600`; db credentials exist only
  inside `.env` — never on any command line and never baked into the
  compose file (compose interpolates them from `.env` at runtime).
* `backup`/`update` never proceed without a completed pre-backup unless you
  explicitly pass `--no-backup`.
* `repair` and `config set` refuse to auto-rotate `ZAGROS_SECRET_KEY` when a
  database exists (stored credentials would become unreadable).
* The installer adds only the documented CLI, root-only host agent and its two
  systemd units outside the managed data/config trees. Full Uninstall removes
  and verifies all of them.

---

## Verification (honest status)

* **CI on this repo** (`ci.yml`): ShellCheck (`-S warning`) for all three host
  scripts, plus the CLI harness from
  [zagros-devkit](https://github.com/ZagrosGM/zagros-devkit), which drives the
  **real** CLI through 269 assertions (install → config → admin → cores → backup →
  restore → update → forced-failure rollback → doctor → repair → clean/prune
  → full uninstall & verification) against a faithful docker/compose/hostctl
  double. GitHub runners additionally run the real-VPS E2E below.
* **Real-VPS E2E** (`e2e.yml`, `workflow_dispatch`): boots a fresh
  `ubuntu-latest` machine, runs the **real** one-liner install from GHCR,
  creates an admin, probes health/doctor, installs a core, does a full
  backup → mutate → restore cycle, and uninstalls. See the Actions tab for
  the latest run.
* The in-container bridge (`app.platform.hostctl`) is tested directly by the
  panel's pytest suite (15 tests, real subprocesses against the real code —
  see the main repository).

Limitations: `wireguard/openvpn/softether/ssh` are *privileged* cores and need
`NET_ADMIN` plus kernel support. Native SoftEther outbound namespaces also
need `SYS_ADMIN`; the generated Compose grants both while withholding the
Docker socket and host PID namespace. Doctor's firewall check is informational
(host firewalling is site-specific); `restore` across different database
engines is intentionally refused.

---

## Development

```bash
bash -n zagros zagros.sh                  # syntax
shellcheck -x -S warning zagros zagros.sh # lint

# the end-to-end CLI harness lives in the devkit repository
git clone https://github.com/ZagrosGM/zagros-devkit.git
bash zagros-devkit/zagros-scripts/tests/test_cli.sh
```

Contributions welcome; keep the honesty contract: no TODOs, no placeholders,
no mocks in product paths, and every user-visible command documented in this
README **and** covered by the test suite.

## Community

* **Telegram channel (announcements):** <https://t.me/zagrosgm>
* **Telegram group (discussion & support):** <https://t.me/zagrosgm_group>
* **Panel repository:** <https://github.com/ZagrosGM/Zagros>
* **This repository:** <https://github.com/ZagrosGM/zagros-scripts>

## License

[AGPL-3.0](LICENSE) — same as the Zagros panel.

## Optional independent PPTP runtime

The installer prepares (but does not enable) the panel container for Zagros'
legacy/insecure ACCEL-PPP provider by mounting `/dev/ppp` and granting explicit
`NET_ADMIN` + `NET_RAW`. It attempts to load `ppp_generic`, `ppp_mppe`, `pppox`,
`pptp`, `nf_conntrack_pptp`, and `nf_nat_pptp`; no listener starts until the
provider is explicitly installed,
configured, enabled and started in the panel. `privileged:true`, Docker socket
access and host PID access are not used. `zagros doctor` reports missing PPP
kernel/device support as an environment limitation.

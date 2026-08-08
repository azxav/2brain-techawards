#!/usr/bin/env bash
#
# Idempotent control-plane deploy for stock Ubuntu 24.04 (#46).
#
# Bash rather than Bun because Bun does not exist on the VM until this script
# puts it there. Every step is written to be re-runnable: install if absent,
# fetch-and-reset rather than clone, write-then-compare units. That re-run is the
# upgrade path, not a curiosity, so anything that only works once is a bug here.
#
# A second run converges on the same box and exits 0. It is not a no-op, and one
# step is deliberately not: it always restarts the service. An operator's env edit
# changes no file this script hashes, so there is nothing here to compare it
# against, and edit → verify → restart is the flow the /usr/local/sbin copy of the
# validator exists to serve. Everything else a second run touches, it touches only
# if the bytes differ.
#
# There is no separate migrate step: src/index.ts migrates before it listens, so
# a healthy /healthz is what proves the deploy landed.
#
# Preconditions this script does not create — the operator writes all three from
# escrow before the first run, at exactly these paths (README.md, beside this
# file, is the runbook for producing them and for everything else automation
# cannot do: cloud scaffolding, escrow, restore, rebuild):
#   /etc/gbrain-cp/control-plane.env   the full environment
#   /etc/gbrain-cp/oci-api-key.pem     the control plane's OCI API signing key
#   /etc/gbrain-cp/deploy-key          a read-only SSH deploy key for the repo
# Pre-flight refuses a box missing any of them, and the validator pins the signing
# key to that path rather than trusting OCI_PRIVATE_KEY_PATH to name a readable one.
#
# Run it from a copy of cloud/deploy/ placed *outside* $CHECKOUT (see the guard
# below), taken from the same ref as $REPO_REF: the systemd units come from this
# directory while the code they run comes from the checkout, so a stale copy here
# deploys units that do not match the code.
#
# Exit 2 means the box or the operator's inputs are wrong and nothing was changed;
# any other non-zero means a step broke part-way and the box is half-built. That
# promise is only worth what its weakest refusal is worth, so every exit 2 lives
# in the pre-flight block below, above the first thing that mutates the box. A new
# one added further down would be a lie about the two lines above.
#
# The broken-step class is not reliably 1. Only two failures here exit 1 by hand:
# an unparseable CP_DATABASE_URL the validator already accepted, and /healthz not
# answering in time. Everything else dies under `set -e` carrying the failing
# command's own status — apt exits 100, curl 22. Read it as "not 0 and not 2".
#
# Usage: sudo ./install.sh
set -euo pipefail

# The checkout and node_modules are created with the ambient umask and must stay
# readable by the service user. An operator shell with umask 077 would otherwise
# hand the service a tree it cannot read, and the failure would surface as a
# crash loop rather than as anything to do with this script. Nothing secret is
# written at the ambient umask: the env file, the signing key, and the deploy key
# all get an explicit mode below.
umask 022

# Must equal cloud/image/scripts/provision.sh: the control plane and the fleet it
# provisions run the same Bun and the same Postgres major. Enforced by
# cloud/test/deploy-contract.test.ts.
BUN_VERSION="${BUN_VERSION:-1.3.14}"
POSTGRES_MAJOR="${POSTGRES_MAJOR:-16}"
APT_LOCK_WAIT_SECONDS="${APT_LOCK_WAIT_SECONDS:-300}"
APT_LOCK_RETRY_SECONDS="${APT_LOCK_RETRY_SECONDS:-5}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
# Public-origin poll: retries × 2s. A first-ever ACME issuance is not instant, so
# this window is deliberately wider than the localhost one.
PUBLIC_HEALTH_RETRIES="${PUBLIC_HEALTH_RETRIES:-90}"

# These defaults must name a tree that actually contains the control plane at
# cloud/src/index.ts. The repo was renamed gbrain -> 2brain (the old URL only
# 301-redirects, which git honours for fetch but is not something to depend on),
# and the control plane lives on `dashboard` until #46 lands on master. A wrong
# default here does not fail loudly: `git reset --hard` succeeds against whatever
# it fetched, `bun run src/index.ts` then dies "Module not found", and the unit
# crash-loops — a healthy box turned unhealthy by a deploy that reported nothing
# wrong until the health poll ran out. When #46 merges, flip REPO_REF to master
# in the same change that merges it.
REPO_URL="${REPO_URL:-git@github.com:azxav/2brain.git}"
REPO_REF="${REPO_REF:-dashboard}"
CHECKOUT="${CHECKOUT:-/opt/gbrain-cp}"
ENV_DIR=/etc/gbrain-cp
ENV_FILE="$ENV_DIR/control-plane.env"
DEPLOY_KEY="$ENV_DIR/deploy-key"
SERVICE_USER=gbrain-cp
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Bounded, lock-specific apt retry, copied from the image provisioner: a delayed
# unattended-upgrade or cloud agent can hold the dpkg lock well after the box
# reports ready, and blanket retries would paper over real package failures.
run_apt() {
  local deadline error_file status
  deadline=$((SECONDS + APT_LOCK_WAIT_SECONDS))

  while true; do
    error_file="$(mktemp)"
    if command apt-get "$@" 2>"$error_file"; then
      status=0
    else
      status=$?
    fi
    cat "$error_file" >&2

    if [[ "$status" -eq 0 ]]; then
      rm -f "$error_file"
      return 0
    fi
    if ! grep -Eq 'Could not get lock|Unable to acquire' "$error_file" \
      || (( SECONDS >= deadline )); then
      rm -f "$error_file"
      return "$status"
    fi

    rm -f "$error_file"
    echo "[deploy] apt is locked by another process; retrying in ${APT_LOCK_RETRY_SECONDS}s" >&2
    sleep "$APT_LOCK_RETRY_SECONDS"
  done
}

# Writes $dest only when the bytes differ, so an unchanged unit keeps its mtime and
# `systemctl status` still names the install that actually changed something.
#
# Deliberately does not report whether it wrote. It used to, and the one caller used
# that to reload only on a write — which is how systemd's in-memory state came apart
# from the bytes on disk: a run that wrote a unit and then died before the reload
# (caddy validate fails, SSH drops, Ctrl-C) left the next run comparing equal,
# skipping the reload nobody had done, and restarting the stale unit. See the
# unconditional daemon-reload below.
install_if_changed() {
  local mode="$1" src="$2" dest="$3"
  if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
    return 0
  fi
  install -m "$mode" "$src" "$dest"
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "install.sh must run as root" >&2
  exit 2
fi

. /etc/os-release
if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
  echo "Unsupported host: expected Ubuntu 24.04, got ${PRETTY_NAME:-unknown}" >&2
  exit 2
fi

# This script rewrites $CHECKOUT with `git reset --hard`. Bash reads a script
# incrementally, by byte offset, so if this file lived inside that tree an
# upgrade run would swap the bytes under the running interpreter and execute
# garbage from the middle of the new file.
if [[ "$HERE" == "$CHECKOUT" || "$HERE" == "$CHECKOUT"/* ]]; then
  echo "run install.sh from a copy outside $CHECKOUT: it rewrites that tree" >&2
  exit 2
fi

# --- pre-flight: every refusal, before the first mutation -----------------------
#
# Before apt, before git: an input found to be wrong afterwards leaves a half-built
# box the next run has to reason about. That reasoning is the cost these checks
# exist to avoid, so they are grouped rather than each landing where its value
# happens to be first used.

# This copy of deploy/ is an input like any other. The units come from here while
# the code they run comes from the checkout, so a directory missing a unit fails
# only after apt, Bun, and a clone — and only for whichever file was dropped.
for deploy_file in \
  "$HERE/bin/gbrain-cp-verify-env" \
  "$HERE/files/systemd/gbrain-control-plane.service" \
  "$HERE/files/systemd/gbrain-control-plane-backup.service" \
  "$HERE/files/systemd/gbrain-control-plane-backup.timer"; do
  if [[ ! -f "$deploy_file" ]]; then
    echo "incomplete deploy directory: missing $deploy_file" >&2
    exit 2
  fi
done

# The deploy key is the same class of precondition as the env file: written from
# escrow by the operator, needed by a step near the end, and worth nothing to
# discover late. It used to be checked beside its first use, twelve apt packages
# and a Bun install too late for the exit-2 contract above to be true.
if [[ ! -f "$DEPLOY_KEY" ]]; then
  echo "missing read-only deploy key: $DEPLOY_KEY" >&2
  exit 2
fi

# Likewise: a $CHECKOUT that is not a checkout is an operator-resolvable state, and
# the fetch below is far too late to say so.
if [[ -e "$CHECKOUT" && ! -d "$CHECKOUT/.git" ]]; then
  echo "$CHECKOUT exists but is not a git checkout; remove it and re-run" >&2
  exit 2
fi

# The file is the only input — the validator drops anything it inherited from this
# shell. It parses with python3, which this script has not installed yet; the host
# guard above is what makes that safe, since every Ubuntu 24.04 cloud image ships
# python3 for cloud-init. Installing python3 first would defeat the point of
# validating first.
CP_ENV_FILE="$ENV_FILE" "$HERE/bin/gbrain-cp-verify-env"

# --- end pre-flight: everything below changes the box ---------------------------

export DEBIAN_FRONTEND=noninteractive
run_apt update
run_apt install -y --no-install-recommends \
  apt-transport-https \
  ca-certificates \
  curl \
  git \
  gnupg \
  iptables-persistent \
  jq \
  python3 \
  postgresql-common \
  sudo \
  unzip

# Oracle's stock Ubuntu image ships a host INPUT chain that ACCEPTs SSH and then
# REJECTs every other new connection, so 80/443 are blocked at the OS firewall
# even when the NSG and subnet security list allow them. Caddy's ACME challenge
# (tls-alpn-01, over 443) then never completes and no certificate issues, while
# the localhost health poll below still passes — a deploy that reports success and
# serves nothing. The workspace image opens these in provision.sh before it bakes;
# the control-plane box needs the same. Idempotent, then persisted across reboot:
# insert only when the rule is absent, save via netfilter-persistent (the
# iptables-persistent package above).
for port in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
  fi
done
netfilter-persistent save

if [[ ! -f /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc ]]; then
  install -d -m 0755 /usr/share/postgresql-common/pgdg
  # --remove-on-error: curl creates the output file the moment the response starts,
  # so a transfer that dies halfway leaves a truncated key that the guard above then
  # reads as "already fetched" on every later run. Verified against curl 8.5.0, the
  # version Ubuntu 24.04 ships: a 200 whose body is cut short exits 18 and, without
  # this flag, leaves the partial file behind.
  curl --fail --silent --show-error --remove-on-error \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
fi
cat >/etc/apt/sources.list.d/pgdg.sources <<EOF
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: ${VERSION_CODENAME}-pgdg
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
EOF

# Guard the key, write the list unconditionally — the shape of the pgdg block
# above, and for the reason that block reads oddly until you need it. One guard
# over both writes turns a blip between them into a permanent wedge: the keyring
# lands, the list does not, and every later run sees the keyring, skips the whole
# block, and installs caddy from a repo that was never added. The box then stays
# broken until someone thinks to rm a keyring by hand. provision.sh gets away with
# writing both unconditionally because it is one-shot; adding the guard is what
# introduced the trap, so the guard is what has to be narrow.
#
# Both files land on a temp path and are installed only once the transfer finished,
# so a half-file can never be mistaken for a done one. That is also why the key is
# fetched and dearmored in two steps rather than the `curl | gpg --dearmor -o` this
# used to be: --remove-on-error cleans up after a direct `curl -o`, but there is no
# equivalent for the pipe, where gpg creates the keyring, then reads a stream that
# stops early, and pipefail aborts with the ruined file already in place.
caddy_tmp="$(mktemp -d)"
trap 'rm -rf "$caddy_tmp"' EXIT
if [[ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
  curl -1sLf --remove-on-error https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    -o "$caddy_tmp/caddy.asc"
  gpg --dearmor -o "$caddy_tmp/caddy.gpg" "$caddy_tmp/caddy.asc"
  install -m 0644 "$caddy_tmp/caddy.gpg" /usr/share/keyrings/caddy-stable-archive-keyring.gpg
fi
curl -1sLf --remove-on-error https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  -o "$caddy_tmp/caddy-stable.list"
install -m 0644 "$caddy_tmp/caddy-stable.list" /etc/apt/sources.list.d/caddy-stable.list

run_apt update
# No pgvector here: the control-plane registry is plain relational tables. The
# workspace image is the one that needs the extension.
#
# postgresql-client-16, NOT postgresql-16-client. The second spelling has never
# existed in any Debian or pgdg archive, and it is not a typo anyone makes twice —
# it is a pattern-match. `postgresql-N-<name>` is the *extension* form, and the
# workspace image sitting one directory away installs postgresql-16-pgvector in
# exactly that shape, so the wrong spelling looks like it has a precedent right
# there. It does not. apt answers "Unable to locate package" and the first run of
# every fresh box dies here, a dozen packages deep. deploy-contract.test.ts pins
# both the right spelling and the absence of the wrong one.
#
# postgresql-16 already depends on the client, so this line is redundant — it is
# spelled out because the CREATE ROLE step below invokes psql directly.
run_apt install -y --no-install-recommends \
  caddy \
  "postgresql-${POSTGRES_MAJOR}" \
  "postgresql-client-${POSTGRES_MAJOR}"

if [[ "$(/usr/local/bin/bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]]; then
  export BUN_INSTALL=/usr/local/lib/bun
  curl -fsSL https://bun.com/install | bash -s "bun-v${BUN_VERSION}"
  ln -sfn /usr/local/lib/bun/bin/bun /usr/local/bin/bun
fi
/usr/local/bin/bun --version

if ! getent group "$SERVICE_USER" >/dev/null; then
  groupadd --system "$SERVICE_USER"
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_USER" --home-dir "/var/lib/$SERVICE_USER" \
    --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 0750 -o root -g "$SERVICE_USER" "$ENV_DIR"
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "/var/lib/$SERVICE_USER"
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"
# Unconditional: the validator pins OCI_PRIVATE_KEY_PATH to exactly this path and
# refuses a file that is not there, so by here it exists. The `if -f` this replaces
# was the gap — it silently skipped when the operator pointed the env elsewhere,
# and left the service a key it could not read.
chown root:"$SERVICE_USER" "$ENV_DIR/oci-api-key.pem"
chmod 0640 "$ENV_DIR/oci-api-key.pem"

# Existence is checked in pre-flight; this only fixes the mode.
chown root:root "$DEPLOY_KEY"
chmod 0600 "$DEPLOY_KEY"
export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

# The checkout stays root-owned. git refuses to touch a repository owned by
# another user, and that refusal applies to root too, so handing this tree to
# $SERVICE_USER would clone once and then fail every re-run. Telling git to trust
# it instead would be worse: $SERVICE_USER could then plant a .git/config whose
# core.pager or core.fsmonitor runs as root on the next fetch. The service only
# ever reads this tree — ProtectSystem=strict denies it writes regardless — so
# root ownership costs nothing and is what the image provisioner does for /opt/gbrain.
#
# Pre-flight has already refused a $CHECKOUT that exists but is not a checkout, so
# the two branches here are the only two states left.
if [[ -d "$CHECKOUT/.git" ]]; then
  # set-url first: without it a changed REPO_URL is silently ignored, because
  # fetch would keep using whatever origin the original clone recorded.
  git -C "$CHECKOUT" remote set-url origin "$REPO_URL"
  git -C "$CHECKOUT" fetch --depth 1 origin "$REPO_REF"
  git -C "$CHECKOUT" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$CHECKOUT"
fi

# --production, like provision.sh: cloud/src imports express, postgres, and node
# builtins, and nothing else. The devDependencies are pglite (a multi-megabyte wasm
# blob used only by cloud/test), typescript, and @types/* — none of which a box
# that runs `bun run src/index.ts` has any use for.
/usr/local/bin/bun install --frozen-lockfile --production --cwd "$CHECKOUT/cloud"

# `mapfile` reports success even when the process substitution feeding it died,
# so the arity check below — not set -e — is what stops a failed parse here. An
# empty array would trip set -u at ${db_parts[0]}, but as a bare exit 1 naming a
# bash internal; three lines with an empty middle would not trip it at all and
# would reach CREATE ROLE with an empty password. Hence both the check and the
# parser's own refusal.
mapfile -t db_parts < <(python3 - "$ENV_FILE" <<'PY'
import re
import shlex
import sys
from urllib.parse import unquote, urlparse

url = None
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        match = re.fullmatch(r"CP_DATABASE_URL=(.*)", line.rstrip("\n"))
        if match:
            parts = shlex.split(match.group(1), comments=False, posix=True)
            url = parts[0] if parts else ""
if not url:
    raise SystemExit("CP_DATABASE_URL not found")
parsed = urlparse(url)
name = parsed.path.removeprefix("/")
user = unquote(parsed.username or "")
password = unquote(parsed.password or "")
if not name or not user or not password:
    raise SystemExit("database URL must include database, user, and password")
print(user)
print(password)
print(name)
PY
)
# exit 1, not 2, and it is the difference the header defines: the validator already
# accepted this same URL through the same urlparse in pre-flight, so if the parse
# fails *here* the operator's input is not what is wrong — a step is. Exit 2 would
# also be a lie by then, because apt, Bun, and a clone have all run.
if [[ "${#db_parts[@]}" -ne 3 ]]; then
  echo "could not parse CP_DATABASE_URL from $ENV_FILE, though the validator accepted it" >&2
  exit 1
fi
DB_USER="${db_parts[0]}"
DB_PASSWORD="${db_parts[1]}"
DB_NAME="${db_parts[2]}"

# %I/%L quote the identifier and literal so an operator's password cannot be
# read as SQL syntax; \gexec runs only the rows the WHERE NOT EXISTS produced,
# which is what makes a re-run a no-op instead of a duplicate-object error. The
# unconditional ALTERs re-assert the password and owner if the env file changed.
systemctl enable --now postgresql.service
sudo -u postgres psql --set=ON_ERROR_STOP=1 \
  --set=db_user="$DB_USER" --set=db_password="$DB_PASSWORD" --set=db_name="$DB_NAME" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'db_user') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'db_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'db_user') \gexec
SQL

for unit in gbrain-control-plane.service gbrain-control-plane-backup.service gbrain-control-plane-backup.timer; do
  install_if_changed 0644 "$HERE/files/systemd/$unit" "/etc/systemd/system/$unit"
done
# Unconditional, and reloading right here rather than further down. `cmp` above
# compares bytes on disk; daemon-reload mutates systemd's in-memory copy. Those two
# are only in sync if every run that wrote also reloaded, and a run can end between
# the two: the next run then finds the file already correct, skips the reload that
# never happened, and `systemctl restart` starts the *stale* unit. Health passes,
# the deploy reports success, and the box is running a unit no file describes. The
# reload costs ~50ms. It is not worth reasoning about which run wrote what.
systemctl daemon-reload
# Not used again below — this copy is for the operator, who must re-run it after
# editing the env file and before restarting the service.
install -m 0755 "$HERE/bin/gbrain-cp-verify-env" /usr/local/sbin/gbrain-cp-verify-env

CP_ORIGIN="$(python3 - "$ENV_FILE" <<'PY'
import re
import shlex
import sys
from urllib.parse import urlparse

value = None
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        match = re.fullmatch(r"CP_BASE_URL=(.*)", line.rstrip("\n"))
        if match:
            parts = shlex.split(match.group(1), comments=False, posix=True)
            value = parts[0] if parts else ""
if not value:
    raise SystemExit("CP_BASE_URL not found")
host = urlparse(value).hostname
if not host:
    raise SystemExit("CP_BASE_URL has no hostname")
print(host)
PY
)"
CP_PORT_VALUE="$(python3 - "$ENV_FILE" <<'PY'
import re
import shlex
import sys

port = "8080"
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        match = re.fullmatch(r"CP_PORT=(.*)", line.rstrip("\n"))
        if match:
            parts = shlex.split(match.group(1), comments=False, posix=True)
            if parts:
                port = parts[0]
print(port)
PY
)"

cat >/etc/caddy/Caddyfile <<EOF
${CP_ORIGIN} {
    encode zstd gzip
    header -Server
    reverse_proxy 127.0.0.1:${CP_PORT_VALUE}
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# enable, then restart: restart starts a stopped unit, so `enable --now` followed
# by a restart would only queue a redundant start job. The restart is what makes
# a re-run pick up the code the fetch above just moved.
systemctl enable gbrain-control-plane.service
systemctl restart gbrain-control-plane.service
# The timer, never the backup service: the timer's Unit= is what pulls the oneshot
# in, and the oneshot carries no [Install] so that it cannot be enabled on its own.
# Enabling it here would not double the backups, it would schedule none — and it
# would not even fail: systemd exits 0, advises on stderr, and creates no symlink.
systemctl enable --now gbrain-control-plane-backup.timer

for _ in $(seq 1 "$HEALTH_TIMEOUT_SECONDS"); do
  if curl --fail --silent "http://127.0.0.1:${CP_PORT_VALUE}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
# Restart=always means a crash-looping unit never reaches `failed`, so the poll
# above cannot tell "still starting" from "dead" and simply runs out. Say so, and
# print the evidence: otherwise this is a bare curl connection error after a
# minute of silence.
if ! curl --fail --silent --show-error "http://127.0.0.1:${CP_PORT_VALUE}/healthz" >/dev/null; then
  echo "[deploy] control plane did not answer /healthz within ${HEALTH_TIMEOUT_SECONDS}s" >&2
  systemctl --no-pager --full status gbrain-control-plane.service >&2 || true
  journalctl --no-pager --lines=50 --unit gbrain-control-plane.service >&2 || true
  exit 1
fi

# Only now point the public listener at it. Caddy's .deb enables and starts it on
# install, but that is the packaging's choice, not ours — assert it, then reload
# so the Caddyfile written above takes effect on a re-run too.
systemctl enable --now caddy.service
systemctl reload caddy.service
systemctl is-active --quiet \
  postgresql.service \
  gbrain-control-plane.service \
  caddy.service

# The localhost poll above proved the app process answers; it cannot see the OS
# firewall, the NSG, the DNS record, or ACME. That blind spot is exactly what let
# a first deploy report success while public 443 was firewalled and no certificate
# had issued. Exercise the real public origin over real DNS and TLS, and fail the
# deploy if it never answers — this catches that whole class at once rather than
# one symptom at a time. `--fail` treats a non-2xx (a Caddy 502 while the app is
# down, an ACME-not-ready page) as failure too.
PUBLIC_HEALTH_URL="https://${CP_ORIGIN}/healthz"
for _ in $(seq 1 "$PUBLIC_HEALTH_RETRIES"); do
  if curl --fail --silent "$PUBLIC_HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! curl --fail --silent --show-error "$PUBLIC_HEALTH_URL" >/dev/null; then
  echo "[deploy] control plane did not answer ${PUBLIC_HEALTH_URL} over public HTTPS within $((PUBLIC_HEALTH_RETRIES * 2))s" >&2
  echo "[deploy] check the OS firewall (iptables 80/443), the workspace NSG and subnet security list, the ${CP_ORIGIN} DNS record, and 'journalctl -u caddy' for ACME errors" >&2
  exit 1
fi

echo "2Brain control plane deployed for https://${CP_ORIGIN}"

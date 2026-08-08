#!/usr/bin/env bash
set -euo pipefail

SOURCE_ARCHIVE="${1:?usage: provision.sh <gbrain-source.tar.gz> <image-bundle-dir>}"
IMAGE_BUNDLE="${2:?usage: provision.sh <gbrain-source.tar.gz> <image-bundle-dir>}"
IMAGE_FILES="$IMAGE_BUNDLE/files"
OPENCLAW_PACKAGE="$IMAGE_BUNDLE/openclaw"
NODE_VERSION="24.15.0"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-arm64.tar.xz"
NODE_SHA256="f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0"
OPENCLAW_VERSION="2026.7.1-2"
BUN_VERSION="${BUN_VERSION:-1.3.14}"
POSTGRES_MAJOR="${POSTGRES_MAJOR:-16}"
APT_LOCK_WAIT_SECONDS="${APT_LOCK_WAIT_SECONDS:-300}"
APT_LOCK_RETRY_SECONDS="${APT_LOCK_RETRY_SECONDS:-5}"

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
    echo "[image] apt is locked by another process; retrying in ${APT_LOCK_RETRY_SECONDS}s" >&2
    sleep "$APT_LOCK_RETRY_SECONDS"
  done
}

if [[ "$(dpkg --print-architecture)" != "arm64" ]]; then
  echo "expected an arm64 base image for the Ampere A2 workspace image" >&2
  exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "provision.sh must run as root" >&2
  exit 2
fi

# The Packer contract intentionally accepts an explicit base image OCID, but
# the provisioner is narrow: Ubuntu 24.04 is the supported production base.
# Failing here prevents a superficially successful image with wrong package or
# systemd behavior.
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
  echo "Unsupported base image: expected Ubuntu 24.04, got ${PRETTY_NAME:-unknown}" >&2
  exit 2
fi

# OCI marks the VM RUNNING before first-boot cloud-init finishes. The Oracle
# Cloud Agent can also start a delayed apt update after cloud-init reports done,
# so every package operation below uses the bounded, lock-specific retry.
timeout 10m cloud-init status --wait

export DEBIAN_FRONTEND=noninteractive
run_apt update
run_apt install -y --no-install-recommends \
  apt-transport-https \
  ca-certificates \
  cloud-init \
  curl \
  debian-archive-keyring \
  debian-keyring \
  e2fsprogs \
  git \
  gnupg \
  iptables-persistent \
  jq \
  python3 \
  postgresql-common \
  sudo \
  util-linux \
  unzip

# PostgreSQL's official APT repository keeps the database major explicit and
# carries the matching pgvector extension package.
install -d -m 0755 /usr/share/postgresql-common/pgdg
curl --fail --silent --show-error \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
cat >/etc/apt/sources.list.d/pgdg.sources <<EOF
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: ${VERSION_CODENAME}-pgdg
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
EOF

# Caddy's official Debian/Ubuntu repository installs the upstream systemd unit.
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  -o /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
  /etc/apt/sources.list.d/caddy-stable.list

run_apt update
run_apt install -y --no-install-recommends \
  caddy \
  "postgresql-${POSTGRES_MAJOR}" \
  "postgresql-${POSTGRES_MAJOR}-pgvector"

# Install a pinned Bun runtime. The source tree and lockfile are supplied from
# the exact git commit recorded in the Packer manifest.
export BUN_INSTALL=/usr/local/lib/bun
curl -fsSL https://bun.com/install | bash -s "bun-v${BUN_VERSION}"
ln -sfn /usr/local/lib/bun/bin/bun /usr/local/bin/bun
/usr/local/bin/bun --version

node_tmp="$(mktemp -d)"
trap 'rm -rf "$node_tmp"' EXIT
curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
  --output "$node_tmp/$NODE_ARCHIVE"
printf '%s  %s\n' "$NODE_SHA256" "$node_tmp/$NODE_ARCHIVE" \
  | sha256sum --check
install -d -m 0755 "/opt/node-v${NODE_VERSION}"
tar -xJf "$node_tmp/$NODE_ARCHIVE" \
  --strip-components=1 \
  -C "/opt/node-v${NODE_VERSION}"
"/opt/node-v${NODE_VERSION}/bin/node" --version \
  | grep -Fx "v${NODE_VERSION}"

install -d -m 0755 /opt/openclaw
install -m 0644 "$OPENCLAW_PACKAGE/package.json" /opt/openclaw/package.json
install -m 0644 "$OPENCLAW_PACKAGE/package-lock.json" /opt/openclaw/package-lock.json
(
  cd /opt/openclaw
  # Run npm ci --omit=dev --no-audit --no-fund with the pinned Node runtime.
  PATH="/opt/node-v${NODE_VERSION}/bin:$PATH" \
    "/opt/node-v${NODE_VERSION}/bin/npm" \
    ci --omit=dev --no-audit --no-fund
)
installed_openclaw_version="$(
  "/opt/node-v${NODE_VERSION}/bin/node" \
    -p "require('/opt/openclaw/node_modules/openclaw/package.json').version"
)"
if [[ "$installed_openclaw_version" != "$OPENCLAW_VERSION" ]]; then
  echo "expected OpenClaw 2026.7.1-2, got $installed_openclaw_version" >&2
  exit 2
fi
install -m 0755 "$IMAGE_FILES/bin/openclaw" /usr/local/bin/openclaw
/usr/local/bin/openclaw --version
chown -R root:root "/opt/node-v${NODE_VERSION}" /opt/openclaw /usr/local/bin/openclaw
chmod -R go-w "/opt/node-v${NODE_VERSION}" /opt/openclaw /usr/local/bin/openclaw
PATH="/opt/node-v${NODE_VERSION}/bin:$PATH" \
  "/opt/node-v${NODE_VERSION}/bin/npm" cache clean --force
rm -rf "$node_tmp"
trap - EXIT

if ! getent group gbrain >/dev/null; then
  groupadd --system gbrain
fi
if ! id gbrain >/dev/null 2>&1; then
  useradd --system --gid gbrain --home-dir /var/lib/gbrain \
    --create-home --shell /usr/sbin/nologin gbrain
fi
if ! getent group openclaw >/dev/null; then
  groupadd --system openclaw
fi
if ! id openclaw >/dev/null 2>&1; then
  useradd --system --gid openclaw --home-dir /var/lib/openclaw \
    --no-create-home --shell /usr/sbin/nologin openclaw
fi
openclaw_uid="$(id -u openclaw)"
if [[ "$openclaw_uid" -eq 0 || "$openclaw_uid" -lt 100 || "$openclaw_uid" -gt 999 ]]; then
  echo "openclaw must use a nonzero Ubuntu system UID" >&2
  exit 2
fi
openclaw_primary_group="$(id -gn openclaw)"
openclaw_primary_gid="$(getent group "$openclaw_primary_group" | cut -d: -f3)"
if [[ "$openclaw_primary_group" != "openclaw" ]] \
  || [[ "$openclaw_primary_gid" -eq 0 || "$openclaw_primary_gid" -lt 100 || "$openclaw_primary_gid" -gt 999 ]]; then
  echo "openclaw must use the nonzero openclaw Ubuntu system primary group" >&2
  exit 2
fi
if [[ "$(getent passwd openclaw | cut -d: -f6)" != "/var/lib/openclaw" ]]; then
  echo "openclaw must use /var/lib/openclaw as its home directory" >&2
  exit 2
fi
openclaw_groups="$(id -nG openclaw)"
if [[ "$openclaw_groups" != "openclaw" ]]; then
  echo "openclaw must belong only to the openclaw group" >&2
  exit 2
fi
for prohibited_group in gbrain sudo; do
  if id -nG openclaw | tr ' ' '\n' | grep -Fxq "$prohibited_group"; then
    echo "openclaw must not belong to the $prohibited_group group" >&2
    exit 2
  fi
done
if [[ "$(getent passwd openclaw | cut -d: -f7)" != "/usr/sbin/nologin" ]]; then
  echo "openclaw must use the non-login shell /usr/sbin/nologin" >&2
  exit 2
fi

OPENCLAW_STORAGE_BYTES=$((10 * 1024 * 1024 * 1024))
OPENCLAW_STORAGE_IMAGE=/var/lib/openclaw.img
OPENCLAW_STORAGE_MOUNT=/var/lib/openclaw
OPENCLAW_FSTAB_ENTRY="/var/lib/openclaw.img /var/lib/openclaw ext4 loop,nodev,nosuid 0 2"

install -d -m 0755 -o root -g root "$OPENCLAW_STORAGE_MOUNT"
if [[ ! -f "$OPENCLAW_STORAGE_IMAGE" ]]; then
  truncate -s "$OPENCLAW_STORAGE_BYTES" "$OPENCLAW_STORAGE_IMAGE"
  chmod 0600 "$OPENCLAW_STORAGE_IMAGE"
  mkfs.ext4 -F -L openclaw-state "$OPENCLAW_STORAGE_IMAGE"
fi
if ! grep -Fqx "$OPENCLAW_FSTAB_ENTRY" /etc/fstab; then
  printf '%s\n' "$OPENCLAW_FSTAB_ENTRY" >>/etc/fstab
fi
if ! mountpoint -q "$OPENCLAW_STORAGE_MOUNT"; then
  mount "$OPENCLAW_STORAGE_MOUNT"
fi
openclaw_storage_source="$(findmnt -n -o SOURCE --target "$OPENCLAW_STORAGE_MOUNT")"
openclaw_storage_size="$(blockdev --getsize64 "$openclaw_storage_source")"
openclaw_storage_options="$(findmnt -n -o OPTIONS --target "$OPENCLAW_STORAGE_MOUNT")"
if [[ "$openclaw_storage_size" -ne "$OPENCLAW_STORAGE_BYTES" ]] \
  || [[ ",$openclaw_storage_options," != *,nodev,* ]] \
  || [[ ",$openclaw_storage_options," != *,nosuid,* ]]; then
  echo "OpenClaw storage mount does not match the 10 GiB nodev,nosuid contract" >&2
  exit 2
fi

install -d -m 0700 -o openclaw -g openclaw \
  /var/lib/openclaw/.openclaw \
  /var/lib/openclaw/browser \
  /var/lib/openclaw/workspace
ln -sfn ../browser /var/lib/openclaw/.openclaw/browser
chown -h openclaw:openclaw /var/lib/openclaw/.openclaw/browser
install -d -m 0750 -o root -g openclaw /etc/openclaw

# The GBrain provider bridge: the one GBrain-owned plugin inside the pinned
# OpenClaw runtime. It lives OUTSIDE /var/lib/openclaw and is installed
# root-owned, directories 0755 and files 0644, so the agent identity can read
# and load it but can never rewrite its own privileged credential-import route.
# Each file is installed by name rather than copied as a tree: `cp -r` would
# carry the checkout's own ownership and mode through, and a stray file added
# to the bundle directory would be installed without review.
install -d -m 0755 -o root -g root /usr/local/share/openclaw
install -d -m 0755 -o root -g root /usr/local/share/openclaw/gbrain-agent-bridge
for bridge_file in package.json openclaw.plugin.json index.js; do
  install -m 0644 -o root -g root \
    "$IMAGE_FILES/openclaw/gbrain-agent-bridge/$bridge_file" \
    "/usr/local/share/openclaw/gbrain-agent-bridge/$bridge_file"
done
# The same safeguard the /opt runtime trees carry, and for the same reason: the
# `install` modes above are the only thing standing between the agent identity
# and its own credential-import route, and a single later `chmod` would undo
# them. The PARENT is included deliberately — write permission on
# /usr/local/share/openclaw alone lets openclaw `mv` the bridge aside and
# substitute its own plugin without ever touching the bridge directory's mode.
chown -R root:root /usr/local/share/openclaw
chmod -R go-w /usr/local/share/openclaw

install -d -m 0755 -o root -g root /opt/gbrain
tar -xzf "$SOURCE_ARCHIVE" -C /opt/gbrain
cd /opt/gbrain
/usr/local/bin/bun install --frozen-lockfile --production
/usr/local/bin/bun build --compile --outfile /usr/local/bin/gbrain src/cli.ts
chmod 0755 /usr/local/bin/gbrain
/usr/local/bin/gbrain --version

install -d -m 0700 -o gbrain -g gbrain /var/lib/gbrain
install -d -m 0750 -o root -g gbrain /etc/gbrain
install -d -m 0755 /usr/local/libexec/gbrain

for unit in gbrain-web.service gbrain-worker.service gbrain-scheduler.service gbrain-agent.service; do
  install -m 0644 "$IMAGE_FILES/systemd/$unit" "/etc/systemd/system/$unit"
done
install -m 0755 "$IMAGE_FILES/bin/gbrain-cloud-init-finalize" /usr/local/sbin/gbrain-cloud-init-finalize
install -m 0755 "$IMAGE_FILES/bin/gbrain-agent-finalize" /usr/local/sbin/gbrain-agent-finalize
install -m 0755 "$IMAGE_FILES/bin/gbrain-git-credential" /usr/local/libexec/gbrain/gbrain-git-credential
install -m 0755 "$IMAGE_FILES/bin/gbrain-update" /usr/local/sbin/gbrain-update

# The image contains no tenant configuration. Caddy and the three product
# services become boot-enabled only after cloud-init validates and writes the
# per-workspace contract. The agent remains disabled until a later ticket.
systemctl daemon-reload
systemctl disable --now caddy.service || true
systemctl disable gbrain-web.service gbrain-worker.service gbrain-scheduler.service gbrain-agent.service || true

# Leave PostgreSQL integrated with boot, but remove all tenant databases and
# secrets from the baked image. cloud-init creates the local role/database.
systemctl enable postgresql.service

# Oracle's Ubuntu image ships a host INPUT chain that permits SSH and then
# rejects all other new connections. The subnet security list is necessary but
# not sufficient: persist explicit Caddy ingress before capturing the image.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
  fi
done
if ! iptables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d 127.0.0.0/8 -j REJECT 2>/dev/null; then
  iptables -I OUTPUT 1 -m owner --uid-owner openclaw \
    -p tcp --dport 5432 -d 127.0.0.0/8 -j REJECT
fi
if ! ip6tables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d ::1/128 -j REJECT 2>/dev/null; then
  ip6tables -I OUTPUT 1 -m owner --uid-owner openclaw \
    -p tcp --dport 5432 -d ::1/128 -j REJECT
fi
netfilter-persistent save

rm -f /tmp/gbrain-source.tar.gz /tmp/gbrain-image-bundle.tar.gz
run_apt clean
rm -rf /var/lib/apt/lists/* /root/.bun/install/cache /root/.cache

# Every launched instance must get a fresh cloud-init run and machine identity.
cloud-init clean --logs --machine-id

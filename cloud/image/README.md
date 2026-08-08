# 2Brain Workspace OCI image

This directory builds the repeatable Oracle Cloud Infrastructure custom image
used for one 2Brain Workspace VM. The baked Ubuntu image contains Bun, the
compiled `gbrain` CLI, PostgreSQL 16 with pgvector, Caddy, and systemd units for
the Workspace web process, worker, and scheduler. A pinned native OpenClaw
runtime and its `gbrain-agent.service` unit are baked into the common image but
remain inert on Brain tier: the unit is disabled and inactive there, runs only as
the dedicated `openclaw` identity, and is enabled only by agent-tier cloud-init
for an Agent Workspace.

The image is built with Packer's official
[`oracle-oci` builder](https://developer.hashicorp.com/packer/integrations/hashicorp/oracle/latest/components/builder/oci).
Oracle's [custom-image tutorial](https://docs.oracle.com/en/learn/packer-oci-custom-img/)
describes the required OCI identity and networking setup.

## Build

Prerequisites: Bun, Git, Packer, an OCI API key profile, and an existing Ubuntu
24.04 base image plus subnet. Build from a clean checkout: the script refuses a
dirty worktree, and both uploaded archives are derived from the same Git `HEAD`.

```bash
cd cloud
bun run image:check

# Prints every line below, read-only, including the base image and both shapes.
bun run image/smoke-preflight.ts --discover > .env.build

export OCI_REGION=us-ashburn-1
export OCI_AVAILABILITY_DOMAIN='example:US-ASHBURN-AD-1'
export OCI_COMPARTMENT_OCID='ocid1.compartment...'
export OCI_SUBNET_OCID='ocid1.subnet...'
export OCI_BASE_IMAGE_OCID='ocid1.image...'
export OCI_PACKER_SHAPE='VM.Standard.A2.Flex' # optional; this is the default
./image/build.sh
```

The builder defaults to `VM.Standard.A2.Flex`, 1 OCPU, and 8 GB of memory. The
base image must be Canonical Ubuntu `aarch64`; provisioning refuses any other
architecture before installing packages. `--discover` reports whether A2 can
boot the selected image in the tenancy. Explicit environment overrides remain
available for the builder capacity values.

### Compartment and subnet are independent — do not set them to the same place

`OCI_COMPARTMENT_OCID` decides where the finished **image** is stored.
`OCI_SUBNET_OCID` decides where the throwaway **build VM** runs. Packer treats
them as separate variables, and the correct build uses two different places:

| Variable | Must point at | Why |
|---|---|---|
| `OCI_COMPARTMENT_OCID` | the **fleet** compartment | the control plane's scoped key can only read images there; an image built elsewhere has to be moved by hand before it can be launched |
| `OCI_SUBNET_OCID` | a subnet that **allows inbound TCP 22** | Packer provisions the build VM over SSH |

`--discover` reports the tenancy **root** compartment, not the fleet
compartment, so its output needs one hand-edit before use: keep its subnet,
replace its compartment.

The tempting correction — pointing both at the fleet — does not work. The
fleet's workspace subnet deliberately allows only ICMP, 80, and 443, and
`workspace.pkr.hcl` attaches no NSG to the build VM, so nothing opens 22 for it.
OCI drops the blocked SYN rather than rejecting it, so SSH cannot distinguish
"firewalled" from "still booting": Packer prints its ordinary
`Waiting for SSH to become available...` line until the timeout expires, then
fails with a message that reads like a slow VM. Budget ~25 wasted minutes and a
misleading cause.

Verify the subnet before a build rather than after, e.g.:

```bash
oci network subnet get --subnet-id "$OCI_SUBNET_OCID" \
  --query 'data."security-list-ids"' --raw-output
# then, for each security list id:
oci network security-list get --security-list-id <id> \
  --query 'data."ingress-security-rules"[].{proto:protocol,src:source,tcp:"tcp-options"}'
```

There is no dedicated build subnet yet; builds currently borrow an unrelated
subnet that happens to allow 22. Tracked in the repository issues — until it is
resolved, confirm the borrowed subnet still exists and still allows 22 before
relying on it.

Optional build variables are `OCI_CONFIG_FILE`, `OCI_PROFILE`,
`OCI_PACKER_OCPUS`, `OCI_PACKER_MEMORY_GB`, `OCI_SSH_USERNAME`, and
`GBRAIN_IMAGE_NAME`. The build writes its Packer manifest beneath
`cloud/image/.artifacts/`; the manifest is ignored by Git.

The manifest records each image's `gbrain_git_sha`. The Workspace and the
control plane are versioned together: a workspace only honours a feature the
image's commit contains, so a control plane ahead of the fleet's image fails at
the seam rather than at boot. `smoke-provision.ts` names this cause when its
setup-link idempotency assertion fails.

`build.sh --check` always verifies the repository-side contract. When Packer is
installed it also runs `packer init`, `packer fmt -check`, and `packer validate`
without contacting OCI.

## Inert Native OpenClaw Runtime

The common Workspace image contains Node.js 24.15.0 and OpenClaw 2026.7.1-2
from a committed npm lockfile. Image provisioning verifies the Node ARM64
archive SHA-256, npm registry integrity, installed package version, and
root-owned launcher before capture.

OpenClaw runs only as the `openclaw` system identity. Its state is
`/var/lib/openclaw/.openclaw`, its managed-browser data is
`/var/lib/openclaw/browser`, and its work directory is
`/var/lib/openclaw/workspace`. Those paths share a 10 GiB `nodev,nosuid` ext4
filesystem. The service never reads `/etc/gbrain/workspace.env`; agent-tier
provisioning supplies `/etc/openclaw/agent.env`.

Brain-tier cloud-init disables the unit and verifies it is inactive. Agent-tier
cloud-init chains `gbrain-agent-finalize` after the Brain-tier finalizer: it
writes the marker `/etc/openclaw/agent.env` the unit conditions on, points the
gateway at loopback port 3334 with **trusted-proxy auth** and the `/agent`
control-UI base path, enables the GBrain provider bridge plus the bundled
`admin-http-rpc` plugin, enables and restarts `gbrain-agent.service`, and
rewrites the Caddyfile so the Workspace origin serves GBrain at the root and the
OpenClaw interface under `/agent`.

There is no Gateway token. `gateway.auth.token` is mutually exclusive with
trusted-proxy mode, and `/etc/openclaw/agent.env` therefore carries exactly
`GBRAIN_AGENT_RUNTIME_ENABLED=true` and no credential of any class. Trusted-proxy
`requiredHeaders` is a **presence check** in the pinned release — OpenClaw never
compares the value — so `X-GBrain-OpenClaw-Proxy` is a routing marker, not a
shared secret. The boundary is the loopback bind, Caddy stripping any
client-supplied copy of both identity headers at the edge, and the VM giving
Members no shell.

The GBrain provider bridge lives at
`/usr/local/share/openclaw/gbrain-agent-bridge`, root-owned and unwritable by
`openclaw`. It registers exactly one route, `POST /api/v1/gbrain/provider`, which
imports an Anthropic or OpenRouter credential into an auth profile and exposes no
read, list, delete, shell, file, or arbitrary-provider operation.

The agent finalizer reads exactly one value out of
`/etc/gbrain/workspace.env` — `GBRAIN_SUBDOMAIN`, by `grep` — and never sources
that file, so no Platform Credential crosses into OpenClaw's config, env, or
state. It fails closed: a missing or malformed subdomain, an invalid Caddyfile,
or a gateway that never answers on `127.0.0.1:3334` aborts cloud-init. It then
proves the result rather than assuming it — `openclaw config validate`, the
plugin SDK subpath the bridge imports, a loader-level load of the bridge, a
structural read-back of the effective configuration, and live calls to the
bridge route and `/api/v1/admin/rpc` (including an unauthenticated call that must
be refused). Any failure aborts cloud-init.

## Cloud-init contract

Launch the image with user-data shaped like
[`cloud-init.example.yaml`](./cloud-init.example.yaml). The control plane must
replace every placeholder before launch.

| Key | Consumer and contract |
|---|---|
| `GBRAIN_WORKSPACE_NAME` | Human-readable workspace name. |
| `GBRAIN_SUBDOMAIN` | Fully qualified DNS name already pointing at the VM. |
| `GBRAIN_WORKSPACE_BASE_URL` | Exact public `https://` URL for Workspace and setup links. |
| `GBRAIN_WORKSPACE_TOKEN_SECRET` | High-entropy Workspace token signing secret. |
| `GBRAIN_BOOTSTRAP_CREDENTIAL` | High-entropy one-time operator credential used to create the first setup link. |
| `GBRAIN_EMAIL_RESEND_API_KEY` | Resend API key used by the first-admin trust loop. |
| `GBRAIN_EMAIL_FROM` | Verified sender address. |
| `OPENROUTER_API_KEY` | This workspace's own OpenRouter provisioned key, minted per workspace at provision time with its own spend limit. Never a fleet-wide key. |
| `GBRAIN_EMBEDDING_MODEL` | Pinned to `openrouter:openai/text-embedding-3-small` in this image contract. |
| `GBRAIN_EMBEDDING_DIMENSIONS` | Pinned to `1536`. |
| `GBRAIN_DATABASE_URL` | Database URL variable consumed by the web process and CLI. |
| `TWO_BRAIN_DATABASE_URL` | Database URL variable consumed by the worker and scheduler. |

The finalizer fails closed if a value is absent, still a placeholder, malformed,
or if the two database URLs do not identify the same local database. User-data is written as
`root:gbrain` mode `0640`; use URL-safe secrets so the environment file remains
valid shell syntax. Cloud-init's module and user-data behavior is documented in
the [cloud-init module reference](https://cloudinit.readthedocs.io/en/latest/topics/modules.html).

The VM's network security group should expose TCP 22, 80, and 443. The baked
host firewall also persists explicit TCP 80/443 ingress rules because Oracle's
Ubuntu base image otherwise rejects every new non-SSH connection. PostgreSQL
and Workspace port 3131 bind locally and must not be exposed publicly.

## Hand-launch smoke test

After DNS points to a hand-launched VM and cloud-init finishes:

```bash
sudo cloud-init status --wait
sudo systemctl status caddy gbrain-web gbrain-worker gbrain-scheduler
sudo journalctl -u cloud-final -u gbrain-web -u gbrain-worker -u gbrain-scheduler

./cloud/image/smoke-test.sh \
  https://workspace.example.com \
  'replace-with-launch-value' \
  admin@example.com
```

The smoke script verifies public HTTPS, requests the first-admin setup link
through the bootstrap trust loop, and prints the manual email/login checks. Caddy
obtains and renews the public certificate; see the official
[Caddy installation guide](https://caddyserver.com/docs/install). The database
packages come from PostgreSQL's official
[Ubuntu repository](https://www.postgresql.org/download/linux/ubuntu/) with the
[pgvector package](https://apt.postgresql.org/pub/repos/apt/pool/main/p/pgvector/).

## Operations

The core services (`gbrain-web`, `gbrain-worker`, `gbrain-scheduler`, `caddy`,
and `postgresql`) are enabled at boot and use `Restart=always`. The
`gbrain-agent.service` unit is the exception: it ships disabled and stays
inactive at boot on Brain tier. Inspect any unit with `systemctl status` and
`journalctl -u <unit>`. Apply a manually approved binary update by copying the
candidate to the VM and running:

```bash
sudo /usr/local/sbin/gbrain-update /tmp/gbrain-new
```

The updater verifies the candidate, swaps it atomically, restarts the supervised
processes, waits for health, and rolls back on failure.

`gbrain-agent.service` ships disabled and stays inactive on Brain tier. It runs
the native OpenClaw runtime as the dedicated unprivileged `openclaw` identity —
never through the `gbrain` credential helper — and consumes
`/etc/openclaw/agent.env` only — a marker file, not a secret store.
`gbrain-agent-finalize` provisions that agent-scoped environment file and
enables the unit, and it runs only for an Agent Workspace.

Once the unit is enabled, its resource directives reserve capacity for GBrain
and PostgreSQL on the 4 GiB pilot VM. The unit ships disabled, so these apply
only after enablement:

| Directive | Value | Effect |
|---|---|---|
| `CPUQuota` | `150%` | caps the agent at 1.5 cores |
| `MemoryHigh` | `2G` | soft memory watermark that throttles before the hard cap |
| `MemoryMax` | `3G` | hard memory ceiling |
| `TasksMax` | `512` | caps the agent's process/thread count |
| `CPUWeight` / `IOWeight` | `25` / `25` | yields CPU and I/O priority to the core services |
| `OOMScoreAdjust` | `750` | makes the agent the preferred OOM victim under memory pressure |

The unit also mounts private 256M tmpfs filesystems on `/tmp` and `/var/tmp`, so
scratch usage cannot consume the shared disk.

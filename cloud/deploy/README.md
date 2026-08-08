# Deploying the control plane

The runbook for installing, updating, and rebuilding the 2Brain Cloud control
plane on its VM. [`install.sh`](./install.sh) does everything that can be
automated; this file is **every act it cannot do** — the cloud scaffolding, the
escrow, and the two procedures (restore, rebuild) that only exist on paper until
someone rehearses them.

Read [`../CONTEXT.md`](../CONTEXT.md) first if any word here is ambiguous.

## Vocabulary

This is a **deploy**: installing or updating the control plane on its own VM.
It is deliberately not called any of the three words it would otherwise collide
with, each of which already means something else in this codebase:

| Not this | Which already means |
|---|---|
| *bootstrap* | the per-workspace bootstrap credential, and the one-time operator claim |
| *setup* | the first-Administrator flow inside a workspace |
| *provisioning* | the reconciler that builds workspace VMs |

A deploy touches one VM: the control plane's. It provisions nothing.

## 1. One-time cloud scaffolding

Launch the control-plane VM from a Canonical Ubuntu `aarch64` image with the
repository defaults (A2 Flex, 1 OCPU, 4 GB memory, 50 GB boot volume):

```bash
cd cloud
OCI_CONTROL_PLANE_IMAGE_OCID=ocid1.image... \
OCI_CONTROL_PLANE_NSG_OCID=ocid1.networksecuritygroup... \
OCI_CONTROL_PLANE_PUBLIC_IP_OCID=ocid1.publicip... \
OCI_SSH_PUBLIC_KEY_FILE="$HOME/.ssh/id_ed25519.pub" \
bun run launch:control-plane
```

The command also uses the existing `OCI_REGION`, `OCI_COMPARTMENT_OCID`,
`OCI_AVAILABILITY_DOMAIN`, and `OCI_SUBNET_OCID` values. Re-running it is safe:
it returns the existing non-terminated instance with the same display name.
Sizing environment variables are explicit overrides; the values above remain
the pilot defaults.

After `install.sh` has converged the VM, verify the real OCI capacity and public
service together:

```bash
CP_BASE_URL=https://ws.2brainai.tech \
OCI_CONTROL_PLANE_INSTANCE_OCID=ocid1.instance... \
bun run smoke:control-plane
```

This checks A2 Flex, 1 OCPU, 4 GB memory, the 50 GB boot volume, then requests
the configured `CP_BASE_URL` `/healthz` endpoint.

None of this is created by `install.sh`, and all of it must exist before the
first run. Each row says why it matters, not just what to click.

### Fleet compartment

A dedicated OCI compartment. `OCI_COMPARTMENT_OCID` points at it. Both the
workspace fleet and this VM launch there.

Why: it is the boundary the control plane's IAM grants are scoped to. Without a
dedicated compartment there is no way to give the control plane authority over
its own fleet and nothing else.

### IAM user, API key, and policy

A dedicated IAM user with an API signing key, and a policy scoped **to that
compartment only**. Never a tenancy-admin key: this key sits on an
internet-facing VM, and a key that can only touch the fleet compartment is the
difference between losing the fleet and losing the tenancy.

The policy must cover exactly what the code calls:

| Grant | Called by |
|---|---|
| manage `instance-family` in the compartment | `POST/GET/DELETE /20160918/instances` (`src/adapters/compute.ts`) |
| use `virtual-network-family` in the compartment | `GET /20160918/vnicAttachments`, `GET /20160918/vnics` — how a launch learns its public IP |
| read `instance-images` in the compartment | launching from the baked workspace image |
| manage `objects` in the backup bucket | the nightly registry backup's `PUT` (`src/adapters/object-storage.ts`) |

That last row is the one that gets forgotten. The backup signs with the *same*
IAM user as the compute adapter, so a policy that stops at instances and images
deploys a control plane that provisions perfectly and never successfully backs
up — discovered on the night you need a restore. Verify it the same night you
deploy (see [Backups](#7-backups)).

The private key half goes to `/etc/gbrain-cp/oci-api-key.pem` and to escrow.

### Reserved public IP

Reserve it; do not use an ephemeral IP.

Why: the fleet's SSH allowlists name this address. An ephemeral IP is released
when the instance is terminated, so the address would change out from under
every workspace NSG the moment you rebuild — which is precisely when you can
least afford to hand-edit the fleet.

### Network security groups

Two, one per role. The control-plane box carries the first; every workspace VM
carries the second, attached at launch by `src/adapters/compute.ts`.

**Control-plane NSG** — on the reserved-IP VM:

| Port | Source |
|---|---|
| 80, 443 | anywhere |
| 22 | the operator's addresses only |

**Workspace NSG** — its OCID is `OCI_WORKSPACE_NSG_OCID` in the env, and the
control plane refuses to boot without it (`src/index.ts` requireEnv, and
`gbrain-cp-verify-env`):

| Port | Source |
|---|---|
| 80, 443 | anywhere |
| 22 | the control-plane reserved IP only |

Required because OCI evaluates the subnet security list and the NSG as a **union**:
if no NSG is attached, the shared subnet list is the only policy in force, so
tightening it to lock down one workspace's SSH would cut ingress for the whole
fleet. The NSG is what lets each workspace carry its own ingress rules. Recreate it
on a rebuild and update `OCI_WORKSPACE_NSG_OCID` to the new OCID.

80 must be open, not just 443: TLS issuance uses it.

### DNS A record for the origin

An A record for `CP_BASE_URL`'s hostname (e.g. `cloud.example.com`) pointing at
the reserved IP, **not Cloudflare-proxied**.

Why: Caddy on this VM terminates its own TLS via ACME. Proxying intercepts the
challenge and the certificate never issues. This is the same constraint
`src/adapters/dns.ts` encodes as `proxied: false` for workspace records — the
control plane's own record is created by hand, so nothing in the code enforces
it here. Get it wrong and the deploy reaches a healthy `/healthz` on localhost
while the public origin serves no certificate at all.

Create it **before** the first deploy: `install.sh` writes a Caddyfile for that
hostname and reloads Caddy, which is when issuance is attempted.

### GitHub OAuth app

Under the **product's organization, not a personal account** — a personal app
dies with the account and cannot be handed over. Callback URL:

```
<CP_BASE_URL>/auth/github/callback
```

That path is built in `src/index.ts` and is not configurable. Client id and
secret become `CP_GITHUB_CLIENT_ID` / `CP_GITHUB_CLIENT_SECRET`.

### OpenRouter provisioning key

A **provisioning** key from the platform's OpenRouter account (Settings →
Provisioning Keys), not an inference key. It becomes
`CP_OPENROUTER_PROVISIONING_KEY` and mints one spend-limited embedding key per
workspace, capped at `CP_OPENROUTER_KEY_LIMIT_USD` — whole dollars, default 5.
Both the validator and the app refuse anything else, because an unparseable cap
reaches OpenRouter as no cap at all.

Why a provisioning key rather than an inference key: this one stays on the
control plane and can only mint and revoke. What reaches a workspace VM is a key
minted from it — capped, revocable on its own, and metered per workspace at
`GET /api/workspaces/:workspaceId/usage`. A fleet-wide inference key on a
customer VM would be readable by anyone who reached that box and would bill every
other workspace's budget with it.

### Read-only deploy key

A deploy key on the repo, **read-only**. Private half at
`/etc/gbrain-cp/deploy-key`; `install.sh` chmods it 0600 and fetches through it.

Why read-only: this box only ever reads the repo. A writable key on it turns a
compromised VM into a compromised source tree.

### Backup bucket

A **private** Object Storage bucket (`CP_BACKUP_BUCKET`, in namespace
`CP_BACKUP_NAMESPACE`), plus a lifecycle rule deleting objects under the
`registry/` prefix older than your retention.

**Retention is that rule, and nothing in the code.** The storage adapter has one
method — `put` — deliberately: pruning in-app would mean List and Delete, two
more signed endpoints and two more failure modes on an unattended nightly timer,
to reimplement what the bucket already does. If you do not create the rule,
dumps accumulate forever. Nothing will warn you.

Private, because a sealed dump is still a dump: the sealing key is what stops it
being readable, and a public bucket makes that key the only thing between an
anonymous fetch and the fleet.

### Uptime monitor

An external monitor on `GET <CP_BASE_URL>/healthz`.

External, because the failure it must catch is the box being gone.

## 2. Operator escrow

Put the **full env file** — including `CP_SECRET_KEY` — and the **OCI private
key** in a password manager, off the VM.

This is the step that looks like paperwork and is not. The registry backup is
sealed under `CP_SECRET_KEY`, so a dump without that key is unreadable
ciphertext and nothing else. **The escrow, not the bucket, is what makes a dead
VM recoverable.** A backup you can fetch and cannot open is not a backup.

Escrow before the first deploy, and re-escrow whenever a value changes.

## 3. First deploy

1. Launch an Ubuntu 24.04 VM in the fleet compartment, attach the reserved IP
   and the NSG. `install.sh` refuses any other OS.

2. Write the **three** preconditions from escrow, at exactly these paths.
   Pre-flight refuses if any is missing — all three, not two:

   | Path | Mode | What |
   |---|---|---|
   | `/etc/gbrain-cp/control-plane.env` | 0640 (0600 also accepted) | the full environment |
   | `/etc/gbrain-cp/oci-api-key.pem` | — | the OCI API signing key |
   | `/etc/gbrain-cp/deploy-key` | — | the read-only deploy key |

   `install.sh` normalizes ownership and modes on all three once it runs. But the
   env file's mode is **checked first**: pre-flight refuses anything other than
   0600 or 0640, before the line that would have fixed it. Write it correctly
   rather than relying on the fix.

   Env reference is the comment block at the top of `src/index.ts` — the
   canonical list. The validator additionally pins what will otherwise bite you:

   - `OCI_PRIVATE_KEY_PATH` must be **exactly** `/etc/gbrain-cp/oci-api-key.pem`.
     That is the one path `install.sh` grants the service group; a key anywhere
     else stays unreadable to the service and crash-loops it.
   - `CP_DATABASE_URL` must target local Postgres on 127.0.0.1:5432, with a
     database, user, and password. `install.sh` creates that role and database.
   - `CP_BASE_URL` must be an `https://` origin with no trailing slash.
   - `CP_SECRET_KEY` must be base64 decoding to exactly 32 bytes.
   - **Unknown and duplicate keys are refused.** A stray variable is exit 2, not
     a warning.
   - Values must be a single field; `CP_PORT=`, `CP_FLEET_CAP=` and friends are
     refused rather than silently becoming 0.

3. Copy `cloud/deploy/` onto the box, **outside `/opt/gbrain-cp`** and **from
   the same ref you will pass as `REPO_REF`**.

   Both halves are load-bearing. Outside, because `install.sh` rewrites
   `/opt/gbrain-cp` with `git reset --hard`, and bash reads a script by byte
   offset as it runs — a copy inside that tree would have its bytes swapped
   underneath the running interpreter. (It refuses this, exit 2.) Same ref,
   because **the systemd units come from this copy while the code they run comes
   from the checkout**: a stale copy deploys units that do not match the code,
   and nothing detects it.

4. Optionally validate the env alone first — the file is its only input, so this
   is safe to run before anything is installed:

   ```bash
   sudo ./bin/gbrain-cp-verify-env
   ```

   It defaults to `/etc/gbrain-cp/control-plane.env`, and needs `sudo` to read
   it. It exits 2 and names the first thing wrong.

5. Deploy. **Set `REPO_URL` and `REPO_REF` explicitly** — the default `REPO_REF`
   is `master`, a moving target, and a deploy that cannot say what it shipped is
   not one you can roll back:

   ```bash
   sudo REPO_URL=git@github.com:<org>/<repo>.git REPO_REF=<sha-or-tag> ./install.sh
   ```

   It prints `2Brain control plane deployed for https://<origin>` on success.
   There is no separate migrate step: `src/index.ts` migrates before it listens,
   so a healthy `/healthz` is what proves the deploy landed.

## 4. Verify

Six checks, in order. **4.4–4.6 are the ones no test suite can reach** — the
fakes behind the adapter seam are precisely what they exist to bypass, so a green
`cloud` suite says nothing about them and this runbook is the only place they are
written down. Do all six on the first deploy, and 4.4–4.6 again after any
rebuild.

### 4.1 The origin answers

```bash
# From outside the box — proves DNS, the NSG, Caddy, and the certificate.
curl -fsS https://cloud.example.com/healthz
```

A connection that hangs is the NSG; a TLS error is usually the A record being
Cloudflare-proxied (§1). Confirm your uptime monitor sees the same URL.

### 4.2 The app is reachable only through Caddy

```bash
# On the box. The app must listen on 127.0.0.1 only, never 0.0.0.0.
sudo ss -ltnp | grep bun
```

Pass is **one line**, whose address column is `127.0.0.1:<CP_PORT>` (8080 unless
you set it) and whose last field is `users:(("bun",pid=…,fd=…))`. Fail is a line
reading `0.0.0.0:<CP_PORT>` or `*:<CP_PORT>`: the port is then exposed on the
public interface and only the NSG is holding it shut.

**`sudo` is load-bearing here.** `ss -p` attributes a socket to a process only
when the socket belongs to the *calling* user. The app runs as `gbrain-cp`, so
run as `ubuntu` this prints the socket with no `users:(("bun",…))` field at all —
`grep bun` then matches nothing and you get an empty result that looks exactly
like "the app is not listening". Empty output from this command means you forgot
`sudo`, not that the check failed.

### 4.3 Sign-in and invite redemption

In a browser:

1. Sign in with GitHub at `/dashboard`. The configured `CP_OPERATOR_GITHUB_IDS`
   identity claims the one-time operator account.
2. Issue an invite (`POST /api/invites`) and redeem it as a second identity.

Sign-in exercises the OAuth app and callback; redemption exercises the registry
write path. Neither is covered by `/healthz`.

### 4.4 A real provision, end to end — and its teardown

The first time the provisioning state machine meets real OCI, real DNS, and a
real ACME exchange. The unit suites drive every transition against fakes; what
they cannot tell you is whether the IAM policy, the compartment, the image OCID,
and the Cloudflare token are the real ones.

1. From `/dashboard`, **Create a workspace** with a throwaway name.

2. Watch it advance. The page reloads itself every 5s while anything is still
   provisioning, and shows one label per step:

   | Step | The dashboard says |
   |---|---|
   | `pending` | Queued |
   | `credentials` | Preparing credentials |
   | `instance` | Starting the machine |
   | `dns` | Publishing the address |
   | `health` | Waiting for HTTPS |
   | `setup_link` | Creating your setup link |
   | `running` | Ready |

   Minutes, not seconds: `health` waits on the new workspace's first boot and its
   own ACME issuance. It does **not** wait on DNS propagation — the control plane
   dials the workspace by the IP the launch handed it (`src/adapters/workspace.ts`),
   presenting the hostname only for SNI and the certificate check, so a name it
   just published can never gate its own health probe. `GET
   /api/workspaces/<workspace-id>` returns the same state as JSON if you would
   rather poll than watch.

   A stall is not a failure — the reconciler retries a step up to 60 times before
   giving up. A failure lands the row in `failed` with the reason on the page.

   > **If you find `/etc/systemd/resolved.conf.d/gbrain.conf` on an older box**,
   > pointing the resolver at Cloudflare: that was a manual mitigation from before
   > the management lane dialed workspaces by IP. It is now inert — a rebuild
   > neither recreates it nor needs it. Leave it or remove it; nothing depends on it.

3. When the link exists, an **Open setup link** button replaces the step label —
   that is the `setup_link` step landing, with `running` following on the next
   tick. Follow it and create the first Administrator: the link is single-use,
   and it is the one part of the journey that proves the new workspace's own
   Workspace HTTP boundary came up, not merely its TLS.

4. **Tear it down** — see below. Not optional.

#### Teardown is manual

**The control plane ships no delete path.** `cloud/src/app.ts` has no delete
route, and `store.ts` says so where it explains why failed rows are excluded from
the fleet cap. Nothing reclaims this VM for you: a test workspace left behind is
a billed VM, a live DNS record, and a fleet-cap slot, until a human notices.

Take `ociInstanceOcid`, `dnsRecordId`, and the workspace id from the registry row
(`GET /api/workspaces/<workspace-id>`) **before** you start: once step 3 marks the
row `deleted` that endpoint 404s it (`app.ts`), and only SQL will still tell you
what you were meant to clean up.

1. **Terminate the instance.** Its display name is `2brain-ws-<workspace-id>`
   (`instanceDisplayName`, `src/provisioning.ts`):

   ```bash
   oci compute instance terminate --instance-id '<ociInstanceOcid>'
   ```

2. **Release the DNS record.** Cloudflare is authoritative for the workspace zone
   (`src/adapters/dns.ts`); delete the record named for the workspace's
   subdomain, in the zone `CP_CLOUDFLARE_ZONE_ID` names. Leaving it is a public A
   record pointing at an address OCI will hand to someone else.

3. **Mark the registry**, so the fleet cap and the dashboard stop counting it:

   ```sql
   UPDATE cp_workspaces SET lifecycle_state = 'deleted' WHERE workspace_id = '<workspace-id>';
   ```

#35's lifecycle also revokes the embedding token and the GitHub App
installation. **Neither applies yet.** `embedding_token_ref` and
`github_installation_id` are registry columns nothing populates at this phase
(#42, #43), so on a pilot workspace both are null and there is nothing to revoke.
When those phases land, this list grows — and the delete path that should replace
all three of these steps is where they belong.

### 4.5 Launches land in the fleet compartment

Every launch passes `OCI_COMPARTMENT_OCID` as `compartmentId` (`launchInstance`,
`src/adapters/compute.ts`), so the instance lands in whatever that value names —
which is exactly why this check is worth its minute. What it proves is that the
value names **the compartment your IAM policy is scoped to**, and not some other
one a broader-than-intended key was also able to launch into. A tenancy-admin key
with a wrong compartment OCID provisions perfectly, and you find out the policy
was scoping nothing on the day you needed it to.

While 4.4's workspace is still running:

```bash
oci compute instance list --compartment-id '<OCI_COMPARTMENT_OCID>' \
  --query "data[?\"display-name\"=='2brain-ws-<workspace-id>'].\"lifecycle-state\""
```

One row, `RUNNING`. An empty result means the instance is in a different
compartment from the one you just named — reconcile `OCI_COMPARTMENT_OCID`
against the compartment in the policy before provisioning anything else.

### 4.6 The reserved IP survives a stop/start

§1 says the fleet's SSH allowlists name this address. This is where you prove it
instead of assuming it. Do it **now**, while the box is empty: the cost of being
wrong today is a rebuild, and the cost of finding out later is a rebuild plus
every workspace NSG in the fleet.

1. Record the address `dig +short cloud.example.com` prints.
2. Stop the VM and wait for `STOPPED`:

   ```bash
   oci compute instance action --action STOP --instance-id '<control-plane instance OCID>'
   ```

3. Start it again (`--action START`) and wait for `RUNNING`.
4. Confirm nothing moved:

   ```bash
   dig +short cloud.example.com          # must equal step 1
   curl -fsS https://cloud.example.com/healthz
   ```

**The address changing is the failure**, and it means the IP is ephemeral rather
than reserved: the VNIC was handed a new one on start. Everything else will look
healthy — `/healthz` answers on the new address, DNS still resolves to the old —
so only the comparison in step 4 catches it. Fix it by reserving the address and
reattaching, before any workspace NSG names the old one.

Step 4 answering also proves the units come back **enabled**, not merely started:
`install.sh` enables them, but a hand-fix during a rough first deploy is exactly
what leaves a box that runs until the day it reboots.

### 4.7 Before enabling customer Agent Workspaces

Agent tier is a different entitlement from Brain tier, and it is not released by
deploying a build that can provision it. Run, from a repository checkout:

```bash
bun run verify:agent-pilot-release docs/verification/agent-pilot-release.json
```

A `RELEASE PASS` final line and exit 0 is the only state in which customers may
be offered Agent Workspaces. Anything else — blocked, or the usual case of no
manifest at all — means agent-tier provisioning stays internal: builds and
disposable operator testing are fine, customer access is not. The check is
offline and reads only committed files, so it can be run before or after a
deploy and costs nothing.

This does not gate Brain Workspaces. A blocked pilot never blocks a normal
control-plane update.

## 5. Update

Re-running `install.sh` **is** the supported update path — same three
preconditions, same copy-from-the-matching-ref rule:

```bash
sudo REPO_URL=git@github.com:<org>/<repo>.git REPO_REF=<new-sha> ./install.sh
```

It converges: it installs what is absent, fetches and resets the checkout, and
rewrites units only when their bytes differ. It is **not** a no-op — it always
restarts the service, deliberately. An env edit changes no file the script
compares, so there would otherwise be nothing to notice.

After editing the env file, that restart is yours to drive:

```bash
sudo /usr/local/sbin/gbrain-cp-verify-env      # the copy install.sh leaves for you
sudo systemctl restart gbrain-control-plane
```

Verify first, always. The units read the env through `EnvironmentFile`; a bad
value is not a failed restart but a crash loop, `Restart=always`, and a service
that never reaches `failed` for you to notice.

Migrations run at boot. There is no migrate step to remember.

## 6. Units

| Unit | What |
|---|---|
| `gbrain-control-plane.service` | the app; `Restart=always` |
| `gbrain-control-plane-backup.timer` | nightly, 03:00 UTC, up to 15 min jitter, `Persistent=true` |
| `gbrain-control-plane-backup.service` | the backup oneshot the timer drives |

Enable the **timer**, never the backup service. The timer is what schedules the
oneshot (`Unit=` names it); the oneshot carries no `[Install]` **so that it
cannot be enabled on its own**, and getting this wrong does not double your
backups — it silently gives you none.

`systemctl enable gbrain-control-plane-backup.service` does not fail. On Ubuntu
24.04's systemd it **exits 0**, writes an advisory to stderr ("The unit files
have no installation config…"), creates no symlink, and schedules nothing;
`systemctl is-enabled` on it reports `static`. So an operator who enables the
service out of habit sees a success exit, watches the advisory scroll past, and
believes backups are on while nothing is scheduled at all. Check
`systemctl list-timers` (§7), not the exit code.

`install.sh` gets this right; a hand-fix at 3am might not.

## 7. Backups

The registry is the one dataset in the pilot with backups. `src/backup.ts`
runs `pg_dump`, seals the **whole** dump under `CP_SECRET_KEY`, and PUTs it to:

```
registry/<ISO 8601 stamp>.sql.sealed     # ':' and '.' in the stamp become '-'
e.g.  registry/2026-07-17T03-14-07-123Z.sql.sealed
```

The whole dump is sealed, not just the columns that were already ciphertext: a
plain dump carries operator emails, GitHub ids, workspace names, subdomains, and
invite codes.

```bash
systemctl list-timers gbrain-control-plane-backup.timer   # next/last run
journalctl -u gbrain-control-plane-backup                 # what it did

# Namespace and bucket are the escrowed env file's CP_BACKUP_NAMESPACE and
# CP_BACKUP_BUCKET. Nothing exports them into your shell — substitute them.
oci os object list -ns '<CP_BACKUP_NAMESPACE>' -bn '<CP_BACKUP_BUCKET>' --prefix registry/
```

Check the journal the morning after the first deploy. The backup refuses to
store a dump that is empty or has no `cp_workspaces` table in it, and it exits
non-zero so the unit fails and the journal shows it — but nothing pages you.
A first backup that never ran because of a missing `manage objects` grant looks
exactly like a healthy control plane.

## 8. Restore rehearsal

**An unrehearsed backup does not count.** Do this once, now, and again whenever
`CP_SECRET_KEY` changes. It is the one procedure someone follows under pressure.

Run it from an operator machine with the OCI CLI configured, a local Postgres,
and a gbrain checkout. **Stand at the root of the checkout** — the import below
resolves relative to your working directory, and from `cloud/` it fails with
`Cannot find module`.

```bash
# 1. Fetch a dump. Namespace and bucket are the escrowed env file's
#    CP_BACKUP_NAMESPACE and CP_BACKUP_BUCKET — substitute them; on an operator
#    machine nothing has set them.
oci os object get -ns '<CP_BACKUP_NAMESPACE>' -bn '<CP_BACKUP_BUCKET>' \
  --name registry/<stamp>.sql.sealed --file dump.sealed

# 2. Open it with the escrowed sealing key. Without CP_SECRET_KEY this is noise.
#    The key is an env assignment, not an argument: argv is visible in `ps`.
CP_SECRET_KEY='<from escrow>' bun -e '
  const { openSecret, parseSealingKey } = await import("./cloud/src/secrets.ts");
  const sealed = await Bun.file("dump.sealed").text();
  await Bun.write("dump.sql", openSecret(sealed, parseSealingKey(process.env.CP_SECRET_KEY)));
'

# 3. Restore into a throwaway Postgres and prove the fleet list survived.
createdb registry_restore_check
psql --set=ON_ERROR_STOP=1 -d registry_restore_check -f dump.sql
psql -d registry_restore_check -c \
  'SELECT workspace_id, name, subdomain, lifecycle_state, provisioning_step
     FROM cp_workspaces ORDER BY name;'
dropdb registry_restore_check

# 4. Shred the evidence. dump.sql is the whole fleet in plaintext (§7), and this
#    rehearsal runs from the repo root by construction, so it lands inside a git
#    checkout every time. Both files are gitignored; that stops the commit, not
#    the copy sitting on your disk.
rm dump.sql dump.sealed
```

Step 3 needs no role to pre-exist: the dump is taken `--no-owner
--no-privileges`.

The rehearsal has passed when that `SELECT` prints the workspaces you expect —
not when step 2 exits 0. A wrong key fails closed and loudly (`sealed secret
could not be opened`), which is the good case; the case worth rehearsing is
discovering *now* that the key in escrow is not the key the dump was sealed
with.

## 9. Rebuild from scratch

The VM is gone. In order:

1. Launch a fresh Ubuntu 24.04 VM in the fleet compartment; **reattach the
   reserved IP** and the NSG. The fleet's SSH allowlists name that address —
   reattaching is what makes the rebuilt control plane reachable to the fleet
   without touching a single workspace.
2. Write the env file, the OCI key, and the deploy key from escrow.
3. Run `install.sh` (§3). It builds the box, creates the role and database, and
   boots the app — which **migrates before it listens**. So by the time it
   succeeds the registry is not empty: it is a live, migrated, empty-of-rows
   schema.

4. Restore the newest dump over it. The dump is plain `pg_dump` output and
   carries its own `CREATE TABLE` statements, so it must land in an **empty
   database** — restoring onto the schema step 3 just created dies on `relation
   "cp_workspaces" already exists`. Stop the service, recreate the database
   empty, then restore:

   ```bash
   sudo systemctl stop gbrain-control-plane gbrain-control-plane-backup.timer

   # Fetch + open the newest dump exactly as in §8, producing dump.sql.

   # Recreate empty. <db> and <role> are CP_DATABASE_URL's database and user;
   # install.sh already created the role, so only the database is rebuilt.
   sudo -u postgres psql --set=ON_ERROR_STOP=1 \
     -c 'DROP DATABASE <db>' -c 'CREATE DATABASE <db> OWNER <role>'

   # Restore as the app role, so the restored objects end up owned by it. The
   # password is CP_DATABASE_URL's, and argv is visible in `ps` (§8), so it goes
   # through the environment rather than into a connection string on the line.
   PGPASSWORD='<the password from CP_DATABASE_URL>' \
     psql --set=ON_ERROR_STOP=1 -h 127.0.0.1 -U <role> -d <db> -f dump.sql

   sudo systemctl start gbrain-control-plane gbrain-control-plane-backup.timer
   rm dump.sql dump.sealed          # the fleet in plaintext, as in §8
   ```

   The dump carries `cp_migrations` with it, so the app boots, sees every
   migration already applied, and skips them rather than re-running them.

5. Verify (§4), and confirm the restored fleet list matches reality — instances
   terminated or created since the dump will not be in it.

The DNS A record and the OAuth app survive; they are not on the VM.

### What is not recoverable, by design

**The pilot has no workspace backups (#35).** This is a decision, not a gap.
GitHub-synced Sources are the durable copy of workspace content. Members and
grants, agent memory, and event history are **accepted losses**. Deletion and
suspension copy says so, and must keep saying so.

This runbook recovers the *control plane*. A workspace VM that is gone is gone;
what the registry gives you back is the fleet's shape — which workspaces exist,
their subdomains, OCIDs, and lifecycle state — not their contents.

## 10. Exit codes

`install.sh` splits failures into two classes, and the split is the promise:

| Exit | Meaning | Do |
|---|---|---|
| 0 | Deployed; `/healthz` answered. | — |
| **2** | Your inputs or the box are wrong. **Nothing was changed.** | Fix what it named, re-run. No cleanup. |
| **any other non-zero** | A step broke part-way. The box is half-built. | Read the error, fix, re-run — it converges. |

Exit 2 is trustworthy because every refusal that produces it lives in the
pre-flight block, above the first line that mutates the box — pinned by
`cloud/test/deploy-contract.test.ts`, since the natural place to write the next
refusal is beside whatever first needs it.

The second class is **not always literally 1**. Only two failures exit 1 by
hand: an unparseable `CP_DATABASE_URL` after the validator already accepted it,
and `/healthz` not answering within `HEALTH_TIMEOUT_SECONDS` (60). Everything
else fails under `set -e` and exits with the failing command's own status — apt
exits 100, curl 22. Read "not 0 and not 2" as one class and do not wait for a 1.

A `/healthz` timeout dumps `systemctl status` and the last 50 journal lines to
stderr before exiting: `Restart=always` means a crash-looping unit never reaches
`failed`, so the poll cannot tell "still starting" from "dead" and simply runs
out. The evidence is in that dump, not in the exit code.

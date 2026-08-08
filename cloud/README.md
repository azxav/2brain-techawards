# 2Brain Cloud control plane

The fleet/provisioning surface for 2Brain Cloud (issue #35): a Bun + TypeScript
monolith with its own Postgres, separate from the per-VM 2Brain Workspace product.
It owns dashboard identity (GitHub OAuth), invite-gated signup, the workspace
registry, end-to-end provisioning, and the workspace lifecycle (delete, suspend,
resume); later tickets add GitHub App sync, embedding-key minting, and billing on
top of the seams established here.

This is a **separate codebase** that happens to live in the gbrain repository: it
has its own `package.json`, lockfile, test suite, and database. It shares no runtime
with gbrain or the Workspace.

## Layout

| Path | What it is |
|---|---|
| `src/db.ts` | `SqlExecutor` seam + schema migrations (users, sessions, invite codes, pending signups, workspace registry, provisioning state) |
| `src/db-postgres.ts` | Production executor (postgres.js) |
| `src/store.ts` | Registry + identity data access over `SqlExecutor`, including the provisioning lease and step transitions |
| `src/secrets.ts` | AES-256-GCM sealing for the few secrets the registry must replay (the bootstrap credential) |
| `src/cloud-init.ts` | Renders the VM launch contract; required keys come from the image's own verifier |
| `src/provisioning.ts` | The reconciler: lease, one step per tick, cleanup on failure, and the delete/suspend/resume actions |
| `src/adapters/github.ts` | GitHub OAuth: interface, real HTTPS impl, in-memory fake |
| `src/adapters/compute.ts` | OCI compute + the request signer, and `FakeCompute` |
| `src/adapters/dns.ts` | Cloudflare DNS, and `FakeDns` |
| `src/adapters/workspace.ts` | The HTTPS management lane onto a workspace, and `FakeWorkspace` |
| `src/adapters/openrouter.ts` | Per-workspace OpenRouter provisioned embedding keys, and `FakeOpenRouterKeys` |
| `src/app.ts` | The HTTP app (Express): auth flow, signup, operator invite API, workspace create/status/lifecycle, usage metering, dashboard |
| `src/pages.ts` | Server-rendered pages (landing, signup, dashboard, delete confirmation) |
| `src/index.ts` | Composition root: env → real adapters → listen → reconciler loop |
| `src/adapters/object-storage.ts` | OCI Object Storage (the backup seam), and `FakeObjectStorage` |
| `src/backup.ts` | Nightly registry backup: `pg_dump` → seal whole → PUT to a private bucket |
| `test/` | Tests drive the HTTP API only, with fake adapters and embedded-Postgres (PGLite) storage |
| `image/` | Packer OCI image, cloud-init contract, systemd units, and smoke tooling |
| `deploy/` | The control-plane VM's installer, env validator, systemd units, and runbook |

## The adapter seam

Every cloud effect sits behind a thin interface owned by this codebase, with an
in-memory fake next to the real implementation (`src/adapters/`). The HTTP API and
the provisioning state machine depend only on the interfaces; tests exercise the
whole app through HTTP with fakes bound. Stripe and SSH follow the same pattern in
later tickets.

## Provisioning

The registry row **is** the state. A reconciler tick takes a short lease on one
workspace, advances it by exactly one step, persists what that step created, and
releases:

```
pending → credentials → instance → dns → health → setup_link → running
                                                            ↘ failed (after cleanup)
```

There is no in-memory machine, so killing the control plane mid-provision costs at
most the step in flight — the next tick re-reads the row and resumes. Every external
effect is keyed on the workspace id and looked up before it is created (OCI by
instance display name and retry token, Cloudflare by record name), so an effect that
succeeded but whose acknowledgement was lost is re-found rather than duplicated.

A terminal failure releases what it created in reverse (DNS record → instance →
embedding key → launch secrets) before marking the row `failed`. Cleanup that cannot finish records
the residue in `provisioning_error` rather than dropping it: an orphan nobody knows
about is worse than a failed row that names it.

## Lifecycle

Delete, suspend and resume ride the same reconciler. The API validates the request
and writes an intent state; a later tick performs the cloud effects and lands the
settled state:

```
running   → suspending → suspended     instance stopped, DNS left in place
suspended → resuming   → running       instance started, health re-probed
any live  → deleting   → deleted       instance, DNS and credentials released
```

Doing the work in the HTTP handler instead would put a multi-effect teardown
somewhere a crash cannot be resumed from, which is how VMs, DNS records and live
credentials get orphaned. An action is refused (`409 incompatible_state`) from a
state it is not defined for, so the settled state is never a guess.

**Delete** revokes the bootstrap credential, the embedding token reference and the
GitHub App installation reference first — those cannot fail, and a credential that
outlives the workspace it belonged to is worse than a retry. It then releases the
DNS record and terminates the instance, looking the instance up by display name
when no OCID was recorded (the shape of a launch whose acknowledgement was lost).
Cleanup that cannot finish is retried and then named on the deleted row, the same
rule a failed provision follows. Delete is accepted mid-provision.

**Suspend** stops the instance and leaves everything else standing: the boot volume
keeps every Source, member and grant, and the DNS record keeps pointing at a machine
that answers nothing. That is what makes it the enforcement lever short of deletion.
It is operator-only. **Resume** starts the instance and waits for the workspace to
answer over HTTPS before reporting `running`, so nobody is told their workspace is
back while it is still booting. A resume that never answers stops the instance again
and returns the row to `suspended` with the reason attached — it never tears anything
down, and it never leaves a running machine recorded as stopped, which would put the
VM beyond the reach of the lever (suspend is only offered from `running`).

The delete confirmation (`GET /workspaces/:id/delete`) names both halves of the
outcome, because the pilot takes **no backups**: Sources synced from GitHub survive
in the repositories; members and their grants, agent memory, and event history do
not. The owner types the workspace name to confirm.

Secrets: most credentials here are verifiers, stored as sha256 digests and never
recovered. The per-workspace bootstrap credential is the exception — the management
lane has to present it — so it is sealed under `CP_SECRET_KEY` (`src/secrets.ts`)
rather than stored in plaintext. The launch secrets are dropped once the workspace
is running.

## Platform embeddings

Search works on a fresh workspace with nothing the user configured. The `pending`
step mints an OpenRouter *provisioned* key named for the workspace, capped at
`CP_OPENROUTER_KEY_LIMIT_USD`, and cloud-init injects it alongside the pinned model
(`openrouter:openai/text-embedding-3-small`, 1536 dimensions). It is minted with the
launch secrets because the launch consumes it.

**No fleet-wide embedding key ever reaches a customer VM** (a #35 rule). Each VM
holds only its own key: capped, individually revocable, and metered on its own. The
provisioning key that mints them stays on the control plane.

OpenRouter returns key material exactly once, so a mint whose acknowledgement was
lost cannot be adopted — the adapter revokes the same-named predecessor and mints
afresh, which is safe because no VM has consumed one at that point. A failed
provision revokes the key by handle, or by name when the handle was never recorded.

Operators read per-workspace spend at `GET /api/workspaces/:workspaceId/usage`; a
provider that cannot be reached is reported as unavailable rather than as zero.

## Run

```bash
cd cloud
bun install
bun test               # HTTP-seam tests, hermetic (PGLite + fakes)
bun run typecheck
bun run image:check    # static image/cloud-init contract
CP_DATABASE_URL=postgres://... \
CP_GITHUB_CLIENT_ID=... CP_GITHUB_CLIENT_SECRET=... \
CP_BASE_URL=https://cloud.yourapp.example \
CP_OPERATOR_GITHUB_IDS=12345678 \
bun run start
```

Real-cloud verification is two stages, cheap first:

```bash
cd cloud
# 1. read the availability domain + public subnet a launch needs (read-only)
bun --env-file=../.env.oci-verification run image/smoke-preflight.ts --discover > ../.env.oci-discovered

# 2. prove the adapters work — GETs only, creates nothing, costs nothing
bun --env-file=../.env.oci-verification --env-file=../.env.oci-discovered run image/smoke-preflight.ts

# 3. the real thing: launches a billed VM and writes live DNS
bun --env-file=../.env.oci-verification --env-file=../.env.oci-discovered run image/smoke-provision.ts
```

The Cloudflare zone is the **registrable domain** (e.g. `example.tech`), not the
workspace domain (`workspace.example.tech`) — the latter is a name inside the
zone, not a delegated zone of its own. Note the consequence: `DNS:Edit` cannot be
scoped below a zone, so the token can edit every record in it, including the mail
records delivery depends on. See the design's DNS decision for why that is
accepted for the pilot and how to narrow it.

Use `bun --env-file`, **not** `source`. An env file whose value contains a space
or a `<` (a mail `From:` header does both) is not valid shell, so `source` dies
part-way through and silently leaves the rest of the file unset — which surfaces
much later as a confusing mid-run failure. Bun's parser handles those values, and
CRLF, correctly.

OCI credentials come from `~/.oci/config` (the file `image/build.sh` already
expects); the image OCID defaults to the newest build in the Packer manifest. So
neither script asks for values that are already recorded somewhere.

The preflight exists because the OCI request signer is the one part of the
provisioning path no fake can exercise — unit tests prove the signing string is
well-formed; only a real response proves OCI accepts it. Four checks:

| Check | Why it is the check |
|---|---|
| signed `ListInstances` → 200 | the read path's signature is accepted |
| signed `POST /instances` with an empty body → 400 | the **write** path signs 3 headers a GET never does (content-length, content-type, x-content-sha256). It cannot be proven read-only, so it is proven by *rejection*: an empty body reaches validation only once the signature has passed. 400 means signed; 401 means broken. Nothing is created either way. |
| flipped signature byte → 401 | without this, the 200 above proves nothing — it could be an endpoint ignoring the header |
| baked image is `AVAILABLE` | the OCID a launch would use exists, via the images route |

Run it before the real thing; it is free.

**The image and the control plane are versioned together.** Provisioning depends
on workspace-side behaviour that only exists from the commit which taught
`/api/workspace/v1/operator/links` to honour `idempotency_key`; an image baked
before it ignores the key and mints a fresh setup link per call, so a retried
issuance silently leaves a second live link behind. The image records its origin
in `gbrain_git_sha` (`image/.artifacts/packer-manifest.json`) — check it against
the change before trusting a smoke result, and rebuild via `image/build.sh` when
it is behind. This is #35's build order: gbrain fixes, then the baked image, then
the control plane.

`smoke:provision` is the manual per-image-release run: it provisions a throwaway
workspace with the real adapters, waits for HTTPS and health, completes setup,
checks that setup-link issuance is idempotent, and **always tears the VM and DNS
record down** — including when it fails, and including when an operator kills it
with Ctrl-C or `SIGTERM`. Its registry is in-memory, so it never touches the
production control plane's database. While Resend's domain is pending, email
delivery is the one assertion it reports as pending rather than checking.

The run is bounded end to end: no single reconciler tick may exceed
`SMOKE_ROUND_DEADLINE_MS` (default 3 min) and the whole run may not exceed
`SMOKE_DEADLINE_MS` (default 30 min). Either bound names the provisioning step it
gave up on and then tears down, so a run that stops making progress costs a clear
failure rather than an operator noticing an idle terminal an hour later.

Credentials come from `~/.oci/config` (the file `image/build.sh` already expects)
plus the environment. Neither script prints a secret.

Env reference lives in `src/index.ts`. `CP_OPERATOR_GITHUB_IDS` is the one-time
operator bootstrap: one configured immutable GitHub id may create the first
operator account, which can then issue invite codes through `POST /api/invites`.
After that claim, every new identity — including other configured ids — must
redeem an invite. Set `CP_COOKIE_SECURE=false` only for plain-HTTP local runs.

The per-workspace VM build and launch contract lives in
[`image/README.md`](./image/README.md).

## Customer Agent Workspaces are gated separately

Agent-tier provisioning may be offered to customers only when this passes:

```bash
bun run verify:agent-pilot-release docs/verification/agent-pilot-release.json
```

It is an offline check of a committed manifest and the fixed headers of the
evidence reports it names: issues #61 and #68 recorded closed, the exact pinned
OpenClaw version, one 40-character subject commit SHA shared by the manifest and
every report, and a passing report for each required proof (full suite,
PostgreSQL, browser/native access, providers, approvals, Member revocation,
export redaction, network isolation, public/loopback dependencies, VM updates).
It never calls GitHub or OCI — the operator records authoritative issue state
immediately before release.

**Blocked, or no manifest at all, means internal disposable testing only.** The
manifest is absent until the pilot's real-VM evidence exists, so that is the
normal state; `docs/verification/agent-pilot-release.example.json` shows the
shape and is deliberately non-releasable. Brain-tier releases and the issue-34
verifier (`bun run verify:workspace-release`) are unaffected either way.

## Deploying the control plane

Everything above is a local run. Installing or updating the control plane on its
own VM — `install.sh`, the env validator, the systemd units, and the runbook for
every act automation cannot do (cloud scaffolding, operator escrow, restore
rehearsal, rebuild from scratch) — is [`deploy/README.md`](./deploy/README.md).

Read it before the first deploy rather than during one. The full env file,
including `CP_SECRET_KEY`, has to be in escrow **off the VM** beforehand: the
nightly registry backup is sealed under that key, so a dump without it is
unreadable ciphertext. The escrow, not the bucket, is what makes a dead VM
recoverable.

## Identity + signup flow

1. `GET /auth/github` → provider authorize URL (state cookie).
2. `GET /auth/github/callback` → exchange code for profile.
   - Existing user → session → `/dashboard`.
   - Operator login → account created, invite gate bypassed.
   - Anyone else → pending signup (30 min) → `/signup` asks for an invite code.
3. `POST /signup` redeems the invite atomically (invalid, revoked, and exhausted
   codes are refused; a failed signup never burns a use) and signs the user in.

Sessions are 30-day httpOnly cookies storing only a sha256 hash server-side, with
a double-submit CSRF token (`cp_csrf` cookie ↔ `x-csrf-token` header / form field)
required on mutating routes. No identity method other than GitHub exists.

### Issuing invite codes

Invite codes are issued through the authenticated control-plane API. Sign in to
the control-plane `/dashboard` as the operator, open the browser DevTools
Console, review the following same-origin request, and run it:

```js
await (async () => {
  const csrfMatch = document.cookie.match(/(?:^|;\s*)cp_csrf=([^;]+)/);
  if (!csrfMatch) throw new Error('No control-plane CSRF cookie; sign in again.');

  const response = await fetch('/api/invites', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': decodeURIComponent(csrfMatch[1]),
    },
    body: JSON.stringify({
      maxUses: 1,
      workspaceQuota: 1,
      note: 'Single-user workspace invite',
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Invite request failed (${response.status})`);
  }
  return payload;
})();
```

Chrome may block pasted Console text with its self-XSS warning. Read and review
the request first; if you understand it, type `allow pasting` manually and press
Enter, then paste and run the request.

For the usual one-person invitation, keep both values at `1`:

- `maxUses` is the number of accounts that may redeem the code.
- `workspaceQuota` is the number of workspaces each account created through that
  invite may own.

A successful response includes the plaintext code:

```json
{
  "inviteId": "…",
  "code": "2b-…",
  "maxUses": 1,
  "workspaceQuota": 1
}
```

Copy the `code` value and send it to the recipient over an appropriate private
channel. The plaintext code is returned only when it is created. The database
stores its digest, and `GET /api/invites` lists only a prefix, so a lost code
must be replaced with a newly issued one.

The recipient signs in with GitHub, enters the code on `/signup`, and then
creates a workspace from `/dashboard`. If issuance returns `operator_required`,
the signed-in account is not the claimed operator; check the one-time
`CP_OPERATOR_GITHUB_IDS` bootstrap described above.

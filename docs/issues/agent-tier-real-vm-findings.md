# Agent tier on a real VM — findings from the first run (2026-07-28)

The agent tier (#56, #57, #58 — all merged to `master` at `d79bd7c`) was run on
real Oracle Cloud for the first time on 2026-07-28. **It had never worked.**
Seven defects, each fatal on its own, were live on `master` behind 310 green
cloud tests. All seven are fixed here; the fixes are proven on a real VM, not
only in the suite.

Workspace `agent3.ws.2brainai.tech` now provisions through the public control
plane, reaches `running` only after the OpenClaw gateway answers, serves GBrain
at `/` and the OpenClaw control UI at `/agent/`, and survives a reboot.

This file records what the suites could not see, and what is still missing
before a customer can use the agent. It is not a progress log.

---

## 1. The seven defects, and why every suite missed them

| # | Defect | Symptom on a real VM |
|---|---|---|
| A | `GBRAIN_AGENT_TIER` was not in `gbrain-cloud-init-finalize`'s closed key allow-list | `unknown cloud-init environment key`, exit 2 — GBrain, worker, scheduler and Caddy never started |
| B | The agent finalizer ran even though the Brain finalizer had failed | Token minted, gateway configured, Caddyfile replaced, all over a half-built Workspace |
| C | `InaccessiblePaths=/run/docker.sock` — a path the image never creates | `status=226/NAMESPACE`, restart loop |
| D | `ExecStart=… openclaw gateway --foreground` — not a flag in 2026.7.1-2 | `OpenClaw does not recognize option`, restart loop |
| E | `gateway.mode` was never set | `Gateway start blocked: existing config is missing gateway.mode` |
| F | `InaccessiblePaths=-/run/systemd` masks the directory systemd builds the namespace from | `status=226/NAMESPACE` **with no log line at all** |
| G | Private `/tmp` took systemd's root-owned `0755` default | `Unable to create fallback OpenClaw temp dir`, exit 1 |

Two failure classes are worth naming, because both will recur:

**Two lists that must agree, with nothing comparing them (A).** The control
plane renders `workspace.env`; the image validates it against a closed
allow-list. Different files, different suites, no shared source of truth. The
regression test now feeds the agent-tier render straight into the finalizer's
own `--validate-only`, so the renderer can never again emit a key the image
refuses.

**Static contract tests read a unit as text; systemd runs it (C–G).** #56 built
a genuinely rigorous verifier — pinned spans, stack walkers, mutation probes —
and every one of C through G still shipped past it. A unit file can parse
perfectly, satisfy every allow-list, and still be one systemd will never start.
F is the sharpest case: it is the *last* mount applied, so it fails with nothing
but a bare exit code. Nothing short of booting the unit finds these.

**Ordering hid the tail behind the head.** The agent finalizer aborted at
`systemctl reload caddy` — Caddy was never enabled, because of A — before
reaching its own gateway probe, which is precisely the check that would have
reported D through G. Each fix revealed the next defect; there is no reason to
expect the seventh was the last, only that the boot path is now clean.

## 2. What is proven, and what is only assumed

Proven on the live VM:

- Provisioning reaches `running` **only** after the agent gateway answers
  (12 recorded probe attempts before promotion), and a failed provision rolls
  back and terminates the instance.
- All six services active, `cloud-init status: done`, `[gateway] ready`.
- Every path in `InaccessiblePaths` is mode `0` **inside the running service's
  namespace** — the isolation survives the narrower `/run/systemd` masking.
- A GBrain Agent credential authenticates over real HTTP (its
  `verifyAccessToken` branch was dead code before #58), and Agent Activity
  records one row per call, refusals included, with `last_used_at` populated.
- Source Access fails closed: at Read + No Source Access, `list_pages` is
  refused `permission_denied` and `put_page` `insufficient_scope`.
- OpenClaw reaches GBrain over MCP and sees all 85 tools.
- Reboot persistence: `/health` and `/agent/` both answer 200 afterwards.

**Not** proven, and should not be claimed:

- The granted-write half of Source Access — grant one Source, write into it,
  refuse a write aimed outside the grant — was not exercised.
- Gateway token enforcement end to end. An unauthenticated WebSocket receives a
  `connect.challenge`, so a gate exists, but the protocol was not driven to a
  verdict.
- Anything owned by #60–#64: channels, scheduled browser work, resource
  saturation, suspend/resume, export.

## 3. The security precondition: metadata hands over every credential

From inside the OpenClaw process,
`http://169.254.169.254/opc/v2/instance/metadata/user_data` returns 200 and
yields `GBRAIN_BOOTSTRAP_CREDENTIAL`, `GBRAIN_WORKSPACE_TOKEN_SECRET`,
`GBRAIN_DATABASE_URL` (with the PostgreSQL password), and `OPENROUTER_API_KEY`.

The unit's filesystem masking of `/etc/gbrain` is therefore decorative: the same
secrets are one HTTP call away. The bootstrap credential in particular is a path
to first-Administrator access to the Workspace.

This is nominally #61's scope (egress isolation), but it is a precondition for
giving any customer an agent, not a later hardening step. `gbrain-agent` shares
the host network namespace, so the fix is a firewall rule scoped to the
`openclaw` UID, not a network namespace.

**Current state: no egress isolation is implemented.**
`cloud/image/scripts/provision.sh` installs exactly one owner-scoped rule pair
for the `openclaw` UID — an IPv4 and an IPv6 REJECT of TCP 5432 to loopback,
which keeps the agent identity off the local PostgreSQL socket. There are no
metadata, IPv4 link-local, private/fleet, cross-Workspace, or IPv6
unique-local/link-local rules of any kind. Nothing in this repository blocks the
metadata service today, so the exposure described above is live. Do not read the
planned denial categories in T16.8, or the accepted-decision list in
`CLAUDE.md`, as a description of what the image currently enforces.

**#61 is an open RELEASE dependency, not a build blocker.** Agent-tier code may
be built, tested, and exercised on a disposable VM while #61 is open. What is
gated is offering an Agent Workspace to a customer: `bun run
verify:agent-pilot-release` (contract in `docs/RELEASING.md` and
`cloud/README.md`) reports blocked until both #61 and #68 are recorded closed,
one frozen subject commit SHA is shared by the manifest and every evidence
report, and each required real-VM proof reports `pass`. The absent manifest that
is normal before that evidence exists means internal disposable testing only.
#68 must not invent replacement firewall rules; T16.8 runs #61's own
implementation and its own test procedure.

**The isolation must not break VM updates, and the proof is two-sided.** A
whole-VM outbound block would satisfy every denial category and silently break
the box, so denial evidence alone is not evidence. T16.8 records the seven
denial categories **and** the five required positive paths; T16.9 separately
proves that root-owned OS and package update paths keep DNS and public HTTPS,
that `apt-get update` and a simulated upgrade resolve and inspect available
changes, that GBrain, worker, scheduler, Caddy, PostgreSQL, and OpenClaw all
return healthy afterwards, that the bound Agent still passes `gbrain__whoami`,
and that OpenClaw's denied private destinations remain denied after the update
run. Never weaken the `openclaw` identity's filter to make an OS update pass —
update processes run under their own privileged identity and keep only the
public access they need.

## 4. The usability gap: no customer can reach the agent today

The runtime works. The **route in does not exist**. Every step below currently
requires SSH into the workspace VM — which customers do not have, and which only
worked during this run because a test key was injected into cloud-init and then
removed.

1. **The gateway token is unreachable.** It is generated on the VM into
   `/etc/openclaw/agent.env` (`0640 root:openclaw`) and deliberately retained by
   no control plane. Nothing surfaces it. The Agents panel tells Administrators
   to "go to `/agent` and add this MCP server" while never giving them the
   credential that gets them in. (#59)
2. **The control UI cannot find its own gateway.** It does not derive the
   proxied WebSocket URL from the page it was served on: the field is empty with
   a placeholder of `ws://127.0.0.1:18789`. A new Administrator's first
   experience is "Could not connect", with advice to run `openclaw status` — a
   CLI they have no access to. The working value is
   `wss://<subdomain>/agent`.
3. **The MCP snippet in the Agents panel does not work as written.** It declares
   `"type": "http"`, but `openclaw mcp add --url …` defaults to the legacy SSE
   probe, and GBrain's `/mcp` answers `405` to it. It needs
   `--transport streamable-http`. An Administrator following the on-screen
   instructions gets `SSE error: Non-200 status code (405)`.
4. **There is no model credential and no way to add one.** OpenClaw connects but
   cannot think. Its guided setup (`openclaw onboard`) is a CLI on the VM.

### Recommended shape of the fix

The current design asks a customer to hand-carry a secret from a machine they
cannot log into. The better answer is to **remove the token from the customer's
path entirely** rather than surface it more conveniently.

- **Authenticate the agent with the GBrain session (preferred, owns #59).**
  OpenClaw supports `gateway.auth.mode=trusted-proxy`, and the gateway already
  binds loopback with `trustedProxies=[127.0.0.1]`. Put Caddy's `/agent` route
  behind a `forward_auth` to gbrain-web, which authorizes the Workspace session
  and its membership. A trusted Member then clicks **Agent** in GBrain and is
  in — no token, no URL to type, nothing to copy. This matches the shared-agent
  model exactly: authority follows Workspace membership rather than possession
  of a separate secret. The shared-authority warning belongs on that click.
  Token mode stays as the break-glass path for direct/native clients.
- **If the token must remain the mechanism,** it needs a readable surface: have
  the finalizer write a second copy at `0640 root:gbrain` so gbrain-web can
  render it to Administrators only, and have that panel also emit the correct
  `wss://<subdomain>/agent` URL. This is strictly worse than the above — it puts
  a long-lived shared secret on a page — but it is small.
- **Wire MCP automatically instead of printing a snippet.** GBrain knows when an
  Agent is registered on agent tier; it can write the server into OpenClaw's
  config itself. Until then, fix the snippet to name `streamable-http` and stop
  implying a copy-pasteable `mcpServers` block that the CLI will reject.
- **Seed a model on first boot.** The Workspace already holds a spend-capped
  provisioned OpenRouter key. Seeding OpenClaw with it makes the agent useful
  the moment an Administrator opens it, with replacing it a deliberate choice
  rather than a prerequisite. If user-owned keys must stay mandatory, the
  control UI has to be the place it happens — not `openclaw onboard` over SSH.
- **Close the metadata exposure first (§3).** Giving customers a working agent
  before that is handing them a supported way to read their own Workspace's
  platform credentials.

## 5. Operational notes learned in this run

- **Image architecture is pinned to nothing.** `smoke-preflight --discover`
  hands out an `aarch64` base image while the live control plane ran
  `VM.Standard.E5.Flex` (x86). The launch fails `400 InvalidParameter` with no
  mention of architecture. The live fleet is now ARM
  (`VM.Standard.A2.Flex`); the pre-existing brain workspace remains x86 on its
  older image, so the fleet is mixed.
- **`CP_MAX_STEP_ATTEMPTS=120` is now required.** At the default 20 (~105 s) an
  ARM 1-OCPU VM cannot boot and complete ACME in time, and the workspace is
  destroyed by rollback.
- **Packer cannot finish an image build.** Its OCI plugin fails to parse the
  `CreateImage` response —
  `malformed MIME header line: application/json: application/json` —
  reproducibly, on every attempt. **The image is created regardless**: the POST
  succeeds server-side. Workaround: `packer build -on-error=abort`, wait for the
  image to reach `AVAILABLE`, then terminate the retained build instance by
  hand. `cloud/image/build.sh` reports failure and writes no manifest.
- **`install.sh` cannot fetch a bare commit SHA** (`couldn't find remote ref`).
  Pass a branch as `REPO_REF` and record the resolved SHA separately.

---

# FROZEN PROCEDURE — #68 Task 16 disposable-VM proof (written in Task 14)

Everything above this line records the 2026-07-28 run. Everything below is a
**procedure that has not been executed**. It is frozen here in Task 14 so that
Task 16 runs a fixed script against a fixed subject commit rather than
improvising in front of a live VM.

No item below may be marked passed by reading it. Task 16 executes it against an
image built from the frozen subject commit, then writes
`docs/verification/agent-pilot-browser-native.md` and
`docs/verification/agent-pilot-vm-isolation.md`. Those two files are created in
Task 16 and **must not exist before it**.

## T16.0 Gate — resolve every unverified external contract BEFORE provisioning

The four blocks below are carried forward **verbatim** from the Task 14 brief.
Each is a *must-resolve-before-VM* item. Resolve it against the pinned
`openclaw@2026.7.1-2` artifact (`npm pack openclaw@2026.7.1-2`, then read the
tarball) or against the real vendor CLI, and record the resolution in the table
that follows, before any VM is launched. A step whose command or path is wrong
does not fail — it silently proves nothing, which is the exact
presence-check-instead-of-proof failure class that section 1 above already cost
us seven defects for.

If resolving one of these changes a command string, the product copy that
renders that same string (the Task 11 Agent page) **must change in the same
commit**, or the documentation and the UI silently disagree.

> **[UNVERIFIED EXTERNAL CONTRACT — installed layout and CLI.]** Two things here
> are drafts. First, the installed path
> `/opt/openclaw/node_modules/.package-lock.json` and the shape of its integrity
> entry: confirm against the image the provisioner actually builds, not against
> this line — an integrity check that reads the wrong file, or a missing file,
> must fail closed rather than pass vacuously. Second,
> `openclaw mcp doctor gbrain --probe --json`: confirm the subcommand and both
> flags exist in openclaw@2026.7.1-2. This step is a **verifier**; a verifier
> that silently no-ops because a path or flag was wrong is the exact
> presence-check-instead-of-proof failure this branch has hit repeatedly.

> **[UNVERIFIED EXTERNAL CONTRACT — third-party auth flows.]** Steps 6-7 assume
> `/login codex` exists and drives a browser device-code flow; step 9 assumes
> `claude setup-token` is the current Anthropic CLI command and that its output
> is what the plugin route's `validateAnthropicSetupToken` accepts. Both are
> other vendors' surfaces and may have changed. This is the one step that spends
> real subscriptions on a real VM — confirm each command before the VM is
> provisioned, not while standing in front of it.

> **[UNVERIFIED EXTERNAL CONTRACT — pinned OpenClaw CLI.]** `openclaw config set`
> with the `gateway.mode` / `gateway.remote.url` keys, `openclaw tui`,
> `OPENCLAW_GATEWAY_PASSWORD`, `openclaw mcp serve`, and `--password-file` are
> all unconfirmed against openclaw@2026.7.1-2. They must match the strings Task
> 11 renders in the product UI — if this step's commands are corrected, correct
> the UI copy in the same change, or the two will silently disagree.

> **[RESOLVED EXTERNAL CONTRACT — auth-profile store and session metadata.]**
> Resolved against the pinned `openclaw@2026.7.1-2` artifact, and the resolution
> **contradicts** the shape this procedure originally assumed. The live store is
> not a flat `auth-profiles.json`; that filename survives only as an
> import/export compatibility format and is not what the gateway reads on start.
> The runtime store is SQLite:
>
> ```text
> file    <agentDir>/openclaw-agent.sqlite
> table   auth_profile_store
> row     store_key = 'primary'
> column  store_json   (TEXT, holds the JSON payload)
> ```
>
> `<agentDir>` is `<state dir>/agents/<agentId>/agent`, where the state dir is
> `$OPENCLAW_STATE_DIR` or `<home>/.openclaw`. The live read path has **no**
> fallback to the JSON file. Inside `store_json` the payload does have the
> expected `{ profiles: { <profileId>: <credential> } }` shape,
> `provider: "openai"` is a real field value on Codex credentials, and profile
> ids follow `<provider>:<name>` — the convention `anthropic:gbrain` already
> uses. The answering backend is named by `result.meta.agentMeta.provider` and
> `result.meta.agentMeta.model`, and for fallback races by
> `result.meta.executionTrace.winnerProvider` / `.winnerModel`; all four are
> distinct from a provider response body's own `model` field, which is what
> T16.5 must assert on.
>
> A helper written to the original flat-file assumption would find no such file,
> silently no-op or error, and report the Codex-to-Claude fallback "proven"
> without it ever having fired — the exact presence-check-instead-of-proof
> failure class this gate exists for. T16.5 below carries the corrected
> procedure; do not re-derive it from the earlier text.

One correction is already resolved and must **not** be re-broken: Channels is a
sibling top-level destination in the pinned Control UI, not nested under Config.
The product renders `Agent -> Channels`. Any evidence or command that says
`Config -> Channels` is wrong.

### T16.0 resolution record (fill in before provisioning)

| Contract | Resolved value | Where confirmed | UTC |
|---|---|---|---|
| Installed OpenClaw lock path | | | |
| Integrity entry shape | | | |
| `openclaw mcp doctor` subcommand and both flags | | | |
| Codex `/login codex` device flow | | | |
| `claude setup-token` output vs `validateAnthropicSetupToken` | | | |
| `openclaw config set gateway.mode` / `gateway.remote.url` | | | |
| `openclaw tui` and `OPENCLAW_GATEWAY_PASSWORD` | | | |
| `openclaw mcp serve --url --password-file` | | | |
| Auth-profile store path and JSON shape | SQLite `<agentDir>/openclaw-agent.sqlite`, table `auth_profile_store`, row `store_key='primary'`, column `store_json` (TEXT) holding `{ profiles: { … } }`. NOT a flat `auth-profiles.json`. | pinned `openclaw@2026.7.1-2` artifact | 2026-08-04 |
| `provider: 'openai'` selector and `anthropic:gbrain` profile name | `provider: "openai"` is a real field value on Codex credentials; profile ids are `<provider>:<name>`, so `anthropic:gbrain` follows the convention | pinned `openclaw@2026.7.1-2` artifact | 2026-08-04 |
| Session/run metadata naming the answering backend | `result.meta.agentMeta.provider` / `.model`; for fallback races `result.meta.executionTrace.winnerProvider` / `.winnerModel` | pinned `openclaw@2026.7.1-2` artifact | 2026-08-04 |

## T16.1 Local gate — the release journey must pass first

Task 14 added the Agent-tier customer journey to the existing Postgres/Playwright
release harness. One run drives the Brain-tier journey and then the Agent-tier
journey, each against its own throwaway database:

```bash
DATABASE_URL="$DATABASE_URL" \
WORKSPACE_RELEASE_EVIDENCE_DIR=/tmp/agent-browser-evidence \
bun run scripts/verify-workspace-browser.ts
```

Expected: exit `0`; `browser-evidence.json` and `agent-browser-evidence.json`
written; screenshots recorded; every accessibility scan empty; and the
Agent-tier report proved free of the derived shared password. Do not provision a
VM while this is red.

## T16.2 Provision a fresh disposable Agent VM (brief Step 2)

Use the normal control-plane smoke/provision workflow with an image built from
the exact frozen subject commit. Do **not** retrofit an existing Brain
Workspace. Record only a generic VM evidence identifier, the image identifier,
the subject commit SHA, the OpenClaw version, and UTC timestamps.

Before provider setup, prove:

```text
GET /health                                      2xx
GET /api/workspace/v1/agent/runtime-health       204
GET /agent/ without GBrain session               401
GET /agent-client/ without password/readiness    non-2xx
TCP 3334 from the public network                 unreachable
```

Then compare the installed `/opt/openclaw/node_modules/.package-lock.json`
OpenClaw integrity entry with the repository's pinned
`cloud/image/openclaw/package-lock.json` entry, **and** check the version is
`2026.7.1-2`. Fail if either version or integrity differs. The comparison must
fail closed on a missing or unreadable file: record the path and bytes actually
read, never "the check ran".

Then live-probe the allowlisted admin RPC, the bounded provider route, the
Responses endpoint, `/tools/invoke`, and:

```bash
openclaw mcp doctor gbrain --probe --json
```

Use safe health/validation requests only. Never print credentials or upstream
payloads into evidence.

## T16.3 Complete setup without giving the pilot user VM access (brief Step 3)

As the Administrator, through the product UI only:

1. Accept the warning.
2. Initialize the bound Agent.
3. Leave Scope at Read and Source Access at None.
4. Confirm the grant.
5. Wait for live `gbrain__whoami`.
6. Open `/agent/` and send `/login codex`.
7. Complete the Codex device-code flow in the Administrator's browser.
8. Run **Check Codex** and record exact `openai/gpt-5.6-sol`.
9. On the Administrator's own trusted computer, run `claude setup-token`.
10. Paste it into GBrain once, then run **Check Claude** and record exact
    `anthropic/claude-sonnet-5`.
11. Run the default answer proof.

Then inspect the GBrain database, the service journal, the cloud-init log, the
HTTP access log, the page source, and the evidence output for distinctive
canaries. Do not copy auth-store contents into evidence.

## T16.4 Prove browser, native app, and CLI access (brief Step 4)

With two active Members:

- fresh browser device profiles for both Members open `/agent/` through GBrain
  sessions without an OpenClaw token or password, complete the pinned
  loopback-device pairing, and successfully make an admin-scoped `config.*`
  call. `models.list` is `operator.read`, **not** `operator.admin`, so it cannot
  serve as the admin-scoped probe;
- both see the same OpenClaw conversations, files, and schedules;
- fresh native desktop and mobile device profiles perform real WebSocket
  protocol handshakes to `wss://<workspace>/agent-client/` with the shared
  password, pair, and prove an admin-scoped call;
- configure the test computer once with:

  ```bash
  openclaw config set gateway.mode remote
  openclaw config set gateway.remote.url wss://<workspace>/agent-client/
  ```

  then set `OPENCLAW_GATEWAY_PASSWORD` without putting its value in shell
  history, and run `openclaw tui` **without** `--url`;
- `openclaw mcp serve --url wss://<workspace>/agent-client/ --password-file <mode-0600-file>`
  connects;
- real WebSocket handshakes with no password and with a wrong password fail
  before pairing;
- a forged proxy-user header from the public side fails;
- the Member can switch among connected models;
- resetting the session to Default restores automatic fallback.

Record product screenshots with generic identities and redact the Workspace
hostname.

## T16.5 Prove real Codex to Claude fallback visibility (brief Step 5)

On this disposable VM only, and never against a VM holding customer data:

1. Start a default-model session and prove Codex answers from OpenClaw
   session/run metadata, not from `response.model`.
2. Stop the Gateway and use an ephemeral root-only helper under `/run` to mutate
   the auth-profile store. The store is **SQLite**, not a flat JSON file, so the
   helper must:

   1. resolve `<agentDir>/openclaw-agent.sqlite`, where `<agentDir>` is
      `<state dir>/agents/<agentId>/agent` and the state dir is
      `$OPENCLAW_STATE_DIR` or `<home>/.openclaw`;
   2. **fail closed if that file does not exist or cannot be opened.** A missing
      file is not an empty store — it means the path is wrong and the whole
      fallback proof below would be vacuous;
   3. copy the database file to a mode-`0600` backup under `/run` and record its
      hash;
   4. `SELECT store_json FROM auth_profile_store WHERE store_key='primary'`,
      `JSON.parse` **that string** (the payload is inside the TEXT column, not
      the file), count `profiles` entries, remove only entries whose `provider`
      is `openai`, and `UPDATE` the same row with the re-serialized payload;
   5. assert the entry count actually decreased, and abort the whole step if it
      did not;
   6. restart the Gateway.

   The helper never prints profile IDs, credential values, or `store_json`
   contents. A helper written against a flat `auth-profiles.json` finds no file,
   no-ops, and "proves" a fallback that never fired.

3. Send another default-model turn.
4. Prove OpenClaw uses `anthropic/claude-sonnet-5` from session/run metadata and
   shows its fallback notice.
5. Stop the Gateway, atomically restore the root-only backup, delete the
   ephemeral copy, restart, and prove the restored Codex profile works.
6. Prove OpenClaw shows recovery and returns to `openai/gpt-5.6-sol`.
7. Repeat the same backup/filter/restore procedure for only the
   `anthropic:gbrain` profile. Select Claude explicitly and prove the strict
   session errors rather than silently choosing another model.
8. Reset to Default and prove the automatic chain returns.

"Session/run metadata" above means `result.meta.agentMeta.provider` /
`result.meta.agentMeta.model`, and for a fallback race
`result.meta.executionTrace.winnerProvider` / `.winnerModel`. A provider
response body's own `model` field is not evidence of which backend answered.

Always restore the original `openclaw-agent.sqlite` and hash-compare it against
the backup in `finally`, even when the test fails. **Assert that the removed
entry count actually changed**: a filter that matched nothing leaves Codex
working and "proves" a fallback that never fired.

## T16.6 Prove approval behavior with two Members (brief Step 6)

Trigger a harmless OpenClaw action that requires approval:

- both active Members see the pending approval;
- Member A allows it and the action runs once;
- Member B's later response is refused as already resolved;
- a second harmless request receives no response and ends denied at timeout;
- no GBrain API or UI can force the action through;
- terminal remains unavailable.

## T16.7 Prove Member disable and provider independence (brief Step 7)

Keep a browser and a native client open for Member B, then disable that
membership:

- the GBrain browser session stops authorizing immediately;
- the membership-status response is `200` or `202` as specified;
- the native ingress locks during rotation;
- the OpenClaw auth-generation reload closes every pre-existing native
  WebSocket. Record the close code and reason when the pinned runtime emits one,
  and prove the closure is causally between the config patch and Gateway
  recovery;
- a fresh real WebSocket handshake with the old password cannot reconnect;
- Member A fetches the new password, and a fresh device profile completes a real
  WebSocket handshake, pairs, and makes an admin-scoped call;
- Member B cannot fetch it;
- Codex, Claude, OpenRouter if configured, channels, conversations, and files
  remain present.

The Task 14 local journey already proves the GBrain half of this: session
revocation survives re-enabling the membership, disclosure is refused, the
rotation is applied, and the remaining Member receives the new generation. This
step exists for the half a fake runtime cannot reach — the real WebSocket
closure and reconnection.

## T16.8 Run the #61 owner-scoped network proof (brief Step 8)

Use issue #61's implementation and its own test procedure; #68 must not invent
replacement firewall rules. From the `openclaw` OS identity, prove denial for
operator-supplied test destinations in every category:

```text
cloud metadata
IPv4 link-local
private/fleet ranges
another disposable Workspace deployment
IPv6 link-local
IPv6 unique-local/private
IPv4-mapped IPv6 equivalents
```

Then prove the required positive paths:

```text
public DNS resolution from OpenClaw
public HTTPS from OpenClaw
OpenClaw authenticated loopback Gateway use
OpenClaw authenticated GBrain MCP use
GBrain/worker/scheduler loopback and database dependencies
```

Record commands and outcomes using generic destination labels. Keep actual fleet
addresses out of committed evidence.

## T16.9 Prove VM updates were not broken (brief Step 9)

```bash
sudo apt-get update
sudo apt-get --simulate upgrade
sudo systemctl restart gbrain-web.service gbrain-worker.service gbrain-scheduler.service
sudo systemctl is-active --quiet gbrain-web.service
sudo systemctl is-active --quiet gbrain-worker.service
sudo systemctl is-active --quiet gbrain-scheduler.service
sudo systemctl is-active --quiet gbrain-agent.service
```

Expected:

- package indexes download over root-owned public network access;
- the simulated upgrade can resolve and inspect available package changes;
- OpenClaw's denied private destinations remain denied afterwards;
- GBrain, worker, scheduler, Caddy, PostgreSQL, and OpenClaw return healthy;
- the bound Agent still passes `gbrain__whoami`.

Do not weaken the OpenClaw identity's filter to make OS updates pass. OS and
package update processes run under their own privileged identity and retain only
the public access they need.

## T16.10 Inspect deletion and export on the disposable VM (brief Step 10)

Create a Workspace Export and prove it carries no OpenClaw state and none of the
canaries planted in T16.3. Read the deletion warning. Delete the disposable
Workspace through the normal control-plane lifecycle and prove the VM, DNS, and
credentials are released. This is safe here because the VM holds only synthetic
pilot data.

## T16.11 Evidence-report contracts (brief Step 11)

Create both files only after the runs above, and only with results actually
observed.

`docs/verification/agent-pilot-browser-native.md` must record:

| Section | Contents |
|---|---|
| Subject | generic VM evidence identifier, image identifier, subject commit SHA, OpenClaw version, UTC start and end |
| Pre-setup gates | the five T16.2 probes with observed status codes |
| Integrity | installed versus pinned OpenClaw version and integrity comparison, plus the file actually read |
| Setup | the eleven T16.3 items, each PASS or FAIL, with the exact recorded model identifiers |
| Browser access | both Members, pairing, the admin-scoped `config.*` call, shared conversations/files/schedules |
| Native access | real WebSocket handshakes: success, no password, wrong password, forged proxy header |
| CLI access | `openclaw tui` without `--url`, and `openclaw mcp serve --password-file` |
| Fallback | the eight T16.5 items, including the asserted entry-count change and the `finally` hash comparison |
| Approvals | the six T16.6 items |
| Revocation | the eight T16.7 items, including the WebSocket close code/reason and its causal position |
| Export and deletion | canary scan result, deletion warning text, released resources |

`docs/verification/agent-pilot-vm-isolation.md` must record:

| Section | Contents |
|---|---|
| Subject | image identifier, subject commit SHA, UTC timestamps |
| Denials | all seven T16.8 categories, with generic destination labels |
| Positives | all five T16.8 required positive paths |
| Updates | `apt-get update`, the dry-run upgrade, service recovery, and the post-update denial re-proof |

Both reports must:

- use generic identities and redacted origins;
- contain no password, cookie, provider credential, Agent credential, internal
  address, exact fleet rule, prompt content beyond the fixed readiness prompt,
  or model response;
- mark any unproven item `FAIL` — never "assumed", "expected", or
  "not applicable".

## T16.12 Known traps this run will hit

Carried forward from section 5 so Task 16 does not rediscover them:

- `CP_MAX_STEP_ATTEMPTS=120` is required. At the default the Workspace is
  destroyed by rollback before ACME finishes on a 1-OCPU ARM VM.
- The fleet is ARM (`VM.Standard.A2.Flex`). `smoke-preflight --discover` may
  still hand out a mismatched base image, and the launch then fails
  `400 InvalidParameter` without naming architecture.
- Packer reports failure on every image build (`malformed MIME header line`)
  **but the image is created**. Wait for `AVAILABLE`, then terminate the retained
  build instance by hand. No manifest is written.
- `install.sh` cannot fetch a bare commit SHA. Pass a branch as `REPO_REF` and
  record the resolved SHA separately.
- The metadata exposure in section 3 is a precondition, not a footnote. If it is
  still open, the pilot hands customers a supported way to read their own
  Workspace's platform credentials.

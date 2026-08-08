```yaml
status: fail
subject_commit_sha: d2cdca5bd52b0b2748e8a4967cf4621afb006487
verified_at: 2026-08-04T13:45:00Z
```

# Agent pilot — full test run

Verdict: **fail**. The full-suite gate still does not complete green on this
host, so the customer-pilot release gate stays blocked. This report records what
passed, what did not, and why — it does not convert a partial result into a
pass.

Three earlier subjects were frozen and then voided, each by a defect that only a
real VM boot exposed:

| Void subject | What it hid |
|---|---|
| `62daeb6` | The agent service could not boot: the OpenAI provider selected the Codex harness, whose external plugin the image does not ship and cannot install under a read-only `$HOME`. |
| `5caf8b0` | The agent booted, but `gbrain-agent-finalize` exited 2 — its ESM config probe was written to an extensionless `mktemp` name, so Node refused to load it and every live route probe below it was skipped. |
| `235af70` | The probe ran at last, then died `ENOENT` on the **literal** path `$OPENCLAW_HOME/.openclaw/openclaw.json`, because `openclaw config file` returns a display path — and reported it as a contract mismatch. |

Each failure was reported as something other than what it was. That is the
pattern this report exists to resist.

## The full gate

```bash
bun run ci:local
```

Not re-run at this subject. It was run at `62daeb6` and exited **123**
(`xargs`: one or more parallel shards exited non-zero), for a reason that is
environmental and unchanged: the runner bind-mounts the *host* working tree into
a Linux container, this checkout has CRLF line endings, so `skills/*/SKILL.md`
begins `---\r\n` and every consumer anchored on a bare `\n` fails. The two
largest failure families were that single artifact — 84 assertions in
`RESOLVER.md trigger round-trip`, 24 in `skills conformance`.

`skills/` is byte-identical to branch base `8075a51` and GitHub Actions checks
out LF, so this reproduces only on a Windows working tree. One shard also cost
58 minutes, so the gate is not a practical local pre-release check on this host
regardless.

Closing this out needs an LF checkout inside the runner container — a
`.gitattributes`-normalised copy or `core.autocrlf=input` — not a test change.
CI on the pull request is the authority for the full suite.

## What is proven at this subject commit

| Check | Result |
|---|---|
| `bun run typecheck` (root, Windows) | exit 0 |
| `bun run typecheck` (`cloud/`, Windows) | exit 0 — the root typecheck does **not** cover `cloud/` |
| `bun run check:all` (WSL) | exit 0 |
| Focused check — 14 `test/` files (WSL) | 410 pass / 1 fail (see below) |
| `test/workspace-export.test.ts` (Windows) | 14 pass / 0 fail |
| `cloud/test` — full suite | 363 pass / 16 skip / 1 fail (see below) |
| `cloud/test/workspace-transport-caddy.test.ts` with a real binary | 17 pass / 0 fail |
| `test/e2e/workspace-boundary-postgres.test.ts` (WSL, real Postgres) | 29 pass / 0 fail |

Two failures above are environmental, and both were confirmed rather than
assumed:

- **`test/workspace-export.test.ts` under WSL** — its `beforeAll` runs 118
  migrations on PGLite over the `/mnt/d` mount and exceeds the 5 s hook timeout.
  Reproducible in isolation there, and the same file passes 14/14 on native
  Windows Bun. Environment, not code.
- **`cloud/test` "a Caddy binary is available to prove the ingress split"** — a
  deliberate gate that fails when no `caddy` binary is on `PATH`. Supplied via
  `GBRAIN_CADDY_BIN`, the ingress suite runs and passes 17/17. The gate failing
  loudly rather than skipping silently is the intended design.

## Real-hardware results

Live agent workspace `aziz-5111.ws.2brainai.tech` (`14fefae2`), provisioned by
the production control plane from image
`2brain-workspace-d2cdca5bd52b-20260804120839`.

| Journey step | Result |
|---|---|
| Provision, finalize, route | **pass** — all six HTTP proofs; the finalizer's three live route probes executed for the first time at this subject |
| OpenClaw panel reaches the GBrain MCP surface | **pass** — driven by the pilot user |
| Restart persistence | **pass** — `SOFTRESET`, then `/health` 200 and `/agent/` 401 within ~30 s. A 401 rather than 502 is the proof: a lost OpenClaw config blocks gateway start outright |
| Suspend and resume | **pass** — the instance genuinely stopped (HTTP fell to 000), resumed to `running` on its original IP with no provisioning error, gateway answering ~19 s later |
| Agent MCP **write** and Agent attribution | **NOT PROVEN live** — proved in code only |
| Out-of-Source refusal | **NOT PROVEN live** — proved in code only |
| The seven `#61` network-denial categories | **NOT PROVEN** — deliberately deferred; see below |

### Why the last three are not live results

The Agent credential exists only on the workspace VM and in that Workspace's own
database. The VM carries no SSH key — port 22 answers from the control plane and
rejects every user — and the control plane retains no copy by design. `/mcp`
answers an unauthenticated caller 401, correctly. Closing these two needs the
pilot user's own panel session, not more automation.

What *is* proved, on real Postgres, is the mechanism: 76 source-sensitive
operations driven through the real MCP dispatch path with a principal holding no
Source Access, every one denied, with no restricted marker leaked in any
response. Agent attribution, run metadata, and Source-filtered activity are
covered by 22 further tests. See `agent-pilot-postgres.md`.

The `#61` denial categories are **not** an environmental gap. They were skipped
on an explicit scope decision — reach functional proof before building guards.
They must never be recorded as `pass` or as `n/a` in
`agent-pilot-vm-isolation.md`.

## Consequence

`status: fail` here blocks `docs/verification/agent-pilot-release.json`, which is
correct. Customer Agent Workspace provisioning stays disabled; internal
disposable-VM and operator testing remain allowed. Production currently runs
this branch under exactly that allowance.

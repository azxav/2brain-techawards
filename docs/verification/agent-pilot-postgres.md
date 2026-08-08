```yaml
status: pass
subject_commit_sha: d2cdca5bd52b0b2748e8a4967cf4621afb006487
verified_at: 2026-08-04T13:25:00Z
```

# Agent pilot — PostgreSQL parity

Workspace boundary contracts re-proved on PostgreSQL at the frozen subject
commit. Verdict: **pass** — 29 tests, 0 failures, 69.1s.

This run supersedes identical `pass` results taken at `8bcbf74` and `62daeb6`.
Both subjects were voided by later fixes to the agent image; the suite was re-run
in full against the new subject rather than either result being carried forward.
The void chain is recorded in
`.superpowers/sdd/2026-07-29-openclaw-customer-access/t16s7-build-image.sh`.

```bash
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5434/gbrain_boundary' \
  bun test test/e2e/workspace-boundary-postgres.test.ts
```

Executed under WSL with native Bun against a `pgvector` container published on
host port 5434, with `git rev-parse HEAD` equal to the subject. PGLite is the
local/test engine and PostgreSQL is the shared production engine (ADR-0045);
engine parity is what stops a PGLite-green suite from masking a PostgreSQL-only
failure in the Agent-tier authorization paths.

## Why the command carries an explicit `DATABASE_URL`

The parity suite selects its engine from `DATABASE_URL`. With that variable
unset it does not fail — it skips, and the run reports green having proved
nothing about PostgreSQL. The variable is therefore part of the evidence, not
an environment convenience, and the run above records it having been set.

## Execution environment

Run under WSL with native Bun rather than on the Windows host. Windows Bun
starves `postgres.js` sockets on this repository's parity suite, which surfaces
as connection-level flake unrelated to the contracts under test. The suite
enforces this itself: it skips outright on `win32`, so a Windows run would be a
silent green proving nothing.

## Covered contracts

Schema and audit: immutable redacted Audit and Change Events, including those
written for failed mutations, and Change Event cursor allocation serialized
through transaction commit order.

Authorization: the deny-by-default Source Access policy; canonical operation
access and multi-Source version filtering; email-bound single-use invitation
redemption carrying role and Source Access independently; Agent registration,
authorization, rotation, and revocation; durable Agent customer-access
constraints; Agent Activity filtered through the viewer's current Source Access.

Operations: Source maintenance evidence and projections; permanent deletion of
an Archived Source; a secret-free Workspace Export taken under a consistent
PostgreSQL snapshot; deterministic retention with concurrent claims and restart
recovery.

## What this suite is, and is not, evidence of

It drives the real MCP dispatch path with a principal holding no Source Access
across 76 source-sensitive operations, asserts every one is denied, and asserts
no response leaks a restricted fact, job, or stacktrace marker. That is the
mechanism behind the Agent's out-of-Source refusal.

It is not a live proof. The same refusal has never been observed through a real
Agent credential on a real Agent Workspace VM, because that credential exists
only on the VM and in that Workspace's own database, and the control plane
retains no copy. See `agent-pilot-full-test.md` for what was and was not proved
on real hardware.

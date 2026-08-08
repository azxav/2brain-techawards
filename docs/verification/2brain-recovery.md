# 2Brain v1 recovery evidence

Verified on 2026-07-14. Verdict: **pass**.

Production runs Postgres plus two independently supervised processes — an
always-on worker and a scheduler (`docs/operations/2brain-clean-start.md`). The
release must survive either of them dying at the worst possible moment: while
holding a lease on a destructive operation.

## Setup and clean start

| Property | Evidence |
| --- | --- |
| The foundation initializes idempotently and creates no legacy projections | `workspace-foundation`: *initializes idempotently without creating legacy product projections* |
| A database with pre-existing public tables is rejected, not adopted | `workspace-foundation`: *rejects every existing public table instead of attaching clean-start tables to it* |
| Concurrent first-Administrator setup cannot create two Workspaces | `workspace-setup`: *database singleton invariant prevents concurrent first-Administrator setup* |
| The bootstrap credential issues a replay-safe setup link | `workspace-setup`: *bootstrap credential issues a replay-safe setup link and the confirmed administrator enters only the empty shell* |
| Setup works end to end through the browser against real Postgres | Browser journey: `first_administrator_setup` |

The clean-start refusal was re-executed live during the rollback rehearsal — see
[2brain-rollback.md](2brain-rollback.md).

## Worker and scheduler recovery

| Property | Evidence |
| --- | --- |
| Worker and scheduler liveness are recorded independently | `workspace-foundation`: *records worker and scheduler liveness independently* |
| An expired running lease is reclaimed and the job completes after restart | `workspace-retention`: *reclaims an expired running lease after worker restart*; `workspace-export`: *reclaims an expired running lease and completes on restart* |
| Permanent deletion recovers idempotently after a worker restart | `workspace-source-deletion`: *recovers after a worker restart by reclaiming the expired lease idempotently* |
| An expired lease fails durably once restart attempts are exhausted | `workspace-retention`: *fails an expired lease durably when restart attempts are exhausted*; `workspace-export`: *fails durably once attempts are exhausted* |
| Only one worker claims a queued job | `workspace-retention`: *allows only one concurrent worker to claim a queued job* |

## Idempotency

Destructive and expensive operations are keyed, so a retried request cannot
duplicate work: exports are *idempotent for a repeated request key*, retention
*queues one auditable durable job for an idempotency key*, and permanent
deletion *queues a durable idempotent Background Operation and audits the
request*. Permanent deletion additionally revalidates both the archived state
and the requesting Administrator immediately before it destroys anything, so a
lease reclaimed after a restart cannot execute against authorization that has
since been revoked.

## Trustworthy state during failure

When a surface cannot refresh, it must show its Last Trustworthy State rather
than an apparently empty Workspace (ADR-0039). Home trust evidence stays
fail-closed under current Source Access, and the live-update chrome degrades from
stream to poll to an explicit `Connection lost` with a retry
(`workspace-live-updates`, `workspace-home`, and Postgres parity).

## Postgres parity

Concurrent operation claims, lease reclamation, and restart recovery are
re-verified against real Postgres — see
[2brain-postgres-parity.md](2brain-postgres-parity.md).

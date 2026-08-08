# 2Brain v1 retention evidence

Verified on 2026-07-14. Verdict: **pass**.

Retention is a scheduled, durable, auditable job — not a background sweep that
runs on whatever the process happens to see. It is verified for what it purges,
what it must never purge, and how it behaves when a worker dies mid-purge.

## Cutoffs

| Property | Evidence |
| --- | --- |
| Change Events purge at the inclusive 90-day boundary; Audit Events are never purged | `workspace-retention`: *purges Change Events at the inclusive 90-day boundary and never purges Audit Events* |
| Every fixed cutoff is enforced while Workspace-lifetime evidence is preserved | `workspace-retention`: *enforces every fixed cutoff while preserving Workspace-lifetime evidence* |
| Ask Results expire and are purged in bounded batches | `workspace-ask`: *purges expired Ask Results in bounded retention batches* |

Immutable administrative audit survives retention by construction (ADR-0032):
the Audit Event table rejects updates, and retention has no cutoff that reaches
it.

## Scheduling and durability

| Property | Evidence |
| --- | --- |
| One auditable durable job per idempotency key | `workspace-retention`: *queues one auditable durable job for an idempotency key* |
| The scheduler enqueues exactly one daily job across restarts | `workspace-retention`: *the scheduler enqueues one daily retention job across restarts* |
| Only one worker can claim a queued job | `workspace-retention`: *allows only one concurrent worker to claim a queued job* |
| A retry keeps its deterministic cutoff | `workspace-retention`: *retries a retryable failed retention job without changing its deterministic cutoff* |
| A failed purge batch records a payload-free durable failure | `workspace-retention`: *records a payload-free durable failure when a purge batch cannot run* |

A retry reusing its original cutoff matters: a retry that recomputed "90 days
ago" from the current clock would silently purge a different set of rows than the
job that was audited.

## Recovery

Lease reclamation after a worker restart, and durable failure once restart
attempts are exhausted, are covered in
[2brain-recovery.md](2brain-recovery.md).

## Postgres parity

Deterministic retention, concurrent claims, and restart recovery are re-verified
against real Postgres — Postgres parity: *keeps deterministic retention,
concurrent claims, and restart recovery in Postgres parity*.

# 2Brain v1 PGLite/Postgres parity

Executed on 2026-07-14 under WSL with native Bun against
`pgvector/pgvector:pg16`. Verdict: **pass** — 23 tests, 0 failures, 1850
assertions, 28s.

```bash
docker run -d --name gbrain-parity -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=gbrain -p 55464:5432 pgvector/pgvector:pg16
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55464/gbrain' \
  bash scripts/run-e2e.sh test/e2e/workspace-boundary-postgres.test.ts
docker rm -f gbrain-parity
```

PGLite is the local/test engine; Postgres is the shared production engine
(ADR-0045). Parity means every schema, policy, cursor, retention, and operation
contract behaves identically on both, so a PGLite-green suite cannot mask a
Postgres-only failure.

## Covered contracts

Schema and audit: immutable redacted Audit and Change Events including failed
mutations and JSONB shape; Change Event cursor allocation serialized through
transaction commit order.

Authorization: the deny-by-default Source Access policy; canonical operation
access and multi-Source version filtering; email-bound single-use invitation
redemption with independent role and Source Access; Agent registration,
authorization, rotation, and revocation; Agent Activity filtered by Source
Access; legacy entry redirects following live role and session changes.

Product surfaces: Knowledge cursor, Saved Views, and reauthorization; Page
detail provenance, versions, and rechecked denial; Search inclusion, explicit
selection, and link recheck; Ask synthesis, reauthorization, cancellation, and
retention lifecycle; Setup Checklist and Member Home; Attention detection,
deduplication, dismissal, and verified recovery; live-update cursor and current
Source Access projection; Home trust evidence fail-closed under current Source
Access; personal Notification storage, authorization, mutation, and live
projection.

Operations: Managed Git Source operations persisted and concurrently claimed;
Source maintenance evidence and projections; permanent deletion of an Archived
Source; a secret-free Workspace Export under a consistent Postgres snapshot;
deterministic retention with concurrent claims and restart recovery.

## Defect found and fixed

Five of these tests each inserted their own `workspace_workspaces` row. A
deployment holds exactly one Workspace (ADR-0035), enforced by a
`UNIQUE CHECK (singleton)`, so the second row was rejected the moment an earlier
test had established the Workspace: the suite failed 5 of 23. Those tests had
apparently only ever been run under a per-test filter, never in a full-file run.

Home, Export, and retention assert Workspace-wide projections — an Export covers
the whole Workspace — so simply sharing one Workspace between them produced
cross-test bleed instead. They now each run against their own isolated database
with their own singleton Workspace, torn down afterwards, which is the only
shape that is both constraint-legal and assertion-correct.

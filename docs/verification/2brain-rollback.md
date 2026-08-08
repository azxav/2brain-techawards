# 2Brain v1 rollback evidence

Rehearsed on 2026-07-14 against `pgvector/pgvector:pg16` in a disposable
container. Verdict: **pass**.

## What rollback means for this release

2Brain v1 is a clean-start deployment (ADR-0041) served at `/app` after a hard
cutover (ADR-0038). It never initializes the legacy GBrain schema and never
projects legacy Sources, Pages, Agents, credentials, settings, sessions, or
logs. The release therefore owns a *separate* database, and rolling the whole
release back is repointing the deployment at the previous release and removing
the 2Brain database. Nothing has to be un-migrated, because the previous
release's database is never written to.

The rehearsal proves exactly that claim rather than asserting it.

## Rehearsal

The previous release's database (`legacy_gbrain`) holds one legacy table and
row. Its fingerprint is `md5(pg_dump)` with the random `\restrict` nonce that
`pg_dump` stamps into every dump excluded, so the fingerprint reflects schema
and data only. A control re-dump of the unchanged database reproduces the same
fingerprint, which is what makes the later comparisons meaningful.

| Step | Command | Result |
| --- | --- | --- |
| Baseline | `pg_dump legacy_gbrain` | `397ced9d97d10899e0cbc429d7a8d1ea` |
| Control re-dump, no change | `pg_dump legacy_gbrain` | `397ced9d97d10899e0cbc429d7a8d1ea` (fingerprint is stable) |
| Release refuses the previous release's database | `TWO_BRAIN_DATABASE_URL=…/legacy_gbrain bun src/workspace/runtime.ts worker --once` | Refused: `2Brain clean start requires a new empty database. Existing public tables found: sources.` |
| Release deploys to its own database | `TWO_BRAIN_DATABASE_URL=…/two_brain bun src/workspace/runtime.ts worker --once` | `116 migration(s) applied`; 95 public tables in `two_brain` |
| Legacy database untouched by the deploy | `information_schema.tables` | 0 `workspace%` tables in `legacy_gbrain`; fingerprint `397ced9d97d10899e0cbc429d7a8d1ea` |
| Whole-release rollback | `DROP DATABASE two_brain` | Release database gone; no residue |
| Previous release after rollback | `SELECT id, name FROM sources` | `handbook / Legacy handbook`; fingerprint `397ced9d97d10899e0cbc429d7a8d1ea` |

## What this establishes

- The release cannot attach itself to the previous release's database. The
  clean-start guard fails closed on any pre-existing public table, so a
  misconfigured rollout cannot contaminate the data a rollback depends on.
- Deploying the release leaves the previous release's database byte-identical
  under a stable fingerprint, so rollback needs no restore, no down-migration,
  and no data reconciliation.
- Dropping the 2Brain database completes the rollback, and the previous release
  still serves its data afterwards.

## Bounds

The rehearsal uses a representative legacy table rather than a full legacy
production database, because the property under test is that 2Brain writes
nothing to it at all — which the `workspace%` table count and the unchanged
fingerprint demonstrate for any legacy content. Rollback of the application
binary itself is a deployment action (repoint the supervisor at the previous
build) and is not automated here.

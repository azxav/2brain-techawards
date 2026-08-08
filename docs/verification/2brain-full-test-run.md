# 2Brain v1 full test run

Executed on 2026-07-14. Verdict: **pass**.

## Results

| Suite | Command | Result |
| --- | --- | --- |
| Workspace unit suites (29 files) | `bun test test/workspace-*.test.ts test/admin-embed-spawn.serial.test.ts --timeout=60000` | 255 pass, 0 fail, 3433 assertions, 267s |
| Postgres parity (23 tests) | `bash scripts/run-e2e.sh test/e2e/workspace-boundary-postgres.test.ts` | 23 pass, 0 fail, 1850 assertions, 28s |
| Release gate evaluator | `bun test test/workspace-release-gate.test.ts` | 8 pass, 0 fail (including the committed manifest) |
| Primary browser journey | `bun run verify:workspace-browser` | 23 of 23 checks pass |
| Typecheck | `bun run typecheck` | exit 0, no errors |
| Build | `bun run build` | exit 0, 1731 modules compiled |
| Whitespace | `git diff --check` | exit 0 |

The workspace unit suites and the Postgres parity suite are run under WSL with
native Bun. On Windows, `bun test` starves the postgres.js socket and the
Postgres-backed suites hang; that is an environment limitation, not a product
or test defect.

## Scope

This is the targeted run the ticket requires: every workspace suite, the
Postgres parity suite, the release gate evaluator, and the black-box browser
journey. Repository-wide gates for unrelated GBrain subsystems are out of scope
for this ticket and were not run.

Source *synchronization* — the git fetch itself — is covered by
`workspace-source-synchronization` and by Postgres parity, not by the browser
journey, whose Source executors are stubs. See
[2brain-browser-journey.md](2brain-browser-journey.md) for what the harness
supplies and what that costs.

## Defects found and fixed during this run

- Five of the 23 Postgres parity tests each inserted a second
  `workspace_workspaces` row, which the `UNIQUE CHECK (singleton)` constraint
  rejects once an earlier test has established the deployment's one Workspace
  (ADR-0035). Those five had never passed in a full-file run. Home, Export, and
  retention assert Workspace-wide projections, so they now run against their own
  isolated database rather than sharing one Workspace with other fixtures.
- Two product defects surfaced by the browser journey's console-health check are
  recorded in [2brain-browser-journey.md](2brain-browser-journey.md).

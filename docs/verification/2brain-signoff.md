# 2Brain v1 release signoff

Date: 2026-07-14. Issue: #34. Verdict: **RELEASE PASS** — all five gates pass
independently.

```
$ bun run verify:workspace-release
Functional: PASS
Trust: PASS
Security: PASS
Experience: PASS
Operations: PASS
2Brain v1 RELEASE PASS
```

The manifest is [2brain-release.json](2brain-release.json). The verifier is
fail-closed (ADR-0043): a gate passes only if every artifact it names exists at a
repository-relative path and is itself marked `pass`, and only if every artifact
that gate requires is actually linked to it. Strength in one gate cannot
compensate for a failure in another, and a missing file blocks the release rather
than being skipped.

## Gates

| Gate | Evidence |
| --- | --- |
| Functional | [full test run](2brain-full-test-run.md), [browser journey](2brain-browser-journey.md), [Postgres parity](2brain-postgres-parity.md) |
| Trust | [trust evidence](2brain-trust.md), full test run, browser journey, Postgres parity |
| Security | [security matrix](2brain-security-matrix.md), [export inspection](2brain-export-inspection.md), Postgres parity |
| Experience | [design evidence ledger](2brain-design-evidence.md), [accessibility](2brain-accessibility.md), [performance](2brain-performance.md), browser journey |
| Operations | export inspection, [retention](2brain-retention.md), [recovery](2brain-recovery.md), [rollback](2brain-rollback.md), Postgres parity |

## Headline results

- 255 workspace unit tests pass (29 files, 0 failures).
- 23 of 23 Postgres parity tests pass against `pgvector/pgvector:pg16`.
- 23 of 23 browser journey checks pass black-box through the production HTTP and
  authentication boundary, real Postgres, and an always-on worker.
- 0 WCAG 2.2 AA violations across fourteen rendered states (System/Light/Dark,
  desktop/tablet/mobile); 0 browser console errors.
- Every performance budget met with substantial headroom (authenticated shell
  171 ms against 2500 ms; Knowledge and Search p95 60 ms and 52 ms against
  1000 ms).
- Whole-release rollback rehearsed against a live database.

## Defects this verification found and closed

The gate earned its keep. Five real defects were found *by* running it, and all
five are fixed in this ticket rather than waived:

1. Muted body text failed WCAG contrast at 4.23:1 (now `#72716d`).
2. The shared accent failed contrast for button text at 3.87:1 (now `#1f73c4`).
3. The Source ID field's `pattern` attribute was an invalid regex under the `v`
   flag browsers compile it with, so client-side validation silently never
   applied.
4. No favicon was served, so every document 404'd on `/favicon.ico`.
5. Five of the 23 Postgres parity tests violated the one-Workspace-per-deployment
   constraint and had never passed in a full-file run.

Code review of this ticket then found defects in the *verification itself*, which
matter just as much, because a gate that lies is worse than no gate:

6. `production_http_auth_boundary` and `always_on_worker` were assigned `pass`
   as literals, asserting nothing. They are now real assertions — an anonymous
   browser context proving 401 on read and mutation, a session without the CSRF
   header proving 403, the session cookie's `httpOnly`/`secure`/`SameSite` flags
   read back from the browser, and a Background Operation that only the worker
   can drive to `completed`.
7. The harness mounted the router with `production: false`, which disables the
   `secure` cookie flag, while the security matrix cited it as transport
   evidence. The journey now runs the production cookie configuration.
8. Ask's refusal path was never driven through the browser. The journey now asks
   a question whose synthesized answer no Page supports and asserts the product
   refuses it.
9. The Trust gate required no trust artifact, and Operations required no
   performance report, so both could pass empty. Both are now required, and a
   test verifies the committed manifest against the real evidence files.
10. Tablet, Light, and System appearance were never audited despite being claimed.
    They are now.

## Honest bounds

This release verifies interaction-level performance budgets; it does not claim a
load-tested throughput figure. The rollback rehearsal covers the database and
configuration, not the deployment system's binary rollout. Design Evidence rows
in the baseline matrix that describe surfaces v1 does not ship remain uncaptured
and are not cited as passing evidence — see
[2brain-design-evidence.md](2brain-design-evidence.md).

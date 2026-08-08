# Issue #25 Knowledge, Agent, and Automation Attention evidence

Verified 2026-07-14. This ledger extends the issue #24 Source-health ledger
(`2brain-issue-24-evidence.md`) to the three remaining Attention categories:
Knowledge quality (Missing evidence), Agent access (repeated authorization
failure and Admin-scope review), and Automation health (stalled runtime and
failed orchestration). It maps every newly visible category, detector
evidence, remediation action, permission, empty, loading, failure, keyboard,
theme, and supported viewport state to the approved Notion evidence
vocabulary in `2brain-notion-evidence-matrix.md` and current official Notion
help. It does not claim that Notion implements Condition Episodes,
category detectors, or 2Brain Source Access filtering.

Official sources (unchanged from issue #24):

- [Intro to databases](https://www.notion.com/help/intro-to-databases) -
  operational work renders as database rows with status, person, and date
  properties; a status pill supports the shape of Attention Status.
- [Updates & notifications](https://www.notion.com/help/updates-and-notifications) -
  activity about an item is a reverse-chronological feed of structured
  who-did-what events, never raw system output.
- [Workspace audit log](https://www.notion.com/help/audit-log) - protected
  administrative overrides are recorded as immutable structured events with
  actor, action, and timestamp.

The applicable approved matrix references remain U-01/U-02 (shell and empty
Attention state), U-03 (list grammar), U-08/U-09 (reason-bearing destructive
confirmation), and U-11 (loading/recovery emphasis), following the issue
#16/#20/#22/#24 precedent: hierarchy and component grammar are inferred from
those approved primitives and the official help vocabulary above, labelled
with 2Brain semantics rather than represented as direct Notion captures.
System-only item creation (ADR 0003), detector-verified resolution (ADR
0004), Condition Episode deduplication (ADR 0044), Source Access filtering
(ADR 0002), and the Administrator-only oversight of Agent access and
Automation health work are 2Brain security/authorization semantics, which
the evidence policy permits as recorded deviations.

## Evidence ledger

All same-viewport verification below ran against the real workspace router
and shell served from a seeded database, in the in-app Browser, as an
Administrator session (Source Access All, dark 1440x900) and a Member
session whose Source Access is Specific (`onboarding-docs` only; light
375x812 mobile). The seeded conditions are real: Pages whose deterministic
Evidence Status computes `missing_evidence`, an Agent registered with Admin
scope whose three most recent structured activity events failed, a worker
heartbeat row past the stall threshold, a real failed `source.provision`
Background Operation row, and a real failed `source.verify` run through
`runSourceMaintenanceWorkerOnce` — not fabricated Attention rows. States
were verified through the rendered accessibility tree, page text, and DOM
(status pills, focus, computed theme colors); this session's browser
harness could not capture bitmaps, so the ledger records the same-viewport
DOM/accessibility verification for each state instead of screenshots.

| ID | Visible surface or state | Official Notion mapping | 2Brain translation and verification |
|---|---|---|---|
| DE-025-01 | All four categories in one queue | Databases help presents work as rows with status and select properties | Administrator at `/app/attention` saw seven items in one list: `Category: Knowledge quality` (per-Page `Affected: onboarding-docs:benefits-overview`), `Category: Agent access` (twice for one Agent: Admin-scope review and repeated authorization failure), `Category: Automation health` (`Affected: worker` and `Affected: source.provision:finance-handbook`), and `Category: Source health` — each with the shared status pill, Assignee, Detected, and Last verification properties. |
| DE-025-02 | Missing evidence → Knowledge quality item | 8.4 Evidence Status table; no Notion equivalent for detector creation (ADR 0003 deviation) | Two real Pages with neither citations nor a traceable import produced exactly one Open item each after detector reconciliation on queue load; the item is tied to the affected evidence: `Evidence: page benefits-overview · source onboarding-docs · observed <time> · evidence status missing_evidence`. Cited, source-backed, and deleted Pages produced nothing (unit tests assert the same). |
| DE-025-03 | Risky Agent authorization conditions | Audit-log help records access decisions as structured events; ADR 0003 deviation | The active Admin-scope Agent produced `An Admin-scope Agent requires Administrator review.` with `Evidence: scope admin · agent <id> · observed <time>`; three consecutive failed activity events produced `An Agent is repeatedly failing authorization.` No credential material appears anywhere in the queue, evidence, or history payloads (no token, no hash — asserted in unit, HTTP, and Postgres-parity tests and confirmed in the rendered DOM). |
| DE-025-04 | Worker/scheduler/orchestration failures → Automation health | 8.3 Background Operation lifecycle; no Notion equivalent | The stalled worker heartbeat rendered `A workspace runtime role has stalled.` (`Evidence: role worker · observed <time> · last heartbeat <time>`); the failed provisioning operation rendered `A background orchestration operation is failing.` (`Evidence: error clone_failed · request req-dev-provision-1 · observed <time> · operation <id> · operation type source.provision`). The simultaneously failing `source.verify` stayed `Category: Source health`, keeping Automation health reserved for orchestration not owned by one Source's maintenance evidence (§7.8). |
| DE-025-05 | Category-scoped detector verification | No Notion equivalent; ADR 0004 deviation | On the Knowledge item, `Request verification` with the condition still present kept the item active and surfaced "Verification ran and found the condition still present…". After the Page gained real citations, the same action resolved the item (`Resolved` pill, episode `Cleared`), with history attributing detection and resolution to `System (knowledge-quality-detector)`. A fresh worker heartbeat and a newer successful Agent activity resolved the Automation and Agent items on the next reconciliation, each under its own detector identity. |
| DE-025-06 | Dedup and clear-then-recur across new categories | No Notion equivalent; ADR 0044 deviation | Repeated queue reloads (each reconciling all categories) changed only `Last verification` on the seven items — never their count. Unit, HTTP, and Postgres-parity tests assert concurrent detector runs, retries, and a restarted worker identity leave exactly one active item per condition and resource, and that a cleared-then-recurring condition opens a new episode and item. |
| DE-025-07 | Reason-bearing dismissal suppressing an Agent access episode | Audit-log help; U-08/U-09 confirmation grammar | `Dismiss…` on the Admin-scope item opened the modal focused on Reason (Escape closed it and returned focus). After dismissal with a reason, the item stayed `Dismissed` while the condition persisted, and after the scope was genuinely reduced the episode cleared without resurrecting it: history shows `Dismissed with a recorded reason` then `The suppressed condition cleared`, and the evidence remained what the item was dismissed against (`scope admin`). |
| DE-025-08 | Member-filtered queue without disclosure | Databases render only permitted rows; ADR 0002 deviation plus Administrator oversight exception | The Member session (Specific: `onboarding-docs`) saw only the `onboarding-docs` Source-health item and the Page-scoped Knowledge item; `finance-handbook`, the Agent id, and the strings `Agent access`/`Automation health` appeared nowhere in the payload or DOM. Agent access and Automation health work is Administrator-only oversight; direct detail requests against hidden items return 404 (unit, HTTP, and Postgres-parity tests). |
| DE-025-09 | No user-authored Attention Items | No Notion equivalent; ADR 0003 deviation | No creation control exists anywhere in the UI and no creation route exists: `POST /api/workspace/v1/attention` returns 404 (HTTP test), and the only mutation seams are the lifecycle actions on system-created items. |
| DE-025-10 | Empty, loading, and failure states | U-11 loading/recovery emphasis | Queue loads keep `aria-busy` while reconciling. A forced 500 rendered "Last Trustworthy State — potentially outdated" with the previously loaded rows preserved, recovery copy, `Request req-dev-fail`, and a Retry button that restored the live queue once the failure cleared — identical grammar for the new categories as for Source health (DE-024-09 covers the empty-queue copy, unchanged). |
| DE-025-11 | Keyboard, themes, and supported viewports | U-01 shell tokens; responsive reflow as a 2Brain accessibility adaptation | All actions remain native buttons/summary/dialog; the dismiss dialog focuses its Reason field and closes on Escape with focus returned. Dark 1440x900 (Administrator) and light 375x812 mobile (Member) render the same tokens (verified computed body colors `rgb(25,25,25)/rgb(241,241,239)` vs `rgb(255,255,255)/rgb(32,32,32)`), and the mobile shell shows no horizontal scrolling with the new categories present. |

## Authorization and verification evidence

- Category mapping is a closed pure policy
  (`WORKSPACE_ATTENTION_CONDITION_POLICY`): Source-specific verification and
  synchronization failures stay Source health; Automation health is reserved
  for stalled worker/scheduler heartbeats and non-maintenance orchestration
  outcomes. Pure policy tests pin every condition type's category, resource
  type, Member visibility, and lifecycle transitions.
- Every detector reuses the same Condition Episode reconciliation: the
  partial unique active-episode index plus the 1:1 episode-item constraint
  make duplicate active items impossible during an uninterrupted episode,
  including under concurrent evaluation, retries, and worker restarts
  (unit and Postgres-parity tests).
- Resolution always re-runs the item's own category evaluator scoped to the
  affected resource; Members can only request it. A resource that leaves the
  active lifecycle (deleted Page, revoked Agent, archived/deleted Source) is
  recorded as `page_left_active_lifecycle` / `agent_left_active_lifecycle` /
  `source_left_active_lifecycle`, never as a verified recovery, and the
  history view says so.
- Member reads pass through current Source Access per resource type
  (Source items by Source, Page items by their Page's Source) and fail
  closed to Administrator-only for Agent, runtime, and orchestration
  resources, so denied Source and Page metadata never leaks. Evidence is
  safe by construction: identifiers, counts, error codes, and timestamps —
  never tokens, hashes, prompts, or raw worker output.
- The detectors run after worker operations complete (all categories, in
  `runtime.ts`), as the reconciliation pass on every Attention queue read,
  and on Member-requested verification; every detect/observe/resolve/dismiss
  emits history plus Audit and Change Events (unit, HTTP, and
  Postgres-parity tests).

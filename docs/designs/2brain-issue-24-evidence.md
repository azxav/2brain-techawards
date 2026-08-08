# Issue #24 Source-health Attention evidence

Verified 2026-07-13. This ledger maps the visible Attention Queue, category,
assignment, lifecycle, verification, dismissal, history, deduplication,
empty, loading, failure, keyboard, theme, and supported viewport states of
Source-health Attention Items to the approved Notion evidence vocabulary in
`2brain-notion-evidence-matrix.md` and to current official Notion help. It
does not claim that Notion implements Condition Episodes, detector-verified
resolution, or 2Brain Source Access filtering.

Official sources:

- [Intro to databases](https://www.notion.com/help/intro-to-databases) -
  operational work renders as database rows with status, person, and date
  properties; a status pill supports the shape of Attention Status.
- [Updates & notifications](https://www.notion.com/help/updates-and-notifications) -
  activity about an item is a reverse-chronological feed of structured
  who-did-what events, never raw system output.
- [Workspace audit log](https://www.notion.com/help/audit-log) - protected
  administrative overrides are recorded as immutable structured events with
  actor, action, and timestamp.

The applicable approved matrix references are U-01/U-02 (shell and empty
Attention state), U-03 (list/settings grammar), U-08/U-09 (reason-bearing
destructive confirmation), and U-11 (loading/recovery emphasis). The matrix
rows "Attention Queue" and "Attention lifecycle actions" record that exact
Notion captures remain capture-required, so this issue follows the issue
#16/#20/#22 precedent: hierarchy and component grammar are inferred from
those approved primitives and the official help vocabulary above, labelled
with 2Brain semantics rather than represented as direct Notion captures.
System-only item creation (ADR 0003), detector-verified resolution (ADR
0004), Condition Episode deduplication (ADR 0044), and Source Access
filtering (ADR 0002) are 2Brain security/authorization semantics, which the
evidence policy permits as recorded deviations.

## Evidence ledger

All same-viewport verification below ran against the real workspace router
and shell served from a seeded database, in the in-app Browser, as an
Administrator session (Source Access All) and a Member session whose Source
Access is Specific (`onboarding-docs` only). The seeded conditions came from
real failed `source.verify` / `source.sync` maintenance runs through
`runSourceMaintenanceWorkerOnce`, not fabricated rows.

| ID | Visible surface or state | Official Notion mapping | 2Brain translation and verification |
|---|---|---|---|
| DE-024-01 | Attention Queue list | Databases help presents work as rows with status, person, and date properties | In-app Browser at 1440x900 (dark), Administrator at `/app/attention`: each item renders condition summary as the row title, a colored status pill (`Open`/`In progress`/`Resolved`/`Dismissed`), and meta properties `Category: Source health`, `Affected: <source-id>`, `Assignee`, `Detected <time>`, `Last verification <time>`. A `Needs attention`/`All items` status filter uses the existing tablist grammar. |
| DE-024-02 | System-only creation from real failures | No Notion equivalent; ADR 0003 deviation | Two real worker failures (verification on `onboarding-docs`, synchronization on `finance-handbook`) each produced exactly one Open item after detector reconciliation on queue load. No creation control exists anywhere in the UI; the only entry path is the detector. |
| DE-024-03 | Deduplication by Condition Episode | No Notion equivalent; ADR 0044 deviation | A second real failure during the same uninterrupted episode changed only `Last verification`; the queue still showed one item (unit, HTTP, and Postgres-parity tests assert the same). After a verified clear and a later recurrence, `All items` showed the ended item plus a new Open item from the new episode. |
| DE-024-04 | Assignment and Open → In progress | Databases person property; updates help who-did-what events | `Take ownership` assigned the item to the acting session (`Assignee: admin@example.test`) and removed itself; `Move to In progress` flipped the status pill to the amber `In progress` state and disappeared. Both appear in history as Member events. |
| DE-024-05 | Verification-gated resolution | No Notion equivalent; ADR 0004 deviation | With the condition still failing, `Request verification` kept the item active and surfaced "Verification ran and found the condition still present, so the item stays active." with the latest verification time. After a real successful verification run, the same action resolved the item (`Resolved` pill, episode `Cleared`). No control asserts Resolved directly. |
| DE-024-06 | Reason-bearing dismissal | Audit-log help records administrative overrides as immutable events; U-08/U-09 confirmation grammar | `Dismiss…` opens a modal dialog focused on the required Reason field, with the impact note "Dismissal suppresses this continuing episode." Submission recorded the dismissal with its reason (immutable Audit Event asserted in tests), and the continuing episode produced no new item while the condition persisted. |
| DE-024-07 | Evidence and history detail | Updates help reverse-chronological structured feed | `View evidence and history` disclosure shows safe evidence (error code, operation ID, request ID, observed time — never remote URLs or raw worker output), the Condition Episode span, and the full history: `Detected by the system`, `Assigned`, `Moved to In progress`, `Resolution requested`, `Verification found the condition still present`, `Resolved after the system verified the condition is absent`, each attributed to `Member <id>` or `System (source-health-detector)`. |
| DE-024-08 | Member-filtered queue without disclosure | Databases render only permitted rows | The Member session saw only `onboarding-docs` items; `finance-handbook` appeared nowhere in the payload or DOM (asserted via page text), with no count or placeholder hinting at hidden work. Direct detail/mutation requests against the hidden item return 404 (unit, HTTP, and Postgres-parity tests). |
| DE-024-09 | Empty, loading, and failure states | U-11 loading/recovery emphasis | Empty `Needs attention` renders "Nothing needs attention. Verified conditions are clear for the Sources you can access." Loading shows "Loading Attention" with `aria-busy`. A forced 500 rendered "Last Trustworthy State — potentially outdated" with preserved rows, recovery copy, `Request req-dev-fail`, and a Retry button that restored the loaded queue. |
| DE-024-10 | Keyboard, themes, and supported viewports | U-01 dark shell tokens; responsive reflow is a 2Brain accessibility adaptation | All actions are native buttons/summary/dialog with the shared `:focus-visible` outline; the dismiss dialog traps focus on its Reason field and closes on Escape, and its form submits through the standard form-submission path (verified via `requestSubmit`, which trusted Enter triggers; the automation harness's synthetic Enter cannot trigger implicit submission by browser design). Dark 1440x900 (Administrator) and light 375x812 mobile (Member) render from the same tokens via media emulation; the mobile shell shows no horizontal scrolling after the primary nav learned to scroll within itself. |

## Authorization and verification evidence

- Items exist only 1:1 with a Condition Episode; a partial unique index
  enforces at most one active episode per condition type and resource, and
  `episode_id` is unique on items, so duplicates are impossible at the
  schema seam.
- Detection, observation, and clearing derive from durable verification
  events and background-operation outcomes; archived and permanently
  deleted Sources are excluded from detection and their active episodes are
  cleared on reconciliation (archived-Source parity test). A clearance
  caused by the Source leaving the active lifecycle is recorded as
  `source_left_active_lifecycle`, never as a verified recovery, and the
  history view says so.
- The detector runs after relevant events (the worker loop reconciles right
  after each completed or failed `source.verify`/`source.sync` operation)
  and as a reconciliation pass on every Attention queue read.
- Resolution always re-runs the detector's verification for the item's
  condition and resource; Members can only request it. Dismissal requires a
  reason at the module seam and at the protected-mutation policy
  (`attention.dismiss` is reason-required), and every attention mutation and
  detector outcome emits history plus Audit and Change Events (unit, HTTP,
  and Postgres-parity tests).

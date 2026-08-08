# Issue #22 Structured Agent Activity evidence

Verified 2026-07-13. This ledger maps the visible structured-activity list,
run detail, relationship labels, oversight indication, redaction, full
parameters, truncation, empty, restricted, loading, failure, keyboard,
theme, and viewport states of Agent Activity to the approved Notion evidence
vocabulary in `2brain-notion-evidence-matrix.md` and to current official
Notion help. It does not claim that Notion implements 2Brain Source Access,
the Administrator oversight exception, Request Detail redaction, or
seven-day full-parameter retention.

Official sources:

- [Workspace audit log](https://www.notion.com/help/audit-log) - activity
  about actors is presented as structured, administrator-scoped event
  records (actor, event, timestamp), never as raw request transcripts.
- [Updates & notifications](https://www.notion.com/help/updates-and-notifications) -
  per-item activity is a reverse-chronological feed of structured edit
  events describing who did what and when.
- [Add and manage connections](https://www.notion.com/help/add-and-manage-connections) -
  non-human integrations appear in an administrator-visible directory with
  owner and access scope, and their effects surface as activity rather than
  as prompt or payload contents.

The applicable approved matrix references are U-03 (settings/list grammar
for administrative resources) and U-11 (loading/recovery emphasis). The
matrix row "Agent directory/detail/activity" records that exact Notion
captures remain capture-required, so this issue follows the issue #16/#20
precedent: hierarchy and component grammar are inferred from U-03/U-11 and
the official help vocabulary above, labelled with 2Brain semantics rather
than represented as direct Notion captures. Source-filtered Member activity,
the explicit Administrator oversight exception, evidence-gated relationship
labels, and redaction-first Request Detail are 2Brain security/authorization
semantics (ADR 0009, ADR 0010, ADR 0023), which the evidence policy permits
as recorded deviations.

## Evidence ledger

All same-viewport verification below ran against the real workspace router
and shell served from a seeded database, in the in-app Browser, as an
Administrator session and a Member session whose Source Access is Specific
(`onboarding-docs` only).

| ID | Visible surface or state | Official Notion mapping | 2Brain translation and verification |
|---|---|---|---|
| DE-022-01 | Structured activity list inside the Agent Directory row | Audit-log help presents actor activity as structured event rows; updates help uses a reverse-chronological feed | In-app Browser at 1440x900 (dark), Administrator: `View structured activity` is a disclosure on each Agent row. Entries render newest first as `operation · Outcome` with time, latency in ms, and request ID (`page.retrieve · Succeeded`, `At 7/13/2026 … · 240 ms · Request req-1001`). No prompt text appears anywhere in the payload or DOM. |
| DE-022-02 | Administrator oversight indication | Audit-log help scopes complete activity to workspace admins | The Administrator list is headed by "Complete structured activity is shown through the explicit Administrator oversight exception. Page reads and ordinary Knowledge stay Source-authorized." The backend uses a separate explicit oversight branch that never consults or widens Source Access (design §9.1 P0-5; unit and Postgres-parity tests). |
| DE-022-03 | Member-filtered activity (restricted state without disclosure) | Connections help shows integrations to the organization while their effects stay permission-scoped | Member session on the same Agent rendered only the two `onboarding-docs` entries under "Structured activity describes what this Agent did, filtered to Sources you can currently access."; the `finance-handbook` entry and the source-less `agent.self_check` entry were absent, with no count, placeholder, or other hint that hidden activity exists. Backend filtering is authoritative (ADR 0009; unit, HTTP, and Postgres-parity tests). |
| DE-022-04 | Evidence-gated relationship labels | Updates help describes edits as explicit who-did-what events | Entries rendered `onboarding-docs / setup-guide — Retrieved by this Agent` and `onboarding-docs / release-notes — Written by this Agent`; `Cited by` uses the same mapping. A Source-only entry renders `Source: finance-handbook` with no relationship, and no `Used by` copy exists anywhere. Recording rejects a relationship without its Page, Page evidence without its Source, and unknown Source IDs (`invalid_activity_evidence` / `source_not_found`, plus schema CHECKs). |
| DE-022-05 | Run detail | Audit-log events carry actor and timestamp metadata | Entries recorded inside an Agent Run render `Run <id> (nightly-sweep-42) · Started … · Ended … · Succeeded`; a run without an end time renders `In progress`. Run metadata passes the same fail-closed redaction as Request Detail before storage. |
| DE-022-06 | Redacted Request Detail | Audit-log help exposes event records, not request contents | Administrator-only `Redacted Request Detail` disclosure appears only on entries where capture happened and shows the captured time plus the redacted record with prompt-shaped keys collapsed (`"prompt": "[REDACTED]"`). Entries without capture show nothing — no "raw data unavailable" placeholder, so absent data is never implied to exist (ADR 0010). Member payloads never contain a `request_detail` key (HTTP test asserts the string is absent). |
| DE-022-07 | Full parameters and seven-day retention | No Notion equivalent; ADR 0023 security semantic recorded as a deviation | When capture was explicitly enabled, a separate `Full parameters (explicitly enabled · seven-day retention)` disclosure renders beside — never inside — the redacted record. The stored expiry is exactly seven days after capture; every read purges expired captures and the payload filter hides them independently; Member payloads and the Member-filtered API never contain them (unit and Postgres-parity tests). |
| DE-022-08 | Truncation, empty, loading, and failure states | U-11 loading/recovery emphasis | An Agent with 201 entries rendered "Showing the most recent 200 activity entries." above the list, and the API reports `truncated` explicitly. An Agent with no visible activity rendered "No structured activity to show." (identical for none-recorded and none-authorized, preserving non-disclosure). Opening a list shows "Loading structured activity" with `aria-busy` until resolution. A forced 500 rendered "Structured activity could not be loaded. Retry when the service is available. Request req-dev-fail" with a Retry button that recovered to the loaded state once the service returned. |
| DE-022-09 | Keyboard, themes, and supported viewports | U-01 dark shell tokens; responsive reflow is a 2Brain accessibility adaptation | The activity disclosure is a native `summary` (focusable, Enter/Space toggles) confirmed via `document.activeElement`, with the existing `.agents-view :focus-visible` outline. Dark 1440x900 (Administrator) and light 375x812 mobile (Member) rendered from the same tokens via media emulation; on mobile the entry rows wrapped without horizontal scrolling and all disclosures stayed operable. |

## Authorization and retention evidence

- Recording validates the Agent, the Run, and the Source context at write
  time; relationship labels cannot be stored without their Page and Source
  evidence (schema CHECK constraints plus `invalid_activity_evidence`).
- Full request parameters are rejected at the recording seam unless
  explicitly enabled (`full_parameters_disabled`), are classified with a
  seven-day expiry at capture, are purged on read after expiry, and are
  filtered from payloads independently of purge timing.
- Member reads resolve current Source Access on every request; empty access
  yields an empty list without a query against activity rows. The
  Administrator path is a separate explicit branch that grants no Knowledge
  reads (unit, HTTP, and Postgres-parity tests).

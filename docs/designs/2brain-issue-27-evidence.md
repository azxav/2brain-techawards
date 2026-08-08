# Issue #27 personal Notifications evidence

Verified 2026-07-14. This ledger maps the personal Notifications surface to
official Notion Inbox evidence and records same-viewport verification of the
real server-rendered 2Brain route. It does not claim that Notion implements
2Brain Membership/Source authorization, shared Attention semantics, fixed
retention, or authenticated SSE/polling deduplication.

Official references:

- [Intro to workspaces](https://www.notion.com/help/intro-to-workspaces) —
  Inbox is a sidebar utility that gathers personal notifications and shows a
  red unread badge.
- [Inbox & notifications](https://www.notion.com/en-gb/help/updates-and-notifications?nxtPslug=updates-and-notifications) —
  notifications open their durable target and support unread/read filters,
  mark read/unread, and archive behavior.
- [Navigate with the sidebar](https://www.notion.com/en-gb/help/navigate-with-the-sidebar) —
  Inbox bulk and per-notification controls establish the list/action grammar.
- [Comments, mentions & reactions](https://www.notion.com/help/comments-mentions-and-reminders) —
  the Inbox badge counts personal notifications and denied private content
  does not notify an unauthorized recipient.
- [Reset Notion](https://www.notion.com/help/reset-notion) — content that is
  not displaying correctly has an explicit reload/recovery path.
- [Notion's page load and navigation times just got faster](https://www.notion.com/blog/faster-page-load-navigation) —
  Notion documents the distinct initial page-load interval and progressive
  retrieval of content; 2Brain makes that interval explicit with a named
  loading state.

The in-app Browser runtime could not initialize because its bundled client
failed while defining the required `process` shim (`Cannot redefine property:
process`), the same limitation recorded for issue #26. The approved local
Playwright fallback used installed Microsoft Edge against an isolated seeded
PGlite server and the production Workspace router. It verified 1440×900 light,
1440×900 dark, and 390×844 light viewports. Populated, read, archive, empty,
loading, Last Trustworthy State failure/retry, and non-jumping live-arrival
scenarios passed without layout overflow or application console output; the
forced failure produced only the expected browser network diagnostic for its
deterministic HTTP 503.

## Evidence ledger

| ID | Visible surface or state | Approved mapping | 2Brain translation and same-viewport verification |
|---|---|---|---|
| DE-027-01 | Sidebar utility and unread indicator | Notion workspace Inbox badge | `/app/notifications` is a utility beside Settings rather than a primary product destination. A polite, numeric badge appears only when unread personal Notifications exist. Desktop light/dark and mobile checks verified the active utility remains visible without horizontal page overflow. |
| DE-027-02 | Personal list and durable target | Notion Inbox chronological notification list | Each row exposes a fixed safe summary, event classification, time, expiry, read state, and link to the durable Attention Item, Background Operation, or Membership surface. No raw prompt, credential, provider secret, request payload, Source name, or restricted metadata is rendered. |
| DE-027-03 | Unread/read | Notion mark read/unread control | Native 44px-capable buttons toggle only the recipient's personal read state. Desktop interaction changed `Unread`/`Mark read` to `Read`/`Mark unread` and cleared the badge without modifying the linked Attention Item. |
| DE-027-04 | Archive | Notion archive control | Archive removes the Notification from the active personal list. Browser interaction reached the explicit `No Notifications` empty state; the shared Attention condition remained unchanged in service coverage. |
| DE-027-05 | Loading, empty, and failure | Official Notion page-load documentation plus the `Reset Notion` reload/recovery path; U-11 visual recovery emphasis | The live region begins with `Loading Notifications`, emits a composed empty state, and retains Last Trustworthy State with a timestamped recovery message and native Retry button on failure. Playwright held and inspected loading and deterministic HTTP-failure/retry states at 1440×900 light/dark and 390×844 light; the trustworthy list remained visible through failure. The named loading and Last Trustworthy State treatments are explicit 2Brain clarity additions, not claims of pixel-identical Notion states. |
| DE-027-06 | Live arrival without duplicate application | Official Notion Inbox timing/badge evidence plus issue #26 authenticated pending-update contract | A recipient-only `notifications` invalidation refreshes the unread badge immediately but does not insert or reorder the visible list. Playwright injected a real Notification change event through the production SSE route at all three verified viewport/theme combinations: the badge advanced from 1 to 2, `Apply 1 new update` appeared, and the existing row did not jump. The ID-keyed pending map, monotonic cursor, explicit Apply action, SSE/polling parity, and applied-ID set prevent duplicate application. |
| DE-027-07 | Keyboard, focus, viewport, and theme | Notion sidebar/list interaction grammar | `R` refreshes when focus is outside an input; native links/buttons provide keyboard activation and visible focus treatment. Playwright verified populated, loading, failure/retry, and live-arrival states at 1440×900 light, 390×844 light, and 1440×900 dark; it also exercised read/archive/empty at desktop and read at mobile. There was no clipping of the active utility, horizontal page overflow, or framework overlay. |
| DE-027-08 | Authorization reduction and non-disclosure | Notion denied-content non-notification; 2Brain security deviation | Creation, list, unread count, read/unread, archive, and live projection recheck active Membership and current Source Access. Revocation discards queued Source-scoped invalidations while advancing the safe cursor; ownership failures use the same non-disclosing not-found response. |
| DE-027-09 | Fixed retention | 2Brain product requirement | Notifications receive a database-enforced 30-day expiry, disappear from reads after expiry, and are deleted by a bounded retention batch. This is a 2Brain lifecycle rule, not a Notion behavior claim. |

## Mismatch ledger

- Notion Inbox includes mentions, comments, reminders, page following, and
  settings. 2Brain intentionally allows only direct-responsibility outcomes:
  assignment, owned-condition change, requested verification outcome,
  initiated Background Operation outcome, and Membership/access change.
- Notion can group by page or comment thread. 2Brain keeps one flat personal
  event list whose durable target remains the system of record; shared
  Attention conditions are never copied into personal task records.
- Notion's badge is commonly red. 2Brain uses its established blue action
  token to preserve original branding while retaining the same count/placement
  grammar.

## Automated contract evidence

- Targeted PGlite coverage verifies allowlisted event-to-recipient policy,
  idempotency, creation/read reauthorization, ownership isolation, no Attention
  duplication, read/archive independence, safe stored fields, cursor paging,
  fixed expiry, bounded purge, HTTP session/CSRF behavior, and UI state hooks.
- Live-update coverage verifies recipient-only projection, access-reduction
  discard, cursor advancement, transport parity, reconnect deduplication, and
  the non-jumping pending/apply client.
- The targeted PostgreSQL parity case exercises the schema, current Source
  authorization, unread/list/read/archive mutations, and live projection.

## Rendered artifact ledger

Artifacts are stored outside the repository under
`C:\Users\aziz\.codex\visualizations\2026\07\14\019f5edb-7e8f-7760-8d81-fb4fac5ad6bc`.

| State | 1440×900 light | 390×844 light | 1440×900 dark |
|---|---|---|---|
| Populated | `issue-27-notifications-desktop.png` | `issue-27-notifications-mobile.png` | `issue-27-notifications-desktop-dark.png` |
| Loading held | `issue-27-notifications-loading-desktop.png` | `issue-27-notifications-loading-mobile.png` | `issue-27-notifications-loading-desktop-dark.png` |
| Failure with Last Trustworthy State | `issue-27-notifications-failure-desktop.png` | `issue-27-notifications-failure-mobile.png` | `issue-27-notifications-failure-desktop-dark.png` |
| Live arrival pending application | `issue-27-notifications-live-desktop.png` | `issue-27-notifications-live-mobile.png` | `issue-27-notifications-live-desktop-dark.png` |

`issue-27-notifications-read.png` records the desktop read state. Archive was
then exercised in the same session and reached the explicit empty state.

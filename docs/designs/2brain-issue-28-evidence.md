# Issue #28 Workspace Home trust evidence

Verified 2026-07-14. This ledger maps the 2Brain Home trust surface to
official Notion Home/sidebar, database-view, dashboard, Inbox, and recovery
evidence, then records same-viewport verification against the real
server-rendered Workspace route. It does not claim that Notion implements
2Brain Source currentness, Attention detectors, Background Operations,
Source Access, or a Last Trustworthy State contract.

Official references:

- [Navigate with the sidebar](https://www.notion.com/help/navigate-with-the-sidebar)
  — Home is organized into restrained sections such as Recents and Agents;
  links open the underlying permitted content, and private/shared visibility
  follows the viewer's access.
- [Intro to workspaces](https://www.notion.com/help/intro-to-workspaces) —
  Home surfaces pages and tasks needing attention inside a spacious editor
  canvas.
- [Dashboards view](https://www.notion.com/help/dashboards) — a stable overview
  can combine focused underlying views and follows their permissions. 2Brain
  deliberately does not adopt Notion's chart/metric examples for Workspace
  trust.
- [Views, filters, sorts & groups](https://www.notion.com/help/views-filters-and-sorts)
  — clean list rows, visible ordering, and direct page opening establish the
  section/row/evidence-link grammar.
- [Inbox & notifications](https://www.notion.com/en-gb/help/updates-and-notifications?nxtPslug=updates-and-notifications)
  — important page/project changes are collected chronologically and each
  update jumps to its source evidence.
- [Reset Notion](https://www.notion.com/help/reset-notion) — content-display
  failure has an explicit reload/recovery path.

The in-app Browser runtime failed before tab acquisition while defining its
required process shim (`Cannot redefine property: process`); troubleshooting
documentation was unavailable because initialization did not complete. This is
the same runtime limitation recorded for issues #26 and #27. The approved
fallback used Playwright 1.61.1 with installed Microsoft Edge against an
isolated seeded PGlite server and the production Workspace router.

The fallback verified 1440×900 light, 1440×900 dark, and 390×844 light
viewports. It exercised populated, loading, forced failed refresh with Last
Trustworthy State, retry, pending live update, explicit Apply, connection loss,
keyboard activation, reduced motion, and empty-section contract states. The
document had no horizontal overflow or framework overlay. Console output was
clean apart from the expected deterministic HTTP 503, offline network
diagnostic, and browser favicon 404 used during recovery tests.

The final browser pass also followed Source and Attention evidence links to
their exact authorized selections/records, confirmed the operation anchor,
forced two refresh responses to complete out of order, and verified that the
newer trustworthy projection remained visible. An offline Home refresh used
the explicit connection-loss recovery and `Unavailable` request fallback;
no undefined metadata reached the page.

## Evidence ledger

| ID | Visible surface or state | Approved mapping | 2Brain translation and same-viewport verification |
|---|---|---|---|
| DE-028-01 | Home document canvas and sections | Notion Home/sidebar sections plus spacious editor canvas | `/app` renders one document-style canvas with Trust Summary, Attention, Background Operations, and Recent changes separated by simple dividers. 1440×900 light/dark and 390×844 light captures passed without bento cards, charts, health rings, grades, percentages presented as trust, or page overflow. |
| DE-028-02 | Plain Source currentness | Notion section rows and direct content links | Each permitted active Source produces one qualitative statement (`current`, `due soon`, `stale`, or insufficient evidence) derived from verification cadence and links to permitted Source/Knowledge evidence. The browser verified `Team Docs is current…`; the denied `Private Plans` name, ID, state, and count were absent from DOM and API. |
| DE-028-03 | Active trust conditions | Notion Home content needing attention plus focused dashboard views | Authorized active Attention and active/recently failed Background Operations appear as plain statements and dedicated rows. Every statement and row has an internal evidence link; the browser followed the permitted Source selection, exact Attention record, and operation anchor. Durable operation progress remains operation evidence, never a composite trust or productivity metric. |
| DE-028-04 | Authorized Attention preview | Notion Home/My Tasks attention grammar and direct-source navigation | Open and In progress items are prioritized by lifecycle/category, expose safe assignee and next action, and link to the durable Attention Item. Source/Page filtering occurs before summaries or links are built; Agent/Automation oversight remains Administrator-only. |
| DE-028-05 | Material Recent changes | Notion Inbox chronological important-update grammar | The allowlist includes permitted Source, Page/Knowledge, Agent, Attention, and self/Administrator access events. Login, setup, Notifications, ordinary retrieval, viewing, searching, and unknown resource types are excluded. Playwright verified a new Source event stayed absent while `Apply 1 new update` was pending, then appeared only after explicit Apply. |
| DE-028-06 | Authorized Background Operations | Notion dashboard focused-view permissions and persistent row grammar | Members see only operations whose Source is currently permitted; Administrators see full active and recently failed operational evidence. Each row links to the authorized operation evidence target, exposes durable state/progress/update time, and omits denied error/resource metadata. |
| DE-028-07 | Setup, access-required, and empty causes | Existing issue #23 Setup Checklist mapping plus Notion section-empty grammar | Incomplete Administrator setup keeps the live-evidence checklist. Members see `Workspace is being set up` only before synchronized Knowledge and `Access required` after Knowledge exists without usable Source Access. Ready Home names `No active Attention`, `No active or recently failed Background Operations`, and `No recent material changes` independently. |
| DE-028-08 | Loading and failed refresh | Notion loading/recovery emphasis plus Reset Notion | Refresh sets `aria-busy=true` and visibly announces `Refreshing Home evidence`. A deterministic 503 retained all previously rendered rows, labeled them `Last Trustworthy State — potentially outdated`, included time/recovery/request ID, and offered a native Retry button; Retry restored the trustworthy state. A forced response race proved that an older refresh cannot replace newer trustworthy evidence. Loading and failure were captured at 1440×900. |
| DE-028-09 | Connection loss and non-jumping updates | Issue #26 authenticated pending-update contract plus Notion stable view ordering | Stream/poll failure keeps prior Home content and shows the shared Last Trustworthy State connection label. Authorized events enter the ID-keyed pending map; no row moves or appears until explicit Apply, except a safe empty-state transition. Access reduction reloads current authorization before queued content can apply. |
| DE-028-10 | Keyboard, theme, reduced motion, and supported viewports | Notion native link/button grammar and project shell captures | Refresh, Retry, evidence links, and Apply are native focusable controls. Playwright focused Refresh and activated it with Enter, verified the reduced-motion media override (`0.001ms`/`1e-06s`), checked dark/light themes, and confirmed zero document overflow at 1440×900 and 390×844. The mobile live-status bar reflows across the bottom with reserved content space. |

## Mismatch ledger

- Current Notion moved Home into customizable sidebar sections. The approved
  2Brain V1 route contract retains `/app` as a spacious Home document; the
  implementation borrows section hierarchy and direct navigation, not the
  exact current placement.
- Notion Dashboard views can include charts and executive metrics. Issue #28
  explicitly prohibits that interpretation for shared-memory trust, so 2Brain
  uses qualitative evidence rows only.
- Notion does not expose 2Brain's Source currentness, Condition Episodes,
  Source Access, operation authorization, or Last Trustworthy State semantics.
  Those are security/product requirements verified directly rather than
  attributed to Notion.

## Automated contract evidence

- Targeted PGlite coverage verifies freshness wording, evidence links,
  Attention/operation/change allowlists, ordering, explicit empty causes,
  unauthenticated rejection, and denied metadata non-disclosure through both
  the domain and HTTP/shell seams.
- Setup Checklist and live-update suites verify cause-specific setup/access
  states, current-cursor bootstrap, duplicate-safe pending counts, explicit
  application, connection-loss preservation, and access-reduction reload.
- The targeted PostgreSQL boundary case proves allowed Source/Page evidence
  remains linked while denied Source, Attention, operation, and change metadata
  stays absent under the current persisted Source Access policy.

## Rendered artifact ledger

Artifacts are stored outside the repository under
`C:\Users\aziz\.codex\visualizations\2026\07\14\019f5f17-307c-7b63-841e-d8a6f4b48220`.

| State | Artifact |
|---|---|
| Populated 1440×900 light | `issue-28-home-desktop-light.png` |
| Populated 390×844 light | `issue-28-home-mobile-light.png` |
| Populated 1440×900 dark | `issue-28-home-desktop-dark.png` |
| Loading held | `issue-28-home-loading-desktop.png` |
| Failed refresh with Last Trustworthy State | `issue-28-home-failure-desktop.png` |
| Pending live update before explicit Apply | `issue-28-home-pending-desktop.png` |
| Complete connection loss | `issue-28-home-connection-loss.png` |

`issue-28-visual-results.json` records the executable viewport, overflow,
console, interaction, keyboard, and reduced-motion assertions.

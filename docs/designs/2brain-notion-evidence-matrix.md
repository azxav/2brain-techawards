# 2Brain Notion design-evidence matrix

Status: baseline release gate

Date: 2026-07-10

Authority: ADR-0026, ADR-0027, ADR-0040

This document is the visual source of truth for 2Brain v1. It prevents “Notion-inspired” interpretation: a screen, component, state, visual token, motion, or responsive choice cannot ship until its Design Evidence Entry is complete.

## Evidence policy

Accepted evidence is limited to:

1. User-supplied Notion screenshots.
2. Current official public Notion product and Help Center material.
3. Publicly accessible Notion interface captures.

Private Workspace access is not required. If a necessary pattern lacks reliable evidence, implementation pauses for one targeted reference capture. The discarded gbrain admin interface is never fallback evidence.

Permitted deviations are limited to WCAG 2.2 AA accessibility, security or authorization clarity, and accurate 2Brain product meaning. Each deviation must name the conflict, preserve the closest supported Notion pattern, and be recorded in the evidence entry.

2Brain uses its own name, icon, data, and terminology. Notion logos, trademarks, illustrations, and proprietary assets are excluded. A consistently applied, appropriately licensed outline icon set may substitute for the icon shapes visible in a reference.

## Baseline references

The screenshots remain outside the repository because they contain personal Workspace information. Do not commit them without redaction.

| ID | Reference | Raster size | What it can establish |
|---|---|---:|---|
| U-01 | `Screenshot 2026-07-10 152343.png` | 2560 × 1324 | Expanded dark desktop sidebar, selected destination, grouped navigation, workspace identity header, collapse affordance, bottom utilities, compact anchored menu, page title, toolbar, and centered empty state |
| U-02 | `Screenshot 2026-07-10 152352.png` | 2546 × 1324 | Dark desktop Workspace/account popover, identity block, outlined actions, grouped rows, role badge, truncation, dividers, selected-row check, additive action, logout, and shell context |
| U-03 | `Screenshot 2026-07-10 152416.png` | 2558 × 1324 | Dark desktop modal backdrop, large two-pane Settings dialog, grouped Settings navigation, selected row, close control, section hierarchy, dividers, right-aligned selects/toggles, and independent scrolling |
| U-04 | User-supplied Notion login capture | 2558 × 1328 | Light desktop centered authentication form, focused email field, helper copy, primary action, alternative-action grouping, and restrained help affordance |
| U-05 | User-supplied Notion onboarding capture | 2560 × 1422 | Dark desktop onboarding hierarchy, option rows, disabled primary action, consent rows, background shell skeleton, and language utility |
| U-06 | User-supplied Notion first-run shell capture | 2552 × 1342 | Dark authenticated shell, compact navigation, setup progress card, spacious first-run canvas, and restrained suggested actions |
| U-07 | User-supplied Notion setup-checklist capture | 2560 × 1326 | Dark setup checklist, completed/incomplete rows, progress treatment, bordered panel, and dimmed surrounding shell |
| U-08 | User-supplied Notion logout capture | 2540 × 1308 | Focused destructive confirmation modal, backdrop, primary destructive action, and cancel action |
| U-09 | User-supplied Notion invitation capture | 2560 × 1318 | Large dark modal form, email chip field, role selector, supporting descriptions, primary/cancel actions, and dimmed shell |
| U-10 | User-supplied Notion role-menu capture | 2556 × 1308 | Open select menu, selected-row check, role hierarchy, descriptions, dividers, and constrained scrolling |
| U-11 | User-supplied Notion loading capture | 2560 × 1328 | Centered loading overlay, compact elevated status surface, spinner, and non-interactive dimmed background |

Raster pixels are not CSS measurements. Browser zoom, display scaling, font rendering, and capture cropping are unknown. Exact colors, fonts, spacing, radii, shadows, and dimensions must be measured from a controlled reference capture before becoming tokens.

Current official semantic references:

| ID | Official reference | Supported behavior |
|---|---|---|
| O-01 | [Navigate with the sidebar](https://www.notion.com/help/navigate-with-the-sidebar) | Sidebar as the primary navigation hub; Inbox, Search, quick entry points, grouped content, and collapse behavior |
| O-02 | [Search in your workspace](https://www.notion.com/help/search) | Search from the sidebar, modal entry, recent items, sorting, filtering, database search, and keyboard entry |
| O-03 | [What is a database?](https://www.notion.com/help/what-is-a-database) | Rows as pages, properties, multiple views, search, filters, and sorting |
| O-04 | [Views, filters, sorts & groups](https://www.notion.com/help/views-filters-and-sorts) | Per-view settings, filter/sort/group controls, and side-peek/full-page opening behavior |
| O-05 | [Table view](https://www.notion.com/help/tables) | Page rows, columns/properties, row selection, resizing, wrapping, and table interaction |
| O-06 | [Notification settings](https://www.notion.com/en-gb/help/notification-settings) | Inbox badge and notification settings entry points |
| O-07 | [Account settings & preferences](https://www.notion.com/en-gb/help/account-settings) | Settings entry through the Workspace identity area and preference grouping |

Official help text can establish interaction semantics. It does not establish a visual token unless its current interface image is captured at a controlled viewport and attached to the relevant entry.

## Observable visual grammar

The three baseline screenshots directly support these choices for the matching dark desktop states:

- Near-black content canvas, a subtly differentiated sidebar, and slightly lighter elevated surfaces.
- Low-contrast borders and dividers rather than card-heavy framing.
- Near-white primary text, muted warm-grey secondary text, blue actions, red notification dots, and a restrained amber role badge.
- Dense navigation and popovers paired with a spacious page canvas.
- Neutral filled backgrounds for selected or emphasized rows.
- Thin outlined secondary buttons, filled blue primary buttons, and blue text-link actions.
- Monochrome outline icons placed beside labels and compact icon-only toolbar controls.
- Small rounding on rows and buttons, larger rounding on popovers/dialogs, and pill treatment only where the reference shows it.
- Hierarchy expressed through relative type size, weight, spacing, and muted group labels.
- Grouped menus with separators, plus ellipsis truncation for long labels.
- Dimmed backdrop for the full Settings dialog; no backdrop for anchored popovers.
- Centered empty state composed of a restrained outline icon, one explanatory sentence, and one next action.
- Separate visible scrolling regions where content length requires them.

The screenshots do not prove hover, focus, pressed, disabled, loading, validation, success, failure, motion, keyboard, focus-trap, tooltip, contrast, or responsive behavior. Those states require additional evidence and accessibility verification.

For issue #6, the operator confirmed that exact Notion captures for email-confirmation, failure, and narrow/mobile states are unavailable and explicitly approved inference from U-04 through U-11. Those inferred states preserve the closest evidenced hierarchy and component grammar, use 2Brain-specific meaning, and are recorded below rather than represented as direct Notion captures.

## Issue #6 evidence ledger

| Entry | 2Brain state | Evidence mapping | Viewport verification | Inference / exception | Status |
|---|---|---|---|---|---|
| DE-006-01 | Setup form, dark desktop | U-04 centered form hierarchy + U-05 dark onboarding + U-09 modal-form controls | 1440 × 900, in-app browser; 580px max form, 52px fields, 48px action | 2Brain requires Workspace name, Administrator email, and clean-start impact copy | Pass — Codex visual/keyboard review, 2026-07-11; local side-by-side inspection |
| DE-006-02 | Setup submitting/loading | U-11 loading overlay and spinner | 1440 × 900; 21px spinner; reduced-motion CSS included | Loading copy translated to Workspace creation | Pass — Codex visual/reduced-motion review, 2026-07-11; local comparison |
| DE-006-03 | Email confirmation required/success/failure | U-04 authentication hierarchy + U-08 focused modal + U-11 progress | 1440 × 900; 580px status width; request ID uses 12px monospace | Exact state unavailable; operator-approved inference with request ID and recovery action | Pass — Codex flow review, 2026-07-11; local comparison |
| DE-006-04 | Authenticated setup-only shell and checklist | U-06 first-run shell + U-07 checklist | 1440 × 900; 260px sidebar; 650px content maximum | Member/Knowledge/Agent destinations intentionally absent until later authorization work; checklist begins at verified 0/5 | Pass — Codex visual/DOM review, 2026-07-11; local side-by-side inspection |
| DE-006-05 | Narrow setup-only shell | U-04 single-column hierarchy + U-06/U-07 shell/checklist | 390 × 844; 58px identity bar; measured 390px client/scroll width | Exact mobile capture unavailable; sidebar collapses to identity bar without inventing a drawer | Pass — Codex reflow review, 2026-07-11; local comparison |
| DE-006-06 | Invalid/expired/used link | U-04 centered authentication hierarchy + U-08 modal emphasis | 1440 × 900; keyboard-readable request ID and recovery copy | Exact error capture unavailable; security clarity adds explicit recovery action | Pass — Codex keyboard/flow review, 2026-07-11; local comparison |

All references remain outside the repository because the captures contain private Workspace information. Comparison captures were inspected locally at the listed implementation viewports. UI uses system typography and code-native symbols; no Notion trademark, logo, illustration, or proprietary asset is shipped.

Accessibility verification for DE-006-01–06: semantic landmarks/headings and explicit labels are exposed in the browser DOM; keyboard order follows document order and the skip link becomes visible on focus; form controls are 48–52px tall; focus uses a two-pixel blue ring in addition to the border; narrow reflow has no horizontal overflow at 390px; status and error changes use `role=status`/`role=alert`; reduced-motion removes spinner duration; primary dark-theme text (`#f1f1ef` on `#191919`) and light-theme text (`#202020` on `#ffffff`) exceed WCAG AA contrast. Screen-reader-specific product testing remains part of the whole-release gate; this slice verifies the semantic browser tree rather than claiming a device/reader matrix.

For issue #12, the operator confirmed on 2026-07-12 that exact Notion captures for a people list, Source Access policy, authorization failure, and the complete invitation-management flow do not exist or cannot be obtained. The approved fallback composes only the closest available Notion primitives (U-03, U-08, U-09, U-10, and U-11), records every domain-specific difference as an exception, and verifies the resulting 2Brain states directly. This is evidence of interaction grammar, not a claim that Notion provides 2Brain's role or Source Access model.

## Issue #12 fallback evidence ledger

| Entry | 2Brain state | Evidence mapping | Required 2Brain verification | Inference / exception | Status |
|---|---|---|---|---|---|
| DE-012-01 | Administrator Settings, people list, and empty/loading/failure states | U-03 two-pane Settings hierarchy + U-11 loading treatment | 1440 × 900 and 390 × 844; dark captures `01-admin-settings-desktop.png`/`02-admin-settings-mobile.png`; light tokens checked from the same CSS; populated list, loading DOM, retry failure, and independent content scrolling verified | Exact Notion people-management list unavailable; 2Brain rows expose role and Source Access as separate dimensions | Pass — Codex in-app Browser visual/DOM/console review, 2026-07-12 |
| DE-012-02 | Invitation form and delivery result | U-09 modal-form hierarchy + U-11 progress | 1440 × 900 capture `06-invitation-specific-sources.png`; All/Specific/None selection, Source IDs, successful reset, validation, and safe API response verified | 2Brain adds explicit Source Access policy; invitation secrets remain absent from browser payloads | Pass — Codex interaction review, 2026-07-12 |
| DE-012-03 | Role and Source Access controls | U-10 open-select grammar + U-03 right-aligned Settings controls | 1440 × 900; role and Specific Sources changed independently and persisted; missing-reason failure focused the reason field; Escape and focus wrapping verified | Notion has no equivalent Source Access policy; labels and descriptions are 2Brain domain UI | Pass — Codex keyboard/interaction review, 2026-07-12 |
| DE-012-04 | Disable/re-enable and logout/revoke | U-08 focused confirmation hierarchy | 1440 × 900 capture `05-member-account-logout.png`; protected disable/re-enable APIs covered; logout navigated to `/login` and revoked the session | Membership disable and session revoke are security-specific 2Brain actions; inline reason replaces a separate confirmation modal | Pass — Codex flow and targeted-test review, 2026-07-12 |
| DE-012-05 | Member Settings and Access required | U-03 personal Settings section + U-04 centered explanatory hierarchy | 1440 × 900 captures `03-member-access-required-desktop.png`/`04-member-admin-forbidden.png`; Member nav omits administration, direct route returns safe 403, DOM and payload expose no Source identity or count | Exact authorization-failure capture unavailable; zero disclosure overrides visual fidelity | Pass — Codex visual/authorization review, 2026-07-12 |

Issue #12 comparison artifacts are stored in the local, redacted verification folder `D:\Temp\gbrain-issue12-evidence\` and remain outside the repository. In-app Browser checks found no console errors or framework overlay. Semantic dialog/navigation/headings and explicit labels were present; initial focus stayed inside the dialog, Tab wrapped from the final action to the first dialog link, Escape returned to `/app`, controls met the existing 38–52px target grammar, 390px reflow used one column without horizontal clipping, independent content scrolling remained available, and reduced-motion inherits the global animation override. Dark-theme screenshots were captured directly. As part of the operator-approved fallback, exact Notion light-theme comparisons and a device/reader matrix are explicitly waived because those captures cannot be obtained; light-theme foreground/background token pairs were instead checked from the same responsive CSS and exceed WCAG AA, while the semantic browser tree was inspected directly. The ledger does not claim those waived checks were captured.

For issue #16, the operator confirmed on 2026-07-13 that the missing exact Notion Source lifecycle states should use the documented fallback. The approved composition uses U-03 for the two-pane Settings hierarchy and restrained rows, U-08 for focused destructive confirmation, U-10 for compact state selection/actions, and U-11 for loading/progress grammar. Notion is not claimed to provide 2Brain's Archive semantics, retained Knowledge policy, Source projections, Source Access authorization, or desktop-only lifecycle mutation.

## Issue #16 fallback evidence ledger

| Entry | 2Brain state | Evidence mapping | Required 2Brain verification | Inference / exception | Status |
|---|---|---|---|---|---|
| DE-016-01 | Administrator Sources Settings: active/archived, loading/empty, dark desktop, and mobile status-only | U-03 two-pane Settings hierarchy and low-contrast rows + U-10 compact state selector + U-11 loading treatment | 1440 × 900 captures `01-active-sources-desktop.png` and `04-archived-sources-desktop.png`; 390 × 844 capture `06-sources-mobile-status-only.png`; active/archived API state, empty states, semantic tab panel, independent scrolling, zero document overflow, and absent mobile mutation controls verified | Exact Notion Source list/lifecycle and mobile administration states are unavailable; the tabs, lifecycle labels, and larger-viewport direction are 2Brain-specific | Pass — Codex in-app Browser visual/DOM/console review, 2026-07-13 |
| DE-016-02 | Archive warning, reason, confirmation, cancellation, focus, and keyboard states | U-08 focused destructive confirmation + U-03 supporting-text hierarchy | 1440 × 900 capture `02-archive-confirmation-desktop.png`; initial reason focus, Tab wrap, Escape cancellation, trigger focus return, 38–40px actions, explicit retained/excluded impact, and reduced-motion rule verified | Notion does not establish 2Brain retention or projection behavior; impact copy names Search, Ask, relationships, verification, synchronization, and automation from the issue specification | Pass — Codex keyboard/interaction review, 2026-07-13 |
| DE-016-03 | Archive success, archived Source, restore confirmation/success, and unchanged verification evidence | U-03 retained inline status/row grammar + U-10 compact action grammar + U-11 mutation progress | 1440 × 900 captures `04-archived-sources-desktop.png` and `05-restored-source-desktop.png`; Source moved between real API projections, success remained announced, restore returned it active, and `Last verified: Never` remained unchanged | Archive/restore, indefinite retention, and verification-evidence preservation are 2Brain semantics directly verified against the API rather than attributed to Notion | Pass — Codex flow/API review, 2026-07-13 |
| DE-016-04 | Archive failure with preserved reason and request ID; Member permission denial with zero Source disclosure | U-08 focused failure hierarchy + U-04 centered explanatory hierarchy | 1440 × 900 captures `03-archive-failure-desktop.png` and `07-member-forbidden-desktop.png`; failure time/resource/recovery/request ID and preserved input verified; Member route exposed no Source ID, count, tabs, or action; console remained clean | Exact Notion Source authorization/failure states are unavailable; security zero-disclosure and durable request diagnostics override visual fidelity | Pass — Codex failure/authorization review, 2026-07-13 |

Issue #16 artifacts are stored outside the repository at `D:\Temp\gbrain-issue16-evidence\`. The in-app Browser reported no console warnings/errors or framework overlay. Desktop controls measured 38–43.5px high, dialog controls 40px, focus uses a two-pixel outline, the modal traps focus and returns it on Escape, and the 390px viewport had zero document overflow while removing Connect/Archive/Restore mutations. Dark-theme screenshots were captured directly. The exact light-theme capture and device/reader matrix remain explicitly waived under the operator-approved fallback; code-native light tokens were checked instead: primary text is 16.29:1 and muted text is 4.55:1 on white, while dark primary and muted text are 15.55:1 and 6.67:1. The ledger does not represent waived variants as captured.

For issue #32, the operator confirmed on 2026-07-14 that exact Notion captures for a data-export configuration, background export progress, completion with download and expiry, export failure, retry, and cancellation do not exist or cannot be obtained, and approved the documented fallback. The approved composition uses U-03 for the two-pane Settings hierarchy and low-contrast rows, U-08 for focused failure emphasis, U-10 for compact per-row actions, and U-11 for loading/progress grammar, and reuses the already-passed 2Brain resource-row, accessible progressbar, operation-actions, and Last-Trustworthy-State primitives verified in DE-016 and DE-024. Notion is not claimed to provide 2Brain's secret-free export, archive integrity, 30-day download expiry, or Background-Operation lifecycle semantics.

## Issue #32 fallback evidence ledger

| Entry | 2Brain state | Evidence mapping | Required 2Brain verification | Inference / exception | Status |
|---|---|---|---|---|---|
| DE-032-01 | Administrator Data export Settings: configuration, impact explanation, empty/loading, dark desktop and mobile | U-03 two-pane Settings hierarchy + U-11 loading treatment | 1440 × 900 and 390 × 844, in-app Browser; render-verified panel, both included and never-included class lists, Start export control, refresh-failure Last-Trustworthy-State, 0px horizontal overflow at 390px, and Close-link initial focus | The included/never-included impact lists are generated from the export builder's declared retained and excluded data classes, so the visible copy cannot drift from what the archive reads; secret-free reassurance is 2Brain-specific | Pass — local in-app Browser visual/DOM review, 2026-07-14 |
| DE-032-02 | Export durable progress, completion, archive integrity, and download/expiry | U-11 progress + U-03 rows + U-10 compact per-row actions | 1440 × 900; running row exposes a `progressbar` with `aria-valuenow`, completed row shows size, sha256 checksum, and record counts with "Available until", and the expired row hides Download and shows renewal guidance | The progressbar and rows reuse DE-016/DE-024 primitives; the client-side blob download and 30-day download expiry are 2Brain semantics verified against the API rather than attributed to Notion | Pass — local in-app Browser review, 2026-07-14 |
| DE-032-03 | Export failure, retry, and cancellation-where-safe | U-08 focused failure hierarchy + U-11 mutation progress | 1440 × 900; the failed row shows message, request ID, and Retry; a queued export and a running export still within the cancellation-safe window show Cancel / Request cancellation, and the cancellation-requested notice renders when a running export carries `cancel_requested` | Retry and cancel mirror the Background Operations recovery grammar; cancellation is offered only while safe, matching AC-1 "cancellation where safe" (once the worker marks an active build `cancellation_safe=false` the control is withdrawn, exactly as the DE-024 operations row does, though the cancel API still accepts a running export and the worker discards the partial archive at finish); a queued-export cancellation is durable and non-retryable | Pass — local in-app Browser review, 2026-07-14 |
| DE-032-04 | Member permission denial with zero export disclosure | U-04 centered explanatory hierarchy | Member Settings navigation omits Data export, a direct `/app/settings/export` request returns the safe 403 message document, and no export control is rendered for a Member (appDocument render and router gate) | Exact Notion authorization capture is unavailable; zero disclosure overrides visual fidelity | Pass — appDocument render + router 403 gate, 2026-07-14 |

Issue #32 comparison artifacts are stored outside the repository at `D:\Temp\gbrain-issue32-evidence\` and the redacted 2Brain captures remain outside version control. The in-app Browser reported no console errors. Semantic dialog, navigation, headings, lists, and a labelled `progressbar` are present; initial focus lands on the Close link (verified), while Tab wrapping and Escape-to-`/app` are handled by the same settings-dialog focus trap verified in DE-012 and DE-016. Start and Download controls measured 38px; the 390px viewport had zero document overflow while keeping the export controls available, because export start, retry, cancel, and download are non-destructive (unlike desktop-only Source lifecycle mutations). Reduced motion inherits the global animation override. Dark and light tokens were checked from the same responsive CSS: light primary text is `#202020` on `#ffffff` (16.29:1) and dark primary text is `#f1f1ef` on `#191919` (15.55:1), with the completed (`#26733a` / `#68b879`) and failed (`#c7352b` / `#f17b70`) state colors legible in both themes. The exact Notion light-theme comparison and a device/reader matrix are explicitly waived under the operator-approved fallback; the ledger does not represent waived variants as captured.

## Surface coverage

`Covered` means a matching visual state exists. `Partial` means only a structural primitive is supported. `Capture required` blocks production UI implementation for that state.

| 2Brain surface | Current coverage | Required evidence before implementation |
|---|---|---|
| `/login`, magic-link confirmation, Workspace Setup | Covered for issue #6 by U-04/U-05/U-09/U-11 and DE-006-01–03/06 | Exact confirmation/error states unavailable; operator-approved inference recorded in each entry |
| First-Administrator Setup Checklist | Covered for issue #6 by U-06/U-07 and DE-006-04 | Later interactive checklist actions require their own feature evidence |
| Expanded dark desktop shell/sidebar | Covered by U-01 | Controlled same-viewport capture for token measurement |
| Collapsed shell, light theme, tablet, mobile drawer | Partial: issue #6 narrow setup shell covered by DE-006-05 | General member shell, light theme, tablet, and interactive mobile navigation remain capture-required |
| Single-Workspace identity menu | Partial via U-02 | Member and Administrator contents; copy must exclude Workspace switching |
| Home Trust Summary, Attention preview, recent changes | Capture required | Populated and empty Notion Home/dashboard sections without charts or bento invention |
| Knowledge table and Saved Views | Partial semantics via O-03–O-05 | Populated table, view tabs, properties, status pills, toolbar, filter, sort, search, overflow, empty, and pagination/loading states |
| Page detail and provenance | Capture required | Database Page detail with properties and original-location action |
| Page history panel and diff | Capture required | Page history/version side panel and compare state |
| Sources list/detail and freshness | Partial: issue #16 active/archived lifecycle fallback via DE-016-01/03 | Remaining populated detail/freshness interactions still require exact connection-style evidence or a separately approved fallback |
| Add/configure/archive/restore/delete Source | Partial: issue #16 Archive/Restore fallback via DE-016-02–04; issue #20 permanent-deletion fallback via DE-020-01–09 | Add/configure, their validation/progress, and exact delete-confirmation captures remain capture-required; issue #20 records the approved inference from U-03/U-08/U-09/U-11 |
| Agent directory/detail/activity | Partial: issue #22 structured-activity fallback via DE-022-01–09 | Directory-embedded structured activity, oversight, redaction, and retention states record the approved inference from U-03/U-11 and official audit-log/updates/connections help; exact populated directory/detail captures remain capture-required |
| Agent registration and credential reveal | Capture required | Integration creation, scope/source picker, one-time secret reveal, copy feedback, and revoke confirmation |
| Attention Queue | Partial: issue #24 Source-health fallback via DE-024-01–03/08–09; issue #25 all-category fallback via DE-025-01–04/08–10 | Queue rows, status pills, filter, all four categories, and Member-filtered/empty/failure states record the approved inference from U-01/U-02/U-03/U-11 and official database help; exact populated Notion queue captures remain capture-required |
| Attention lifecycle actions | Partial: issue #24 fallback via DE-024-04–07/10; issue #25 category-scoped verification/dismissal fallback via DE-025-05–07/11 | Assignment, status transition, reason-bearing dismissal, verified-resolution feedback, and recurrence history record the approved inference from U-08/U-09/U-11 and official updates/audit-log help; exact Notion captures remain capture-required |
| Global Search | Semantics via O-02 | Open modal, recent state, results, filters, no results, and inaccessible-result handling |
| Ask 2Brain | Capture required | Current Notion AI question, progress, cited result, insufficient evidence, error, and cancellation patterns |
| Notifications | Partial: issue #27 fallback via DE-027-01–09 | Official Inbox/sidebar evidence supports the unread badge, personal list, durable-target navigation, read/unread, archive, empty, keyboard, theme, and viewport grammar; exact Notion captures remain capture-required, while 2Brain authorization, shared Attention separation, live deduplication, safe payload, and 30-day retention are documented product deviations |
| Preferences/appearance | Covered in dark desktop by U-03 | Light theme, open select, enabled toggle, focus, validation, and responsive dialog |
| Members, invitations, roles, Source Access | Operator-approved fallback via DE-012-01–05 | Compose U-03/U-08/U-09/U-10/U-11 primitives; verify 2Brain-specific people list, invite, role menu, access picker, disable/re-enable, and authorization failure locally |
| Background Operations/automations | Capture required | Durable progress, completion, failure, retry, cancellation, and operation history |
| Health/request logs and Audit Events | Capture required | Populated administrative list, filters, row detail, redaction, and empty states |
| Security, retention, export | Partial: issue #32 Data export fallback via DE-032-01–04 (progress, completion, download expiry, failure, retry, cancellation, permission) | Remaining Security and retention sections and their destructive actions stay capture-required; issue #32 records the approved inference from U-03/U-08/U-10/U-11 and DE-016/DE-024 primitives |
| Internal Page sharing | Capture required | Share dialog, member access, copy-link feedback, denied and revoked states |
| Persistent error/recovery and connection loss | Capture required | Inline error, stale-data notice, retry, preserved input, and request ID |
| Live “new updates” notice | Capture required | Non-jumping update indicator and apply/refresh behavior |

One reference may support multiple 2Brain surfaces only when the same primitive is genuinely present. A database status pill can support the shape of Source Freshness and Attention Status, but it cannot establish their meaning; the evidence entry must document that semantic mapping.

## Minimum reference pack

Capture these before building the affected production surfaces:

- For every applicable surface below, capture hover, focus, pressed, disabled,
  loading, success, error, keyboard, reduced-motion, responsive, and mobile
  variants. Record an explicitly unavailable variant as a gap. When the operator
  confirms that no exact Notion state exists or can be obtained, a documented
  fallback may compose the closest captured primitives, provided it does not
  claim unsupported Notion behavior and verifies the 2Brain state directly.
  Domain-adjacent states (for example permission
  denial, destructive confirmation, empty, and recovery) require the same
  treatment.

1. Populated database: views, properties, status pills, rows, filter, sort, search, overflow, loading, and empty states.
2. Database Page detail: properties, side peek, Page history, version comparison, and sharing.
3. Populated Home/dashboard with several restrained sections.
4. Search and Notion AI result states, including citations, refusal/insufficient evidence, progress, cancellation, and failure where available.
5. Inbox/notification list and detail.
6. People, invite, role, permission, and share flows.
7. Connections/integration setup, permissions, credential reveal, and revocation.
8. Import/background progress, completion, failure, retry, and persistent inline error.
9. Security/export settings and destructive confirmation.
10. Login, email verification, Workspace setup, and checklist onboarding.
11. Expanded/collapsed desktop, light/dark, tablet, and mobile navigation states.

## Design Evidence Entry template

Every implemented state gets one row in the release ledger with these fields:

| Field | Required content |
|---|---|
| Entry ID | Stable `DE-###` identifier |
| 2Brain surface and state | Route/component, role, data state, interaction state (for example hover, focus, pressed, disabled, loading, success, or error), theme, and responsive state |
| Notion source | U/O reference ID, capture location, capture date, Notion version if known |
| Controlled viewport | CSS viewport, device scale, browser/app, and zoom |
| Observable mapping | Layout, component, interaction, hierarchy, and state evidenced by the source |
| Measured tokens | Measurements taken from the controlled capture; no estimates |
| Semantic translation | Why the Notion pattern accurately represents the 2Brain domain action |
| Licensed assets | Icon library/name and any non-proprietary asset source |
| Exceptions | Accessibility, security, or product-meaning deviation with rationale |
| Comparison artifact | Reference and implementation combined at the same viewport and state |
| Verification | Reviewer, date, pass/fail, and remaining visible differences |

## Release ledger and issue gate

The release ledger is the collection of completed Design Evidence Entries. It may
link to redacted local or access-controlled comparison artifacts; it must never
embed an unredacted private Workspace capture in this repository. An entry is
`Pass` only when every field in the template is present, its controlled Notion
reference and 2Brain capture show the same viewport and state, all visible
differences are either corrected or recorded as a permitted exception, and the
accessibility checks in the Visual QA loop pass. Missing evidence, an unknown
viewport, or an unresolved visible difference is `Blocked`, not a conditional
pass.

Every UI issue must include this acceptance criterion, filled with the surface
it changes:

> **Design evidence acceptance:** `DE-###` records the `<2Brain surface and
> state>` at `<controlled viewport>` against `<Notion reference>`. Its
> same-viewport comparison artifact is inspectable; all visible differences
> either match or are documented permitted exceptions; keyboard, focus,
> contrast, reflow, reduced-motion, and target-size checks pass. Status: Pass.

An issue that introduces a state listed as `Capture required` in Surface
coverage must first attach the corresponding reference-pack capture. If the
operator records that an exact Notion state does not exist or cannot be
obtained, the issue may instead use an operator-approved fallback entry. That
entry must name the available primitives it composes, state every semantic
exception, avoid attributing the composed behavior to Notion, and pass
same-viewport 2Brain interaction and accessibility verification. Structural
similarity alone, without this recorded exception and direct verification,
cannot pass the gate.

## Visual QA loop

1. Capture and attach the approved Notion state.
2. Record the controlled viewport and measure the required tokens.
3. Implement only the mapped 2Brain state.
4. Capture 2Brain at the same viewport, theme, role, and data state.
5. Place reference and implementation together in one comparison artifact.
6. Inspect layout, typography, density, padding, margins, borders, radii, icons, state emphasis, clipping, and scrolling.
7. Fix visible mismatches and repeat until the entry passes.
8. Run keyboard, focus, screen-reader, contrast, reflow, reduced-motion, and target-size checks; document permitted deviations.

The three baseline screenshots are enough to begin evidence capture and the dark desktop shell. They are not enough to justify the entire application. Production UI work on uncovered states remains blocked until the relevant evidence entry has a controlled reference.

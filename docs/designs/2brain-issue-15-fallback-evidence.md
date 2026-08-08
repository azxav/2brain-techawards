# Issue #15 operator-approved fallback evidence

On 2026-07-13 the operator approved the documented fallback for issue #15
because exact official Notion captures for Source Freshness, cadence-derived
Due soon/Stale states, and preserved trustworthy data after a failed refresh
cannot be obtained. This ledger composes only the closest captured Notion
primitives and verifies the 2Brain-specific states directly. It does not claim
that Notion provides 2Brain's Source cadence, verification, synchronization,
trustworthy-state, or retry semantics.

The Notion primitives are U-03 (two-pane Settings), U-09/U-10 (form and select
hierarchy), U-11 (loading/recovery emphasis), and O-03/O-04/O-05 (row,
property, view, and status semantics only). The controlled U-03 capture was
recorded on 2026-07-10 at 2558×1324. Redacted 2Brain implementation captures
remain outside the repository in `D:\Temp\gbrain-issue15-evidence\`.

## Fallback ledger

| Entry | 2Brain surface and state | Notion source and observable mapping | Controlled viewport and measured tokens | Semantic translation, licensed assets, and exceptions | Comparison artifact | Verification |
|---|---|---|---|---|---|---|
| DE-015-01 | `/app/settings/sources`; Administrator; Current, Due Soon, Stale, Manual, and Unknown freshness; dark desktop plus light-theme tokens | U-03 supplies the Settings container, selected navigation, hierarchy, backdrop, and independent scrolling. U-09/U-10 supply labeled form/select grammar. O-03/O-04/O-05 supply restrained row/property/status treatment, not freshness meaning. | 1440×900 CSS viewport, device scale 1, Codex in-app Browser, 100% zoom. Dialog maximum 920px with 220px navigation; state labels are 12px/700. Light state tokens: Current `#26733a` (5.84:1), Due soon `#8a5700` (6.10:1), Stale `#c7352b` (5.29:1) on `#fff`. Dark tokens: `#68b879` (6.77:1), `#d9a441` (7.24:1), `#f17b70` (6.06:1) on `#202020`. | Freshness derives from 2Brain verification/synchronization evidence. Due soon is informational; Stale communicates potentially outdated evidence; Manual never time-expires. System typography and native controls are used; no proprietary asset or icon is shipped. Exact Notion freshness states are unavailable, so status meaning is an operator-approved product-semantic exception. Light-shell structure is inherited from DE-013-01; issue #15 state-token contrast was measured directly. | `DE-015-sources-freshness-desktop-1440x900.png`, inspected beside U-03 and the U-09/U-10 form primitives. | **Pass** — Codex visual/DOM/contrast review, 2026-07-13. Current, Due Soon, Stale, Manual, cadence, and Last verified were simultaneously visible. No unresolved mismatch remains inside the approved fallback scope. |
| DE-015-02 | `/app/settings/sources`; Administrator; refresh failure, Last Trustworthy State, potentially outdated label, retained rows/form input, safe request identifier, focused Retry, and successful recovery | U-03 supplies the persistent Settings surface; U-11 supplies compact progress/failure emphasis; U-08/DE-013-02 supply secondary recovery-action grammar. No reference is attributed with 2Brain's preservation or retry behavior. | 1440×900, device scale 1, Codex in-app Browser, 100% zoom. Warning uses a 1px `#d7a943` border, 13–14px padding, and a native Retry button with a minimum 36px height. Existing Source rows remain in place without layout replacement. | Preserving verified rows instead of replacing them with an error is a 2Brain trust requirement. The warning exposes only a safe recovery sentence and request ID. Source ID `fallback-source`, Weekly cadence, name, and remote URL remained in the form through failure. Retry is a native labeled button; no custom icon or proprietary asset is used. | `DE-015-last-trustworthy-state-desktop-1440x900.png`; direct before/failure/retry observation at one controlled viewport. | **Pass** — Codex interaction/DOM review, 2026-07-13. Existing rows and form context survived the forced 503, request `request-refresh-failed` was visible, Retry received keyboard focus, and recovery restored the newly queued Source. |
| DE-015-03 | `/app/settings/sources`; Administrator; 390px responsive Freshness states, keyboard/focus semantics, reduced motion, dark/light themes, and console state | U-03 supplies dialog/focus hierarchy and U-11 supplies recovery emphasis. Exact Notion mobile, freshness, and accessibility variants are unavailable; DE-013-03 supplies the already-approved Settings focus-trap, Escape, theme, and reduced-motion grammar. | 390×844 and 1440×900. At 390px, body and dialog client/scroll widths were all exactly 390px; the layout reflows to one column with horizontally scrollable Settings destinations. Initial focus is Close Settings; the failure Retry is a semantic button. Global reduced motion collapses animation duration to `.001ms`. All state-token contrast ratios exceed 4.5:1 in both themes. | Narrow horizontal Settings navigation is a documented 2Brain responsive exception and is not attributed to Notion. Keyboard, WCAG contrast, accurate product meaning, and safe failure clarity override literal visual imitation. System typography/native controls are the only assets. | `DE-015-sources-freshness-mobile-390x844.png` plus the two desktop captures; DOM, viewport metrics, focus state, and console output were recorded in the same browser workflow. | **Pass** — Codex responsive/accessibility review, 2026-07-13. Current, Due Soon, Stale, and Manual remained present; there was no horizontal overflow and no console warning/error. Existing DE-013-03 focus wrapping, Escape, theme, and reduced-motion checks remain applicable because issue #15 did not replace the Settings shell. |

## Fidelity and acceptance ledger

| Acceptance state | Evidence | Result |
|---|---|---|
| Freshness and Last verified | DE-015-01 plus pure/lifecycle tests | Pass |
| Due soon final-20-percent state | DE-015-01 plus exact-boundary pure tests | Pass |
| Timed Stale and known-unsynchronized Stale | DE-015-01 plus pure/lifecycle tests | Pass |
| Manual cadence behavior | DE-015-01 plus pure tests | Pass |
| Preserved Last Trustworthy State and potentially outdated label | DE-015-02 | Pass |
| Failure, safe request identifier, retained form context, and retry | DE-015-02 | Pass |
| Keyboard, focus, reduced motion, dark/light contrast | DE-015-02/03 and DE-013-03 | Pass |
| 1440×900 desktop and 390×844 responsive viewport | DE-015-01/02/03 | Pass |

No Notion logo, trademark, illustration, or proprietary asset is shipped. The
documented differences are accurate 2Brain product semantics, accessibility,
and trustworthy failure recovery. Every issue #15 visible state is covered by
an operator-approved fallback entry and direct implementation verification.
Status: **Pass**.

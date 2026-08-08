# Issue #13 operator-approved fallback evidence

On 2026-07-13 the operator directed issue #13 to use the documented fallback
because exact official Notion captures for Managed Git Source provisioning and
durable Background Operations cannot be obtained. This ledger composes only
the closest captured Notion primitives and verifies the 2Brain-specific states
directly. It does not claim that Notion provides 2Brain's Source, Source Access,
worker, retry, or cancellation semantics.

Private reference captures remain outside the repository. Redacted 2Brain
comparison artifacts are stored locally in
`D:\Temp\gbrain-issue13-evidence\`.

## Fallback ledger

| Entry | 2Brain surface and state | Notion source and observable mapping | Controlled viewport and measured tokens | Semantic translation and exceptions | Comparison artifact | Verification |
|---|---|---|---|---|---|---|
| DE-013-01 | `/app/settings/sources`; Administrator; empty/loading/form/success/validation/detail; dark desktop, light desktop, and narrow responsive | U-03, captured 2026-07-10: two-pane Settings shell, selected navigation row, dimmed backdrop, independent content scrolling. U-09: modal-form hierarchy and primary action. U-10: described select. U-11: loading treatment. O-03/O-05: row/property semantics only. | 1440×900, device scale 1, Codex in-app Browser, 100% zoom; dialog 920px maximum, 220px navigation, 638px form content, 42px selects, 48px primary action. 390×844 reflows to one column with 390px client/scroll width and no page overflow. | HTTPS URL, immutable Source ID, cadence, and search inclusion are 2Brain concepts. No filesystem path control exists. “Included in Workspace Search” explicitly says it does not grant Source Access. Source detail links the retained partial Source to its most recent operation. Narrow horizontal Settings navigation is a 2Brain responsive exception; it does not attribute a Notion mobile pattern. | `DE-013-01-sources-empty-dark-1440x900.png`, `DE-013-04-sources-mobile-dark-390x844.png`, `DE-013-05-source-populated-detail-dark-1440x900.png`, `DE-013-11-source-validation-dark-1440x900.png`, `DE-013-12-sources-empty-light-1440x900.png`; inspected beside U-03 at native reference resolution. | Pass — Codex visual/DOM/keyboard review, 2026-07-13. Form submission returned a queued durable operation immediately; validation, success, populated row, and Source detail were exercised in-browser. |
| DE-013-02 | `/app/settings/operations`; Administrator; empty/loading/Queued/Running/Completed/Failed/progress/outcome/retry/cancellation | U-03 Settings hierarchy + U-11 progress/loading + U-08 focused destructive/cancel action. O-03/O-04/O-05 support restrained history rows, not worker semantics. | 1440×900, device scale 1, Codex in-app Browser, 100% zoom; 5px progress track, 36px secondary actions, 12px state label, independently scrolling content. | Durable state, attempts, request IDs, retry, and cancellation are 2Brain operational semantics. Cancellation is shown only when the API marks it safe; retry is shown only for retryable Failed operations. Safe error summaries and request IDs replace raw diagnostics. | `DE-013-02-operation-queued-dark-1440x900.png`, `DE-013-03-operation-cancelled-dark-1440x900.png`, `DE-013-06-operation-running-dark-1440x900.png`, `DE-013-07-operation-completed-dark-1440x900.png`, `DE-013-08-operation-failed-retry-dark-1440x900.png`, `DE-013-09-operation-retried-dark-1440x900.png`, `DE-013-10-operation-loading-dark-1440x900.png`; direct state captures at the controlled viewport. | Pass — Codex interaction/DOM review and targeted API tests, 2026-07-13. Every lifecycle state, progress, safe failure, retry, queued cancellation, and loading were rendered at the same viewport; late cancellation and restart recovery are additionally covered by targeted unit and Postgres parity tests. |
| DE-013-03 | Settings keyboard, focus, reduced motion, theme, authorization, pending actions, and recovery states | U-03 dialog/focus hierarchy + U-08 cancellation emphasis + U-11 loading. Exact Notion accessibility and Member-denial captures are unavailable under the operator-approved fallback. | 1440×900 and 390×844. Initial focus is `Close Settings`; Tab remains inside the dialog; Shift+Tab wraps; Escape returns to `/app`. Controls use the existing 38–52px target grammar. Reduced motion collapses animation duration. Dark tokens are `#f1f1ef` on `#191919`; the controlled light render verifies `#202020` on `#ffffff`; both exceed WCAG AA. | Member navigation omits Sources and Background Operations and direct routes return safe 403. Connect, Retry, and Cancel disable and announce pending labels while their requests are active. A device/screen-reader matrix is outside this slice; token contrast and semantic browser output are verified directly without claiming equivalent Notion states. | Same artifacts as DE-013-01/02; DOM snapshot, console review, and responsive metrics recorded during the same browser session. | Pass — no console warnings/errors, no horizontal page overflow, explicit labels/landmarks/progressbar/alert/status semantics, 2026-07-13. |

## Fidelity ledger

| Comparison point | Fallback evidence | 2Brain result |
|---|---|---|
| Modal container and backdrop | U-03 | Large centered dark Settings dialog over a dimmed shell; two-pane desktop structure retained. |
| Navigation and selection | U-03 | Low-contrast selected row, grouped Settings destinations, restrained borders, and independent scrolling retained. |
| Form hierarchy and controls | U-09/U-10 | Code-native labeled fields, described cadence select, default-on checkbox, and one blue primary action. |
| Loading and progress | U-11 | Stable loading box/spinner plus a non-jumping progress track and semantic progressbar. |
| Cancellation and recovery | U-08 | Secondary outlined action with API-gated safety; safe error and request ID remain inspectable. |
| Responsive behavior | Operator-approved direct verification | One-column 390px content, horizontally scrollable Settings destinations, no page clipping, and full-height dialog. |

No proprietary Notion asset, logo, or trademark is shipped. System typography and
code-native controls are used. The material differences are the documented
2Brain domain semantics above; no unresolved visual mismatch remains within the
approved fallback scope.

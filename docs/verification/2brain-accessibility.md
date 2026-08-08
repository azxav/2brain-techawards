# 2Brain v1 accessibility report

Executed on 2026-07-14 as part of the primary browser journey. Verdict:
**pass** — zero WCAG violations across fourteen audited states.

## Method

axe-core runs inside the real browser against the live authenticated document,
configured for `wcag2a`, `wcag2aa`, `wcag21aa`, and `wcag22aa`. Any violation
fails the journey; the thresholds are not negotiable and were not relaxed. Raw
results are in [browser/browser-evidence.json](browser/browser-evidence.json)
under `accessibility`.

## Audited states

| Route | Violations |
| --- | --- |
| `/app` desktop | 0 |
| `/app` Member access-required | 0 |
| `/app/knowledge` Page detail | 0 |
| `/app/search` results | 0 |
| `/app/ask` answered | 0 |
| `/app/ask` refused (evidence gap) | 0 |
| `/app/attention` assigned | 0 |
| `/app/agents` registered | 0 |
| `/app/settings/export` completed | 0 |
| `/app` desktop System | 0 |
| `/app` desktop Light | 0 |
| `/app` desktop Dark | 0 |
| `/app/knowledge` tablet 768×1024 | 0 |
| `/app/notifications` mobile dark reduced-motion | 0 |

States are audited when they carry real content — an answered Ask, a refused
Ask, an assigned Attention Item, a completed export — rather than in their empty
form, because an empty surface has little to violate.

## Appearance and viewports

Appearance defaults to System and offers Light and Dark, so `/app` is audited
under all three (`prefers-color-scheme: no-preference`, `light`, and `dark`).
Layout is audited at desktop (1440×900), tablet (768×1024), and mobile
(390×844); the tablet and mobile documents are additionally asserted to have no
horizontal overflow (`clientWidth === scrollWidth`).

## Defects this report found and closed

These audits found genuine contrast failures, which were fixed rather than
waived:

- Muted text `#777672` on `#f7f7f5` measured 4.23:1, below the 4.5:1 minimum for
  body text. It is now `#72716d`.
- White 13px button text on the shared accent `#2383e2` measured 3.87:1. The
  accent is now `#1f73c4` (4.88:1 against white), which also keeps 3.34:1 focus
  contrast against the dark `#202020` surface.

Both tokens are asserted in `test/workspace-source-provisioning.test.ts` so a
regression fails a unit test rather than waiting for the next release audit.

## Non-axe coverage

Automated rules cannot see everything, so the journey also asserts behaviour
that WCAG requires but axe cannot detect:

- Keyboard operation: Settings takes initial focus on `Close Settings`, and
  Escape closes Settings and returns to the Workspace.
- Reduced motion is emulated (`prefers-reduced-motion: reduce`) for the mobile
  audit.
- Assistive-technology announcements rely on live regions (`role="status"`,
  `aria-live`, `aria-atomic`, `aria-busy`) and on the `role="tablist"` /
  `aria-selected` Source lifecycle tabs, which are asserted in the workspace unit
  suites rather than by axe.

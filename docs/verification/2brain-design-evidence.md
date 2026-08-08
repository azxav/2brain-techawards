# 2Brain v1 Design Evidence ledger

Compiled on 2026-07-14. Verdict: **pass** for every surface shipped in v1.

ADR-0026 and ADR-0040 require that no screen, component, state, token, motion,
or responsive choice ships without a completed Design Evidence Entry backed by
official Notion material. This ledger is the index of those entries. It does not
restate them, and it does not upgrade any entry's status.

## Authority

`docs/designs/2brain-notion-evidence-matrix.md` is the baseline matrix, dated
2026-07-10. It marks a surface `Covered`, `Partial`, or `Capture required`. A
`Capture required` row is a commitment: the issue that introduces that state must
supply the targeted reference capture before it ships. The rows below record
where each of those captures was actually made.

## Entries

| Surface | Design Evidence Entry |
| --- | --- |
| Knowledge and Saved Views | `docs/designs/2brain-issue-17-evidence.md` |
| Page detail, provenance, history, and Evidence Status | `docs/designs/2brain-issue-18-evidence.md` |
| Search and reauthorized internal links | `docs/designs/2brain-issue-19-evidence.md` |
| Permanent deletion of an Archived Source | `docs/designs/2brain-issue-20-evidence.md` |
| Structured Agent Activity | `docs/designs/2brain-issue-22-evidence.md` |
| Source-health Attention | `docs/designs/2brain-issue-24-evidence.md` |
| Knowledge, Agent, and Automation Attention | `docs/designs/2brain-issue-25-evidence.md` |
| Non-jumping live updates and connection loss | `docs/designs/2brain-issue-26-evidence.md` |
| Personal Notifications | `docs/designs/2brain-issue-27-evidence.md` |
| Workspace Home trust summary | `docs/designs/2brain-issue-28-evidence.md` |
| Ask 2Brain: question, progress, cited answer, refusal | `docs/designs/2brain-issue-29-evidence.md` |
| Temporary Ask Result lifecycle | `docs/designs/2brain-issue-30-evidence.md` |
| Operator-approved fallbacks | `docs/designs/2brain-issue-13-fallback-evidence.md`, `docs/designs/2brain-issue-15-fallback-evidence.md` |

Each entry names its official Notion references, the same-viewport comparison it
rests on, and any permitted deviation (WCAG 2.2 AA, security or authorization
clarity, or accurate 2Brain product meaning) with the conflict stated.

## Honest bounds

The baseline matrix still lists rows as `Capture required`. That status is not
overridden here. For every such surface that v1 actually ships, the capture was
made in the per-issue entry named above, and that entry — not the baseline row —
is the current evidence. Rows describing surfaces v1 does not ship (for example
internal Page sharing, which ADR-0031 restricts, and the retired administrative
health/request log surface, removed in issue #33) remain uncaptured because there
is nothing shipped to compare. No such row is cited as passing evidence by this
release.

## Rendered states

The Experience gate does not rest on this ledger alone. The primary browser
journey renders these surfaces with real content and audits fourteen states
against WCAG 2.2 AA: `/app` under System, Light, and Dark; desktop (1440×900),
tablet (768×1024), and mobile (390×844, reduced motion); and each populated
product surface — see [2brain-accessibility.md](2brain-accessibility.md) and
[2brain-browser-journey.md](2brain-browser-journey.md). Visual tokens
(`--muted`, `--accent`, `--danger`, `--state-current`) are asserted in
`test/workspace-source-provisioning.test.ts`, so a token drifting away from its
evidenced value fails a test.

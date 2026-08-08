---
status: accepted
date: 2026-08-05
---

# Use one active Brain Source catalog for every Workspace projection

## Context

The core `sources` table owns Page Source identity and seeds the built-in
`default` Source. `workspace_sources` is narrower: it stores control metadata
for HTTPS Managed Git Sources created through the Workspace. Knowledge, Search,
Ask, Page detail, Agent Activity, live updates, Home, Attention, setup state,
and export incorrectly treated that narrower table as the complete Source
catalog.

This caused a real Agent write to disappear from the Workspace. OpenClaw called
`put_page` with `source_id: default`; GBrain returned `created_or_updated`, but
the Workspace Knowledge query inner-joined `workspace_sources`, where no
`default` row exists. The Page was durable and queryable through MCP but absent
from the product UI, direct Workspace links, live updates, and export.

## Decision

One deployment still hosts one Workspace and one Brain (ADR-0035). Therefore
every active core Brain Source belongs to that Workspace's readable Source
catalog; `workspace_sources` remains optional management metadata, not the
catalog itself.

Introduce one deep Workspace Source catalog module. Its interface projects each
core Source with optional Managed Git metadata and owns these rules:

- A Source is active only when the core Source is not archived and, when
  Managed Git metadata exists, that metadata is neither archived nor deleted.
- `default` is presented as **Workspace Knowledge**, with kind `built_in` and
  Source Freshness **Not applicable**.
- Other core-only Sources are presented with kind `unmanaged` and their core
  Source name. They also have Source Freshness **Not applicable**.
- Sources with Workspace management metadata retain kind `managed_git`, their
  configured inclusion flag, verification evidence, cadence, and lifecycle.
- The built-in and unmanaged rows are visible in Settings but read-only there:
  no Git, synchronization, archive, restore, or permanent-delete controls.
- Managed Git creation remains the only remote Workspace Source-creation path.
  No filesystem path or generic core Source mutation is added to the browser.

Every Knowledge-facing module consumes this catalog before applying the
caller's current Source Access. **All Sources** means every current and future
active catalog Source. **Specific Sources** intersects explicit grants with the
current active catalog. **No Source Access** remains empty. Missing policy,
unknown Source, archived Source, and deleted Source all fail closed. Direct Page
and Page Version requests remain undisclosed not-found responses when denied.

The resulting behavior is uniform:

- Knowledge lists every authorized active Page, regardless of Source kind.
- Search and Ask can use authorized catalog Sources. Workspace search inclusion
  still controls default Search eligibility; explicit Source selection bypasses
  inclusion but never Source Access. The built-in `default` Source retains its
  existing federated/default-search inclusion.
- Saved Views store filters, never authority, and re-evaluate the current
  catalog and Source Access when opened.
- Agent writes validate and retain their real Source attribution even for
  built-in or unmanaged Sources. Successful Page writes emit a Workspace Change
  Event that projects as a Knowledge live update.
- An open Knowledge view applies authorized Page-write updates automatically;
  access changes still force a full authorization refresh.
- Home, Attention, notifications, setup/member empty states, and Page links use
  the same catalog. A durable active core Page is Knowledge even when no Managed
  Git Source has synchronized; Git-specific Administrator checklist steps stay
  Git-specific.
- Workspace Export includes Pages, Page Versions, and non-secret Source metadata
  from every catalog Source. Raw OpenClaw files, channel uploads, conversations,
  browser state, and credentials remain excluded unless separately persisted
  through a supported GBrain attachment surface.
- Existing hidden Pages become visible through projection changes; no Page copy,
  rewrite, or Source migration is required.

PGLite and PostgreSQL must implement the same catalog behavior. Tests observe
the Workspace HTTP and MCP seams: built-in, unmanaged, managed, archived,
All/Specific/None, detail/history, Search/Ask, saved-view reauthorization,
Activity attribution, live updates, Home/Attention, setup state, Settings, and
secret-free export.

## Alternatives rejected

**Special-case `default` in every query.** Rejected because the same defect
already spans many callers and would recur for any other core-only Source.

**Insert a synthetic `workspace_sources` row for `default`.** Rejected because
that schema requires Managed Git concepts such as remote URL, cadence,
verification, and provisioning state. Fake values would make UI and lifecycle
claims false and would still omit other core-only Sources.

**Require Agents to write only to Managed Git Sources.** Rejected because
`put_page` already supports durable database-only Pages, the built-in Source is
part of the Brain model, and transport choice must not determine product
visibility.

## Relationship to earlier decisions

This ADR clarifies ADR-0007, ADR-0013, ADR-0016, ADR-0017, ADR-0025, and
ADR-0042. It does not weaken Source Access, add browser Source creation beyond
Managed Git, change archive semantics, or include private OpenClaw state in
Workspace Export.

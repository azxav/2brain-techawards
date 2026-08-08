# 2Brain v1 primary acceptance journey

Executed on 2026-07-14. Verdict: **pass** (20 of 20 checks).

The journey drives Microsoft Edge through Playwright against the production HTTP
and authentication boundary, a real Postgres database, and an always-on worker.
Every product interaction and every product assertion goes through the browser
and the real HTTP boundary — no in-process calls, no seeded sessions, no
authorization bypassed for convenience. The machine-readable report and its
screenshots are committed under [browser/](browser/browser-evidence.json).

## What the harness supplies, and what that costs

The harness is honest about being a harness. Three things are not the product,
and no evidence here claims otherwise:

- **Test-only endpoints.** `/__release/token` returns the email token that
  production would deliver by email, `/__release/seed` inserts the Knowledge
  fixture a synchronized Source would otherwise contain, and
  `/__release/status/:kind` reads the database so the journey can *wait* for the
  worker. These are used to deliver fixtures and to synchronize on worker
  progress — never to assert a product outcome that the UI itself should show.
- **Stubbed Source executors.** Provisioning and maintenance executors are
  stubs, so no real git clone or fetch happens. The journey therefore verifies
  Source *onboarding* — the request, the durable Background Operation, and the
  always-on worker driving it to `completed` — but **not** git synchronization
  itself. Synchronization is covered by `workspace-source-synchronization` and by
  Postgres parity (*keeps Source maintenance evidence and projections in Postgres
  parity*), and this journey does not claim to re-verify it.
- **A fixture Ask synthesizer.** The real product refuses to ship an unsupported
  claim, and that is precisely what is tested: the fixture synthesizer is asked
  for an answer no retrieved Page supports, and the journey asserts the product
  refuses it (`ask_refusal_on_unsupported_claim`).

## How to reproduce

```bash
docker run -d --name gbrain-release -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=gbrain -p 55530:5432 pgvector/pgvector:pg16
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55530/gbrain' \
BROWSER_EXECUTABLE='…/msedge.exe' \
WORKSPACE_RELEASE_EVIDENCE_DIR='docs/verification/browser' \
  bun run verify:workspace-browser
docker rm -f gbrain-release
```

The harness creates its own isolated database, applies the 116 production
migrations, mounts the real workspace router, starts an always-on worker, and
spawns the browser client.

## Checks

| Check | Covers |
| --- | --- |
| `first_administrator_setup` | Bootstrap link, Workspace naming, email confirmation, first Administrator |
| `production_http_auth_boundary` | Unauthenticated read and mutation are refused with 401; a session without the CSRF header is refused with 403; the session cookie is `httpOnly`, `secure`, `SameSite=Lax` |
| `always_on_worker` | A queued Background Operation only ever reaches `completed` via the separate always-on worker process |
| `member_invitation` | Email-bound single-use invitation with independent role and Source Access |
| `member_login` | Log out, request a login link, redeem it |
| `source_onboarding_worker` | Managed Git Source connected, queued, and driven to `completed` by the worker (onboarding, not git sync — see above) |
| `zero_source_access_explanation` | No Source Access renders `Access required`, not an empty Brain |
| `current_and_future_source_access` | All Sources includes Sources connected after the grant |
| `knowledge_and_page_inspection` | Knowledge list, Evidence filters, Page detail and provenance |
| `deterministic_search` | Real queries return authorized Pages with Evidence Status |
| `ask_answer_and_citation` | Single-question Ask returns an extractively supported cited answer |
| `ask_refusal_on_unsupported_claim` | An answer no retrieved Page supports is refused with an evidence gap, and its text never reaches the page |
| `attention_and_notifications` | Attention assignment and the personal Notification surface |
| `agent_registration_and_directory` | Agent registration, one-time credential reveal, Directory |
| `export_completion` | Workspace Export queued, completed by the worker, retrievable |
| `role_alone_grants_no_source_access` | An Administrator with No Source Access is refused the Source lifecycle |
| `administrator_source_access_grant` | The Administrator grants itself All Sources through the Members surface |
| `archive_and_deletion` | Archive, then typed-confirmation permanent deletion executed by the worker |
| `system_light_and_dark` | `/app` audited under System, Light, and Dark |
| `tablet_layout` | 768×1024 with no horizontal overflow |
| `mobile_dark_reduced_motion` | 390×844 dark reduced-motion with no horizontal overflow |
| `keyboard_escape` | Escape closes Settings and returns to the Workspace |
| `console_health` | Zero browser console errors across the whole journey |

## Two findings this journey produced

`role_alone_grants_no_source_access` exists because the journey originally
assumed an Administrator could archive a Source. It cannot: Source Access is
evaluated independently of the Workspace role (ADR-0042 and the Source Access
matrices), and the first Administrator holds No Source Access until it is
granted. The refusal is now asserted as a security property before the grant is
made, so the journey proves deny-by-default instead of tripping over it.

`console_health` failed on first execution and surfaced two real product
defects, both fixed in this ticket:

- The Source ID field's `pattern` attribute was invalid under the `v` flag that
  browsers compile pattern attributes with (an unescaped `-` after a range), so
  client-side validation silently never applied.
- No favicon was served, so every document 404'd on `/favicon.ico`.

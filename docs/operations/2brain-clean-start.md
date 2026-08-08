# 2Brain clean-start deployment foundation

This foundation creates a new 2Brain control-plane database. It does not run
the legacy GBrain schema initializer and therefore does not import or project
legacy Sources, Pages, Agents, credentials, settings, sessions, or logs. In
particular, the legacy compatibility `default` Source is not present.

## Initialize a production database

Create a new, empty Postgres database and point the deployment at it. Never
reuse the database URL or volume of a legacy GBrain deployment.

```bash
export TWO_BRAIN_DATABASE_URL='postgres://…/two_brain'
bun src/workspace/runtime.ts worker --once
```

The command is retry-safe. It creates only `workspace_deployments` and
`workspace_runtime_heartbeats`; the first-Administrator flow creates the
actual Workspace in the next slice.

## Process topology

Production runs Postgres plus two independently supervised processes:

```bash
TWO_BRAIN_DATABASE_URL='postgres://…/two_brain' bun src/workspace/runtime.ts worker
TWO_BRAIN_DATABASE_URL='postgres://…/two_brain' bun src/workspace/runtime.ts scheduler
```

Both processes record a database heartbeat and can be started before any
browser-facing Workspace server exists. This foundation does not claim to
process product jobs yet; later slices attach durable operations to these
processes. PGLite is supported for local development and tests only:

```bash
bun src/workspace/runtime.ts worker --once --pglite .tmp/2brain.pglite
```

Do not deploy PGLite as shared production storage. Its file lock cannot safely
support the independent worker and scheduler processes.

## Email delivery for magic links

`gbrain serve --http` sends first-Administrator confirmation, login, and
invitation magic links by email when the operator supplies the full email
environment. All three variables are required together; when any is absent,
behavior is unchanged and delivery stays on the operator outbox routes
(`/api/workspace/v1/operator/outbox`).

| Variable | Meaning |
|---|---|
| `GBRAIN_EMAIL_RESEND_API_KEY` | Resend API key used for the HTTP send. |
| `GBRAIN_EMAIL_FROM` | From-address, e.g. `2Brain <no-reply@workspace.example.test>`. Must be a Resend-verified sender domain. |
| `GBRAIN_WORKSPACE_BASE_URL` | Public origin the magic links point at, e.g. `https://team.example.test`. |

Cookie behavior is likewise deliberate rather than inferred:

| Variable | Meaning |
|---|---|
| `GBRAIN_WORKSPACE_TOKEN_SECRET` | Secret for deriving confirmation delivery tokens. Required for setup and login flows. |
| `GBRAIN_WORKSPACE_PRODUCTION` | Set `1`/`true` to force `Secure` session cookies (or `0`/`false` to disable). Unset falls back to `NODE_ENV === 'production'`. |

A confirmation or login delivery failure marks the outbox row `failed`; the
operator can inspect and retry it through the outbox routes with the bootstrap
credential. Invitation delivery failures surface directly to the inviting
Administrator, who re-sends the invitation from Settings.

## Rollback and recovery

Before cutover, record two immutable deployment values in the operator's
deployment system: the previous release image/digest and the previous
deployment's database connection reference. Keep the new 2Brain database and
its volume separate from that legacy database.

To roll back the application, point the router at the recorded previous image
and reconnect it to its original database. Do not point the previous release
at the new 2Brain database, and do not attempt to transform new Workspace data
back into legacy tables. Preserve the new database for inspection, then retry
the 2Brain deployment from its clean-start procedure once the incident is
understood.

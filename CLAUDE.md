# 2Brain contributor orientation

2Brain is a shared knowledge and agent workspace platform. The public product name is 2Brain; the `gbrain` CLI, package, environment variables, database identifiers, and API contracts remain for compatibility.

## Trust model

- `OperationContext.remote === false` is the only trusted local case.
- HTTP, MCP, connected apps, and agent runtimes are untrusted callers.
- No Source Access grant means no Source access.
- Agent workspaces receive no root, Docker socket, direct PostgreSQL access, platform credentials, or trusted local CLI.
- One deployment hosts one Workspace and one Brain; runtime tier is not tenancy.

## Code map

- `src/core/operations.ts`: shared operation contracts.
- `src/core/engine.ts` and engine implementations: storage abstraction.
- `src/workspace/`: workspace identity, access, activity, retention, and agent runtime.
- `src/commands/`: CLI and service entry points.
- `cloud/`: control-plane and workspace image contracts.
- `test/` and `cloud/test/`: behavioral and infrastructure tests.

Read `docs/architecture/KEY_FILES.md` before changing source code and `docs/TESTING.md` before running or changing tests.

## Verification

```bash
bun install --frozen-lockfile
bun run verify
bun run test:full
```

Use generic public fixtures. Do not publish credentials, customer data, private deployment details, internal plans, or private issue references.

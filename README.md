# 2Brain

2Brain is a secure knowledge and agent workspace platform. It turns distributed notes, documents, conversations, and connected sources into a shared, searchable brain that people and AI agents can use with explicit access controls.

This repository is the public incubation edition of the project. The command-line package and configuration keys remain named `gbrain` for compatibility.

## Problem

Teams lose important context across documents, chat, email, meetings, and individual tools. Traditional search returns fragments; AI assistants often lack durable memory, source provenance, and reliable permission boundaries.

## Solution

2Brain combines hybrid retrieval, a typed knowledge graph, synthesis with citations, and workspace-level access controls. It supports local-first personal use and shared company workspaces without giving agent-facing callers trusted infrastructure access.

## Core capabilities

- Hybrid keyword and vector retrieval with reranking
- Synthesized answers with citations and gap analysis
- Typed pages, links, timelines, and schema packs
- Markdown, file, webhook, and connected-source ingestion
- Embedded PGLite for local use; Postgres with pgvector for scale
- MCP and CLI interfaces for AI agents and developers
- Shared workspaces with role, OAuth scope, and Source Access enforcement
- Background sync, enrichment, maintenance, and durable agent jobs
- Export, retention, audit, and operational health tooling

## Architecture

```text
Sources -> ingestion/sync -> PGLite or Postgres -> retrieval + graph
                                              -> synthesis
CLI / MCP / web workspace -> scoped operations -> answers and writes
worker / scheduler        -> durable maintenance and agent jobs
```

The operation contract is shared across CLI and MCP surfaces. Remote callers are untrusted by default. Source-scoped reads fail closed when no grant exists, and agent workspaces receive no root access, Docker socket, direct database access, platform credentials, or trusted local CLI.

## Quick start

Requirements: [Bun](https://bun.sh/) and Git.

```bash
git clone https://github.com/azxav/2brain-techawards.git
cd 2brain-techawards
bun install --frozen-lockfile
bun run src/cli.ts init --pglite
bun run src/cli.ts doctor
```

Import Markdown and query it:

```bash
bun run src/cli.ts import ./notes
bun run src/cli.ts search "what decisions are still open?"
bun run src/cli.ts think "summarize the project risks with sources"
```

Run the local MCP server:

```bash
bun run src/cli.ts serve
```

For Postgres, hosted MCP, and production options, see [installation](docs/INSTALL.md), [engine choices](docs/ENGINES.md), and [deployment](docs/mcp/DEPLOY.md).

## Development

```bash
bun install --frozen-lockfile
bun run verify
bun run test:full
```

The full suite includes static privacy checks, generated-document freshness, type checking, unit tests, slow tests, and database-backed E2E tests when `DATABASE_URL` is configured. See [testing](docs/TESTING.md) and [contributing](CONTRIBUTING.md).

## Security and privacy

- Public fixtures use fabricated identities.
- Secrets and private source data must never be committed.
- OAuth scopes and Source Access grants constrain remote reads and writes.
- Trusted-local behavior requires `OperationContext.remote === false`.
- Security reports follow the process in [SECURITY.md](SECURITY.md).

## Project status

2Brain is an actively developed incubation-stage product. The repository contains working source, migrations, tests, deployment contracts, examples, and CI. Compatibility-sensitive `gbrain` names are intentionally retained while the public product identity is 2Brain.

## Documentation

- [Installation](docs/INSTALL.md)
- [Testing](docs/TESTING.md)
- [Architecture index](docs/architecture/KEY_FILES.md)
- [MCP integration](docs/mcp/)
- [Schema packs](docs/architecture/schema-packs.md)
- [Agent documentation map](llms.txt)

## License

MIT. See [LICENSE](LICENSE). The required copyright notice is retained from the licensed source snapshot.

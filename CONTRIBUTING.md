# Contributing to 2Brain

## Setup

```bash
git clone https://github.com/azxav/2brain-techawards.git
cd 2brain-techawards
bun install --frozen-lockfile
bun run verify
```

Requirements: Bun, Git, and Bash. Database-backed E2E tests additionally require Postgres with pgvector and `DATABASE_URL`.

## Workflow

1. Read `AGENTS.md` and the relevant entry in `docs/architecture/KEY_FILES.md`.
2. Keep compatibility-sensitive `gbrain` interfaces stable unless the change explicitly migrates them.
3. Add focused tests for behavior changes.
4. Use fabricated identities and data in fixtures and examples.
5. Run `bun run verify`; run `bun run test:full` before substantial submissions.
6. Describe behavior and verification clearly in the pull request.

## Tests

```bash
bun test test/path-to-test.test.ts
bun run verify
bun run test:full
```

See `docs/TESTING.md` for test tiers, isolation rules, and E2E setup.

## Security and privacy

Never commit credentials, private source data, customer identities, internal plans, or private issue links. Report vulnerabilities through `SECURITY.md`.

## License

Contributions are accepted under the repository's MIT license.

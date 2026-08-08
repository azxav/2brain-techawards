# Working on 2Brain

Start with `README.md`, then load only the detail needed for the task.

## Read on demand

1. `CLAUDE.md` — architecture and trust boundaries.
2. `CONTEXT.md` — product vocabulary.
3. `skills/RESOLVER.md` — skill routing.
4. `docs/architecture/KEY_FILES.md` — required before editing `src/`.
5. `docs/TESTING.md` — required before testing.
6. `CONTRIBUTING.md` and `SECURITY.md` — public contribution rules.

## Engineering rules

- Preserve unrelated work and compatibility-sensitive `gbrain` interfaces.
- Treat remote and agent-facing callers as untrusted.
- Trusted local behavior requires `OperationContext.remote === false`.
- Source Access fails closed; use the existing source-scope helpers.
- Use fabricated identities in public fixtures and documentation.
- Never commit credentials, private data, internal plans, or private issue links.
- Run `bun run verify` before proposing a change; use `bun run test:full` for complete local verification.

## Licensing

Keep `LICENSE` intact in every copy or substantial derivative.

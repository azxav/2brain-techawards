# General engineering guidance

- Keep modules narrow and preserve existing public contracts.
- Read `docs/architecture/KEY_FILES.md` before changing source code.
- Add focused tests for behavior changes and run `bun run verify`.
- Treat every remote or agent-facing caller as untrusted.
- Fail closed at authorization and Source Access boundaries.
- Keep secrets, customer data, internal plans, and private infrastructure details out of public artifacts.
- Use fabricated people, organizations, funds, domains, tokens, and repositories in examples and fixtures.
- Describe security improvements functionally without publishing exploitable operational detail.
- Keep release history in `CHANGELOG.md`, not architecture or agent-orientation files.

# Security

## Reporting a vulnerability

Report suspected vulnerabilities privately through a [GitHub security advisory](https://github.com/azxav/2brain-techawards/security/advisories/new). Do not open a public issue or include live credentials, customer data, or exploit details in public artifacts.

Include the affected component, impact, safe reproduction outline, and suggested mitigation when available. Maintainers will acknowledge the report, validate it, coordinate a fix, and publish an appropriate advisory after remediation.

## Security model

- Remote, HTTP, MCP, connected-app, and agent-facing callers are untrusted.
- Trusted-local behavior requires `OperationContext.remote === false`.
- Source Access is deny by default and fails closed.
- Tokens are scope-limited and stored as hashes where supported.
- Public network deployment requires TLS, explicit origin/proxy configuration, rate limits, and protected client registration.
- Agent runtimes receive no root, Docker socket, direct database access, platform credentials, or trusted local CLI.

Operational hardening guidance lives in the deployment documentation. Keep credentials in environment or secret-management systems, never in Git.

# 2Brain vocabulary

- **2Brain**: the public product and repository identity.
- **gbrain**: retained compatibility name for the CLI, package, configuration, and database interfaces.
- **Brain**: durable knowledge store containing pages, links, facts, sources, and retrieval state.
- **Workspace**: the user-facing collaboration boundary hosted by one deployment.
- **Source**: an independently authorized collection of knowledge.
- **Source Access**: deny-by-default policy granting a principal access to specific Sources.
- **Operation**: contract shared by CLI and MCP surfaces.
- **Remote caller**: any caller not explicitly marked with `remote === false`.
- **Agent Workspace**: a workspace deployment with an untrusted agent runtime profile.
- **Worker**: durable background operation executor.
- **Scheduler**: recurring operation dispatcher.
- **PGLite**: embedded Postgres-compatible local engine.
- **Postgres**: scalable production engine, optionally with pgvector.

One deployment maps to one Workspace and one Brain. Source grants control visibility inside that Brain; agent tier changes runtime capability, not tenancy.

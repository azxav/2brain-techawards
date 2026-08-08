# Use Postgres for the shared production Workspace

2Brain's shared production deployment uses Postgres with an always-on worker/scheduler. The approved organizational scale, concurrent Members and Agents, durable Background Operations, retention, and immutable event requirements exceed the safe single-process PGLite topology. PGLite remains supported for local CLI use, development, isolated tests, and schema parity, but it is not the v1 multi-Member production datastore.

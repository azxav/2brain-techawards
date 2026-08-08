# Customers reach OpenClaw by GBrain session or one shared native password

Status: Accepted.

The #68 customer-access contract supersedes #45's token-only ingress wording.
Browser access uses an active GBrain session translated to OpenClaw
trusted-proxy identity. Native apps and CLIs use one per-Workspace shared
OpenClaw password. Every active, current-warning-confirmed Member may retrieve
that password after readiness. Administrators may rotate it manually, and an
active-to-disabled Member transition rotates it automatically. The independent
GBrain Agent credential and every #45 isolation boundary remain unchanged.

Two surfaces implement this. The Workspace agent HTTPS path carries browser
identity: Caddy authenticates the request against the existing GBrain session
before proxying, and OpenClaw accepts the resulting trusted-proxy identity, so a
browser user never sees or handles an OpenClaw secret. The separate native client
path carries no browser identity and authenticates with the shared password
alone. The password is derived, never stored in plaintext, from the immutable
deployment secret `GBRAIN_WORKSPACE_TOKEN_SECRET` plus the workspace ID plus a
generation counter, so rotation is a counter increment and the control plane
still retains no customer-facing OpenClaw secret.

We reject keeping a second customer-facing Gateway token alongside the shared
password. Two simultaneous shared credentials would complicate rotation — every
rotation event would have to fan out across both — and would leave an avoidable
stale-access path, because a revoked or disabled Member could retain the credential
that was not rotated. One shared native credential means one rotation surface and
one revocation story.

Disclosure is deliberately Member-wide rather than first-Administrator-only.
Sharing the password grants Full Shared Agent Access, which may exceed the
retrieving Member's own GBrain permissions, so retrieval is gated on an explicit
confirmation of the current shared-state warning revision
(`openclaw-shared-state-v1`) rather than on role.

Nothing here relaxes workspace security model's isolation decisions. The GBrain Agent credential
remains independently rotatable and revocable, the pinned runtime keeps its
dedicated unprivileged identity and isolated state, execution and egress still
fail closed, and Platform Credentials remain unreadable by the Native OpenClaw
Runtime.

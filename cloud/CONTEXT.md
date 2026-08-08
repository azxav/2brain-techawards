# 2Brain Cloud — context glossary

Vocabulary for the control-plane codebase (`cloud/`). This is a separate bounded
context from the gbrain Workspace runtime; where a word appears in both, the
root [`CONTEXT.md`](../CONTEXT.md) meaning applies inside `src/` and this one
applies inside `cloud/`.

| Term | Meaning |
|---|---|
| **Control plane** | The single fleet/provisioning application (this codebase): dashboard identity, invite gating, registry, provisioning reconciler. Runs once, on its own VM. Never part of any workspace's runtime. |
| **Workspace (deployment)** | One customer's isolated 2Brain: one VM, one Postgres, one Brain (ADR-0035). What the control plane multiplies. "Deployment" used alone means this — never the act of installing the control plane. |
| **Fleet** | The set of workspace VMs the control plane manages. The fleet cap (`CP_FLEET_CAP`) bounds it. The control-plane VM is *not* a fleet member, though it lives in the same compartment. |
| **Fleet compartment** | The dedicated OCI compartment holding the fleet **and** the control-plane VM. Scopes the control plane's IAM grants. |
| **Registry** | The control plane's own Postgres — the source of truth for fleet state (subdomain, instance OCID, lifecycle, sealed credentials, tier). The one dataset in the pilot with backups: workspace data has GitHub as its durable copy; the registry has none. |
| **Operator** | The human running the platform. Bootstrapped by `CP_OPERATOR_GITHUB_IDS`; issues invites; holds the escrow. |
| **Escrow** | The operator's off-VM copy of the control plane's secrets (sealing key, OAuth secret, API tokens, OCI key) in a password manager. Without the sealing key, registry backups are unreadable ciphertext — the escrow is what makes a dead control-plane VM recoverable. |
| **Deploy (control plane)** | The act of installing or updating the control plane on its VM via `cloud/deploy/`. Deliberately *not* called bootstrap (claimed by the per-workspace bootstrap credential and the operator claim flow), setup (claimed by the first-Administrator flow), or provisioning (claimed by the workspace state machine). |
| **Bootstrap credential** | Per-workspace high-entropy credential the control plane holds sealed in the registry; authenticates the HTTPS management lane (`Bootstrap` auth scheme) on that workspace. |
| **Management lanes** | The two-lane design from #35: HTTPS + bootstrap credential for product operations; SSH (NSG-restricted to the control-plane reserved IP) for machine operations. |
| **Reconciler** | The leased, database-backed loop that advances provisioning one step per tick. The registry row is the state; a killed control plane resumes from it. |

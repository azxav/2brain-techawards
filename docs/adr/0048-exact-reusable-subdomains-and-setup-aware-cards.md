# Use exact reusable subdomains and setup-aware control-plane cards

Status: Accepted.

The control plane keeps the existing per-Workspace subdomain architecture. A
Workspace hostname is derived from its display name through the existing
normalization rule; users do not choose a separate hostname. The creation form
shows the exact normalized hostname and checks availability immediately through
an authenticated, rate-limited endpoint. That endpoint returns only the
normalized hostname and `available`, `unavailable`, or `invalid`.

Creation claims only the exact derived hostname. The control plane never appends
numeric or random suffixes. The create transaction remains authoritative: a
concurrent claim returns `409 subdomain_unavailable`, even when an earlier
availability check said the hostname was free. No additional reserved-label list
is introduced.

Deleted and failed Workspace rows remain as audit history. A new nullable
`subdomain_released_at` records when a hostname stops being reserved, and
uniqueness applies only to rows whose hostname has not been released. Deletion
releases the hostname only after DNS removal, VM termination, credential
revocation, and the transition to `deleted` have all completed. A failed
provision releases it only after cleanup proves no VM, DNS record, or credential
residue remains. Partial cleanup keeps the hostname reserved. Any lookup used for
live routing or provisioning must ignore released historical rows.

The control plane also becomes aware of first-Administrator setup completion.
The Workspace exposes a minimal operator status response, authenticated through
the existing bootstrap management lane, containing only the exact setup-complete
state and completion timestamp. The control plane checks incomplete running
Workspaces every ten seconds; opening the dashboard triggers an immediate check
and updates the card without a full-page reload. Timeouts, redirects, generic
health responses, `401`, and other ambiguous outcomes never imply completion.

Setup links are sealed at rest with the existing control-plane sealing key. Until
an authenticated exact-positive setup response arrives, the card continues to
show **Open setup link**. On positive confirmation the control plane atomically
stores `setup_completed_at`, erases the sealed setup link, and renders **Enter
Workspace** linking to `https://<subdomain>/app`.

This decision refines ADR-0037 and the existing persistent provisioning state
machine. It does not change Workspace DNS topology, TLS, VM ingress, deployment
tier behavior, one-Workspace-per-deployment, or any Agent Workspace trust or
isolation boundary.

Behavioral tests must cover normalization and immediate feedback, concurrent
claims, exact `409` refusal, absence of generated suffixes, pending versus
completed deletion, clean versus residual failed provisioning, historical-row
retention, sealed-link storage and erasure, exact-positive setup detection,
polling failure, and the **Open setup link** to **Enter Workspace** transition.

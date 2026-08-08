```yaml
status: fail
subject_commit_sha: d2cdca5bd52b0b2748e8a4967cf4621afb006487
verified_at: 2026-08-04T13:45:00Z
```

# Agent pilot — VM isolation

Verdict: **fail**, by omission. The network-isolation proof was not run. This
file exists so that absence is recorded as a deliberate, dated gap rather than
being discovered later and quietly resolved as `n/a`.

## Status of each artifact the release manifest names

| Manifest key | Status | Note |
|---|---|---|
| `network_isolation` | **NOT PROVEN** | The seven denial categories were not executed. |
| `public_loopback_dependencies` | **NOT PROVEN** | Not executed. |
| `vm_updates` | **NOT PROVEN** | Not executed. |

None of these may be recorded as `pass`. None of them may be recorded as `n/a`:
they are in scope for the pilot and they are unexecuted, which is a different
thing from inapplicable.

## Why

An explicit scope decision was taken during plan Task 14: reach a working
functional path before building guards. Functional proof was the binding
constraint — the agent tier had never once run end to end, and three separate
image defects had to be fixed before it did. The isolation work was deferred
behind that, knowingly.

## The finding that makes this more than a paperwork gap

From inside the OpenClaw process on a real agent VM, the instance metadata
endpoint returns HTTP 200 and yields the workspace bootstrap credential, the
workspace token secret, the database URL including its password, and the
provisioned model key. The unit's filesystem masking of `/etc/gbrain` is
therefore decorative — the same secrets are one HTTP call away.

This defeats the `#45` "no administration escape hatch" decision outright. It is
tracked as issue `#61`, which is open. `gbrain-agent` shares the host network
namespace, so any fix is a firewall keyed on UID, not a network namespace.

## Consequence

`docs/verification/agent-pilot-release.json` cannot be produced from the evidence
that exists. Customer access to Agent Workspaces stays disabled. Internal and
operator testing on disposable VMs remains allowed, and is what the live pilot
deployment is currently operating under.

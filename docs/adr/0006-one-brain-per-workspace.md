---
status: superseded by ADR-0035
---

# Map each Workspace to one Brain in v1

Each 2Brain Workspace exposes exactly one Brain, and the Workspace switcher changes which Brain is active; Sources remain distinct repositories inside that Brain. Combining multiple Brains in one Workspace was rejected because it would blur ownership and authorization and imply deterministic cross-Brain federation that the existing architecture deliberately leaves to agents.

# Host one Workspace and Brain per deployment in v1

Supersedes ADR-0006.

One deployed 2Brain server hosts one Workspace backed by one Brain. The Notion-grounded Workspace menu provides identity, Settings, and invitation actions but does not claim cross-Workspace switching; multi-Workspace switching is deferred until a real multi-Brain gateway and shared identity plane exist, because the current HTTP server dispatches through one BrainEngine.

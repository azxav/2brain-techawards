# Export Workspaces as portable secret-free archives

Export Workspace runs as a Background Operation and produces Pages as Markdown plus JSON metadata, Page Versions, Source configuration, Member and Agent authorization, Attention history, Change Events, and an export manifest. Credentials, tokens, sessions, full request parameters, and managed Git clone internals are excluded so portability does not become a secret-exfiltration path.

ADR-0049 clarifies that Pages, Page Versions, and safe Source metadata cover every Brain Source in the Workspace catalog, including built-in and unmanaged Sources. Private OpenClaw files, channel uploads, conversations, browser state, and credentials remain excluded unless separately persisted through a supported GBrain attachment surface.

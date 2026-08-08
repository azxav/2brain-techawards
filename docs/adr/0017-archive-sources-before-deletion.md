# Archive Sources before allowing permanent deletion

The normal Source-removal action in 2Brain is Archive, a reversible state that retains data and history while stopping active search, synchronization, and automation. Permanent deletion is restricted to Archived Sources under Settings, shows an impact preview, and requires typing the immutable Source ID. Deletion may purge the Source's content, but its redacted lifecycle and immutable Audit Events remain until Workspace deletion.

ADR-0049 preserves this behavior for Managed Git Sources. A core Source archived outside the Workspace is likewise absent from active Knowledge projections, but built-in and unmanaged Source cards are read-only in Workspace Settings and gain no new lifecycle controls.

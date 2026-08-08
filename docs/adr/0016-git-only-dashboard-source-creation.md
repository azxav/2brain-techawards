# Limit dashboard Source creation to managed HTTPS Git repositories

2Brain v1 allows Administrators to connect a Managed Git Source by HTTPS URL from the Workspace, while Local Source paths remain trusted CLI-only and SaaS connectors remain out of scope until real adapters exist. This reuses the backend's confined clone path and SSRF protections and prevents a remote dashboard from becoming an arbitrary server-filesystem registration surface or advertising mock integrations as functional.

ADR-0049 distinguishes creation from visibility. Settings also lists built-in and unmanaged core Sources already present in the Brain, but exposes them as read-only rows with no Git, synchronization, archive, or delete controls. This does not add a remote generic Source-creation path.

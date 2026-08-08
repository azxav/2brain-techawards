# Replace the legacy frontend in one hard cutover

The 2Brain release deletes the legacy admin frontend and its mock-data experience, serves only the new Notion-grounded Workspace interface beneath `/app`, and redirects `/admin` to role-gated Settings. Fresh-schema initialization and Workspace Setup complete before the new interface is served. Operational rollback may restore the prior release as a whole, but the product does not retain a legacy-UI feature flag, hidden route, or parallel interface.

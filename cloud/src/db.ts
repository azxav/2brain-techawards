/**
 * Database seam for the control plane.
 *
 * The control plane owns a plain Postgres database. Everything above this
 * file talks to `SqlExecutor`; production binds it to postgres.js
 * (see index.ts) and tests bind it to embedded PGLite. Both are real
 * Postgres wire-compatible engines, so the DDL below is exercised as-is.
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * Schema migrations, applied in order and recorded in cp_migrations.
 * Append-only: never edit a shipped entry, add a new version instead.
 * One statement per entry: PGLite's query() runs the extended protocol,
 * which takes a single statement at a time.
 */
const MIGRATIONS: Array<{ version: number; statements: string[] }> = [
  {
    version: 1,
    statements: [
      `CREATE TABLE cp_users (
        user_id uuid PRIMARY KEY,
        github_id bigint NOT NULL UNIQUE,
        login text NOT NULL,
        name text,
        avatar_url text,
        is_operator boolean NOT NULL DEFAULT false,
        invite_id uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE cp_invite_codes (
        invite_id uuid PRIMARY KEY,
        code_hash text NOT NULL UNIQUE,
        code_prefix text NOT NULL,
        max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
        use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
        note text,
        created_by uuid REFERENCES cp_users(user_id),
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `ALTER TABLE cp_users
        ADD CONSTRAINT cp_users_invite_id_fkey
        FOREIGN KEY (invite_id) REFERENCES cp_invite_codes(invite_id)`,
      `CREATE TABLE cp_sessions (
        session_hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES cp_users(user_id) ON DELETE CASCADE,
        csrf_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE cp_pending_signups (
        token_hash text PRIMARY KEY,
        github_id bigint NOT NULL,
        login text NOT NULL,
        name text,
        avatar_url text,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      // The workspace registry: source of truth for every hosted deployment.
      // Credential columns hold references or hashes, never raw secrets.
      // backup.ts refuses to store a dump that does not mention this table by
      // name; renaming it without updating that guard fails the nightly backup.
      `CREATE TABLE cp_workspaces (
        workspace_id uuid PRIMARY KEY,
        owner_user_id uuid NOT NULL REFERENCES cp_users(user_id),
        name text NOT NULL,
        subdomain text NOT NULL UNIQUE,
        oci_instance_ocid text,
        tier text NOT NULL DEFAULT 'brain' CHECK (tier IN ('brain', 'agent')),
        stripe_subscription_id text,
        billing_manual_override boolean NOT NULL DEFAULT false,
        bootstrap_credential_hash text,
        embedding_token_ref text,
        github_installation_id text,
        lifecycle_state text NOT NULL DEFAULT 'provisioning'
          CHECK (lifecycle_state IN ('provisioning', 'running', 'suspended', 'deleted', 'failed')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX cp_workspaces_owner_idx ON cp_workspaces (owner_user_id)`,
      `CREATE INDEX cp_sessions_user_idx ON cp_sessions (user_id)`,
    ],
  },
  {
    version: 2,
    statements: [
      // Billing lifecycle, distinct from the Stripe reference: 'none' until a
      // subscription (or a manual override) exists. Later billing tickets move
      // rows through the remaining states.
      `ALTER TABLE cp_workspaces
        ADD COLUMN billing_state text NOT NULL DEFAULT 'none'
        CHECK (billing_state IN ('none', 'trialing', 'active', 'past_due', 'canceled'))`,
    ],
  },
  {
    version: 3,
    statements: [
      // Outbound Workspace management must resolve the bootstrap credential;
      // a verifier hash cannot be presented to the Workspace HTTP boundary.
      `ALTER TABLE cp_workspaces
        RENAME COLUMN bootstrap_credential_hash TO bootstrap_credential_ref`,
    ],
  },
  {
    version: 4,
    statements: [
      // The env-configured operator path is a one-time bootstrap claim. Keep
      // the invariant in Postgres so concurrent OAuth callbacks cannot both win.
      `CREATE UNIQUE INDEX cp_users_single_operator_idx
        ON cp_users (is_operator) WHERE is_operator = true`,
    ],
  },
  {
    version: 5,
    statements: [
      // The provisioning state machine's own state. lifecycle_state stays the
      // customer-facing column; provisioning_step is what the reconciler
      // dispatches on, and it names the step that has *completed*.
      `ALTER TABLE cp_workspaces
        ADD COLUMN provisioning_step text NOT NULL DEFAULT 'pending'
        CHECK (provisioning_step IN ('pending', 'credentials', 'instance', 'dns', 'health', 'setup_link', 'running', 'failed'))`,
      // Each step records what it created before advancing, so a crash resumes
      // holding the same handles rather than re-creating the effect.
      `ALTER TABLE cp_workspaces ADD COLUMN dns_record_id text`,
      `ALTER TABLE cp_workspaces ADD COLUMN setup_link text`,
      // Sealed JSON: the per-workspace secrets cloud-init needs, minted before
      // the launch that consumes them so a crash in between does not lose them.
      // Cleared once the workspace is running; only the bootstrap credential
      // outlives provisioning, because the management lane must present it.
      `ALTER TABLE cp_workspaces ADD COLUMN provisioning_secrets text`,
      // Operator-facing summary of why a provision gave up, plus any residue
      // cleanup could not release. Never carries a credential.
      `ALTER TABLE cp_workspaces ADD COLUMN provisioning_error text`,
      // Bounds a step that keeps saying "not yet" (TLS issuance, first boot).
      `ALTER TABLE cp_workspaces ADD COLUMN step_attempts integer NOT NULL DEFAULT 0 CHECK (step_attempts >= 0)`,
      // A short lease, not a lock: a reconciler that dies mid-step just lets it
      // expire, and the next tick re-reads the row and carries on.
      `ALTER TABLE cp_workspaces ADD COLUMN lease_expires_at timestamptz`,
      `ALTER TABLE cp_workspaces ADD COLUMN lease_owner text`,
      // No index on the reconciler's claim predicate: the pilot's fleet is ~10-20
      // rows, which Postgres scans faster than it would descend a tree. Add one
      // when the fleet is big enough to measure the difference.
    ],
  },
  {
    version: 6,
    statements: [
      // The invite gates signup; this gates how much fleet that signup may take.
      // Without it one invited user could claim every slot under the fleet cap.
      `ALTER TABLE cp_invite_codes
        ADD COLUMN workspace_quota integer NOT NULL DEFAULT 1 CHECK (workspace_quota > 0)`,
    ],
  },
  {
    version: 7,
    statements: [
      // The workspace's public address, captured at the instance step. The health
      // probe and the setup-link call dial the VM by this IP rather than by a
      // hostname the control plane created moments earlier, which the local
      // resolver can NXDOMAIN and negative-cache past the whole health window.
      `ALTER TABLE cp_workspaces ADD COLUMN public_ip text`,
    ],
  },
  {
    version: 8,
    statements: [
      // Lifecycle actions are requested by the API and performed by the
      // reconciler, so each one needs a state of its own: the request writes the
      // intent, a later tick does the work. Without the in-flight states a
      // teardown would have to run inside the HTTP handler, where a crash
      // between two adapter calls orphans whatever the first one left behind.
      `ALTER TABLE cp_workspaces DROP CONSTRAINT cp_workspaces_lifecycle_state_check`,
      `ALTER TABLE cp_workspaces
        ADD CONSTRAINT cp_workspaces_lifecycle_state_check
        CHECK (lifecycle_state IN ('provisioning', 'running', 'suspending', 'suspended',
          'resuming', 'deleting', 'deleted', 'failed'))`,
    ],
  },
];

export async function migrateControlPlaneSchema(db: SqlExecutor): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cp_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  for (const migration of MIGRATIONS) {
    const applied = await db.query<{ version: number }>('SELECT version FROM cp_migrations WHERE version = $1', [migration.version]);
    if (applied.length > 0) continue;
    await db.transaction(async tx => {
      for (const statement of migration.statements) await tx.query(statement);
      await tx.query('INSERT INTO cp_migrations (version) VALUES ($1)', [migration.version]);
    });
  }
}

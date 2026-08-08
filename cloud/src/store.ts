import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from './db.ts';
import { digest, randomInviteCode, randomToken } from './tokens.ts';
import type { GitHubProfile } from './adapters/github.ts';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface ControlPlaneUser {
  userId: string;
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  isOperator: boolean;
  /** The invite redeemed at signup, and so the quota bounding this user. Null for the operator. */
  inviteId: string | null;
}

interface UserRow {
  user_id: string;
  github_id: string | number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  is_operator: boolean;
  invite_id: string | null;
}

const USER_COLUMNS = 'user_id, github_id, login, name, avatar_url, is_operator, invite_id';

function toUser(row: UserRow): ControlPlaneUser {
  return {
    userId: row.user_id,
    githubId: Number(row.github_id),
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    isOperator: row.is_operator,
    inviteId: row.invite_id,
  };
}

export async function findUserByGithubId(db: SqlExecutor, githubId: number): Promise<ControlPlaneUser | null> {
  const rows = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM cp_users WHERE github_id = $1`, [githubId]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function hasOperatorUser(db: SqlExecutor): Promise<boolean> {
  const rows = await db.query<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM cp_users WHERE is_operator = true) AS exists');
  return rows[0]?.exists === true;
}

export async function createUser(
  db: SqlExecutor,
  profile: GitHubProfile,
  options: { isOperator?: boolean; inviteId?: string | null } = {},
): Promise<ControlPlaneUser> {
  const rows = await db.query<UserRow>(
    `INSERT INTO cp_users (user_id, github_id, login, name, avatar_url, is_operator, invite_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${USER_COLUMNS}`,
    [randomUUID(), profile.githubId, profile.login, profile.name, profile.avatarUrl, options.isOperator ?? false, options.inviteId ?? null],
  );
  return toUser(rows[0]);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_TTL_DAYS = 30;

export async function createSession(db: SqlExecutor, userId: string): Promise<{ session: string; csrf: string }> {
  const session = randomToken();
  const csrf = randomToken();
  await db.query(
    `INSERT INTO cp_sessions (session_hash, user_id, csrf_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 day'))`,
    [digest(session), userId, digest(csrf), SESSION_TTL_DAYS],
  );
  return { session, csrf };
}

export async function authenticateSession(db: SqlExecutor, rawSession: string): Promise<(ControlPlaneUser & { csrfHash: string }) | null> {
  const rows = await db.query<UserRow & { csrf_hash: string }>(
    `SELECT u.user_id, u.github_id, u.login, u.name, u.avatar_url, u.is_operator, u.invite_id, s.csrf_hash
       FROM cp_sessions s JOIN cp_users u ON u.user_id = s.user_id
      WHERE s.session_hash = $1 AND s.expires_at > now()`,
    [digest(rawSession)],
  );
  return rows[0] ? { ...toUser(rows[0]), csrfHash: rows[0].csrf_hash } : null;
}

export async function revokeSession(db: SqlExecutor, rawSession: string): Promise<void> {
  await db.query('DELETE FROM cp_sessions WHERE session_hash = $1', [digest(rawSession)]);
}

// ---------------------------------------------------------------------------
// Pending signups (GitHub identity verified, invite code not yet redeemed)
// ---------------------------------------------------------------------------

const PENDING_SIGNUP_TTL_MINUTES = 30;

export async function createPendingSignup(db: SqlExecutor, profile: GitHubProfile): Promise<string> {
  const token = randomToken();
  await db.query(
    `INSERT INTO cp_pending_signups (token_hash, github_id, login, name, avatar_url, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 minute'))`,
    [digest(token), profile.githubId, profile.login, profile.name, profile.avatarUrl, PENDING_SIGNUP_TTL_MINUTES],
  );
  return token;
}

export async function findPendingSignup(db: SqlExecutor, rawToken: string): Promise<GitHubProfile | null> {
  const rows = await db.query<{ github_id: string | number; login: string; name: string | null; avatar_url: string | null }>(
    `SELECT github_id, login, name, avatar_url FROM cp_pending_signups
      WHERE token_hash = $1 AND expires_at > now()`,
    [digest(rawToken)],
  );
  if (!rows[0]) return null;
  return { githubId: Number(rows[0].github_id), login: rows[0].login, name: rows[0].name, avatarUrl: rows[0].avatar_url };
}

export async function deletePendingSignup(db: SqlExecutor, rawToken: string): Promise<void> {
  await db.query('DELETE FROM cp_pending_signups WHERE token_hash = $1', [digest(rawToken)]);
}

// ---------------------------------------------------------------------------
// Invite codes
// ---------------------------------------------------------------------------

export interface InviteCodeView {
  inviteId: string;
  codePrefix: string;
  maxUses: number;
  useCount: number;
  workspaceQuota: number;
  note: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export async function issueInviteCode(
  db: SqlExecutor,
  options: { createdBy: string; maxUses?: number; workspaceQuota?: number; note?: string | null },
): Promise<{ inviteId: string; code: string; maxUses: number; workspaceQuota: number }> {
  const code = randomInviteCode();
  const maxUses = options.maxUses ?? 1;
  const workspaceQuota = options.workspaceQuota ?? 1;
  const inviteId = randomUUID();
  await db.query(
    `INSERT INTO cp_invite_codes (invite_id, code_hash, code_prefix, max_uses, workspace_quota, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [inviteId, digest(code), code.slice(0, 7), maxUses, workspaceQuota, options.note ?? null, options.createdBy],
  );
  return { inviteId, code, maxUses, workspaceQuota };
}

export async function listInviteCodes(db: SqlExecutor): Promise<InviteCodeView[]> {
  const rows = await db.query<{
    invite_id: string;
    code_prefix: string;
    max_uses: number;
    use_count: number;
    workspace_quota: number;
    note: string | null;
    revoked_at: string | null;
    created_at: string;
  }>(
    `SELECT invite_id, code_prefix, max_uses, use_count, workspace_quota, note, revoked_at, created_at
       FROM cp_invite_codes ORDER BY created_at DESC`,
  );
  return rows.map(row => ({
    inviteId: row.invite_id,
    codePrefix: row.code_prefix,
    maxUses: row.max_uses,
    useCount: row.use_count,
    workspaceQuota: Number(row.workspace_quota),
    note: row.note,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }));
}

export type InviteRedemption =
  | { outcome: 'redeemed'; inviteId: string }
  | { outcome: 'invalid' }
  | { outcome: 'exhausted' };

/**
 * Atomically consume one use of an invite code. Must run inside the same
 * transaction that creates the user, so a failed signup never burns a use.
 */
export async function consumeInviteCode(tx: SqlExecutor, rawCode: string): Promise<InviteRedemption> {
  const codeHash = digest(rawCode);
  const existing = await tx.query<{ invite_id: string; max_uses: number; use_count: number; revoked_at: string | null }>(
    'SELECT invite_id, max_uses, use_count, revoked_at FROM cp_invite_codes WHERE code_hash = $1',
    [codeHash],
  );
  if (!existing[0] || existing[0].revoked_at !== null) return { outcome: 'invalid' };
  const rows = await tx.query<{ invite_id: string }>(
    `UPDATE cp_invite_codes SET use_count = use_count + 1
      WHERE code_hash = $1 AND revoked_at IS NULL AND use_count < max_uses
      RETURNING invite_id`,
    [codeHash],
  );
  return rows[0] ? { outcome: 'redeemed', inviteId: rows[0].invite_id } : { outcome: 'exhausted' };
}

// ---------------------------------------------------------------------------
// Workspace registry
// ---------------------------------------------------------------------------

/**
 * The step that has *completed*, so the reconciler dispatches on it directly:
 * pending -> credentials -> instance -> dns -> health -> setup_link -> running,
 * with `failed` reachable from any of them once cleanup has run.
 */
export type ProvisioningStep = 'pending' | 'credentials' | 'instance' | 'dns' | 'health' | 'setup_link' | 'running' | 'failed';

/**
 * The customer-facing state, and the one lifecycle actions move through.
 *
 * `suspending`, `resuming` and `deleting` are in-flight states owned by the
 * reconciler: the API writes the intent and returns, a later tick performs the
 * cloud effects and lands the row on the settled state (`suspended`, `running`,
 * `deleted`). Nothing outside the reconciler writes a settled state.
 */
export type LifecycleState =
  | 'provisioning'
  | 'running'
  | 'suspending'
  | 'suspended'
  | 'resuming'
  | 'deleting'
  | 'deleted'
  | 'failed';

export interface WorkspaceRecord {
  workspaceId: string;
  ownerUserId: string;
  name: string;
  subdomain: string;
  ociInstanceOcid: string | null;
  tier: 'brain' | 'agent';
  billingState: 'none' | 'trialing' | 'active' | 'past_due' | 'canceled';
  stripeSubscriptionId: string | null;
  billingManualOverride: boolean;
  /** Sealed, not hashed: the control plane must present this. See secrets.ts. */
  bootstrapCredentialRef: string | null;
  embeddingTokenRef: string | null;
  githubInstallationId: string | null;
  lifecycleState: LifecycleState;
  provisioningStep: ProvisioningStep;
  dnsRecordId: string | null;
  /** The VM's public address, captured at the instance step. The management lane
   *  dials this rather than resolving the just-created hostname. */
  publicIp: string | null;
  setupLink: string | null;
  provisioningError: string | null;
  stepAttempts: number;
}

interface WorkspaceRow {
  workspace_id: string;
  owner_user_id: string;
  name: string;
  subdomain: string;
  oci_instance_ocid: string | null;
  tier: WorkspaceRecord['tier'];
  billing_state: WorkspaceRecord['billingState'];
  stripe_subscription_id: string | null;
  billing_manual_override: boolean;
  bootstrap_credential_ref: string | null;
  embedding_token_ref: string | null;
  github_installation_id: string | null;
  lifecycle_state: WorkspaceRecord['lifecycleState'];
  provisioning_step: ProvisioningStep;
  dns_record_id: string | null;
  public_ip: string | null;
  setup_link: string | null;
  provisioning_error: string | null;
  step_attempts: number;
}

const WORKSPACE_COLUMNS = `workspace_id, owner_user_id, name, subdomain, oci_instance_ocid, tier,
  billing_state, stripe_subscription_id, billing_manual_override, bootstrap_credential_ref,
  embedding_token_ref, github_installation_id, lifecycle_state, provisioning_step, dns_record_id,
  public_ip, setup_link, provisioning_error, step_attempts`;

function toWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    subdomain: row.subdomain,
    ociInstanceOcid: row.oci_instance_ocid,
    tier: row.tier,
    billingState: row.billing_state,
    stripeSubscriptionId: row.stripe_subscription_id,
    billingManualOverride: row.billing_manual_override,
    bootstrapCredentialRef: row.bootstrap_credential_ref,
    embeddingTokenRef: row.embedding_token_ref,
    githubInstallationId: row.github_installation_id,
    lifecycleState: row.lifecycle_state,
    provisioningStep: row.provisioning_step,
    dnsRecordId: row.dns_record_id,
    publicIp: row.public_ip,
    setupLink: row.setup_link,
    provisioningError: row.provisioning_error,
    stepAttempts: Number(row.step_attempts),
  };
}

export async function createWorkspaceRecord(
  db: SqlExecutor,
  input: {
    ownerUserId: string;
    name: string;
    subdomain: string;
    tier?: WorkspaceRecord['tier'];
    ociInstanceOcid?: string | null;
    bootstrapCredentialRef?: string | null;
    embeddingTokenRef?: string | null;
    githubInstallationId?: string | null;
  },
): Promise<WorkspaceRecord> {
  const rows = await db.query<WorkspaceRow>(
    `INSERT INTO cp_workspaces (workspace_id, owner_user_id, name, subdomain, tier,
        oci_instance_ocid, bootstrap_credential_ref, embedding_token_ref, github_installation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${WORKSPACE_COLUMNS}`,
    [
      randomUUID(),
      input.ownerUserId,
      input.name,
      input.subdomain,
      input.tier ?? 'brain',
      input.ociInstanceOcid ?? null,
      input.bootstrapCredentialRef ?? null,
      input.embeddingTokenRef ?? null,
      input.githubInstallationId ?? null,
    ],
  );
  return toWorkspace(rows[0]);
}

export async function listWorkspacesForUser(db: SqlExecutor, ownerUserId: string): Promise<WorkspaceRecord[]> {
  const rows = await db.query<WorkspaceRow>(
    `SELECT ${WORKSPACE_COLUMNS} FROM cp_workspaces
      WHERE owner_user_id = $1 AND lifecycle_state <> 'deleted'
      ORDER BY created_at ASC`,
    [ownerUserId],
  );
  return rows.map(toWorkspace);
}

export async function findWorkspaceById(db: SqlExecutor, workspaceId: string): Promise<WorkspaceRecord | null> {
  const rows = await db.query<WorkspaceRow>(`SELECT ${WORKSPACE_COLUMNS} FROM cp_workspaces WHERE workspace_id = $1`, [workspaceId]);
  return rows[0] ? toWorkspace(rows[0]) : null;
}

/**
 * Workspaces counting against the fleet cap.
 *
 * The cap bounds live infrastructure, so it counts rows that can hold an
 * instance. Deleted and failed rows are excluded: a failed provision has already
 * terminated whatever it created, and counting it would let a run of failures
 * wedge the fleet permanently — #40 ships no delete path to clear them. A failed
 * provision that could not finish cleanup names its residue in
 * `provisioning_error` for the operator instead.
 */
export async function countActiveWorkspaces(db: SqlExecutor): Promise<number> {
  const rows = await db.query<{ count: string }>(
    `SELECT count(*) AS count FROM cp_workspaces WHERE lifecycle_state NOT IN ('deleted', 'failed')`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** The same rule, scoped to one owner — the unit the invite quota bounds. */
export async function countWorkspacesForOwner(db: SqlExecutor, ownerUserId: string): Promise<number> {
  const rows = await db.query<{ count: string }>(
    `SELECT count(*) AS count FROM cp_workspaces
      WHERE owner_user_id = $1 AND lifecycle_state NOT IN ('deleted', 'failed')`,
    [ownerUserId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** How many workspaces the invite this user signed up with allows them. */
export async function inviteWorkspaceQuota(db: SqlExecutor, inviteId: string): Promise<number> {
  const rows = await db.query<{ workspace_quota: number }>(
    'SELECT workspace_quota FROM cp_invite_codes WHERE invite_id = $1',
    [inviteId],
  );
  return Number(rows[0]?.workspace_quota ?? 0);
}

// ---------------------------------------------------------------------------
// Provisioning state transitions
// ---------------------------------------------------------------------------

/**
 * Take a short lease on the oldest workspace that still needs work.
 *
 * The lease is advisory and time-boxed rather than a lock: a reconciler that
 * dies mid-step leaves a lease that simply expires. Two control-plane processes
 * therefore cost at most one wasted tick, never two VMs.
 *
 * Two kinds of row need work: a provision that has not finished, and a workspace
 * an operator or owner asked to suspend, resume or delete. The lifecycle states
 * are claimed regardless of `provisioning_step`, because a workspace being
 * deleted has usually finished provisioning — its step is `running`, which the
 * provisioning half of the predicate deliberately excludes.
 */
export async function claimNextProvisioningWorkspace(
  db: SqlExecutor,
  options: { owner: string; leaseSeconds: number },
): Promise<WorkspaceRecord | null> {
  const rows = await db.query<WorkspaceRow>(
    `UPDATE cp_workspaces
        SET lease_expires_at = now() + ($2 * interval '1 second'), lease_owner = $1, updated_at = now()
      WHERE workspace_id = (
        SELECT workspace_id FROM cp_workspaces
         WHERE (
             (lifecycle_state = 'provisioning' AND provisioning_step NOT IN ('running', 'failed'))
             OR lifecycle_state IN ('suspending', 'resuming', 'deleting')
           )
           AND (lease_expires_at IS NULL OR lease_expires_at < now())
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING ${WORKSPACE_COLUMNS}`,
    [options.owner, options.leaseSeconds],
  );
  return rows[0] ? toWorkspace(rows[0]) : null;
}

/**
 * Record that someone asked for a lifecycle action, if the row is in a state the
 * action is defined for. The guard is in the WHERE clause rather than in a
 * read-then-write, so two concurrent requests cannot both believe they won.
 *
 * `step_attempts` resets because the counter is about to bound a different piece
 * of work than the one that last used it — but only when the state actually
 * changes. A request that re-asks for the action already under way must not
 * refill its retry budget, or a caller repeating it could postpone the bounded
 * give-up path indefinitely, and that path is what stops a teardown retrying
 * against an unreachable resource forever.
 *
 * Returns the updated row, or null when the workspace was not in an allowed
 * state — the caller's signal to refuse.
 */
export async function requestLifecycleAction(
  db: SqlExecutor,
  workspaceId: string,
  target: Extract<LifecycleState, 'suspending' | 'resuming' | 'deleting'>,
  allowedFrom: readonly LifecycleState[],
): Promise<WorkspaceRecord | null> {
  const rows = await db.query<WorkspaceRow>(
    `UPDATE cp_workspaces
        SET lifecycle_state = $2,
            step_attempts = CASE WHEN lifecycle_state = $2 THEN step_attempts ELSE 0 END,
            provisioning_error = CASE WHEN lifecycle_state = $2 THEN provisioning_error ELSE NULL END,
            updated_at = now()
      WHERE workspace_id = $1 AND lifecycle_state = ANY(string_to_array($3, ','))
      RETURNING ${WORKSPACE_COLUMNS}`,
    // A joined string rather than an array parameter: the states are fixed
    // literals with no commas in them, and both engines behind SqlExecutor bind
    // text identically where their array handling differs.
    [workspaceId, target, allowedFrom.join(',')],
  );
  return rows[0] ? toWorkspace(rows[0]) : null;
}

/**
 * Land a lifecycle action on its settled state and release the lease, guarded on
 * the lease holder for the same reason `advanceProvisioningStep` is: a
 * reconciler whose lease expired mid-action must not overwrite the state its
 * successor is working on.
 */
export async function settleLifecycleState(
  db: SqlExecutor,
  workspaceId: string,
  state: LifecycleState,
  options: { error?: string | null } = {},
  leaseOwner?: string,
): Promise<boolean> {
  const rows = await db.query<{ workspace_id: string }>(
    `UPDATE cp_workspaces
        SET lifecycle_state = $2,
            step_attempts = 0,
            provisioning_error = $3,
            lease_expires_at = NULL,
            lease_owner = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND ($4::text IS NULL OR lease_owner = $4)
      RETURNING workspace_id`,
    [workspaceId, state, options.error === undefined ? null : options.error?.slice(0, 1000) ?? null, leaseOwner ?? null],
  );
  return rows.length > 0;
}

/**
 * Persist the address a workspace answers on, and the DNS record that publishes
 * it, without touching the provisioning ladder.
 *
 * Resume needs this: a restarted instance can in principle come back on a
 * different address, and the record has to follow it. Going through
 * `advanceProvisioningStep` would mean naming a step that is not being advanced.
 */
export async function recordWorkspaceAddress(
  db: SqlExecutor,
  workspaceId: string,
  address: { dnsRecordId: string; publicIp: string },
  leaseOwner?: string,
): Promise<boolean> {
  const rows = await db.query<{ workspace_id: string }>(
    `UPDATE cp_workspaces
        SET dns_record_id = $2, public_ip = $3, updated_at = now()
      WHERE workspace_id = $1 AND ($4::text IS NULL OR lease_owner = $4)
      RETURNING workspace_id`,
    [workspaceId, address.dnsRecordId, address.publicIp, leaseOwner ?? null],
  );
  return rows.length > 0;
}

/**
 * Revoke everything the registry holds on a workspace's behalf.
 *
 * Unlike `clearProvisioningSecrets`, this never keeps the bootstrap credential:
 * the workspace is being deleted, and a credential that outlives it is a
 * standing grant against a machine nobody is watching any more. An instance that
 * cleanup could not terminate is terminated from the cloud console, which needs
 * no workspace credential.
 *
 * The embedding token and the GitHub App installation are cleared here too. Once
 * those adapters exist the remote revocation call belongs alongside this write;
 * until then, dropping the reference is the whole of what the pilot can revoke.
 */
export async function purgeWorkspaceSecrets(db: SqlExecutor, workspaceId: string): Promise<void> {
  await db.query(
    `UPDATE cp_workspaces
        SET provisioning_secrets = NULL,
            bootstrap_credential_ref = NULL,
            embedding_token_ref = NULL,
            github_installation_id = NULL,
            setup_link = NULL,
            updated_at = now()
      WHERE workspace_id = $1`,
    [workspaceId],
  );
}

export interface ProvisioningPatch {
  ociInstanceOcid?: string;
  dnsRecordId?: string;
  publicIp?: string;
  setupLink?: string;
  bootstrapCredentialRef?: string;
  /**
   * OpenRouter's handle for this workspace's embedding key. Stored in the clear,
   * unlike the bootstrap credential beside it: the handle addresses the key but
   * cannot call a model or mint anything — the control plane's provisioning key
   * is what makes it useful, and that never leaves this process's environment.
   */
  embeddingTokenRef?: string;
  provisioningSecrets?: string;
  lifecycleState?: WorkspaceRecord['lifecycleState'];
}

/**
 * Deliberately not part of WORKSPACE_COLUMNS: the sealed launch secrets are read
 * by exactly one step and must not ride along on every list and page render.
 */
export async function readProvisioningSecrets(db: SqlExecutor, workspaceId: string): Promise<string | null> {
  const rows = await db.query<{ provisioning_secrets: string | null }>(
    'SELECT provisioning_secrets FROM cp_workspaces WHERE workspace_id = $1',
    [workspaceId],
  );
  return rows[0]?.provisioning_secrets ?? null;
}

/**
 * Once the workspace is running the launch secrets are dead weight. Drop them.
 *
 * On a failed provision the bootstrap credential goes too, unless cleanup left an
 * instance behind — then an operator still needs it to finish the teardown.
 */
export async function clearProvisioningSecrets(
  db: SqlExecutor,
  workspaceId: string,
  options: { keepBootstrapCredential?: boolean } = { keepBootstrapCredential: true },
): Promise<void> {
  await db.query(
    `UPDATE cp_workspaces
        SET provisioning_secrets = NULL,
            bootstrap_credential_ref = CASE WHEN $2 THEN bootstrap_credential_ref ELSE NULL END
      WHERE workspace_id = $1`,
    [workspaceId, options.keepBootstrapCredential ?? true],
  );
}

/**
 * Record a completed step and release the lease in one statement, so the
 * effect's handle and the step that owns it can never disagree.
 *
 * Guarded on the lease holder: a reconciler whose lease expired mid-step must
 * not write. Without the guard it would clear the *new* holder's lease and
 * COALESCE its own stale handles over the new holder's, orphaning whatever the
 * new holder had just created. Returns false when the lease was lost, which is
 * the caller's signal that its work this tick was discarded.
 *
 * COALESCE rather than a built SET clause: an omitted field means "leave it",
 * and the column list stays fixed instead of interpolated.
 */
export async function advanceProvisioningStep(
  db: SqlExecutor,
  workspaceId: string,
  step: ProvisioningStep,
  patch: ProvisioningPatch = {},
  leaseOwner?: string,
): Promise<boolean> {
  const rows = await db.query<{ workspace_id: string }>(
    `UPDATE cp_workspaces
        SET provisioning_step = $2,
            step_attempts = 0,
            oci_instance_ocid = COALESCE($3, oci_instance_ocid),
            dns_record_id = COALESCE($4, dns_record_id),
            public_ip = COALESCE($5, public_ip),
            setup_link = COALESCE($6, setup_link),
            bootstrap_credential_ref = COALESCE($7, bootstrap_credential_ref),
            embedding_token_ref = COALESCE($8, embedding_token_ref),
            provisioning_secrets = COALESCE($9, provisioning_secrets),
            -- Only a row still provisioning may be moved on by a provisioning
            -- step. A delete or suspend requested while this tick was in flight
            -- has already written the lifecycle column, and COALESCEing over it
            -- would drop the request on the floor while keeping the effects it
            -- was about to release. The step and its handles are still recorded,
            -- so the action's own tick tears down what this one created.
            lifecycle_state = CASE WHEN lifecycle_state = 'provisioning'
              THEN COALESCE($10, lifecycle_state) ELSE lifecycle_state END,
            lease_expires_at = NULL,
            lease_owner = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND ($11::text IS NULL OR lease_owner = $11)
      RETURNING workspace_id`,
    [
      workspaceId,
      step,
      patch.ociInstanceOcid ?? null,
      patch.dnsRecordId ?? null,
      patch.publicIp ?? null,
      patch.setupLink ?? null,
      patch.bootstrapCredentialRef ?? null,
      patch.embeddingTokenRef ?? null,
      patch.provisioningSecrets ?? null,
      patch.lifecycleState ?? null,
      leaseOwner ?? null,
    ],
  );
  return rows.length > 0;
}

/**
 * The step said "not yet" (TLS still issuing, first boot still running).
 * Count the attempt and release the lease so the next tick retries. Guarded on
 * the lease holder for the same reason `advanceProvisioningStep` is.
 */
export async function recordStepAttempt(db: SqlExecutor, workspaceId: string, leaseOwner?: string): Promise<number> {
  const rows = await db.query<{ step_attempts: number }>(
    `UPDATE cp_workspaces
        SET step_attempts = step_attempts + 1, lease_expires_at = NULL, lease_owner = NULL, updated_at = now()
      WHERE workspace_id = $1 AND ($2::text IS NULL OR lease_owner = $2)
      RETURNING step_attempts`,
    [workspaceId, leaseOwner ?? null],
  );
  return Number(rows[0]?.step_attempts ?? 0);
}

/**
 * Terminal. Called only after cleanup has run; `error` never carries a secret.
 *
 * The lifecycle column is left alone unless it still says `provisioning`, for
 * the reason `advanceProvisioningStep` gives: a delete requested while the
 * provision was aborting must survive the abort and finish as a delete.
 */
export async function failWorkspace(db: SqlExecutor, workspaceId: string, error: string): Promise<void> {
  await db.query(
    `UPDATE cp_workspaces
        SET lifecycle_state = CASE WHEN lifecycle_state = 'provisioning' THEN 'failed' ELSE lifecycle_state END,
            provisioning_step = 'failed',
            provisioning_error = $2,
            lease_expires_at = NULL,
            lease_owner = NULL,
            updated_at = now()
      WHERE workspace_id = $1`,
    [workspaceId, error.slice(0, 1000)],
  );
}

export async function releaseLease(db: SqlExecutor, workspaceId: string): Promise<void> {
  await db.query(
    `UPDATE cp_workspaces SET lease_expires_at = NULL, lease_owner = NULL WHERE workspace_id = $1`,
    [workspaceId],
  );
}

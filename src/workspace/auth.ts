import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { appendWorkspaceAuditEvent, appendWorkspaceChangeEvent } from './events.ts';

type AuthEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;
export type SetupPurpose = 'setup' | 'recovery';
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const randomToken = (): string => randomBytes(32).toString('base64url');
const deliveryToken = (key: string, secret: string): string => createHmac('sha256', secret).update(key).digest('base64url');
// Derived rather than random so a retried issuance returns the same link. The
// domain prefix keeps this disjoint from deliveryToken, whose key is a UUID.
const derivedSetupToken = (purpose: SetupPurpose, email: string | null, key: string, secret: string): string =>
  createHmac('sha256', secret).update(`setup-token:v1:${purpose}:${email ?? ''}:${key}`).digest('base64url');
export const normalizeWorkspaceEmail = (email: string): string => email.trim().toLowerCase();

export function bootstrapCredentialMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(Buffer.from(digest(provided)), Buffer.from(digest(expected)));
}

/**
 * Issue a setup or recovery token.
 *
 * With an `idempotencyKey`, the token is derived from the request instead of
 * drawn at random, so a retry returns the same link rather than minting a second
 * one. Only the digest is ever stored, exactly as on the random path.
 *
 * The conflict clause is applied only to the derived path: there a conflict means
 * "this same request already ran". On the random path a conflict would be a
 * 256-bit collision handing the caller someone else's live token, so the insert
 * is left to raise.
 *
 * A retry refreshes the TTL of a still-unconsumed token. The token is unchanged,
 * so the response is still identical for an identical request; what moves is only
 * how long the link the caller was just handed remains usable. Leaving it to
 * expire would let a caller receive a token that is already dead — and, because
 * issuance still answers 201, be unable to tell. A consumed token is left alone
 * and stays refused at consumption, which is where single use is enforced.
 */
export async function issueWorkspaceSetupToken(
  engine: AuthEngine,
  purpose: SetupPurpose,
  options: { ttlMinutes?: number; email?: string; idempotencyKey?: string; tokenSecret?: string } = {},
): Promise<string> {
  const email = options.email ? normalizeWorkspaceEmail(options.email) : null;
  if (purpose === 'recovery' && (!email || !email.includes('@'))) throw new Error('recovery_email_required');
  const derived = options.idempotencyKey !== undefined;
  if (derived && !options.tokenSecret) throw new Error('setup_token_secret_required');
  const raw = derived ? derivedSetupToken(purpose, email, options.idempotencyKey!, options.tokenSecret!) : randomToken();
  await engine.executeRaw(
    `INSERT INTO workspace_setup_tokens (token_hash, purpose, email, expires_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 minute'))
     ${derived
       ? `ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at
          WHERE workspace_setup_tokens.consumed_at IS NULL`
       : ''}`,
    [digest(raw), purpose, email, options.ttlMinutes ?? 30],
  );
  return raw;
}

export async function inspectWorkspaceToken(engine: Pick<BrainEngine, 'executeRaw'>, raw: string, purpose: SetupPurpose) {
  const rows = await engine.executeRaw<{ expires_at: string }>(
    `SELECT expires_at FROM workspace_setup_tokens WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>now()`,
    [digest(raw), purpose],
  );
  return rows[0] ? { valid: true as const, expiresAt: rows[0].expires_at } : { valid: false as const };
}

async function consumeToken(engine: Pick<BrainEngine, 'executeRaw'>, raw: string, purpose: string) {
  const rows = await engine.executeRaw<{ email: string | null }>(
    `UPDATE workspace_setup_tokens SET consumed_at=now()
      WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING email`,
    [digest(raw), purpose],
  );
  if (!rows[0]) throw new Error('invalid_or_expired_token');
  return rows[0];
}

export async function beginWorkspaceSetup(engine: AuthEngine, raw: string, name: string, email: string, requestId: string, tokenSecret: string) {
  const workspaceName = name.trim();
  const normalizedEmail = normalizeWorkspaceEmail(email);
  if (!workspaceName || !normalizedEmail.includes('@')) throw new Error('invalid_setup_input');
  if (!tokenSecret) throw new Error('workspace_token_secret_required');
  return engine.transaction(async tx => {
    await consumeToken(tx, raw, 'setup');
    const workspaceId = randomUUID();
    const identityId = randomUUID();
    const membershipId = randomUUID();
    const deliveryKey = randomUUID();
    const confirmationToken = deliveryToken(deliveryKey, tokenSecret);
    await tx.executeRaw('INSERT INTO workspace_workspaces (workspace_id, name) VALUES ($1, $2)', [workspaceId, workspaceName]);
    await tx.executeRaw('INSERT INTO workspace_identities (identity_id, normalized_email) VALUES ($1, $2)', [identityId, normalizedEmail]);
    await tx.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ($1, $2, $3, 'administrator')", [membershipId, workspaceId, identityId]);
    await tx.executeRaw("INSERT INTO workspace_setup_tokens (token_hash, purpose, email, expires_at) VALUES ($1, 'email_confirmation', $2, now() + interval '30 minutes')", [digest(confirmationToken), normalizedEmail]);
    await tx.executeRaw("INSERT INTO workspace_email_outbox (message_id, recipient_email, template, delivery_key, request_id) VALUES ($1, $2, 'confirm_first_administrator', $1, $3)", [deliveryKey, normalizedEmail, requestId]);
    await appendWorkspaceAuditEvent(tx, { actor: { kind: 'operator', id: 'bootstrap-credential' }, action: 'workspace.setup', target: { type: 'workspace', id: workspaceId }, requestId, before: null, after: { status: 'pending_email_confirmation' }, outcome: 'succeeded' });
    await appendWorkspaceChangeEvent(tx, { actor: { kind: 'system', id: 'workspace-setup' }, action: 'workspace.setup', resource: { type: 'workspace', id: workspaceId }, requestId });
    return { deliveryKey, confirmationToken };
  });
}

export async function renewWorkspaceConfirmation(engine: AuthEngine, email: string, requestId: string, tokenSecret: string) {
  const normalizedEmail = normalizeWorkspaceEmail(email);
  return engine.transaction(async tx => {
    const pending = await tx.executeRaw(
      `SELECT i.identity_id FROM workspace_identities i JOIN workspace_memberships m ON m.identity_id=i.identity_id
       JOIN workspace_workspaces w ON w.workspace_id=m.workspace_id
       WHERE i.normalized_email=$1 AND i.email_confirmed_at IS NULL AND w.setup_completed_at IS NULL`,
      [normalizedEmail],
    );
    if (!pending[0]) throw new Error('pending_confirmation_not_found');
    const deliveryKey = randomUUID();
    const confirmationToken = deliveryToken(deliveryKey, tokenSecret);
    await tx.executeRaw("INSERT INTO workspace_setup_tokens (token_hash, purpose, email, expires_at) VALUES ($1, 'email_confirmation', $2, now() + interval '30 minutes')", [digest(confirmationToken), normalizedEmail]);
    await tx.executeRaw("INSERT INTO workspace_email_outbox (message_id, recipient_email, template, delivery_key, request_id) VALUES ($1, $2, 'confirm_first_administrator', $1, $3)", [deliveryKey, normalizedEmail, requestId]);
    return { deliveryKey, confirmationToken };
  });
}

export async function requestWorkspaceLogin(engine: AuthEngine, email: string, requestId: string, tokenSecret: string) {
  const normalizedEmail = normalizeWorkspaceEmail(email);
  return engine.transaction(async tx => {
    const eligible = await tx.executeRaw(
      `SELECT i.identity_id FROM workspace_identities i JOIN workspace_memberships m ON m.identity_id=i.identity_id
       JOIN workspace_workspaces w ON w.workspace_id=m.workspace_id
       WHERE i.normalized_email=$1 AND i.email_confirmed_at IS NOT NULL AND w.setup_completed_at IS NOT NULL AND m.status='active'`,
      [normalizedEmail],
    );
    if (!eligible[0]) throw new Error('login_identity_not_found');
    const deliveryKey = randomUUID();
    const loginToken = deliveryToken(deliveryKey, tokenSecret);
    await tx.executeRaw("INSERT INTO workspace_setup_tokens (token_hash, purpose, email, expires_at) VALUES ($1, 'login', $2, now() + interval '30 minutes')", [digest(loginToken), normalizedEmail]);
    await tx.executeRaw("INSERT INTO workspace_email_outbox (message_id, recipient_email, template, delivery_key, request_id) VALUES ($1, $2, 'workspace_sign_in', $1, $3)", [deliveryKey, normalizedEmail, requestId]);
    return { deliveryKey, loginToken };
  });
}

async function createSession(tx: Pick<BrainEngine, 'executeRaw'>, email: string) {
  const rows = await tx.executeRaw<{ membership_id: string; workspace_id: string }>(
    `SELECT m.membership_id, m.workspace_id FROM workspace_memberships m JOIN workspace_identities i ON i.identity_id=m.identity_id
     JOIN workspace_workspaces w ON w.workspace_id=m.workspace_id
     WHERE i.normalized_email=$1 AND m.status='active'
       AND i.email_confirmed_at IS NOT NULL AND w.setup_completed_at IS NOT NULL`, [email]);
  if (!rows[0]) throw new Error('membership_not_found');
  const session = randomToken();
  const csrf = randomToken();
  await tx.executeRaw("INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')", [digest(session), rows[0].membership_id, digest(csrf)]);
  return { session, csrf, workspaceId: rows[0].workspace_id, membershipId: rows[0].membership_id };
}

export async function confirmFirstAdministrator(engine: AuthEngine, raw: string, requestId: string): Promise<{ session: string; csrf: string }> {
  return engine.transaction(async tx => {
    const { email } = await consumeToken(tx, raw, 'email_confirmation');
    if (!email) throw new Error('confirmation_email_missing');
    const claimedIdentity = await tx.executeRaw<{ identity_id: string }>('UPDATE workspace_identities SET email_confirmed_at=now() WHERE normalized_email=$1 AND email_confirmed_at IS NULL RETURNING identity_id', [email]);
    if (!claimedIdentity[0]) throw new Error('confirmation_already_completed');
    const claimedWorkspace = await tx.executeRaw<{ workspace_id: string }>(
      `UPDATE workspace_workspaces SET setup_completed_at=now()
       WHERE setup_completed_at IS NULL AND workspace_id IN (SELECT workspace_id FROM workspace_memberships WHERE identity_id=$1)
       RETURNING workspace_id`, [claimedIdentity[0].identity_id]);
    if (!claimedWorkspace[0]) throw new Error('workspace_setup_already_completed');
    const auth = await createSession(tx, email);
    await tx.executeRaw("UPDATE workspace_setup_tokens SET consumed_at=COALESCE(consumed_at, now()) WHERE email=$1 AND purpose='email_confirmation'", [email]);
    await tx.executeRaw("UPDATE workspace_deployments SET lifecycle_state='active' WHERE singleton=TRUE");
    await appendWorkspaceAuditEvent(tx, { actor: { kind: 'system', id: 'email-confirmation' }, action: 'workspace.setup.confirm', target: { type: 'workspace', id: auth.workspaceId }, requestId, before: { status: 'pending_email_confirmation' }, after: { status: 'active' }, outcome: 'succeeded' });
    await appendWorkspaceChangeEvent(tx, { actor: { kind: 'system', id: 'email-confirmation' }, action: 'workspace.setup.confirm', resource: { type: 'workspace', id: auth.workspaceId }, requestId });
    return { session: auth.session, csrf: auth.csrf };
  });
}

export async function redeemWorkspaceRecovery(engine: AuthEngine, raw: string, requestId: string): Promise<{ session: string; csrf: string }> {
  return engine.transaction(async tx => {
    const { email } = await consumeToken(tx, raw, 'recovery');
    if (!email) throw new Error('recovery_email_missing');
    const auth = await createSession(tx, email);
    await appendWorkspaceAuditEvent(tx, { actor: { kind: 'operator', id: 'bootstrap-credential' }, action: 'workspace.recovery', target: { type: 'workspace', id: auth.workspaceId }, requestId, before: { session: 'absent' }, after: { session: 'issued' }, outcome: 'succeeded' });
    await appendWorkspaceChangeEvent(tx, { actor: { kind: 'operator', id: 'bootstrap-credential' }, action: 'workspace.recovery', resource: { type: 'workspace', id: auth.workspaceId }, requestId });
    return { session: auth.session, csrf: auth.csrf };
  });
}

export async function redeemWorkspaceLogin(engine: AuthEngine, raw: string, requestId: string): Promise<{ session: string; csrf: string }> {
  return engine.transaction(async tx => {
    const { email } = await consumeToken(tx, raw, 'login');
    if (!email) throw new Error('login_email_missing');
    const auth = await createSession(tx, email);
    await appendWorkspaceAuditEvent(tx, { actor: { kind: 'member', id: auth.membershipId }, action: 'workspace.login', target: { type: 'workspace', id: auth.workspaceId }, requestId, before: { session: 'absent' }, after: { session: 'issued' }, outcome: 'succeeded' });
    await appendWorkspaceChangeEvent(tx, { actor: { kind: 'member', id: auth.membershipId }, action: 'workspace.login', resource: { type: 'workspace', id: auth.workspaceId }, requestId });
    return { session: auth.session, csrf: auth.csrf };
  });
}

export async function authenticateWorkspaceSession(engine: AuthEngine, raw: string | undefined) {
  if (!raw) return null;
  const rows = await engine.executeRaw<{ membership_id: string; role: string; workspace_id: string; name: string }>(
    `SELECT m.membership_id, m.role, m.workspace_id, w.name FROM workspace_sessions s JOIN workspace_memberships m ON m.membership_id=s.membership_id
     JOIN workspace_workspaces w ON w.workspace_id=m.workspace_id WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND m.status='active'`, [digest(raw)]);
  return rows[0] ?? null;
}

export async function workspaceSessionCsrfMatches(
  engine: Pick<BrainEngine, 'executeRaw'>,
  rawSession: string | undefined,
  rawCsrf: string | undefined,
): Promise<boolean> {
  if (!rawSession || !rawCsrf) return false;
  const rows = await engine.executeRaw(
    `SELECT session_hash FROM workspace_sessions
     WHERE session_hash=$1 AND csrf_hash=$2 AND revoked_at IS NULL AND expires_at>now()`,
    [digest(rawSession), digest(rawCsrf)],
  );
  return rows.length === 1;
}

export async function revokeWorkspaceSession(engine: AuthEngine, rawSession: string | undefined, rawCsrf: string | undefined): Promise<boolean> {
  if (!rawSession || !rawCsrf) return false;
  const rows = await engine.executeRaw<{ session_hash: string }>(
    `UPDATE workspace_sessions SET revoked_at=now() WHERE session_hash=$1 AND csrf_hash=$2 AND revoked_at IS NULL AND expires_at>now() RETURNING session_hash`,
    [digest(rawSession), digest(rawCsrf)],
  );
  return rows.length === 1;
}

export { digest as hashWorkspaceSecret };

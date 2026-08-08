import { randomBytes, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { advanceNativePasswordGenerationInTransaction } from './agent-access.ts';
import { hashWorkspaceSecret, normalizeWorkspaceEmail } from './auth.ts';
import { runProtectedWorkspaceMutation } from './events.ts';
import { createWorkspaceNotificationForEvent } from './notifications.ts';
import type { PrincipalSourceAccess } from './source-access.ts';

type MembershipEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;

export interface WorkspaceMembershipStatusResult {
  membershipId: string;
  previousStatus: WorkspaceMembershipStatus;
  status: WorkspaceMembershipStatus;
  nativeRotationQueued: boolean;
  nativeRotationOperationId: string | null;
}
export type WorkspaceMembershipRole = 'administrator' | 'member';
export type WorkspaceMembershipStatus = 'active' | 'disabled';

function validateEmail(email: string): string {
  const normalized = normalizeWorkspaceEmail(email);
  if (!normalized.includes('@')) throw new Error('invalid_invitation_email');
  return normalized;
}

function validateAccess(access: PrincipalSourceAccess): string[] {
  // #51: the HTTP boundary hands this whatever arrived in the request body —
  // a missing wrapper or wrong shape must refuse as a typed 4xx, not crash
  // into a 500 TypeError.
  if (!access || typeof access !== 'object' || !['all', 'specific', 'none'].includes((access as { mode?: unknown }).mode as string)) {
    throw new Error('invalid_source_access_grant');
  }
  if (access.mode === 'specific' && !Array.isArray(access.sourceIds)) throw new Error('invalid_source_access_grant');
  const sourceIds = access.mode === 'specific' ? [...new Set(access.sourceIds)].sort() : [];
  if (sourceIds.some(sourceId => !isValidSourceId(sourceId))) throw new Error('invalid_source_access_grant');
  if (access.mode === 'specific' && sourceIds.length === 0) throw new Error('specific_source_access_required');
  return sourceIds;
}

async function replaceAccess(
  tx: Pick<BrainEngine, 'executeRaw'>,
  membershipId: string,
  access: PrincipalSourceAccess,
): Promise<void> {
  const sourceIds = validateAccess(access);
  await tx.executeRaw(
    `INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode)
     VALUES ('member', $1, $2)
     ON CONFLICT (principal_kind, principal_id) DO UPDATE SET access_mode=EXCLUDED.access_mode, updated_at=now()`,
    [membershipId, access.mode],
  );
  await tx.executeRaw("DELETE FROM workspace_source_grants WHERE principal_kind='member' AND principal_id=$1", [membershipId]);
  for (const sourceId of sourceIds) {
    await tx.executeRaw("INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', $1, $2)", [membershipId, sourceId]);
  }
}

export async function createWorkspaceInvitation(engine: MembershipEngine, input: {
  workspaceId: string;
  email: string;
  role: WorkspaceMembershipRole;
  sourceAccess: PrincipalSourceAccess;
  actorMembershipId: string;
  requestId: string;
  ttlMinutes?: number;
}): Promise<{ invitationId: string; token: string }> {
  const email = validateEmail(input.email);
  const sourceIds = validateAccess(input.sourceAccess);
  if (input.role !== 'member' && input.role !== 'administrator') throw new Error('invalid_membership_role');
  const invitationId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId }, action: 'membership.invite',
    target: { type: 'invitation', id: invitationId }, requestId: input.requestId,
    before: null, after: { role: input.role, sourceAccess: input.sourceAccess.mode },
  }, async tx => {
    const existing = await tx.executeRaw(
      `SELECT m.membership_id FROM workspace_memberships m
       JOIN workspace_identities i ON i.identity_id=m.identity_id
       WHERE m.workspace_id=$1 AND i.normalized_email=$2`,
      [input.workspaceId, email],
    );
    if (existing[0]) throw new Error('membership_already_exists');
    await tx.executeRaw(
      `INSERT INTO workspace_invitations
       (invitation_id, workspace_id, normalized_email, role, access_mode, token_hash, invited_by_membership_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now()+($8 * interval '1 minute'))`,
      [invitationId, input.workspaceId, email, input.role, input.sourceAccess.mode, hashWorkspaceSecret(token), input.actorMembershipId, input.ttlMinutes ?? 1440],
    );
    for (const sourceId of sourceIds) {
      await tx.executeRaw('INSERT INTO workspace_invitation_source_grants (invitation_id, source_id) VALUES ($1,$2)', [invitationId, sourceId]);
    }
  });
  return { invitationId, token };
}

/**
 * Redeem one single-use invitation.
 *
 * `warningRevision` is #68 Task 11's Agent-tier shared-state acknowledgment. It
 * is a SERVER-supplied constant — the HTTP boundary passes
 * `AGENT_WARNING_REVISION`, never a value from the request body — and the
 * confirmation is inserted inside this same transaction, after the membership
 * exists. Recording it afterwards, outside the transaction, would leave a
 * window in which an active Member holds a share of the runtime's credentials,
 * browser, memory, and GBrain authority with no acknowledgment on record; a
 * failed redemption must leave no confirmation behind either.
 *
 * Brain tier passes nothing and no confirmation is written at all.
 */
export async function redeemWorkspaceInvitation(
  engine: MembershipEngine, token: string, addressedEmail: string, requestId: string,
  warningRevision?: string,
): Promise<{ membershipId: string; workspaceId: string; role: WorkspaceMembershipRole; session: string; csrf: string }> {
  const email = validateEmail(addressedEmail);
  return engine.transaction(async tx => {
    const invitations = await tx.executeRaw<{ invitation_id: string; workspace_id: string; normalized_email: string; role: WorkspaceMembershipRole; access_mode: PrincipalSourceAccess['mode'] }>(
      `SELECT invitation_id,workspace_id,normalized_email,role,access_mode FROM workspace_invitations
       WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, [hashWorkspaceSecret(token)],
    );
    const invitation = invitations[0];
    if (!invitation) throw new Error('invalid_or_expired_invitation');
    if (invitation.normalized_email !== email) throw new Error('invitation_email_mismatch');
    const existingMembership = await tx.executeRaw(
      `SELECT m.membership_id FROM workspace_memberships m
       JOIN workspace_identities i ON i.identity_id=m.identity_id
       WHERE m.workspace_id=$1 AND i.normalized_email=$2`,
      [invitation.workspace_id, email],
    );
    if (existingMembership[0]) throw new Error('membership_already_exists');
    const consumed = await tx.executeRaw<{ invitation_id: string }>(
      'UPDATE workspace_invitations SET consumed_at=now() WHERE invitation_id=$1 AND consumed_at IS NULL RETURNING invitation_id', [invitation.invitation_id],
    );
    if (!consumed[0]) throw new Error('invalid_or_expired_invitation');
    const identityId = randomUUID();
    const identities = await tx.executeRaw<{ identity_id: string }>(
      `INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ($1,$2,now())
       ON CONFLICT (normalized_email) DO UPDATE SET email_confirmed_at=COALESCE(workspace_identities.email_confirmed_at,now()) RETURNING identity_id`,
      [identityId, email],
    );
    const membershipId = randomUUID();
    const memberships = await tx.executeRaw<{ membership_id: string }>(
      `INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,$4)
       RETURNING membership_id`,
      [membershipId, invitation.workspace_id, identities[0]!.identity_id, invitation.role],
    );
    const actualMembershipId = memberships[0]!.membership_id;
    const grants = await tx.executeRaw<{ source_id: string }>('SELECT source_id FROM workspace_invitation_source_grants WHERE invitation_id=$1 ORDER BY source_id', [invitation.invitation_id]);
    const access: PrincipalSourceAccess = invitation.access_mode === 'specific'
      ? { mode: 'specific', sourceIds: grants.map(row => row.source_id) }
      : { mode: invitation.access_mode };
    await replaceAccess(tx, actualMembershipId, access);
    if (warningRevision) {
      await tx.executeRaw(
        `INSERT INTO workspace_agent_warning_confirmations (workspace_id, membership_id, revision)
         VALUES ($1,$2,$3) ON CONFLICT (workspace_id, membership_id, revision) DO NOTHING`,
        [invitation.workspace_id, actualMembershipId, warningRevision],
      );
    }
    await createWorkspaceNotificationForEvent(tx, {
      workspaceId: invitation.workspace_id,
      eventKey: `membership-created:${invitation.invitation_id}:${requestId}`,
      eventType: 'membership_access_changed',
      target: { type: 'membership', id: actualMembershipId },
    });
    const session = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    await tx.executeRaw("INSERT INTO workspace_sessions (session_hash,membership_id,csrf_hash,expires_at) VALUES ($1,$2,$3,now()+interval '30 days')", [hashWorkspaceSecret(session), actualMembershipId, hashWorkspaceSecret(csrf)]);
    return { membershipId: actualMembershipId, workspaceId: invitation.workspace_id, role: invitation.role, session, csrf };
  });
}

export async function listWorkspaceMemberships(engine: Pick<BrainEngine, 'executeRaw'>, workspaceId: string) {
  const rows = await engine.executeRaw<{ membership_id: string; normalized_email: string; role: WorkspaceMembershipRole; status: WorkspaceMembershipStatus; access_mode: PrincipalSourceAccess['mode'] }>(
    `SELECT m.membership_id,i.normalized_email,m.role,m.status,COALESCE(p.access_mode,'none') access_mode
     FROM workspace_memberships m JOIN workspace_identities i ON i.identity_id=m.identity_id
     LEFT JOIN workspace_principal_source_policies p ON p.principal_kind='member' AND p.principal_id=m.membership_id
     WHERE m.workspace_id=$1 ORDER BY i.normalized_email`, [workspaceId],
  );
  return Promise.all(rows.map(async row => {
    const grants = row.access_mode === 'specific' ? await engine.executeRaw<{ source_id: string }>("SELECT source_id FROM workspace_source_grants WHERE principal_kind='member' AND principal_id=$1 ORDER BY source_id", [row.membership_id]) : [];
    return { membershipId: row.membership_id, email: row.normalized_email, role: row.role, status: row.status, sourceAccess: { mode: row.access_mode, sourceIds: grants.map(grant => grant.source_id) } };
  }));
}

export async function setWorkspaceMembershipRole(engine: MembershipEngine, workspaceId: string, membershipId: string, role: WorkspaceMembershipRole, actorMembershipId: string, requestId: string, reason: string) {
  if (role !== 'member' && role !== 'administrator') throw new Error('invalid_membership_role');
  return runProtectedWorkspaceMutation(engine, { actor: { kind: 'member', id: actorMembershipId }, action: 'membership.role.change', target: { type: 'membership', id: membershipId }, requestId, reason, after: { role } }, async tx => {
    const rows = await tx.executeRaw('UPDATE workspace_memberships SET role=$3 WHERE membership_id=$1 AND workspace_id=$2 RETURNING membership_id', [membershipId, workspaceId, role]);
    if (!rows[0]) throw new Error('membership_not_found');
    await createWorkspaceNotificationForEvent(tx, {
      workspaceId, eventKey: `membership-role:${membershipId}:${requestId}`,
      eventType: 'membership_access_changed', target: { type: 'membership', id: membershipId },
    });
  });
}

export async function setWorkspaceMembershipSourceAccess(engine: MembershipEngine, workspaceId: string, membershipId: string, access: PrincipalSourceAccess, actorMembershipId: string, requestId: string, reason: string) {
  // #51: validate up front — the audit-event payload below reads access.mode,
  // so a malformed body must refuse before it is touched.
  validateAccess(access);
  return runProtectedWorkspaceMutation(engine, { actor: { kind: 'member', id: actorMembershipId }, action: 'membership.source_access.change', target: { type: 'membership', id: membershipId }, requestId, reason, after: { sourceAccess: access.mode } }, async tx => {
    const rows = await tx.executeRaw('SELECT membership_id FROM workspace_memberships WHERE membership_id=$1 AND workspace_id=$2', [membershipId, workspaceId]);
    if (!rows[0]) throw new Error('membership_not_found');
    await replaceAccess(tx, membershipId, access);
    await createWorkspaceNotificationForEvent(tx, {
      workspaceId, eventKey: `membership-source-access:${membershipId}:${requestId}`,
      eventType: 'membership_access_changed', target: { type: 'membership', id: membershipId },
    });
  });
}

/**
 * Member disablement is one atomic lifecycle: the status transition, revoking
 * every live session for that Member, and — only on the FIRST active→disabled
 * transition — advancing the shared native-password generation so a disabled
 * Member's copy of the shared OpenClaw credential stops working. Repeating
 * `disabled → disabled` still defensively revokes any session planted after
 * the first disable, but never rotates a second time.
 *
 * A Workspace with no shared Agent yet initialized has no native password to
 * rotate; that is reported back as `nativeRotationQueued: false` rather than
 * failing the disable, because disabling a Member must never depend on the
 * shared runtime existing.
 */
export async function setWorkspaceMembershipStatus(
  engine: MembershipEngine, workspaceId: string, membershipId: string, status: WorkspaceMembershipStatus,
  actorMembershipId: string, requestId: string, reason: string,
): Promise<WorkspaceMembershipStatusResult> {
  if (status !== 'active' && status !== 'disabled') throw new Error('invalid_membership_status');
  return runProtectedWorkspaceMutation(engine, { actor: { kind: 'member', id: actorMembershipId }, action: 'membership.status.change', target: { type: 'membership', id: membershipId }, requestId, reason, after: { status } }, async tx => {
    const locked = await tx.executeRaw<{ status: WorkspaceMembershipStatus }>(
      'SELECT status FROM workspace_memberships WHERE membership_id=$1 AND workspace_id=$2 FOR UPDATE',
      [membershipId, workspaceId],
    );
    if (!locked[0]) throw new Error('membership_not_found');
    const previousStatus = locked[0].status;

    const rows = await tx.executeRaw('UPDATE workspace_memberships SET status=$3 WHERE membership_id=$1 AND workspace_id=$2 RETURNING membership_id', [membershipId, workspaceId, status]);
    if (!rows[0]) throw new Error('membership_not_found');

    let nativeRotationQueued = false;
    let nativeRotationOperationId: string | null = null;

    if (status === 'disabled') {
      // Defensive on every disabled transition, not only the first: a session
      // established between two disable calls must not survive either one.
      await tx.executeRaw(
        'UPDATE workspace_sessions SET revoked_at=now() WHERE membership_id=$1 AND revoked_at IS NULL',
        [membershipId],
      );

      if (previousStatus === 'active') {
        // Lock the binding row before computing the idempotency key so the
        // generation it names is the generation the advance actually produces,
        // even under a concurrent rotation from another Member's disablement.
        const binding = await tx.executeRaw<{ native_password_generation: number }>(
          'SELECT native_password_generation FROM workspace_agent_runtime_bindings WHERE workspace_id=$1 FOR UPDATE',
          [workspaceId],
        );
        if (binding[0]) {
          const newGeneration = Number(binding[0].native_password_generation) + 1;
          const advanced = await advanceNativePasswordGenerationInTransaction(tx, {
            workspaceId, requestId,
            idempotencyKey: `member-disabled:${membershipId}:${newGeneration}`,
          });
          // `advanceNativePasswordGenerationInTransaction`'s early-idempotency
          // branch returns a PRE-EXISTING operation's generation without
          // incrementing anything. Under this call's own idempotency-key
          // scheme that branch should be unreachable — the key names
          // `newGeneration`, and the generation is monotonic, so the same key
          // can never collide with an operation for a different generation —
          // but that is an implicit invariant of two separate files. Make it
          // explicit rather than silently reconciling an operation whose
          // generation was never actually advanced.
          if (advanced.generation !== newGeneration) {
            throw new Error('native_password_generation_advance_mismatch');
          }
          nativeRotationQueued = true;
          nativeRotationOperationId = advanced.operationId;
        }
      }
    }

    await createWorkspaceNotificationForEvent(tx, {
      workspaceId, eventKey: `membership-status:${membershipId}:${requestId}`,
      eventType: 'membership_access_changed', target: { type: 'membership', id: membershipId },
    });

    return { membershipId, previousStatus, status, nativeRotationQueued, nativeRotationOperationId };
  });
}

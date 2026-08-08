import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  AGENT_WARNING_REVISION,
  getAgentAccessStatus,
  hasConfirmedAgentWarning,
  initializeBoundWorkspaceAgent,
} from '../src/workspace/agent-access.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  createWorkspaceInvitation,
  listWorkspaceMemberships,
  redeemWorkspaceInvitation,
  setWorkspaceMembershipRole,
  setWorkspaceMembershipSourceAccess,
  setWorkspaceMembershipStatus,
} from '../src/workspace/memberships.ts';
import { resolvePrincipalSourceAccess } from '../src/workspace/source-access.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
});

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Test', now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-admin', 'admin@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('admin-1', 'workspace-1', 'identity-admin', 'administrator')");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-member-1', 'member-1@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-member-1', 'member')");
});

test('an invitation is email-bound, single-use, and establishes its independent role and Source Access', async () => {
  const invitation = await createWorkspaceInvitation(engine, {
    workspaceId: 'workspace-1', email: ' Member@Example.Test ', role: 'member',
    sourceAccess: { mode: 'specific', sourceIds: ['source-b', 'source-a', 'source-a'] },
    actorMembershipId: 'admin-1', requestId: 'invite-1',
  });

  const redeemed = await redeemWorkspaceInvitation(engine, invitation.token, 'member@example.test', 'redeem-1');
  expect(redeemed).toMatchObject({ role: 'member', workspaceId: 'workspace-1' });
  expect(await resolvePrincipalSourceAccess(engine, { remote: true, principal: { kind: 'member', id: redeemed.membershipId } }, ['source-a', 'source-b', 'source-c']))
    .toEqual({ kind: 'sources', sourceIds: ['source-a', 'source-b'] });
  await expect(redeemWorkspaceInvitation(engine, invitation.token, 'member@example.test', 'replay'))
    .rejects.toThrow('invalid_or_expired_invitation');
});

test('invitation redemption rejects a different addressed email without consuming the token', async () => {
  const invitation = await createWorkspaceInvitation(engine, {
    workspaceId: 'workspace-1', email: 'member@example.test', role: 'administrator',
    sourceAccess: { mode: 'none' }, actorMembershipId: 'admin-1', requestId: 'invite-2',
  });
  await expect(redeemWorkspaceInvitation(engine, invitation.token, 'other@example.test', 'wrong-email'))
    .rejects.toThrow('invitation_email_mismatch');
  expect(await redeemWorkspaceInvitation(engine, invitation.token, 'member@example.test', 'right-email'))
    .toMatchObject({ role: 'administrator' });
});

test('role and Source Access mutations never change one another', async () => {
  const invitation = await createWorkspaceInvitation(engine, {
    workspaceId: 'workspace-1', email: 'member@example.test', role: 'member', sourceAccess: { mode: 'all' },
    actorMembershipId: 'admin-1', requestId: 'invite-3',
  });
  const member = await redeemWorkspaceInvitation(engine, invitation.token, 'member@example.test', 'redeem-3');
  await setWorkspaceMembershipRole(engine, 'workspace-1', member.membershipId, 'administrator', 'admin-1', 'role-1', 'Approved administrator');
  expect(await resolvePrincipalSourceAccess(engine, { remote: true, principal: { kind: 'member', id: member.membershipId } }, ['source-a']))
    .toEqual({ kind: 'sources', sourceIds: ['source-a'] });

  await setWorkspaceMembershipSourceAccess(engine, 'workspace-1', member.membershipId, { mode: 'none' }, 'admin-1', 'access-1', 'No project access');
  expect((await listWorkspaceMemberships(engine, 'workspace-1')).find(row => row.membershipId === member.membershipId))
    .toMatchObject({ role: 'administrator', sourceAccess: { mode: 'none', sourceIds: [] } });
});

test('rejects empty Specific Sources and never turns an invitation into an implicit membership update', async () => {
  await expect(createWorkspaceInvitation(engine, {
    workspaceId: 'workspace-1', email: 'new@example.test', role: 'member',
    sourceAccess: { mode: 'specific', sourceIds: [] }, actorMembershipId: 'admin-1', requestId: 'empty-specific',
  })).rejects.toThrow('specific_source_access_required');

  await expect(createWorkspaceInvitation(engine, {
    workspaceId: 'workspace-1', email: 'admin@example.test', role: 'member',
    sourceAccess: { mode: 'none' }, actorMembershipId: 'admin-1', requestId: 'existing-member',
  })).rejects.toThrow('membership_already_exists');
  expect((await listWorkspaceMemberships(engine, 'workspace-1')).find(row => row.email === 'admin@example.test')).toMatchObject({
    email: 'admin@example.test', role: 'administrator', status: 'active',
  });
});

// ---------------------------------------------------------------------------
// #68 Task 11 — an Agent-tier invitation carries the shared-state
// acknowledgment. The revision is SERVER-supplied: the browser never gets to
// name which revision it acknowledged, and the confirmation lands in the same
// transaction as the membership, so a Member can never exist unacknowledged.
// ---------------------------------------------------------------------------

async function inviteMember(email: string, requestId: string): Promise<string> {
  const invitation = await createWorkspaceInvitation(engine, {
    workspaceId: 'workspace-1', email, role: 'member', sourceAccess: { mode: 'none' },
    actorMembershipId: 'admin-1', requestId,
  });
  return invitation.token;
}

test('a server-supplied warning revision is confirmed in the same transaction as the membership', async () => {
  const token = await inviteMember('joiner@example.test', 'invite-ack-1');
  const redeemed = await redeemWorkspaceInvitation(
    engine, token, 'joiner@example.test', 'redeem-ack-1', AGENT_WARNING_REVISION,
  );
  expect(await hasConfirmedAgentWarning(engine, 'workspace-1', redeemed.membershipId, AGENT_WARNING_REVISION)).toBe(true);
  const rows = await engine.executeRaw<{ revision: string }>(
    'SELECT revision FROM workspace_agent_warning_confirmations WHERE membership_id=$1',
    [redeemed.membershipId],
  );
  expect(rows).toEqual([{ revision: AGENT_WARNING_REVISION }]);
});

test('omitting the revision records no confirmation at all — Brain tier is unchanged', async () => {
  const token = await inviteMember('brain@example.test', 'invite-ack-2');
  const redeemed = await redeemWorkspaceInvitation(engine, token, 'brain@example.test', 'redeem-ack-2');
  expect(await hasConfirmedAgentWarning(engine, 'workspace-1', redeemed.membershipId, AGENT_WARNING_REVISION)).toBe(false);
  expect(await engine.executeRaw('SELECT revision FROM workspace_agent_warning_confirmations')).toEqual([]);
});

/**
 * The real engine, except that the confirmation INSERT fails.
 *
 * This is the only failure point that lands AFTER the membership row exists and
 * at the confirmation write itself, which is what makes the rollback claim
 * testable: no production seam is added, the injection point is
 * `redeemWorkspaceInvitation`'s own engine parameter. An email mismatch — the
 * failure this test used to force — throws at the top of the transaction, long
 * before the insert is reached, so it could not fail however the insert was
 * written.
 */
function engineFailingTheConfirmationInsert(): typeof engine {
  const guard = (sql: string) => {
    if (sql.includes('workspace_agent_warning_confirmations')) throw new Error('confirmation_insert_failed');
  };
  const wrap = (target: any) => new Proxy(target, {
    get(object, property, receiver) {
      if (property === 'executeRaw') {
        return (sql: string, params?: unknown[]) => { guard(sql); return object.executeRaw(sql, params); };
      }
      if (property === 'transaction') {
        return (run: (tx: unknown) => unknown) => object.transaction((tx: unknown) => run(wrap(tx)));
      }
      const value = Reflect.get(object, property, receiver);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
  return wrap(engine) as typeof engine;
}

test('a redemption that fails at the confirmation write leaves no membership and no confirmation', async () => {
  const token = await inviteMember('rollback@example.test', 'invite-ack-3');
  await expect(redeemWorkspaceInvitation(
    engineFailingTheConfirmationInsert(), token, 'rollback@example.test', 'redeem-ack-3', AGENT_WARNING_REVISION,
  )).rejects.toThrow('confirmation_insert_failed');

  // The membership was created earlier in the same transaction. If the
  // confirmation write ever moved outside that transaction, this Member would
  // survive holding a share of the shared runtime with no acknowledgment.
  expect(await engine.executeRaw(
    `SELECT m.membership_id FROM workspace_memberships m
       JOIN workspace_identities i ON i.identity_id=m.identity_id
      WHERE i.normalized_email=$1`,
    ['rollback@example.test'],
  )).toEqual([]);
  expect(await engine.executeRaw('SELECT revision FROM workspace_agent_warning_confirmations')).toEqual([]);
  // The single-use token was not burned either.
  expect(await engine.executeRaw('SELECT consumed_at FROM workspace_invitations WHERE consumed_at IS NOT NULL')).toEqual([]);
});

// ---------------------------------------------------------------------------
// #68 Task 9 — disabling a Member is one atomic lifecycle: the status
// transition, revoking every live session, and — only on the FIRST
// active→disabled transition — advancing the shared native-password
// generation so a disabled Member's copy of the shared OpenClaw credential
// stops working.
// ---------------------------------------------------------------------------

let sessionSeedCounter = 0;

async function seedTwoSessions(membershipId: string): Promise<void> {
  for (const suffix of ['a', 'b']) {
    sessionSeedCounter += 1;
    await engine.executeRaw(
      "INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at) VALUES ($1,$2,$3,now()+interval '1 day')",
      [`session-hash-${suffix}-${membershipId}-${sessionSeedCounter}`, membershipId, `csrf-hash-${suffix}-${membershipId}-${sessionSeedCounter}`],
    );
  }
}

async function activeSessionCount(membershipId: string): Promise<number> {
  const rows = await engine.executeRaw(
    'SELECT session_hash FROM workspace_sessions WHERE membership_id=$1 AND revoked_at IS NULL',
    [membershipId],
  );
  return rows.length;
}

async function desiredPasswordGeneration(): Promise<number> {
  return (await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.desiredGeneration;
}

async function countRotationOperations(generation: number): Promise<number> {
  const rows = await engine.executeRaw(
    "SELECT operation_id FROM workspace_agent_runtime_operations WHERE operation_type='native_password.rotate' AND generation=$1",
    [generation],
  );
  return rows.length;
}

async function initializeAgent(): Promise<void> {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
}

async function disableMember(requestId: string) {
  return setWorkspaceMembershipStatus(engine, 'workspace-1', 'member-1', 'disabled', 'admin-1', requestId, 'Left the team.');
}

test('active to disabled revokes sessions and advances one password generation', async () => {
  await initializeAgent();
  await seedTwoSessions('member-1');
  const result = await disableMember('disable-1');
  expect(result).toMatchObject({
    membershipId: 'member-1', previousStatus: 'active', status: 'disabled', nativeRotationQueued: true,
  });
  expect(result.nativeRotationOperationId).toBeString();
  expect(await activeSessionCount('member-1')).toBe(0);
  expect(await desiredPasswordGeneration()).toBe(2);
  expect(await countRotationOperations(2)).toBe(1);
  // The exact idempotency key format the brief pins.
  const operations = await engine.executeRaw<{ idempotency_key: string }>(
    'SELECT idempotency_key FROM workspace_agent_runtime_operations WHERE operation_id=$1',
    [result.nativeRotationOperationId],
  );
  expect(operations[0]?.idempotency_key).toBe('member-disabled:member-1:2');
});

test('repeating disabled is idempotent and does not rotate again', async () => {
  await initializeAgent();
  await seedTwoSessions('member-1');
  await disableMember('disable-1');
  // A session planted between the two disable calls must not survive the
  // second one either — the revocation is defensive on every disabled
  // transition, not only the first.
  await seedTwoSessions('member-1');
  const second = await disableMember('disable-2');
  expect(second).toMatchObject({
    previousStatus: 'disabled', status: 'disabled', nativeRotationQueued: false, nativeRotationOperationId: null,
  });
  expect(await activeSessionCount('member-1')).toBe(0);
  expect(await desiredPasswordGeneration()).toBe(2);
  expect(await countRotationOperations(2)).toBe(1);
});

test('disabling a Member before the shared Agent is initialized commits without a rotation', async () => {
  await seedTwoSessions('member-1');
  const result = await disableMember('disable-1');
  expect(result).toMatchObject({
    previousStatus: 'active', status: 'disabled', nativeRotationQueued: false, nativeRotationOperationId: null,
  });
  expect(await activeSessionCount('member-1')).toBe(0);
  expect(await engine.executeRaw('SELECT status FROM workspace_memberships WHERE membership_id=$1', ['member-1']))
    .toEqual([{ status: 'disabled' }]);
});

test('re-activating a disabled Member never rotates or reports queued rotation', async () => {
  await initializeAgent();
  await disableMember('disable-1');
  const reactivated = await setWorkspaceMembershipStatus(engine, 'workspace-1', 'member-1', 'active', 'admin-1', 'reactivate-1', 'Rejoined the team.');
  expect(reactivated).toMatchObject({
    previousStatus: 'disabled', status: 'active', nativeRotationQueued: false, nativeRotationOperationId: null,
  });
  expect(await desiredPasswordGeneration()).toBe(2);
});

test('the status-change notification call in setWorkspaceMembershipStatus still fires (brief step 5: "keep the existing notification")', async () => {
  // Deleting the `createWorkspaceNotificationForEvent` call at the end of
  // `setWorkspaceMembershipStatus` is otherwise invisible to this file: on
  // the `active -> disabled` transition the recipient (the Member being
  // disabled) is no longer active by the time the call runs, so
  // `createWorkspaceNotificationForEvent` itself returns null and writes no
  // row either way (see `activeMembership` gating in notifications.ts). The
  // one transition where the call's effect is actually observable is
  // `disabled -> active`: the reactivated Member IS active again by the time
  // the call runs, so a real `workspace_notifications` row must land.
  await initializeAgent();
  await disableMember('disable-1');
  await setWorkspaceMembershipStatus(engine, 'workspace-1', 'member-1', 'active', 'admin-1', 'reactivate-notify-1', 'Rejoined the team.');
  const rows = await engine.executeRaw<{ event_type: string; recipient_membership_id: string; target_id: string }>(
    "SELECT event_type, recipient_membership_id, target_id FROM workspace_notifications WHERE target_id='member-1' AND event_type='membership_access_changed'",
  );
  expect(rows).toEqual([{ event_type: 'membership_access_changed', recipient_membership_id: 'member-1', target_id: 'member-1' }]);
});

test('refuses to reconcile an operation whose returned generation does not match the one just advanced', async () => {
  // `advanceNativePasswordGenerationInTransaction` has an early-idempotency
  // branch (agent-access.ts) that returns a PRE-EXISTING operation without
  // incrementing anything, when its idempotency key already names a row. That
  // branch is unreachable through this call's own monotonic-generation
  // idempotency-key scheme in normal operation — but the invariant that makes
  // it unreachable lives in a different file. Force the branch by planting a
  // colliding key ahead of time under a DIFFERENT generation, so the guard in
  // memberships.ts must be what catches the mismatch, not luck.
  await initializeAgent();
  await engine.executeRaw(
    `INSERT INTO workspace_agent_runtime_operations
       (operation_id, workspace_id, operation_type, generation, idempotency_key, idempotency_fingerprint, request_id)
     VALUES ('planted-op', 'workspace-1', 'native_password.rotate', 9, 'member-disabled:member-1:2', $1, 'planted-req')`,
    ['f'.repeat(64)],
  );
  await expect(disableMember('disable-mismatch-1')).rejects.toThrow('native_password_generation_advance_mismatch');
  // The whole protected mutation rolled back: no half-applied disable.
  expect(await engine.executeRaw('SELECT status FROM workspace_memberships WHERE membership_id=$1', ['member-1']))
    .toEqual([{ status: 'active' }]);
  expect(await desiredPasswordGeneration()).toBe(1);
});

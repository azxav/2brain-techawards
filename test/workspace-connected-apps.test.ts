import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  ConnectedAppNotFoundError,
  changeConnectedAppAccess,
  connectedAppAccessLevelLimiters,
  listConnectedApps,
  resolveConnectedAppAccess,
  revokeConnectedApp,
} from '../src/workspace/connected-apps.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  await initializeWorkspaceFoundation(engine);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`TRUNCATE TABLE
    workspace_connected_app_policies,
    oauth_tokens,
    oauth_codes,
    oauth_clients,
    workspace_memberships,
    workspace_identities,
    workspace_workspaces
    RESTART IDENTITY CASCADE`);
  await engine.executeRaw(
    "INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Test Workspace', now())",
  );
  await engine.executeRaw(`INSERT INTO workspace_identities
    (identity_id, normalized_email, email_confirmed_at)
    VALUES ('identity-admin', 'admin@example.test', now()),
           ('identity-member', 'member@example.test', now()),
           ('identity-disabled', 'disabled@example.test', now())`);
  await engine.executeRaw(`INSERT INTO workspace_memberships
    (membership_id, workspace_id, identity_id, role, status)
    VALUES ('admin-1', 'workspace-1', 'identity-admin', 'administrator', 'active'),
           ('member-1', 'workspace-1', 'identity-member', 'member', 'active'),
           ('disabled-1', 'workspace-1', 'identity-disabled', 'member', 'disabled')`);
  await engine.executeRaw(`INSERT INTO oauth_clients
    (client_id, client_name, scope)
    VALUES ('client-admin', 'Admin-capable connector', 'read write admin'),
           ('client-read', 'Read-only connector', 'read')`);
  await engine.executeRaw(`INSERT INTO workspace_connected_app_policies
    (membership_id, client_id, configured_access_level, connected_at, updated_at)
    VALUES ('member-1', 'client-admin', 'admin', '2026-01-02T03:04:05Z', now()),
           ('disabled-1', 'client-read', 'read', '2026-02-03T04:05:06Z', now())`);
});

describe('resolveConnectedAppAccess', () => {
  test('reports the exact blockers for each requested access level', () => {
    expect(connectedAppAccessLevelLimiters({
      clientScopes: ['read'], membershipRole: 'administrator', membershipStatus: 'active',
    }, 'write')).toEqual(['client_scope']);
    expect(connectedAppAccessLevelLimiters({
      clientScopes: ['admin'], membershipRole: 'member', membershipStatus: 'active',
    }, 'admin')).toEqual(['membership_role']);
    expect(connectedAppAccessLevelLimiters({
      clientScopes: ['write'], membershipRole: 'member', membershipStatus: 'active',
    }, 'admin')).toEqual(['client_scope', 'membership_role']);
    expect(connectedAppAccessLevelLimiters({
      clientScopes: ['admin'], membershipRole: 'administrator', membershipStatus: 'active',
    }, 'admin')).toEqual([]);
    expect(connectedAppAccessLevelLimiters({
      clientScopes: ['admin'], membershipRole: 'administrator', membershipStatus: 'disabled',
    }, 'read')).toEqual(['membership_status']);
  });

  test('uses the minimum cumulative ceiling and reports its limiter', () => {
    expect(resolveConnectedAppAccess({
      configuredAccessLevel: 'admin',
      clientScopes: ['admin'],
      membershipRole: 'member',
      membershipStatus: 'active',
    })).toEqual({ effectiveAccessLevel: 'write', limitingReason: 'membership_role' });

    expect(resolveConnectedAppAccess({
      configuredAccessLevel: 'write',
      clientScopes: ['read'],
      membershipRole: 'administrator',
      membershipStatus: 'active',
    })).toEqual({ effectiveAccessLevel: 'read', limitingReason: 'client_scope' });
  });

  test('fails closed for inactive or malformed policy state', () => {
    expect(resolveConnectedAppAccess({
      configuredAccessLevel: 'read',
      clientScopes: ['admin'],
      membershipRole: 'administrator',
      membershipStatus: 'disabled',
    })).toEqual({ effectiveAccessLevel: 'none', limitingReason: 'membership_status' });

    expect(resolveConnectedAppAccess({
      configuredAccessLevel: 'unexpected',
      clientScopes: ['admin'],
      membershipRole: 'administrator',
      membershipStatus: 'active',
    })).toEqual({ effectiveAccessLevel: 'none', limitingReason: 'invalid_policy' });
  });
});

describe('Connected App storage service', () => {
  test('lists only a Member own logical connections', async () => {
    const rows = await listConnectedApps(engine, { membershipId: 'member-1', role: 'member' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      membershipId: 'member-1',
      clientId: 'client-admin',
      configuredAccessLevel: 'admin',
      effectiveAccessLevel: 'write',
      limitingReason: 'membership_role',
      unavailableAccessLevelReasons: { admin: ['membership_role'] },
    });
    expect(rows[0]).not.toHaveProperty('memberEmail');
    expect(rows[0]!.connectedAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  test('lists every logical connection for an Administrator, including disabled Members', async () => {
    const rows = await listConnectedApps(engine, { membershipId: 'admin-1', role: 'administrator' });
    expect(rows.map(row => [row.memberEmail, row.effectiveAccessLevel])).toEqual([
      ['disabled@example.test', 'none'],
      ['member@example.test', 'write'],
    ]);
  });

  test('updates an existing policy without replacing connected_at', async () => {
    const before = await engine.executeRaw<{ connected_at: Date }>(`SELECT connected_at
      FROM workspace_connected_app_policies
      WHERE membership_id = 'member-1' AND client_id = 'client-admin'`);

    const changed = await changeConnectedAppAccess(engine, {
      membershipId: 'member-1',
      clientId: 'client-admin',
      accessLevel: 'read',
    });

    expect(changed.configuredAccessLevel).toBe('read');
    const after = await engine.executeRaw<{ connected_at: Date }>(`SELECT connected_at
      FROM workspace_connected_app_policies
      WHERE membership_id = 'member-1' AND client_id = 'client-admin'`);
    expect(new Date(after[0]!.connected_at).toISOString()).toBe(new Date(before[0]!.connected_at).toISOString());
  });

  test('never recreates a missing policy through an update', async () => {
    await expect(changeConnectedAppAccess(engine, {
      membershipId: 'member-1',
      clientId: 'client-read',
      accessLevel: 'read',
    })).rejects.toBeInstanceOf(ConnectedAppNotFoundError);
    expect(await engine.executeRaw(`SELECT 1 FROM workspace_connected_app_policies
      WHERE membership_id = 'member-1' AND client_id = 'client-read'`)).toEqual([]);
  });

  test('rejects invalid levels at the storage boundary', async () => {
    await expect(engine.executeRaw(`INSERT INTO workspace_connected_app_policies
      (membership_id, client_id, configured_access_level)
      VALUES ('admin-1', 'client-admin', 'owner')`)).rejects.toThrow();
  });

  test('revokes the entire pair transactionally', async () => {
    await engine.executeRaw(`INSERT INTO oauth_tokens
      (token_hash, token_type, client_id, scopes, membership_id)
      VALUES ('access-hash', 'access', 'client-admin', '{admin}', 'member-1'),
             ('refresh-hash', 'refresh', 'client-admin', '{admin}', 'member-1')`);
    await engine.executeRaw(`INSERT INTO oauth_codes
      (code_hash, client_id, scopes, code_challenge, redirect_uri, expires_at, membership_id)
      VALUES ('code-hash', 'client-admin', '{admin}', 'challenge', 'https://client.example.test/callback', 9999999999, 'member-1')`);

    await revokeConnectedApp(engine, { membershipId: 'member-1', clientId: 'client-admin' });

    expect(await engine.executeRaw(`SELECT 1 FROM workspace_connected_app_policies
      WHERE membership_id = 'member-1' AND client_id = 'client-admin'`)).toEqual([]);
    expect(await engine.executeRaw(`SELECT 1 FROM oauth_tokens
      WHERE membership_id = 'member-1' AND client_id = 'client-admin'`)).toEqual([]);
    expect(await engine.executeRaw(`SELECT 1 FROM oauth_codes
      WHERE membership_id = 'member-1' AND client_id = 'client-admin'`)).toEqual([]);
  });
});

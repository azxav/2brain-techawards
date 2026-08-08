import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { hashWorkspaceSecret } from '../src/workspace/auth.ts';
import {
  getWorkspaceAgent,
  listWorkspaceAgents,
  registerWorkspaceAgent,
  revokeWorkspaceAgentCredential,
  rotateWorkspaceAgentCredential,
  setWorkspaceAgentOwner,
  setWorkspaceAgentPurpose,
  setWorkspaceAgentScope,
  setWorkspaceAgentSourceAccess,
  setWorkspaceAgentStatus,
  workspaceAgentScopeIncludes,
} from '../src/workspace/agents.ts';
import { initializeBoundWorkspaceAgent } from '../src/workspace/agent-access.ts';
import { resolvePrincipalSourceAccess } from '../src/workspace/source-access.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
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
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-member', 'member@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-member', 'member')");
});

function register(overrides: Partial<Parameters<typeof registerWorkspaceAgent>[1]> = {}) {
  return registerWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', name: 'Docs writer', purpose: 'Keeps onboarding docs current',
    ownerMembershipId: 'admin-1', actorMembershipId: 'admin-1', requestId: 'register-1',
    ...overrides,
  });
}

test('a new Agent defaults to Read scope and No Source Access with a durable owner-backed identity', async () => {
  const registered = await register();
  const agents = await listWorkspaceAgents(engine, 'workspace-1');
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({
    agentId: registered.agentId,
    name: 'Docs writer',
    purpose: 'Keeps onboarding docs current',
    owner: { membershipId: 'admin-1', email: 'admin@example.test' },
    status: 'active',
    scope: 'read',
    sourceAccess: { mode: 'none', sourceIds: [] },
    lastActivityAt: null,
  });
  expect(await resolvePrincipalSourceAccess(engine, { remote: true, principal: { kind: 'agent', id: registered.agentId } }, ['source-a']))
    .toEqual({ kind: 'sources', sourceIds: [] });
});

test('an Agent requires an existing owner Membership in the same Workspace', async () => {
  await expect(register({ ownerMembershipId: 'missing' })).rejects.toThrow('agent_owner_not_found');
  await expect(register({ name: '   ' })).rejects.toThrow('agent_name_required');
  await expect(register({ purpose: '' })).rejects.toThrow('agent_purpose_required');
  await expect(register({ scope: 'root' as never })).rejects.toThrow('invalid_agent_scope');
});

test('credential material is returned once and only its hash is stored', async () => {
  const registered = await register();
  expect(registered.credential.token.length).toBeGreaterThanOrEqual(32);
  const rows = await engine.executeRaw<{ credential_id: string; token_hash: string; credential_type: string }>(
    'SELECT credential_id, token_hash, credential_type FROM workspace_agent_credentials WHERE agent_id=$1', [registered.agentId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].credential_type).toBe('api_key');
  expect(rows[0].token_hash).toBe(hashWorkspaceSecret(registered.credential.token));
  expect(rows[0].token_hash).not.toBe(registered.credential.token);
  const detail = await getWorkspaceAgent(engine, 'workspace-1', registered.agentId);
  expect(JSON.stringify(detail)).not.toContain(registered.credential.token);
  expect(JSON.stringify(detail)).not.toContain(rows[0].token_hash);
  expect(detail.credentials).toHaveLength(1);
  expect(detail.credentials[0]).toMatchObject({ credentialId: registered.credential.credentialId, type: 'api_key', revokedAt: null });
});

test('Agent Scope is cumulative while Source Access stays independently evaluated', async () => {
  expect(workspaceAgentScopeIncludes('read', 'read')).toBe(true);
  expect(workspaceAgentScopeIncludes('read', 'write')).toBe(false);
  expect(workspaceAgentScopeIncludes('write', 'read')).toBe(true);
  expect(workspaceAgentScopeIncludes('write', 'admin')).toBe(false);
  expect(workspaceAgentScopeIncludes('admin', 'read')).toBe(true);
  expect(workspaceAgentScopeIncludes('admin', 'write')).toBe(true);

  const registered = await register();
  await setWorkspaceAgentScope(engine, 'workspace-1', registered.agentId, 'admin', 'admin-1', 'scope-1', 'Approved administrative automation');
  expect(await resolvePrincipalSourceAccess(engine, { remote: true, principal: { kind: 'agent', id: registered.agentId } }, ['source-a']))
    .toEqual({ kind: 'sources', sourceIds: [] });

  await setWorkspaceAgentSourceAccess(engine, 'workspace-1', registered.agentId, { mode: 'specific', sourceIds: ['source-b', 'source-a', 'source-a'] }, 'admin-1', 'access-1', 'Scoped to docs Sources');
  expect(await resolvePrincipalSourceAccess(engine, { remote: true, principal: { kind: 'agent', id: registered.agentId } }, ['source-a', 'source-b', 'source-c']))
    .toEqual({ kind: 'sources', sourceIds: ['source-a', 'source-b'] });
  expect((await listWorkspaceAgents(engine, 'workspace-1'))[0]).toMatchObject({ scope: 'admin', sourceAccess: { mode: 'specific', sourceIds: ['source-a', 'source-b'] } });
});

test('rotation issues new material and revokes the old credential through auditable operations', async () => {
  const registered = await register();
  const rotated = await rotateWorkspaceAgentCredential(engine, 'workspace-1', registered.agentId, 'admin-1', 'rotate-1', 'Scheduled rotation');
  expect(rotated.token).not.toBe(registered.credential.token);
  const credentials = await engine.executeRaw<{ credential_id: string; revoked_at: string | null }>(
    'SELECT credential_id, revoked_at FROM workspace_agent_credentials WHERE agent_id=$1 ORDER BY created_at', [registered.agentId],
  );
  expect(credentials).toHaveLength(2);
  expect(credentials[0].revoked_at).not.toBeNull();
  expect(credentials[1].revoked_at).toBeNull();

  await expect(rotateWorkspaceAgentCredential(engine, 'workspace-1', registered.agentId, 'admin-1', 'rotate-2', ''))
    .rejects.toThrow('reason is required');

  const audits = await engine.executeRaw<{ action: string; outcome: string }>(
    "SELECT action, outcome FROM workspace_audit_events WHERE action='credential.rotate' ORDER BY occurred_at",
  );
  expect(audits).toEqual([{ action: 'credential.rotate', outcome: 'succeeded' }, { action: 'credential.rotate', outcome: 'failed' }]);
  const changes = await engine.executeRaw<{ summary: string }>(
    "SELECT summary FROM workspace_change_events WHERE resource_id=$1 AND summary LIKE '%otated%'", [registered.agentId],
  );
  expect(changes).toHaveLength(1);
});

test('revoking an Agent revokes its active credentials and blocks further rotation', async () => {
  const registered = await register();
  await setWorkspaceAgentStatus(engine, 'workspace-1', registered.agentId, 'revoked', 'admin-1', 'status-1', 'Project finished');
  const detail = await getWorkspaceAgent(engine, 'workspace-1', registered.agentId);
  expect(detail.status).toBe('revoked');
  expect(detail.credentials.every(credential => credential.revokedAt !== null)).toBe(true);
  await expect(rotateWorkspaceAgentCredential(engine, 'workspace-1', registered.agentId, 'admin-1', 'rotate-3', 'Attempt after revocation'))
    .rejects.toThrow('agent_revoked');
});

test('a single credential can be revoked without changing the Agent identity', async () => {
  const registered = await register();
  await revokeWorkspaceAgentCredential(engine, 'workspace-1', registered.agentId, registered.credential.credentialId, 'admin-1', 'revoke-1', 'Leaked in CI logs');
  const detail = await getWorkspaceAgent(engine, 'workspace-1', registered.agentId);
  expect(detail.status).toBe('active');
  expect(detail.credentials[0]!.revokedAt).not.toBeNull();
  await expect(revokeWorkspaceAgentCredential(engine, 'workspace-1', registered.agentId, 'missing', 'admin-1', 'revoke-2', 'No such credential'))
    .rejects.toThrow('credential_not_found');
});

test('an Administrator can change the purpose with a recorded reason', async () => {
  const registered = await register();
  await setWorkspaceAgentPurpose(engine, 'workspace-1', registered.agentId, 'Maintains the release checklist', 'admin-1', 'purpose-1', 'Purpose drifted');
  expect((await listWorkspaceAgents(engine, 'workspace-1'))[0]!.purpose).toBe('Maintains the release checklist');
  await expect(setWorkspaceAgentPurpose(engine, 'workspace-1', registered.agentId, '  ', 'admin-1', 'purpose-2', 'Blank purpose'))
    .rejects.toThrow('agent_purpose_required');
  await expect(setWorkspaceAgentPurpose(engine, 'workspace-1', registered.agentId, 'New purpose', 'admin-1', 'purpose-3', ''))
    .rejects.toThrow('reason is required');
});

test('owner changes require an existing Membership and reasons are recorded', async () => {
  const registered = await register();
  await setWorkspaceAgentOwner(engine, 'workspace-1', registered.agentId, 'member-1', 'admin-1', 'owner-1', 'Handed to docs team');
  expect((await listWorkspaceAgents(engine, 'workspace-1'))[0]!.owner).toEqual({ membershipId: 'member-1', email: 'member@example.test' });
  await expect(setWorkspaceAgentOwner(engine, 'workspace-1', registered.agentId, 'missing', 'admin-1', 'owner-2', 'Bad owner'))
    .rejects.toThrow('agent_owner_not_found');
  await expect(setWorkspaceAgentOwner(engine, 'workspace-1', registered.agentId, 'member-1', 'admin-1', 'owner-3', ''))
    .rejects.toThrow('reason is required');
});

test('generic credential and lifecycle operations refuse the bound OpenClaw Agent', async () => {
  const bound = await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  const agentId = bound.agentId;
  for (const operation of [
    () => setWorkspaceAgentOwner(engine, 'workspace-1', agentId, 'member-1', 'admin-1', 'r0', 'Reassigning the shared Agent.'),
    () => setWorkspaceAgentPurpose(engine, 'workspace-1', agentId, 'Something else', 'admin-1', 'r1', 'Rewriting the shared purpose.'),
    () => rotateWorkspaceAgentCredential(engine, 'workspace-1', agentId, 'admin-1', 'r2', 'manual'),
    () => revokeWorkspaceAgentCredential(engine, 'workspace-1', agentId, 'credential-1', 'admin-1', 'r3', 'manual'),
    () => setWorkspaceAgentStatus(engine, 'workspace-1', agentId, 'revoked', 'admin-1', 'r4', 'manual'),
    () => setWorkspaceAgentScope(engine, 'workspace-1', agentId, 'write', 'admin-1', 'r5', 'manual'),
    () => setWorkspaceAgentSourceAccess(engine, 'workspace-1', agentId, { mode: 'all' }, 'admin-1', 'r6', 'manual'),
  ]) {
    await expect(operation()).rejects.toMatchObject({ code: 'managed_agent_operation_required' });
  }

  // Every refusal left the shared Agent and its grant exactly as bound.
  const detail = await getWorkspaceAgent(engine, 'workspace-1', agentId);
  expect(detail).toMatchObject({
    name: 'OpenClaw',
    purpose: 'Shared OpenClaw runtime for this Workspace',
    owner: { membershipId: 'admin-1' },
    status: 'active',
    scope: 'read',
    sourceAccess: { mode: 'none', sourceIds: [] },
  });
  expect(detail.credentials).toEqual([]);
});

test('ordinary unbound Agents keep every generic lifecycle behavior', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  const registered = await register();

  await setWorkspaceAgentOwner(engine, 'workspace-1', registered.agentId, 'member-1', 'admin-1', 'u1', 'Handed to docs team');
  await setWorkspaceAgentPurpose(engine, 'workspace-1', registered.agentId, 'Maintains the release checklist', 'admin-1', 'u2', 'Purpose drifted');
  await setWorkspaceAgentScope(engine, 'workspace-1', registered.agentId, 'write', 'admin-1', 'u3', 'Needs write operations');
  await setWorkspaceAgentSourceAccess(engine, 'workspace-1', registered.agentId, { mode: 'all' }, 'admin-1', 'u4', 'Docs coverage');
  const rotated = await rotateWorkspaceAgentCredential(engine, 'workspace-1', registered.agentId, 'admin-1', 'u5', 'Scheduled rotation');
  expect(rotated.token).not.toBe(registered.credential.token);
  await revokeWorkspaceAgentCredential(engine, 'workspace-1', registered.agentId, rotated.credentialId, 'admin-1', 'u6', 'Leaked in CI logs');
  await setWorkspaceAgentStatus(engine, 'workspace-1', registered.agentId, 'revoked', 'admin-1', 'u7', 'Project finished');

  const detail = await getWorkspaceAgent(engine, 'workspace-1', registered.agentId);
  expect(detail).toMatchObject({
    owner: { membershipId: 'member-1' },
    purpose: 'Maintains the release checklist',
    status: 'revoked',
    scope: 'write',
    sourceAccess: { mode: 'all' },
  });
});

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createWorkspaceRouter(engine, { requestId: () => 'req-agents-1' }));
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address.');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function issueSession(membershipId: string): Promise<{ cookie: string; csrf: string }> {
  const session = `session-${membershipId}`;
  const csrf = `csrf-${membershipId}`;
  await engine.executeRaw(
    "INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at) VALUES ($1,$2,$3,now()+interval '1 day')",
    [hashWorkspaceSecret(session), membershipId, hashWorkspaceSecret(csrf)],
  );
  return { cookie: `workspace_session=${session}`, csrf };
}

test('every Member can read the safe Directory while only Administrators mutate Agents', async () => {
  const registered = await register();
  const admin = await issueSession('admin-1');
  const member = await issueSession('member-1');
  await withServer(async baseUrl => {
    const directory = await fetch(`${baseUrl}/api/workspace/v1/agents`, { headers: { cookie: member.cookie } });
    expect(directory.status).toBe(200);
    const body = await directory.text();
    expect(body).not.toContain(registered.credential.token);
    expect(body).not.toContain('token_hash');
    expect((JSON.parse(body) as { data: unknown[] }).data).toHaveLength(1);

    const detail = await fetch(`${baseUrl}/api/workspace/v1/agents/${registered.agentId}`, { headers: { cookie: member.cookie } });
    expect(detail.status).toBe(200);

    const forbidden = await fetch(`${baseUrl}/api/workspace/v1/agents`, {
      method: 'POST',
      headers: { cookie: member.cookie, 'content-type': 'application/json', 'x-csrf-token': member.csrf, origin: baseUrl },
      body: JSON.stringify({ name: 'Rogue', purpose: 'Escalate', owner_membership_id: 'member-1' }),
    });
    expect(forbidden.status).toBe(403);

    const created = await fetch(`${baseUrl}/api/workspace/v1/agents`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json', 'x-csrf-token': admin.csrf, origin: baseUrl },
      body: JSON.stringify({ name: 'Sync bot', purpose: 'Synchronizes docs', owner_membership_id: 'member-1' }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: { agent_id: string; credential: { credential_id: string; token: string } } };
    expect(createdBody.data.credential.token.length).toBeGreaterThanOrEqual(32);

    const memberScope = await fetch(`${baseUrl}/api/workspace/v1/agents/${registered.agentId}/scope`, {
      method: 'PATCH',
      headers: { cookie: member.cookie, 'content-type': 'application/json', 'x-csrf-token': member.csrf, origin: baseUrl },
      body: JSON.stringify({ scope: 'admin', reason: 'Nope' }),
    });
    expect(memberScope.status).toBe(403);

    const adminScope = await fetch(`${baseUrl}/api/workspace/v1/agents/${registered.agentId}/scope`, {
      method: 'PATCH',
      headers: { cookie: admin.cookie, 'content-type': 'application/json', 'x-csrf-token': admin.csrf, origin: baseUrl },
      body: JSON.stringify({ scope: 'write', reason: 'Needs write operations' }),
    });
    expect(adminScope.status).toBe(204);

    const rotate = await fetch(`${baseUrl}/api/workspace/v1/agents/${registered.agentId}/credentials/rotate`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json', 'x-csrf-token': admin.csrf, origin: baseUrl },
      body: JSON.stringify({ reason: 'Scheduled rotation' }),
    });
    expect(rotate.status).toBe(201);
    const rotateBody = await rotate.json() as { data: { credential_id: string; token: string } };
    expect(rotateBody.data.token).not.toBe(registered.credential.token);

    const missingReason = await fetch(`${baseUrl}/api/workspace/v1/agents/${registered.agentId}/scope`, {
      method: 'PATCH',
      headers: { cookie: admin.cookie, 'content-type': 'application/json', 'x-csrf-token': admin.csrf, origin: baseUrl },
      body: JSON.stringify({ scope: 'read' }),
    });
    expect(missingReason.status).toBe(400);
    expect(((await missingReason.json()) as { error: { code: string } }).error.code).toBe('reason_required');

    const purpose = await fetch(`${baseUrl}/api/workspace/v1/agents/${registered.agentId}/purpose`, {
      method: 'PATCH',
      headers: { cookie: admin.cookie, 'content-type': 'application/json', 'x-csrf-token': admin.csrf, origin: baseUrl },
      body: JSON.stringify({ purpose: 'Documents the release train', reason: 'Purpose drifted' }),
    });
    expect(purpose.status).toBe(204);

    const missing = await fetch(`${baseUrl}/api/workspace/v1/agents/not-real`, { headers: { cookie: member.cookie } });
    expect(missing.status).toBe(404);
  });
});

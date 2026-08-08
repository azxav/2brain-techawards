import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { operations, type AuthInfo } from '../src/core/operations.ts';
import { runServeHttp } from '../src/commands/serve-http.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { authorizationFromAuthInfo } from '../src/workspace/authorization-context.ts';
import {
  WORKSPACE_FOUNDATION_SCHEMA_VERSION,
  initializeWorkspaceFoundation,
  readWorkspaceFoundationState,
} from '../src/workspace/foundation.ts';
import { hashWorkspaceSecret } from '../src/workspace/auth.ts';
import {
  registerWorkspaceAgent,
  rotateWorkspaceAgentCredential,
  setWorkspaceAgentScope,
  setWorkspaceAgentSourceAccess,
  setWorkspaceAgentStatus,
} from '../src/workspace/agents.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  // The foundation initializer demands a clean database (no non-`workspace_`
  // public tables), so it runs BEFORE initSchema() creates the core brain
  // schema that verifyAccessToken's first query (oauth_tokens) needs.
  await initializeWorkspaceFoundation(engine);
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState TRUNCATEs every public table, including the foundation's
  // `workspace_deployments` singleton. The repo's usual reset pattern
  // (resetWorkspaceFoundationForTest + initializeWorkspaceFoundation, see
  // test/workspace-agents.test.ts) cannot run here: this file also needs the
  // core brain schema, and re-initializing the foundation would trip
  // assertCleanStartDatabase on those core tables. So re-seed the singleton
  // directly, mirroring the initializer, and assert readiness below.
  await engine.executeRaw(
    'INSERT INTO workspace_deployments (singleton, schema_version) VALUES (TRUE, $1)',
    [WORKSPACE_FOUNDATION_SCHEMA_VERSION],
  );
  await readWorkspaceFoundationState(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Test', now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-admin', 'admin@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('admin-1', 'workspace-1', 'identity-admin', 'administrator')");
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES
      ('source-a', 'Granted Source', '{}'::jsonb),
      ('source-b', 'Restricted Source', '{}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO workspace_sources (source_id, workspace_id, name, remote_url, expected_cadence, created_by_membership_id)
     VALUES ('source-a', 'workspace-1', 'Granted Source', 'https://example.test/granted.git', 'manual', 'admin-1')`,
  );
});

function registerAgent(overrides: Partial<Parameters<typeof registerWorkspaceAgent>[1]> = {}) {
  return registerWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', name: 'OpenClaw', purpose: 'Shared workspace agent',
    ownerMembershipId: 'admin-1', actorMembershipId: 'admin-1', requestId: 'register-1',
    ...overrides,
  });
}

const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = await runServeHttp(engine, {
    port: 0, tokenTtl: 60, enableDcr: false, bind: '127.0.0.1', suppressBootstrapToken: true,
  });
  const address = server.address() as { port: number };
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

const stopServer = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); });

async function mcpCall(baseUrl: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  const dataLine = text.split('\n').find(line => line.startsWith('data: '));
  const payload = JSON.parse(dataLine ? dataLine.slice(6) : text) as any;
  return { response, payload };
}

test('an Agent credential authenticates with agent identity, mapped scopes, and a last_used_at stamp', async () => {
  const registered = await registerAgent();
  const auth = await provider().verifyAccessToken(registered.credential.token) as unknown as AuthInfo;
  expect(auth.clientId).toBe(registered.agentId);
  expect(auth.clientName).toBe('OpenClaw');
  expect(auth.scopes).toEqual(['read']);
  expect(auth.agentId).toBe(registered.agentId);
  expect(auth.workspaceId).toBe('workspace-1');
  expect(typeof auth.expiresAt).toBe('number');
  expect(auth.sourceId).toBeUndefined();
  expect(auth.allowedSources).toBeUndefined();
  expect(auth.membershipId).toBeUndefined();
  const used = await engine.executeRaw<{ last_used_at: string | null }>(
    'SELECT last_used_at FROM workspace_agent_credentials WHERE credential_id=$1',
    [registered.credential.credentialId],
  );
  expect(used[0].last_used_at).not.toBeNull();
});

test('Agent Scope maps faithfully onto wire scopes for all three tiers', async () => {
  const registered = await registerAgent();
  expect((await provider().verifyAccessToken(registered.credential.token)).scopes).toEqual(['read']);
  await setWorkspaceAgentScope(engine, 'workspace-1', registered.agentId, 'write', 'admin-1', 'scope-w', 'Write duty');
  expect((await provider().verifyAccessToken(registered.credential.token)).scopes).toEqual(['read', 'write']);
  await setWorkspaceAgentScope(engine, 'workspace-1', registered.agentId, 'admin', 'admin-1', 'scope-a', 'Admin duty');
  expect((await provider().verifyAccessToken(registered.credential.token)).scopes).toEqual(['admin']);
});

test('a revoked credential and a revoked Agent refuse, and never fall through to the legacy grant', async () => {
  const registered = await registerAgent();
  // Plant a legacy admin row with the same token hash: if the agent branch
  // ever falls through instead of refusing, this would grant blanket admin.
  await engine.executeRaw(
    // access_tokens.id is a uuid column, so the trap row uses a literal uuid.
    "INSERT INTO access_tokens (id, name, token_hash) VALUES ('00000000-0000-4000-8000-00000000dead', 'legacy', $1)",
    [hashWorkspaceSecret(registered.credential.token)],
  );
  const rotated = await rotateWorkspaceAgentCredential(engine, 'workspace-1', registered.agentId, 'admin-1', 'rotate-1', 'Rotation');
  // Same trap for the rotated token, so the revoked-Agent assertion below is
  // load-bearing too: without it, a silent fall-through would still "pass".
  await engine.executeRaw(
    "INSERT INTO access_tokens (id, name, token_hash) VALUES ('00000000-0000-4000-8000-00000000beef', 'legacy-rotated', $1)",
    [hashWorkspaceSecret(rotated.token)],
  );
  await expect(provider().verifyAccessToken(registered.credential.token)).rejects.toThrow('Invalid token');
  await setWorkspaceAgentStatus(engine, 'workspace-1', registered.agentId, 'revoked', 'admin-1', 'status-1', 'Decommissioned');
  await expect(provider().verifyAccessToken(rotated.token)).rejects.toThrow('Invalid token');
});

test('an orphaned credential whose Agent row is gone refuses instead of inheriting legacy admin', async () => {
  const registered = await registerAgent();
  await engine.executeRaw(
    "INSERT INTO access_tokens (id, name, token_hash) VALUES ('00000000-0000-4000-8000-00000000cafe', 'legacy', $1)",
    [hashWorkspaceSecret(registered.credential.token)],
  );
  // Force the orphan the FK normally prevents: the credential must still fail
  // closed rather than skipping the branch into the legacy blanket-admin grant.
  await engine.executeRaw('ALTER TABLE workspace_agent_credentials DROP CONSTRAINT IF EXISTS workspace_agent_credentials_agent_id_fkey');
  await engine.executeRaw('DELETE FROM workspace_agents WHERE agent_id=$1', [registered.agentId]);
  try {
    await expect(provider().verifyAccessToken(registered.credential.token)).rejects.toThrow('Invalid token');
  } finally {
    // Restore the FK so the shared engine stays schema-faithful for later
    // tests. The orphaned rows must go first or ADD CONSTRAINT fails validation.
    await engine.executeRaw('DELETE FROM workspace_agent_credentials WHERE agent_id=$1', [registered.agentId]);
    await engine.executeRaw(
      'ALTER TABLE workspace_agent_credentials ADD CONSTRAINT workspace_agent_credentials_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES workspace_agents(agent_id)',
    );
  }
});

test('a granted Source is updatable and searchable over /mcp; an ungranted Source refuses fail-closed', async () => {
  const registered = await registerAgent({ scope: 'write' });
  await setWorkspaceAgentSourceAccess(engine, 'workspace-1', registered.agentId,
    { mode: 'specific', sourceIds: ['source-a'] }, 'admin-1', 'grant-1', 'Docs duty');
  const { server, baseUrl } = await startServer();
  try {
    const write = await mcpCall(baseUrl, registered.credential.token, 'put_page', {
      slug: 'agent/notes', content: '# Agent note', source_id: 'source-a',
    });
    expect(write.response.status).toBe(200);
    expect(write.payload.result.isError).toBeFalsy();
    expect(await engine.executeRaw<{ source_id: string }>(
      "SELECT source_id FROM pages WHERE slug='agent/notes'",
    )).toEqual([{ source_id: 'source-a' }]);

    const read = await mcpCall(baseUrl, registered.credential.token, 'list_pages', {});
    expect(JSON.parse(read.payload.result.content[0].text).map((page: { slug: string }) => page.slug))
      .toEqual(['agent/notes']);

    const denied = await mcpCall(baseUrl, registered.credential.token, 'put_page', {
      slug: 'agent/escape', content: '# Escape', source_id: 'source-b',
    });
    expect(denied.payload.result.isError).toBe(true);
    // Prove this is the write-target Source-Access gate, not an argument-
    // validation error, and that the refusal leaks nothing about the Source.
    expect(JSON.parse(denied.payload.result.content[0].text)).toMatchObject({
      error: 'permission_denied', message: 'Source Access to the write target is required.',
    });
    expect(JSON.stringify(denied.payload)).not.toContain('Restricted Source');
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE slug='agent/escape'")).toEqual([]);
  } finally {
    await stopServer(server);
  }
});

test('No Source Access refuses reads, and localOnly operations refuse even an admin Agent', async () => {
  const registered = await registerAgent({ scope: 'admin' });
  const { server, baseUrl } = await startServer();
  try {
    // Default Source Access is `none` — the read gate refuses fail-closed.
    const read = await mcpCall(baseUrl, registered.credential.token, 'list_pages', {});
    expect(read.payload.result.isError).toBe(true);
    expect(JSON.parse(read.payload.result.content[0].text)).toMatchObject({
      error: 'permission_denied', message: 'Source access is required for this operation.',
    });
    // file_list is a REAL registered operation with scope:admin + localOnly.
    // The wire name below is DERIVED from this entry, so a typo fails the
    // lookup here rather than sliding through as a plausible-looking refusal.
    const fileList = operations.find(op => op.name === 'file_list');
    expect(fileList?.scope).toBe('admin');
    expect(fileList?.localOnly).toBe(true);
    // Layer 1 — the HTTP surface. serve-http never publishes a localOnly op,
    // so an admin Agent's call dies before dispatch with `unknown_operation`.
    // Pinned exactly: if a different layer ever fires instead, that is a
    // change worth seeing, not one to absorb behind a permissive regex.
    const local = await mcpCall(baseUrl, registered.credential.token, fileList!.name, {});
    expect(local.payload.result.isError).toBe(true);
    expect(JSON.parse(local.payload.result.content[0].text)).toMatchObject({
      error: 'unknown_operation', message: `Unknown: ${fileList!.name}`,
    });
    // Layer 2 — dispatch's own guard, which layer 1 shadows over HTTP. Call it
    // directly with the Agent's authorization so defense-in-depth cannot rot
    // silently (the #56 fail-open class).
    const auth = await provider().verifyAccessToken(registered.credential.token) as unknown as AuthInfo;
    const direct = await dispatchToolCall(engine, fileList!.name, {}, {
      authorization: authorizationFromAuthInfo(auth),
    });
    expect(direct.isError).toBe(true);
    expect(JSON.parse(direct.content[0].text as string)).toMatchObject({
      error: 'permission_denied',
      message: 'This operation is available only to trusted local callers.',
    });
  } finally {
    await stopServer(server);
  }
});

test('/ingest refuses an Agent credential outright — put_page on /mcp is the only write path', async () => {
  const registered = await registerAgent({ scope: 'write' });
  await setWorkspaceAgentSourceAccess(engine, 'workspace-1', registered.agentId,
    { mode: 'all' }, 'admin-1', 'grant-2', 'Docs duty');
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${registered.credential.token}`, 'content-type': 'text/markdown' },
      body: '# Smuggled page',
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe('agent_credential_not_accepted');
    // Nothing queued a write into the unchecked default Source.
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id='default'")).toEqual([]);
    // The refusal must fire before ANY side effect: /ingest's real effects are
    // a queued minion job and an mcp_request_log row. Both must be absent.
    expect(await engine.executeRaw("SELECT 1 FROM minion_jobs")).toEqual([]);
    expect(await engine.executeRaw("SELECT 1 FROM mcp_request_log")).toEqual([]);
  } finally {
    await stopServer(server);
  }
});

test('every Agent /mcp call writes an Activity row — success and refusal alike, run_id NULL, content-free', async () => {
  const registered = await registerAgent({ scope: 'write' });
  await setWorkspaceAgentSourceAccess(engine, 'workspace-1', registered.agentId,
    { mode: 'specific', sourceIds: ['source-a'] }, 'admin-1', 'grant-3', 'Docs duty');
  const { server, baseUrl } = await startServer();
  try {
    await mcpCall(baseUrl, registered.credential.token, 'put_page', {
      slug: 'agent/observed', content: '# Observed note', source_id: 'source-a',
    });
    await mcpCall(baseUrl, registered.credential.token, 'put_page', {
      slug: 'agent/refused', content: '# Refused note', source_id: 'source-b',
    });
    const rows = await engine.executeRaw<{ operation: string; outcome: string; source_id: string | null; run_id: string | null }>(
      'SELECT operation, outcome, source_id, run_id FROM workspace_agent_activity WHERE agent_id=$1',
      [registered.agentId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.outcome).sort()).toEqual(['failed', 'succeeded']);
    const success = rows.find(row => row.outcome === 'succeeded')!;
    expect(success).toMatchObject({ operation: 'put_page', source_id: 'source-a', run_id: null });
    expect(rows.find(row => row.outcome === 'failed')!.run_id).toBeNull();
    // The durable record never carries page content or the credential.
    const details = await engine.executeRaw('SELECT redacted_detail FROM workspace_agent_request_details');
    // Non-vacuous: the redaction assertions below only mean something if a
    // detail row exists at all, and if it really carries the call's key names.
    expect(details).toHaveLength(2);
    expect(JSON.stringify(details)).toContain('slug');
    expect(JSON.stringify(details)).not.toContain('Observed note');
    expect(JSON.stringify(details)).not.toContain(registered.credential.token);
  } finally {
    await stopServer(server);
  }
});

test('OAuth clients write no Agent Activity, and a recording failure never fails the operation', async () => {
  const oauthProvider = provider();
  const { clientId, clientSecret } = await oauthProvider.registerClientManual(
    'oauth-bystander', ['client_credentials'], 'read',
  );
  const tokens = await oauthProvider.exchangeClientCredentials(clientId, clientSecret!, 'read');
  const registered = await registerAgent({ scope: 'read' });
  await setWorkspaceAgentSourceAccess(engine, 'workspace-1', registered.agentId,
    { mode: 'specific', sourceIds: ['source-a'] }, 'admin-1', 'grant-4', 'Read duty');
  const { server, baseUrl } = await startServer();
  try {
    await mcpCall(baseUrl, tokens.access_token, 'list_pages', {});
    // Non-vacuous: the OAuth call really reached the handler (it logged), so
    // the empty Agent Activity table below is a decision, not a no-op.
    expect(await engine.executeRaw("SELECT 1 FROM mcp_request_log WHERE operation='list_pages'")).toHaveLength(1);
    expect(await engine.executeRaw('SELECT 1 FROM workspace_agent_activity')).toEqual([]);

    // Break the recorder's tables; the operation must still succeed.
    await engine.executeRaw('DROP TABLE workspace_agent_request_details');
    await engine.executeRaw('DROP TABLE workspace_agent_activity CASCADE');
    const stillWorks = await mcpCall(baseUrl, registered.credential.token, 'list_pages', {});
    expect(stillWorks.response.status).toBe(200);
    expect(stillWorks.payload.result.isError).toBeFalsy();
  } finally {
    await stopServer(server);
    // Recreate the dropped tables for the tests that follow this one.
    // resetPgliteState only TRUNCATEs. The `workspace_deployments` singleton
    // this beforeEach re-seeded makes the initializer take its already-
    // initialized path, so assertCleanStartDatabase is skipped and the
    // CREATE TABLE IF NOT EXISTS set simply restores what was dropped.
    await initializeWorkspaceFoundation(engine);
  }
});

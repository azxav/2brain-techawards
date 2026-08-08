import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { hashWorkspaceSecret } from '../src/workspace/auth.ts';
import { registerWorkspaceAgent } from '../src/workspace/agents.ts';
import {
  listWorkspaceAgentActivity,
  recordWorkspaceAgentActivity,
  recordWorkspaceAgentRun,
} from '../src/workspace/agent-activity.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;
let agentId: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
}, 20_000);

afterAll(async () => engine.disconnect(), 20_000);

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Test', now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-admin', 'admin@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('admin-1', 'workspace-1', 'identity-admin', 'administrator')");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-member', 'member@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-member', 'member')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'member-1', 'specific')");
  await engine.executeRaw("INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', 'member-1', 'allowed-source')");
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id, archived)
    VALUES
      ('allowed-source', 'workspace-1', 'Allowed', 'https://example.test/allowed.git', 'daily', 'completed', 'admin-1', FALSE),
      ('denied-source', 'workspace-1', 'Denied', 'https://example.test/denied.git', 'daily', 'completed', 'admin-1', FALSE)`);
  const registered = await registerWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', name: 'Docs writer', purpose: 'Keeps onboarding docs current',
    ownerMembershipId: 'admin-1', actorMembershipId: 'admin-1', requestId: 'register-1',
  });
  agentId = registered.agentId;
});

function record(overrides: Partial<Parameters<typeof recordWorkspaceAgentActivity>[1]> = {}) {
  return recordWorkspaceAgentActivity(engine, {
    workspaceId: 'workspace-1', agentId, operation: 'knowledge.search', outcome: 'succeeded',
    ...overrides,
  });
}

test('records Agent, structured operation, Source context, target evidence, outcome, timing, and run metadata', async () => {
  const run = await recordWorkspaceAgentRun(engine, {
    workspaceId: 'workspace-1', agentId, correlationId: 'ext-run-7',
    outcome: 'succeeded', endedAt: '2026-07-13T09:00:05Z', metadata: { trigger: 'scheduled sweep' },
  });
  await record({
    runId: run.runId, requestId: 'req-1', operation: 'page.retrieve', latencyMs: 240,
    sourceId: 'allowed-source', pageSlug: 'setup-guide', relationship: 'retrieved',
  });

  const view = await listWorkspaceAgentActivity(engine, {
    workspaceId: 'workspace-1', agentId, viewer: { membershipId: 'admin-1', role: 'administrator' },
  });
  expect(view.oversight).toBe(true);
  expect(view.entries).toHaveLength(1);
  expect(view.entries[0]).toMatchObject({
    operation: 'page.retrieve',
    outcome: 'succeeded',
    latencyMs: 240,
    requestId: 'req-1',
    source: { sourceId: 'allowed-source' },
    page: { sourceId: 'allowed-source', slug: 'setup-guide' },
    relationship: 'retrieved',
    run: { runId: run.runId, correlationId: 'ext-run-7', outcome: 'succeeded' },
  });
  expect(view.entries[0]!.occurredAt).toBeTruthy();
  expect(view.entries[0]!.run!.startedAt).toBeTruthy();
  expect(view.entries[0]!.run!.endedAt).toBeTruthy();
});

test('successful Agent-written Page activity emits one material Knowledge change while reads and failures do not', async () => {
  await record({
    requestId: 'req-write', operation: 'page.write', outcome: 'succeeded',
    sourceId: 'allowed-source', pageSlug: 'setup-guide', relationship: 'written',
  });
  await record({
    requestId: 'req-read', operation: 'page.retrieve', outcome: 'succeeded',
    sourceId: 'allowed-source', pageSlug: 'setup-guide', relationship: 'retrieved',
  });
  await record({
    requestId: 'req-failed-write', operation: 'page.write', outcome: 'failed',
    sourceId: 'allowed-source', pageSlug: 'failed-draft', relationship: 'written',
  });

  const changes = await engine.executeRaw<{
    actor_kind: string; actor_id: string; resource_type: string; resource_id: string; request_id: string;
  }>(
    "SELECT actor_kind, actor_id, resource_type, resource_id, request_id FROM workspace_change_events WHERE resource_type='page'",
  );
  expect(changes).toEqual([{
    actor_kind: 'agent', actor_id: agentId, resource_type: 'page',
    resource_id: 'allowed-source:setup-guide', request_id: 'req-write',
  }]);
});

test('rolls Agent activity back when its material Knowledge change cannot be recorded', async () => {
  await engine.executeRaw(`CREATE FUNCTION reject_agent_page_change() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'injected change failure'; END;
    $$ LANGUAGE plpgsql`);
  await engine.executeRaw(`CREATE TRIGGER reject_agent_page_change
    BEFORE INSERT ON workspace_change_events FOR EACH ROW
    WHEN (NEW.resource_type = 'page') EXECUTE FUNCTION reject_agent_page_change()`);
  try {
    await expect(record({
      requestId: 'req-rollback', operation: 'page.write', outcome: 'succeeded',
      sourceId: 'allowed-source', pageSlug: 'rollback-guide', relationship: 'written',
      requestDetail: { redacted: { operation_kind: 'write' } },
    })).rejects.toThrow('injected change failure');
    expect(await engine.executeRaw("SELECT activity_id FROM workspace_agent_activity WHERE request_id='req-rollback'"))
      .toEqual([]);
    expect(await engine.executeRaw('SELECT activity_id FROM workspace_agent_request_details')).toEqual([]);
  } finally {
    await engine.executeRaw('DROP TRIGGER reject_agent_page_change ON workspace_change_events');
    await engine.executeRaw('DROP FUNCTION reject_agent_page_change()');
  }
});

test('relationship labels require corresponding Page evidence and structured fields are validated', async () => {
  await expect(record({ relationship: 'retrieved' })).rejects.toThrow('invalid_activity_evidence');
  await expect(record({ sourceId: 'allowed-source', relationship: 'written' })).rejects.toThrow('invalid_activity_evidence');
  await expect(record({ pageSlug: 'orphan-page' })).rejects.toThrow('invalid_activity_evidence');
  await expect(record({ relationship: 'used_by' as never, sourceId: 'allowed-source', pageSlug: 'x' })).rejects.toThrow('invalid_activity_record');
  await expect(record({ operation: '   ' })).rejects.toThrow('invalid_activity_record');
  await expect(record({ outcome: 'partial' as never })).rejects.toThrow('invalid_activity_record');
  await expect(record({ agentId: 'missing' })).rejects.toThrow('agent_not_found');
  await expect(record({ runId: 'missing-run' })).rejects.toThrow('run_not_found');
  await expect(record({ sourceId: 'not-a-workspace-source' })).rejects.toThrow('source_not_found');
});

test('raw prompts and full request parameters are neither stored nor exposed by default', async () => {
  await record({
    sourceId: 'allowed-source',
    requestDetail: { redacted: { operation_kind: 'search', prompt: 'summarize the secret roadmap', result_count: 3 } },
  });
  const stored = await engine.executeRaw<{ redacted_detail: unknown; full_parameters: unknown }>(
    'SELECT redacted_detail, full_parameters FROM workspace_agent_request_details',
  );
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored[0]!.redacted_detail)).not.toContain('summarize the secret roadmap');
  expect(stored[0]!.full_parameters).toBeNull();

  await expect(record({
    requestDetail: { redacted: { operation_kind: 'search' }, fullParameters: { q: 'complete parameters' } },
  })).rejects.toThrow('full_parameters_disabled');
});

test('ordinary Members see only activity involving Sources they can currently access, without Request Detail', async () => {
  await record({ sourceId: 'allowed-source', pageSlug: 'setup-guide', relationship: 'cited', requestDetail: { redacted: { operation_kind: 'cite' } } });
  await record({ sourceId: 'denied-source', operation: 'page.write' });
  await record({ operation: 'agent.self_check' });

  const view = await listWorkspaceAgentActivity(engine, {
    workspaceId: 'workspace-1', agentId, viewer: { membershipId: 'member-1', role: 'member' },
  });
  expect(view.oversight).toBe(false);
  expect(view.entries).toHaveLength(1);
  expect(view.entries[0]).toMatchObject({ source: { sourceId: 'allowed-source' }, relationship: 'cited' });
  const payload = JSON.stringify(view);
  expect(payload).not.toContain('denied-source');
  expect(payload).not.toContain('requestDetail');
  expect(payload).not.toContain('agent.self_check');
});

test('Administrators inspect complete structured activity through the explicit oversight exception', async () => {
  await record({ sourceId: 'denied-source', operation: 'page.write', pageSlug: 'release-notes', relationship: 'written' });
  await record({ operation: 'agent.self_check', outcome: 'failed', requestDetail: { redacted: { operation_kind: 'health' } } });

  const view = await listWorkspaceAgentActivity(engine, {
    workspaceId: 'workspace-1', agentId, viewer: { membershipId: 'admin-1', role: 'administrator' },
  });
  expect(view.oversight).toBe(true);
  expect(view.entries).toHaveLength(2);
  const detailed = view.entries.find(entry => entry.operation === 'agent.self_check')!;
  expect(detailed.requestDetail).toMatchObject({ redacted: { operation_kind: 'health' } });
  expect(detailed.requestDetail!.capturedAt).toBeTruthy();
  const undetailed = view.entries.find(entry => entry.operation === 'page.write')!;
  expect(undetailed.requestDetail).toBeUndefined();
  await expect(listWorkspaceAgentActivity(engine, {
    workspaceId: 'workspace-1', agentId: 'missing', viewer: { membershipId: 'admin-1', role: 'administrator' },
  })).rejects.toThrow('agent_not_found');
});

test('explicitly enabled full parameters are classified for seven-day retention and expire from every payload', async () => {
  const recorded = await record({
    sourceId: 'allowed-source',
    requestDetail: {
      redacted: { operation_kind: 'search' },
      fullParameters: { q: 'complete parameter capture' },
      fullParametersEnabled: true,
    },
  });
  const stored = await engine.executeRaw<{ captured_at: string; full_parameters_expire_at: string }>(
    'SELECT captured_at, full_parameters_expire_at FROM workspace_agent_request_details WHERE activity_id=$1',
    [recorded.activityId],
  );
  const retention = new Date(stored[0]!.full_parameters_expire_at).getTime() - new Date(stored[0]!.captured_at).getTime();
  expect(retention).toBe(7 * 24 * 60 * 60 * 1000);

  const admin = { membershipId: 'admin-1', role: 'administrator' as const };
  const before = await listWorkspaceAgentActivity(engine, { workspaceId: 'workspace-1', agentId, viewer: admin });
  expect(before.entries[0]!.requestDetail!.fullParameters).toEqual({ q: 'complete parameter capture' });

  await engine.executeRaw("UPDATE workspace_agent_request_details SET full_parameters_expire_at=now() - interval '1 minute'");
  const after = await listWorkspaceAgentActivity(engine, { workspaceId: 'workspace-1', agentId, viewer: admin });
  expect(after.entries[0]!.requestDetail).toBeDefined();
  expect(after.entries[0]!.requestDetail!.fullParameters).toBeUndefined();

  // Reading enforces the retention classification by purging expired captures.
  const purged = await engine.executeRaw<{ full_parameters: unknown; redacted_detail: unknown }>(
    'SELECT full_parameters, redacted_detail FROM workspace_agent_request_details WHERE activity_id=$1',
    [recorded.activityId],
  );
  expect(purged[0]!.full_parameters).toBeNull();
  expect(purged[0]!.redacted_detail).not.toBeNull();

  const memberView = await listWorkspaceAgentActivity(engine, {
    workspaceId: 'workspace-1', agentId, viewer: { membershipId: 'member-1', role: 'member' },
  });
  expect(JSON.stringify(memberView)).not.toContain('complete parameter capture');
});

test('the activity view reports truncation instead of implying completeness beyond the page limit', async () => {
  await engine.executeRaw(
    `INSERT INTO workspace_agent_activity (activity_id, agent_id, operation, outcome, occurred_at)
     SELECT 'bulk-' || lpad(i::text, 4, '0'), $1, 'knowledge.search', 'succeeded', now() - (i || ' seconds')::interval
       FROM generate_series(1, 201) AS i`,
    [agentId],
  );
  const view = await listWorkspaceAgentActivity(engine, {
    workspaceId: 'workspace-1', agentId, viewer: { membershipId: 'admin-1', role: 'administrator' },
  });
  expect(view.truncated).toBe(true);
  expect(view.entries).toHaveLength(200);

  const small = await listWorkspaceAgentActivity(engine, {
    workspaceId: 'workspace-1', agentId: (await registerWorkspaceAgent(engine, {
      workspaceId: 'workspace-1', name: 'Quiet agent', purpose: 'Has almost no activity',
      ownerMembershipId: 'admin-1', actorMembershipId: 'admin-1', requestId: 'register-2',
    })).agentId,
    viewer: { membershipId: 'admin-1', role: 'administrator' },
  });
  expect(small.truncated).toBe(false);
});

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createWorkspaceRouter(engine, { requestId: () => 'req-activity-1' }));
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

async function issueSession(membershipId: string): Promise<{ cookie: string }> {
  const session = `session-${membershipId}`;
  await engine.executeRaw(
    "INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at) VALUES ($1,$2,$3,now()+interval '1 day')",
    [hashWorkspaceSecret(session), membershipId, hashWorkspaceSecret(`csrf-${membershipId}`)],
  );
  return { cookie: `workspace_session=${session}` };
}

test('the activity API serves the Member-filtered view and the Administrator oversight view', async () => {
  await record({ sourceId: 'allowed-source', pageSlug: 'setup-guide', relationship: 'retrieved', requestDetail: { redacted: { operation_kind: 'read' } } });
  await record({ sourceId: 'denied-source', operation: 'page.write' });
  const admin = await issueSession('admin-1');
  const member = await issueSession('member-1');
  await withServer(async baseUrl => {
    const unauthenticated = await fetch(`${baseUrl}/api/workspace/v1/agents/${agentId}/activity`);
    expect(unauthenticated.status).toBe(401);

    const memberResponse = await fetch(`${baseUrl}/api/workspace/v1/agents/${agentId}/activity`, { headers: { cookie: member.cookie } });
    expect(memberResponse.status).toBe(200);
    const memberBody = await memberResponse.text();
    const memberData = (JSON.parse(memberBody) as { data: { oversight: boolean; entries: unknown[] } }).data;
    expect(memberData.oversight).toBe(false);
    expect(memberData.entries).toHaveLength(1);
    expect(memberBody).not.toContain('denied-source');
    expect(memberBody).not.toContain('request_detail');

    const adminResponse = await fetch(`${baseUrl}/api/workspace/v1/agents/${agentId}/activity`, { headers: { cookie: admin.cookie } });
    expect(adminResponse.status).toBe(200);
    const adminData = (await adminResponse.json() as { data: { oversight: boolean; entries: { operation: string; request_detail?: { redacted: unknown } }[] } }).data;
    expect(adminData.oversight).toBe(true);
    expect(adminData.entries).toHaveLength(2);
    expect(adminData.entries.find(entry => entry.operation === 'knowledge.search')?.request_detail).toMatchObject({ redacted: { operation_kind: 'read' } });

    const missing = await fetch(`${baseUrl}/api/workspace/v1/agents/not-real/activity`, { headers: { cookie: member.cookie } });
    expect(missing.status).toBe(404);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashWorkspaceSecret } from '../src/workspace/auth.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { getWorkspaceHome } from '../src/workspace/home.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { appDocument } from '../src/web/workspace-shell.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
}, 20_000);

afterAll(async () => {
  await engine.disconnect();
}, 20_000);

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Trust Workspace', now())");
  await engine.executeRaw(`INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES
    ('identity-admin', 'admin@example.test', now()),
    ('identity-member', 'member@example.test', now())`);
  await engine.executeRaw(`INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES
    ('admin-1', 'workspace-1', 'identity-admin', 'administrator'),
    ('member-1', 'workspace-1', 'identity-member', 'member')`);
  await engine.executeRaw(`INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES
    ('member', 'admin-1', 'all'), ('member', 'member-1', 'specific')`);
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state,
     created_by_membership_id, last_verified_at, last_sync_at, last_synced_revision)
    VALUES
    ('docs-source', 'workspace-1', 'Team Docs', 'https://example.test/docs.git', 'daily', 'completed', 'admin-1', '2026-07-14T08:00:00Z', '2026-07-14T08:00:00Z', 'docs-rev'),
    ('secret-source', 'workspace-1', 'Secret Plans', 'https://example.test/secret.git', 'daily', 'completed', 'admin-1', '2026-07-10T08:00:00Z', '2026-07-10T08:00:00Z', 'secret-rev')`);
  await engine.executeRaw("INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', 'member-1', 'docs-source')");
});

async function seedAttention(): Promise<void> {
  await engine.executeRaw(`INSERT INTO workspace_condition_episodes
    (episode_id, workspace_id, category, condition_type, resource_type, resource_id)
    VALUES
    ('episode-docs', 'workspace-1', 'source_health', 'source_stale', 'source', 'docs-source'),
    ('episode-secret', 'workspace-1', 'source_health', 'source_stale', 'source', 'secret-source'),
    ('episode-agent', 'workspace-1', 'agent_access', 'agent_risky_access', 'agent', 'agent-1')`);
  await engine.executeRaw(`INSERT INTO workspace_attention_items
    (item_id, workspace_id, episode_id, category, condition_type, resource_type, resource_id, summary, evidence, status)
    VALUES
    ('attention-docs', 'workspace-1', 'episode-docs', 'source_health', 'source_stale', 'source', 'docs-source', 'Team Docs needs verification', '{}', 'open'),
    ('attention-secret', 'workspace-1', 'episode-secret', 'source_health', 'source_stale', 'source', 'secret-source', 'Secret Plans needs verification', '{}', 'open'),
    ('attention-agent', 'workspace-1', 'episode-agent', 'agent_access', 'agent_risky_access', 'agent', 'agent-1', 'Agent has risky access', '{}', 'open')`);
}

async function seedOperations(): Promise<void> {
  await engine.executeRaw(`INSERT INTO workspace_background_operations
    (operation_id, workspace_id, operation_type, initiator_membership_id, resource_type, resource_id,
     state, progress, idempotency_key, idempotency_fingerprint, request_id)
    VALUES
    ('operation-docs', 'workspace-1', 'source.sync', 'admin-1', 'source', 'docs-source', 'running', 40, 'docs-op', 'docs-fp', 'req-docs-op'),
    ('operation-secret', 'workspace-1', 'source.sync', 'admin-1', 'source', 'secret-source', 'failed', 60, 'secret-op', 'secret-fp', 'req-secret-op')`);
}

async function seedChanges(): Promise<void> {
  await engine.executeRaw(`INSERT INTO workspace_agents
    (agent_id, workspace_id, name, purpose, owner_membership_id, created_by_membership_id)
    VALUES ('agent-1', 'workspace-1', 'Docs Agent', 'Maintains permitted docs', 'admin-1', 'admin-1')`);
  await engine.executeRaw(`INSERT INTO workspace_change_events
    (event_id, workspace_id, actor_kind, actor_id, resource_type, resource_id, summary, request_id, occurred_at)
    VALUES
    ('change-docs', 'workspace-1', 'member', 'admin-1', 'source', 'docs-source', 'Synchronized Team Docs.', 'req-change-docs', '2026-07-14T08:15:00Z'),
    ('change-page', 'workspace-1', 'agent', 'agent-1', 'page', 'docs-source:handbook', 'Updated the team handbook.', 'req-change-page', '2026-07-14T08:14:00Z'),
    ('change-agent', 'workspace-1', 'member', 'admin-1', 'agent', 'agent-1', 'Changed Docs Agent access.', 'req-change-agent', '2026-07-14T08:13:30Z'),
    ('change-attention', 'workspace-1', 'member', 'admin-1', 'attention_item', 'attention-docs', 'Moved an Attention Item to In progress.', 'req-change-attention', '2026-07-14T08:13:00Z'),
    ('change-secret', 'workspace-1', 'member', 'admin-1', 'source', 'secret-source', 'Changed Secret Plans.', 'req-change-secret', '2026-07-14T08:12:30Z'),
    ('change-self-access', 'workspace-1', 'member', 'admin-1', 'membership', 'member-1', 'Changed your Source Access.', 'req-change-self', '2026-07-14T08:12:00Z'),
    ('change-login', 'workspace-1', 'member', 'member-1', 'workspace', 'workspace-1', 'Signed in to a Workspace.', 'req-login', '2026-07-14T08:11:00Z')`);
}

async function issueSession(membershipId: string): Promise<string> {
  const session = `session-${membershipId}`;
  await engine.executeRaw(
    "INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at) VALUES ($1,$2,$3,now()+interval '1 day')",
    [hashWorkspaceSecret(session), membershipId, hashWorkspaceSecret(`csrf-${membershipId}`)],
  );
  return `workspace_session=${session}`;
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createWorkspaceRouter(engine, { requestId: () => 'req-home-1' }));
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

describe('Workspace Home trust projection', () => {
  test('a Member sees only authorized evidence-linked trust, Attention, operations, and material changes', async () => {
    await seedAttention();
    await seedOperations();
    await seedChanges();

    const home = await getWorkspaceHome(engine, {
      workspaceId: 'workspace-1',
      viewer: { membershipId: 'member-1', role: 'member' },
      now: '2026-07-14T09:00:00Z',
    });

    expect(home.trustSummary.map(statement => statement.summary)).toEqual([
      'Team Docs is current. It was verified within its daily cadence.',
      '1 active Attention item needs review.',
      '1 Background Operation is active.',
    ]);
    expect(home.attention.map(item => item.itemId)).toEqual(['attention-docs']);
    expect(home.operations.map(operation => operation.operationId)).toEqual(['operation-docs']);
    expect(home.recentChanges.map(change => change.eventId)).toEqual([
      'change-docs', 'change-page', 'change-agent', 'change-attention', 'change-self-access',
    ]);
    expect(home.recentChanges.find(change => change.eventId === 'change-agent')?.evidence.href)
      .toBe('/app/agents#agent-agent-1');
    expect(home.recentChanges.find(change => change.eventId === 'change-attention')?.evidence.href)
      .toBe('/app/attention?status=all#attention-attention-docs');

    const serialized = JSON.stringify(home);
    expect(serialized).not.toContain('Secret Plans');
    expect(serialized).not.toContain('attention-agent');
    expect(serialized).not.toContain('Signed in');
    expect(serialized).not.toMatch(/score|percentage|chart|metric/i);
    for (const linked of [
      ...home.trustSummary,
      ...home.attention,
      ...home.operations,
      ...home.recentChanges,
    ]) {
      expect(linked.evidence.href).toStartWith('/app');
      expect(linked.evidence.label.length).toBeGreaterThan(0);
    }
  });

  test('an Administrator receives full operational evidence while ordinary Workspace events stay excluded', async () => {
    await seedAttention();
    await seedOperations();
    await seedChanges();

    const home = await getWorkspaceHome(engine, {
      workspaceId: 'workspace-1',
      viewer: { membershipId: 'admin-1', role: 'administrator' },
      now: '2026-07-14T09:00:00Z',
    });

    expect(home.trustSummary.map(statement => statement.summary)).toContain(
      'Secret Plans is stale. Its verification is overdue for its daily cadence.',
    );
    expect(home.attention.map(item => item.itemId)).toEqual([
      'attention-agent', 'attention-secret', 'attention-docs',
    ]);
    expect(home.operations.map(operation => operation.operationId)).toEqual([
      'operation-secret', 'operation-docs',
    ]);
    expect(home.recentChanges.map(change => change.eventId)).toContain('change-secret');
    expect(home.recentChanges.map(change => change.eventId)).not.toContain('change-login');
  });

  test('Home rejects stale Attention for archived Sources while administrators retain archive and operation evidence', async () => {
    await engine.executeRaw(`INSERT INTO workspace_sources
      (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state,
       created_by_membership_id, archived)
      VALUES ('archived-source', 'workspace-1', 'Archived Docs', 'https://example.test/archived.git',
              'daily', 'completed', 'admin-1', TRUE)`);
    await engine.executeRaw("INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', 'member-1', 'archived-source')");
    await engine.executeRaw(`INSERT INTO workspace_condition_episodes
      (episode_id, workspace_id, category, condition_type, resource_type, resource_id)
      VALUES ('episode-archived', 'workspace-1', 'source_health', 'source_stale', 'source', 'archived-source')`);
    await engine.executeRaw(`INSERT INTO workspace_attention_items
      (item_id, workspace_id, episode_id, category, condition_type, resource_type, resource_id, summary, evidence, status)
      VALUES ('attention-archived', 'workspace-1', 'episode-archived', 'source_health', 'source_stale',
              'source', 'archived-source', 'Archived Docs needs verification', '{}', 'open')`);
    await engine.executeRaw(`INSERT INTO workspace_background_operations
      (operation_id, workspace_id, operation_type, initiator_membership_id, resource_type, resource_id,
       state, progress, idempotency_key, idempotency_fingerprint, request_id)
      VALUES ('operation-archive', 'workspace-1', 'source.permanent_delete', 'admin-1', 'source', 'archived-source',
              'running', 25, 'archive-op', 'archive-fp', 'req-archive-op')`);
    await engine.executeRaw(`INSERT INTO workspace_change_events
      (event_id, workspace_id, actor_kind, actor_id, resource_type, resource_id, summary, request_id)
      VALUES ('change-archive', 'workspace-1', 'member', 'admin-1', 'source', 'archived-source',
              'Archived a Source.', 'req-archive')`);

    const member = await getWorkspaceHome(engine, {
      workspaceId: 'workspace-1', viewer: { membershipId: 'member-1', role: 'member' },
      now: '2026-07-14T09:00:00Z',
    });
    expect(JSON.stringify(member)).not.toContain('archived-source');
    expect(JSON.stringify(member)).not.toContain('Archived Docs');

    const admin = await getWorkspaceHome(engine, {
      workspaceId: 'workspace-1', viewer: { membershipId: 'admin-1', role: 'administrator' },
      now: '2026-07-14T09:00:00Z',
    });
    expect(admin.attention.map(item => item.itemId)).not.toContain('attention-archived');
    expect(admin.operations.map(operation => operation.operationId)).toContain('operation-archive');
    expect(admin.recentChanges.map(change => change.eventId)).toContain('change-archive');
    expect(admin.recentChanges.find(change => change.eventId === 'change-archive')?.evidence.href)
      .toBe('/app/settings/sources?state=archived#source-archived-source');
  });

  test('preview limits do not undercount trust conditions or hide authorized material changes', async () => {
    await seedAttention();
    await seedOperations();
    await engine.executeRaw(`INSERT INTO workspace_condition_episodes
      (episode_id, workspace_id, category, condition_type, resource_type, resource_id)
      VALUES ('episode-docs-2', 'workspace-1', 'knowledge_quality', 'knowledge.missing_evidence', 'page', 'docs-source:guide')`);
    await engine.executeRaw(`INSERT INTO workspace_attention_items
      (item_id, workspace_id, episode_id, category, condition_type, resource_type, resource_id, summary, evidence, status)
      VALUES ('attention-docs-2', 'workspace-1', 'episode-docs-2', 'knowledge_quality', 'knowledge.missing_evidence',
              'page', 'docs-source:guide', 'Guide needs evidence', '{}', 'open')`);
    await engine.executeRaw(`INSERT INTO workspace_background_operations
      (operation_id, workspace_id, operation_type, initiator_membership_id, resource_type, resource_id,
       state, progress, idempotency_key, idempotency_fingerprint, request_id)
      VALUES ('operation-docs-2', 'workspace-1', 'source.verify', 'admin-1', 'source', 'docs-source',
              'queued', 0, 'docs-op-2', 'docs-fp-2', 'req-docs-op-2')`);
    await engine.executeRaw(`INSERT INTO workspace_change_events
      (event_id, workspace_id, actor_kind, actor_id, resource_type, resource_id, summary, request_id, occurred_at)
      SELECT 'noise-' || value, 'workspace-1', 'member', 'member-1', 'workspace', 'workspace-1',
             'Viewed Workspace.', 'req-noise-' || value, '2026-07-14T08:30:00Z'::timestamptz + value * interval '1 second'
        FROM generate_series(1, 60) value`);
    await engine.executeRaw(`INSERT INTO workspace_change_events
      (event_id, workspace_id, actor_kind, actor_id, resource_type, resource_id, summary, request_id, occurred_at)
      VALUES ('older-authorized', 'workspace-1', 'member', 'admin-1', 'source', 'docs-source',
              'Verified Team Docs.', 'req-older-authorized', '2026-07-14T08:00:00Z')`);

    const home = await getWorkspaceHome(engine, {
      workspaceId: 'workspace-1', viewer: { membershipId: 'member-1', role: 'member' },
      now: '2026-07-14T09:00:00Z', limit: 1,
    });
    expect(home.attention).toHaveLength(1);
    expect(home.operations).toHaveLength(1);
    expect(home.trustSummary.map(statement => statement.summary)).toContain('2 active Attention items need review.');
    expect(home.trustSummary.map(statement => statement.summary)).toContain('2 Background Operations are active.');
    expect(home.recentChanges.map(change => change.eventId)).toEqual(['older-authorized']);
  });

  test('empty authorized sections have explicit causes rather than fabricated activity', async () => {
    const home = await getWorkspaceHome(engine, {
      workspaceId: 'workspace-1',
      viewer: { membershipId: 'member-1', role: 'member' },
      now: '2026-07-14T09:00:00Z',
    });

    expect(home.attention).toEqual([]);
    expect(home.operations).toEqual([]);
    expect(home.recentChanges).toEqual([]);
    expect(home.empty).toEqual({
      attention: 'No active Attention needs review.',
      operations: 'No active or recently failed Background Operations.',
      recentChanges: 'No recent material changes.',
    });
  });

  test('the authenticated Home API and canvas expose the same safe evidence projection', async () => {
    await seedAttention();
    await seedOperations();
    await seedChanges();
    // This test exercises the real HTTP boundary, which has no `now` seam —
    // freshness is judged against the wall clock. The shared fixed-date seed
    // ages out of its daily cadence in real time, so re-stamp the verification
    // to one hour ago to keep "Team Docs is current" true on any run date.
    await engine.executeRaw(
      "UPDATE workspace_sources SET last_verified_at=$1, last_sync_at=$1 WHERE source_id='docs-source'",
      [new Date(Date.now() - 60 * 60 * 1000).toISOString()],
    );
    const cookie = await issueSession('member-1');
    const directHome = await getWorkspaceHome(engine, {
      workspaceId: 'workspace-1', viewer: { membershipId: 'member-1', role: 'member' },
    });
    expect(appDocument('Trust Workspace', 'member', 'specific', '/app', {
      memberHomeState: 'ready', view: directHome,
    })).toContain('Trust Summary');

    await withServer(async baseUrl => {
      expect((await fetch(`${baseUrl}/api/workspace/v1/home`)).status).toBe(401);
      const response = await fetch(`${baseUrl}/api/workspace/v1/home`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        data: {
          trust_summary: Array<{ summary: string; evidence: { href: string } }>;
          attention: Array<{ item_id: string }>;
          operations: Array<{ operation_id: string }>;
          recent_changes: Array<{ event_id: string }>;
        };
      };
      expect(body.data.attention.map(item => item.item_id)).toEqual(['attention-docs']);
      expect(body.data.operations.map(item => item.operation_id)).toEqual(['operation-docs']);
      expect(body.data.recent_changes.map(item => item.event_id)).toEqual([
        'change-docs', 'change-page', 'change-agent', 'change-attention', 'change-self-access',
      ]);
      expect(body.data.trust_summary.every(statement => statement.evidence.href.startsWith('/app'))).toBe(true);
      expect(JSON.stringify(body)).not.toContain('Secret Plans');

      const html = await (await fetch(`${baseUrl}/app`, { headers: { cookie } })).text();
      expect(html).toContain('Trust Summary');
      expect(html).toContain('Team Docs is current');
      expect(html).toContain('Team Docs needs verification');
      expect(html).toContain('Background Operations');
      expect(html).toContain('Recent changes');
      expect(html).toContain('Updated the team handbook');
      expect(html).toContain('Refresh Home');
      expect(html).toContain('Last Trustworthy State');
      expect(html).toContain('workspaceApplyLiveUpdates');
      expect(html).not.toContain('Secret Plans');
      expect(html).not.toContain('Signed in to a Workspace');
      expect(html).not.toMatch(/trust score|productivity score|executive BI/i);
    });
  });
});

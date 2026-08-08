import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashWorkspaceSecret } from '../src/workspace/auth.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  getWorkspaceMemberHomeState,
  getWorkspaceSetupChecklist,
  recordWorkspacePageProvenanceInspection,
} from '../src/workspace/setup-checklist.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
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
  await engine.executeRaw('DROP TABLE IF EXISTS ingest_log');
  await engine.executeRaw('DROP TABLE IF EXISTS pages');
  await engine.executeRaw('DROP TABLE IF EXISTS sources');
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await seedWorkspace();
});

async function seedWorkspace(): Promise<void> {
  await engine.executeRaw(
    "INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Trust Workspace', now())",
  );
  await engine.executeRaw(`INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES
    ('identity-admin', 'admin@example.test', now()),
    ('identity-member', 'member@example.test', now())`);
  await engine.executeRaw(`INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES
    ('admin-1', 'workspace-1', 'identity-admin', 'administrator'),
    ('member-1', 'workspace-1', 'identity-member', 'member')`);
  await engine.executeRaw(
    "INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'admin-1', 'all'), ('member', 'member-1', 'none')",
  );
}

async function connectSource(sourceId = 'docs-source'): Promise<void> {
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id)
    VALUES ($1, 'workspace-1', 'Docs', 'https://example.test/docs.git', 'daily', 'completed', 'admin-1')`, [sourceId]);
}

async function completeSynchronization(sourceId = 'docs-source'): Promise<void> {
  await engine.executeRaw(
    "UPDATE workspace_sources SET last_sync_at=now(), last_synced_revision='rev-1' WHERE source_id=$1",
    [sourceId],
  );
}

async function inviteMember(): Promise<void> {
  await engine.executeRaw(`INSERT INTO workspace_invitations
    (invitation_id, workspace_id, normalized_email, role, access_mode, token_hash, invited_by_membership_id, expires_at)
    VALUES ('invitation-1', 'workspace-1', 'invitee@example.test', 'member', 'specific', 'token-hash-1', 'admin-1', now() + interval '7 days')`);
}

async function registerAgent(): Promise<void> {
  await engine.executeRaw(`INSERT INTO workspace_agents
    (agent_id, workspace_id, name, purpose, owner_membership_id, scope, created_by_membership_id)
    VALUES ('agent-1', 'workspace-1', 'Docs Reader', 'Reads documentation Pages', 'admin-1', 'read', 'admin-1')`);
}

describe('Setup Checklist evidence', () => {
  test('an empty Workspace presents the five ordered steps, all incomplete with authorized actions', async () => {
    const checklist = await getWorkspaceSetupChecklist(engine, 'workspace-1');
    expect(checklist.complete).toBe(false);
    expect(checklist.completed_steps).toBe(0);
    expect(checklist.steps.map(item => item.step)).toEqual([
      'connect_source', 'complete_synchronization', 'inspect_provenance', 'invite_members', 'register_agent',
    ]);
    for (const item of checklist.steps) {
      expect(item.complete).toBe(false);
      expect(item.completed_at).toBeNull();
      expect(item.evidence).toBeNull();
      expect(item.action.href.startsWith('/app')).toBe(true);
    }
    expect(checklist.steps.map(item => item.action.href)).toEqual([
      '/app/settings/sources', '/app/settings/sources', '/app/knowledge', '/app/settings/members', '/app/agents',
    ]);
  });

  test('each step completes only through durable live evidence, never a manual checkbox', async () => {
    await connectSource();
    let checklist = await getWorkspaceSetupChecklist(engine, 'workspace-1');
    expect(checklist.steps[0]).toMatchObject({ complete: true, evidence: 'Source docs-source is connected' });
    expect(checklist.steps[1]!.complete).toBe(false);
    expect(checklist.completed_steps).toBe(1);

    await completeSynchronization();
    checklist = await getWorkspaceSetupChecklist(engine, 'workspace-1');
    expect(checklist.steps[1]).toMatchObject({ complete: true, evidence: 'Source docs-source completed synchronization' });

    await recordWorkspacePageProvenanceInspection(engine, {
      workspaceId: 'workspace-1', membershipId: 'admin-1', sourceId: 'docs-source', slug: 'handbook',
    });
    checklist = await getWorkspaceSetupChecklist(engine, 'workspace-1');
    expect(checklist.steps[2]).toMatchObject({ complete: true, evidence: 'Provenance inspected for docs-source/handbook' });

    await inviteMember();
    checklist = await getWorkspaceSetupChecklist(engine, 'workspace-1');
    expect(checklist.steps[3]).toMatchObject({ complete: true, evidence: 'invitee@example.test invited with Specific Sources' });

    await registerAgent();
    checklist = await getWorkspaceSetupChecklist(engine, 'workspace-1');
    expect(checklist.steps[4]).toMatchObject({ complete: true, evidence: 'Agent Docs Reader is registered' });
    expect(checklist.complete).toBe(true);
    expect(checklist.completed_steps).toBe(5);
    for (const item of checklist.steps) expect(item.completed_at).toBeString();
  });

  test('repeated provenance inspections stay idempotent on retries', async () => {
    await connectSource();
    const record = () => recordWorkspacePageProvenanceInspection(engine, {
      workspaceId: 'workspace-1', membershipId: 'admin-1', sourceId: 'docs-source', slug: 'handbook',
    });
    await record();
    await record();
    const rows = await engine.executeRaw<{ first_inspected_at: string | Date; last_inspected_at: string | Date }>(
      'SELECT first_inspected_at, last_inspected_at FROM workspace_page_provenance_inspections',
    );
    expect(rows).toHaveLength(1);
    const checklist = await getWorkspaceSetupChecklist(engine, 'workspace-1');
    expect(checklist.steps[2]!.complete).toBe(true);
  });

  test('archiving the evidence Source regresses Source-bound steps and restoring completes them again', async () => {
    await connectSource();
    await completeSynchronization();
    await recordWorkspacePageProvenanceInspection(engine, {
      workspaceId: 'workspace-1', membershipId: 'admin-1', sourceId: 'docs-source', slug: 'handbook',
    });
    await inviteMember();
    await registerAgent();
    expect((await getWorkspaceSetupChecklist(engine, 'workspace-1')).complete).toBe(true);

    await engine.executeRaw("UPDATE workspace_sources SET archived=TRUE, archived_at=now() WHERE source_id='docs-source'");
    const archived = await getWorkspaceSetupChecklist(engine, 'workspace-1');
    expect(archived.steps.map(item => item.complete)).toEqual([false, false, false, true, true]);
    expect(archived.complete).toBe(false);

    await engine.executeRaw("UPDATE workspace_sources SET archived=FALSE, archived_at=NULL WHERE source_id='docs-source'");
    expect((await getWorkspaceSetupChecklist(engine, 'workspace-1')).complete).toBe(true);
  });

  test('revoking the registered Agent keeps the durable registration evidence', async () => {
    await registerAgent();
    await engine.executeRaw("UPDATE workspace_agents SET status='revoked', revoked_at=now() WHERE agent_id='agent-1'");
    const checklist = await getWorkspaceSetupChecklist(engine, 'workspace-1');
    expect(checklist.steps[4]!.complete).toBe(true);
  });
});

describe('Member Home states', () => {
  test('every Member sees setting up only while the Workspace has no synchronized Knowledge', async () => {
    expect(await getWorkspaceMemberHomeState(engine, 'workspace-1', 'member-1')).toBe('setting_up');
    await connectSource();
    expect(await getWorkspaceMemberHomeState(engine, 'workspace-1', 'member-1')).toBe('setting_up');
  });

  test('once Knowledge exists the state is cause-specific to usable Source Access', async () => {
    await connectSource();
    await completeSynchronization();
    expect(await getWorkspaceMemberHomeState(engine, 'workspace-1', 'member-1')).toBe('access_required');

    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='specific' WHERE principal_id='member-1'");
    expect(await getWorkspaceMemberHomeState(engine, 'workspace-1', 'member-1')).toBe('access_required');

    await engine.executeRaw("INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', 'member-1', 'docs-source')");
    expect(await getWorkspaceMemberHomeState(engine, 'workspace-1', 'member-1')).toBe('ready');
  });

  test('revoking Source Access returns the access-required state at the next decision', async () => {
    await connectSource();
    await completeSynchronization();
    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='all' WHERE principal_id='member-1'");
    expect(await getWorkspaceMemberHomeState(engine, 'workspace-1', 'member-1')).toBe('ready');
    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_id='member-1'");
    expect(await getWorkspaceMemberHomeState(engine, 'workspace-1', 'member-1')).toBe('access_required');
  });
});

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createWorkspaceRouter(engine, { requestId: () => 'req-checklist-1' }));
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

async function issueSession(membershipId: string, suffix = ''): Promise<{ cookie: string; csrf: string }> {
  const session = `session-${membershipId}${suffix}`;
  const csrf = `csrf-${membershipId}${suffix}`;
  await engine.executeRaw(
    "INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at) VALUES ($1,$2,$3,now()+interval '1 day')",
    [hashWorkspaceSecret(session), membershipId, hashWorkspaceSecret(csrf)],
  );
  return { cookie: `workspace_session=${session}`, csrf };
}

async function seedCompiledPage(): Promise<void> {
  await engine.executeRaw("CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, archived BOOLEAN NOT NULL DEFAULT FALSE)");
  await engine.executeRaw(`CREATE TABLE pages (
    id SERIAL PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), slug TEXT NOT NULL,
    type TEXT NOT NULL, page_kind TEXT NOT NULL DEFAULT 'markdown', title TEXT NOT NULL,
    compiled_truth TEXT NOT NULL DEFAULT '', frontmatter JSONB NOT NULL DEFAULT '{}', content_hash TEXT,
    import_filename TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_date TIMESTAMPTZ, effective_date_source TEXT,
    deleted_at TIMESTAMPTZ, UNIQUE (source_id, slug)
  )`);
  await engine.executeRaw(`CREATE TABLE ingest_log (
    id SERIAL PRIMARY KEY, source_id TEXT NOT NULL, source_type TEXT NOT NULL, source_ref TEXT NOT NULL,
    pages_updated JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('docs-source', 'Docs')");
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, import_filename)
    VALUES ('docs-source', 'handbook', 'document', 'Team handbook', 'Trusted text', 'handbook.md')`);
}

describe('Setup Checklist shell', () => {
  test('the first Administrator sees the ordered Home checklist with direct links from incomplete steps', async () => {
    await connectSource();
    const admin = await issueSession('admin-1');
    await withServer(async baseUrl => {
      const html = await (await fetch(`${baseUrl}/app`, { headers: { cookie: admin.cookie } })).text();
      expect(html).toContain('Setup Checklist');
      expect(html).toContain('1 of 5 steps complete');
      expect(html).toContain('Source docs-source is connected');
      expect(html).toContain('Add an HTTPS Managed Git Source');
      expect(html).toContain('Complete its first synchronization');
      expect(html).toContain('Inspect one compiled Page and its provenance');
      expect(html).toContain('Invite Members and grant Source Access');
      expect(html).toContain('Register the first Agent with least privilege');
      expect(html).toContain('<a class="step-action" href="/app/knowledge">Open Knowledge</a>');
      expect(html).toContain('<a class="step-action" href="/app/settings/members">Invite Members</a>');
      expect(html).toContain('<a class="step-action" href="/app/agents">Register an Agent</a>');
      expect(html).toContain('style="width:20%"');

      // Session changes never alter evidence: a fresh session sees the same state.
      const second = await issueSession('admin-1', '-second');
      const again = await (await fetch(`${baseUrl}/app`, { headers: { cookie: second.cookie } })).text();
      expect(again).toContain('1 of 5 steps complete');
      expect(again).toContain('Source docs-source is connected');
    });
  });

  test('the completed checklist leaves Home and stays reviewable from Settings', async () => {
    await connectSource();
    await completeSynchronization();
    await recordWorkspacePageProvenanceInspection(engine, {
      workspaceId: 'workspace-1', membershipId: 'admin-1', sourceId: 'docs-source', slug: 'handbook',
    });
    await inviteMember();
    await registerAgent();
    const admin = await issueSession('admin-1');
    await withServer(async baseUrl => {
      const home = await (await fetch(`${baseUrl}/app`, { headers: { cookie: admin.cookie } })).text();
      expect(home).toContain('Trust Summary');
      expect(home).not.toContain('Setup Checklist</h2>');
      expect(home).toContain('Refresh Home');

      const settings = await (await fetch(`${baseUrl}/app/settings/setup`, { headers: { cookie: admin.cookie } })).text();
      expect(settings).toContain('Setup Checklist');
      expect(settings).toContain('5 of 5 steps complete');
      expect(settings).toContain('Completed — Source docs-source is connected');
      expect(settings).toContain('Completed — Provenance inspected for docs-source/handbook');
      expect(settings).toContain('Completed — invitee@example.test invited with Specific Sources');
      expect(settings).toContain('Completed — Agent Docs Reader is registered');
    });
  });

  test('Members see cause-specific states without setup controls, Source names, or counts', async () => {
    await connectSource();
    const member = await issueSession('member-1');
    await withServer(async baseUrl => {
      const settingUp = await (await fetch(`${baseUrl}/app`, { headers: { cookie: member.cookie } })).text();
      expect(settingUp).toContain('Workspace is being set up');
      expect(settingUp).not.toContain('Access required');
      expect(settingUp).not.toContain('Setup Checklist');
      expect(settingUp).not.toContain('docs-source');

      await completeSynchronization();
      const accessRequired = await (await fetch(`${baseUrl}/app`, { headers: { cookie: member.cookie } })).text();
      expect(accessRequired).toContain('Access required');
      expect(accessRequired).not.toContain('Workspace is being set up');
      expect(accessRequired).not.toContain('Setup Checklist');
      expect(accessRequired).not.toContain('docs-source');
      expect(accessRequired).not.toContain('href="/app/settings/setup"');

      expect((await fetch(`${baseUrl}/app/settings/setup`, { headers: { cookie: member.cookie } })).status).toBe(403);

      await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='all' WHERE principal_id='member-1'");
      const ready = await (await fetch(`${baseUrl}/app`, { headers: { cookie: member.cookie } })).text();
      expect(ready).not.toContain('Access required');
      expect(ready).not.toContain('Workspace is being set up');
    });
  });

  test('an authorized Administrator Page read records durable provenance-inspection evidence; Member reads do not', async () => {
    await connectSource();
    await completeSynchronization();
    await seedCompiledPage();
    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='all' WHERE principal_id='member-1'");
    const admin = await issueSession('admin-1');
    const member = await issueSession('member-1');
    await withServer(async baseUrl => {
      const memberRead = await fetch(`${baseUrl}/api/workspace/v1/knowledge/pages/docs-source/handbook`, { headers: { cookie: member.cookie } });
      expect(memberRead.status).toBe(200);
      expect((await getWorkspaceSetupChecklist(engine, 'workspace-1')).steps[2]!.complete).toBe(false);

      const adminRead = await fetch(`${baseUrl}/api/workspace/v1/knowledge/pages/docs-source/handbook`, { headers: { cookie: admin.cookie } });
      expect(adminRead.status).toBe(200);
      const checklist = await getWorkspaceSetupChecklist(engine, 'workspace-1');
      expect(checklist.steps[2]).toMatchObject({ complete: true, evidence: 'Provenance inspected for docs-source/handbook' });

      const changeEvents = await engine.executeRaw('SELECT event_id FROM workspace_change_events');
      expect(changeEvents).toHaveLength(0);
    });
  });
});

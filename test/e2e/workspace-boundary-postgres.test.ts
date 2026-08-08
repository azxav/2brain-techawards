import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { createWorkspaceRouter } from '../../src/web/workspace-router.ts';
import { createOauthConsentRouter } from '../../src/web/oauth-consent.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { authorizationFromAuthInfo, workspaceMemberAuthorization } from '../../src/workspace/authorization-context.ts';
import {
  appendWorkspaceChangeEvent,
  runProtectedWorkspaceMutation,
  type WorkspaceProtectedMutation,
} from '../../src/workspace/events.ts';
import { listWorkspaceLiveUpdates } from '../../src/workspace/live-updates.ts';
import { getWorkspaceHome } from '../../src/workspace/home.ts';
import {
  archiveWorkspaceNotification,
  countWorkspaceUnreadNotifications,
  createWorkspaceNotificationForEvent,
  listWorkspaceNotifications,
  setWorkspaceNotificationRead,
} from '../../src/workspace/notifications.ts';
import { initializeWorkspaceFoundation, recordWorkspaceRuntimeHeartbeat } from '../../src/workspace/foundation.ts';
import {
  authenticateWorkspaceSession,
  beginWorkspaceSetup,
  confirmFirstAdministrator,
  issueWorkspaceSetupToken,
  revokeWorkspaceSession,
} from '../../src/workspace/auth.ts';
import {
  resolveOperationSourceAccess,
  resolvePrincipalSourceAccess,
  setPrincipalSourceAccess,
} from '../../src/workspace/source-access.ts';
import {
  createWorkspaceInvitation,
  redeemWorkspaceInvitation,
  setWorkspaceMembershipStatus,
} from '../../src/workspace/memberships.ts';
import {
  AGENT_REQUIRED_PROVIDER_MODELS,
  ANSWER_PROOF_TARGET,
  CLAUDE_FALLBACK_MODEL,
  CODEX_DEFAULT_MODEL,
  checkAgentRequiredProvider,
  confirmAgentWarning,
  hasConfirmedAgentWarning,
  importAgentAnthropicCredential,
  initializeBoundWorkspaceAgent,
  proveAgentDefaultAnswer,
} from '../../src/workspace/agent-access.ts';
import type { OpenClawControl } from '../../src/workspace/openclaw-control.ts';
import {
  getWorkspaceAgent,
  listWorkspaceAgents,
  registerWorkspaceAgent,
  rotateWorkspaceAgentCredential,
  setWorkspaceAgentScope,
  setWorkspaceAgentSourceAccess,
  setWorkspaceAgentStatus,
} from '../../src/workspace/agents.ts';
import { hashWorkspaceSecret } from '../../src/workspace/auth.ts';
import {
  listWorkspaceAgentActivity,
  recordWorkspaceAgentActivity,
  recordWorkspaceAgentRun,
} from '../../src/workspace/agent-activity.ts';
import {
  listManagedGitSources,
  listArchivedManagedGitSources,
  queueManagedGitSource,
  retryBackgroundOperation,
  runBackgroundOperationWorkerOnce,
} from '../../src/workspace/source-provisioning.ts';
import {
  queueSourceMaintenance,
  runSourceMaintenanceWorkerOnce,
} from '../../src/workspace/source-synchronization.ts';
import {
  requestWorkspaceExport,
  retrieveWorkspaceExportArtifact,
  runWorkspaceExportWorkerOnce,
} from '../../src/workspace/export.ts';
import {
  enqueueWorkspaceRetention,
  retryWorkspaceRetention,
  runWorkspaceRetentionWorkerOnce,
} from '../../src/workspace/retention.ts';
import { runWorkspaceRuntime } from '../../src/workspace/runtime.ts';
import { archiveWorkspaceSource, restoreWorkspaceSource } from '../../src/workspace/source-lifecycle.ts';
import {
  previewSourceDeletionImpact,
  queueSourcePermanentDeletion,
  runSourceDeletionWorkerOnce,
} from '../../src/workspace/source-deletion.ts';
import { listWorkspaceSearchSources, searchWorkspaceKnowledge } from '../../src/workspace/search.ts';
import {
  cancelWorkspaceAsk,
  createWorkspaceAsk,
  getWorkspaceAsk,
  purgeExpiredWorkspaceAskResults,
  runWorkspaceAsk,
} from '../../src/workspace/ask.ts';
import {
  createWorkspaceSavedView,
  listWorkspaceKnowledge,
  openWorkspaceSavedView,
} from '../../src/workspace/knowledge.ts';
import {
  getWorkspacePage,
  listWorkspacePageVersions,
  WorkspacePageError,
} from '../../src/workspace/page-detail.ts';
import {
  getWorkspaceMemberHomeState,
  getWorkspaceSetupChecklist,
  recordWorkspacePageProvenanceInspection,
} from '../../src/workspace/setup-checklist.ts';
import {
  assignWorkspaceAttentionItem,
  dismissWorkspaceAttentionItem,
  getWorkspaceAttentionItem,
  listWorkspaceAttentionItems,
  requestWorkspaceAttentionResolution,
  runWorkspaceAttentionDetectors,
  runWorkspaceSourceHealthDetector,
  startWorkspaceAttentionProgress,
} from '../../src/workspace/attention.ts';
import {
  restrictedDisclosureMarkers,
  SOURCE_ACCESS_REQUIRED_DENIAL,
  sourceSensitiveDenialCases,
} from '../helpers/source-access-contract.ts';

const databaseUrl = process.env.DATABASE_URL;
// Windows-host guard: under `bun test` on win32 (observed on Bun 1.3.14) the
// postgres.js TCP socket stops being serviced mid-suite — one query per run
// hangs forever (reads stall after a BEGIN, or writes stall mid extended-
// protocol message) and the test dies by timeout with a misleading
// CONNECTION_DESTROYED follow-up. The identical suite passes in seconds under
// WSL native Bun (same Bun version) and the same flow passes on the Windows
// host under `bun run`, so this is a bun-test-on-Windows runtime defect, not
// a workspace bug. Run this suite from WSL per CLAUDE.md.
const windowsHost = process.platform === 'win32';
if (databaseUrl && windowsHost) {
  console.warn('Skipping the Postgres boundary suite on a Windows host: bun test starves the database socket here. Run it under WSL native Bun (see CLAUDE.md).');
}
const describePostgres = databaseUrl && !windowsHost ? describe : describe.skip;

// The host wall clock is not monotonic. A 5-minute probe of this
// Docker-Desktop/WSL2 host saw a 0.568 s backwards step, and 14 989 anomalies
// across 286 578 probe transactions. `workspace_background_operations
// .available_at` is a not-before gate: it defaults to `now()` at enqueue and is
// compared against `now()` at claim. A backwards step landing between those two
// transactions parks a freshly queued row in its own future, the claim query
// matches nothing, and a single-shot worker reports no work.
//
// In production that is harmless — the job runs once the clock catches up — and
// `available_at` must stay wall-clock, because it encodes retry backoff. So the
// exposure is fixed in the harness, not the product: tests that assert on one
// specific claim backdate the gate by a margin no plausible step can cross.
//
// The margin is proven rather than assumed. After backdating, these helpers push
// every stamp forward again by a simulated backwards step two orders of
// magnitude larger than the measured one. Delete the backdate and the simulated
// step alone turns the assertions red on every run. The claim query itself is
// untouched, so a broken `available_at` gate still fails these tests.
const CLOCK_STEP_MARGIN = "interval '1 hour'";
const SIMULATED_BACKWARDS_CLOCK_STEP = "interval '30 seconds'";

async function armQueuedOperationsAgainstClockSteps(
  engine: PostgresEngine,
  table: 'workspace_background_operations',
  where: string,
  params: unknown[] = [],
): Promise<void> {
  await engine.executeRaw(
    `UPDATE ${table} SET available_at = now() - ${CLOCK_STEP_MARGIN}
      WHERE state='queued' AND ${where}`,
    params,
  );
  await engine.executeRaw(
    `UPDATE ${table} SET available_at = available_at + ${SIMULATED_BACKWARDS_CLOCK_STEP}
      WHERE state='queued' AND ${where}`,
    params,
  );
}

describePostgres('2Brain Workspace boundary on Postgres', () => {
  let admin: ReturnType<typeof postgres> | null = null;
  let engine: PostgresEngine | null = null;
  let databaseName = '';

  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl!);
    adminUrl.pathname = '/postgres';
    admin = postgres(adminUrl.toString(), { max: 1 });

    databaseName = `workspace_issue5_${process.pid}_${randomBytes(4).toString('hex')}`;
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);

    const workspaceUrl = new URL(databaseUrl!);
    workspaceUrl.pathname = `/${databaseName}`;
    engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: workspaceUrl.toString(), poolSize: 2 });
    await initializeWorkspaceFoundation(engine);
    await engine.initSchema();
  }, 30_000);

  afterAll(async () => {
    await engine?.disconnect();
    if (admin && databaseName) {
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${databaseName}`;
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
    await admin?.end({ timeout: 1 });
  }, 30_000);

  // A deployment holds exactly one Workspace (ADR-0035), enforced by the UNIQUE
  // CHECK on workspace_workspaces.singleton, and Home, Export, and retention
  // assert Workspace-wide projections. Tests that need their own Workspace
  // therefore run against their own database instead of adding a second
  // Workspace row or reading another test's fixtures. afterEach drops it and
  // restores the shared engine.
  let sharedEngine: PostgresEngine | null = null;
  let isolatedDatabaseName = '';

  async function isolatedWorkspace(name: string): Promise<string> {
    isolatedDatabaseName = `${databaseName}_iso_${randomBytes(4).toString('hex')}`;
    await admin!.unsafe(`CREATE DATABASE "${isolatedDatabaseName}"`);
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.pathname = `/${isolatedDatabaseName}`;
    const isolated = new PostgresEngine();
    await isolated.connect({ engine: 'postgres', database_url: isolatedUrl.toString(), poolSize: 2 });
    await initializeWorkspaceFoundation(isolated);
    await isolated.initSchema();
    sharedEngine = engine;
    engine = isolated;
    const workspaceId = `parity-workspace-${randomBytes(4).toString('hex')}`;
    await engine.executeRaw(
      'INSERT INTO workspace_workspaces (workspace_id,name,setup_completed_at) VALUES ($1,$2,now())',
      [workspaceId, name],
    );
    return workspaceId;
  }

  afterEach(async () => {
    if (!isolatedDatabaseName) return;
    await engine?.disconnect();
    engine = sharedEngine;
    sharedEngine = null;
    await admin!`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${isolatedDatabaseName}`;
    await admin!.unsafe(`DROP DATABASE IF EXISTS "${isolatedDatabaseName}"`);
    isolatedDatabaseName = '';
  }, 30_000);

  test('preserves Audit and Change behavior, including failed mutations and JSONB shape', async () => {
    const event: WorkspaceProtectedMutation = {
      actor: { kind: 'member', id: 'member-postgres' },
      action: 'source.archive',
      target: { type: 'source', id: 'source-postgres' },
      requestId: 'req-postgres',
      reason: 'No longer maintained.',
      before: { status: 'active', credential: 'must-be-redacted' },
      after: { status: 'archived' },
    };

    await runProtectedWorkspaceMutation(engine!, event, async () => undefined);
    let mutationError: unknown;
    try {
      await runProtectedWorkspaceMutation(engine!, event, async () => {
        throw new Error('protected mutation failed');
  });

    } catch (error) {
      mutationError = error;
    }
    expect(mutationError).toBeInstanceOf(Error);
    expect((mutationError as Error).message).toContain('protected mutation failed');

    const audits = await engine!.executeRaw<{
      outcome: string;
      before_type: string;
      before_state: unknown;
    }>(
      `SELECT outcome, jsonb_typeof(before_state) AS before_type, before_state
         FROM workspace_audit_events
        ORDER BY outcome`,
    );
    expect(audits.map(row => row.outcome)).toEqual(['failed', 'succeeded']);
    expect(audits.every(row => row.before_type === 'object')).toBe(true);
    const auditPayloads = audits.map(row => row.before_state);
    expect(JSON.stringify(auditPayloads)).not.toContain('must-be-redacted');
    expect(JSON.stringify(auditPayloads)).toContain('[REDACTED]');

    const changes = await engine!.executeRaw<{ summary: string }>('SELECT summary FROM workspace_change_events');
    expect(changes.map(row => row.summary)).toEqual(['Archived a Source.']);
    let immutableError: unknown;
    try {
      await engine!.executeRaw("UPDATE workspace_audit_events SET action = 'tampered'");
    } catch (error) {
      immutableError = error;
    }
    expect(immutableError).toBeInstanceOf(Error);
    expect((immutableError as Error).message).toContain('immutable');
  }, 20_000);

  test('persists and concurrently claims Managed Git Source operations with Postgres parity', async () => {
    const suffix = randomBytes(4).toString('hex');
    const workspaceId = `source-workspace-${suffix}`;
    const identityId = `source-identity-${suffix}`;
    const membershipId = `source-member-${suffix}`;
    const sourceId = `source-${suffix}`;
    try {
      await engine!.executeRaw(
      'INSERT INTO workspace_workspaces (workspace_id,name,setup_completed_at) VALUES ($1,$2,now())',
      [workspaceId, 'Source parity'],
      );
      await engine!.executeRaw(
      'INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ($1,$2,now())',
      [identityId, `${suffix}@example.test`],
      );
      await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,'administrator')",
      [membershipId, workspaceId, identityId],
      );
      const input = {
      workspaceId, sourceId, name: 'Postgres source',
      remoteUrl: 'https://example.test/team/postgres-source.git', expectedCadence: 'daily',
      actorMembershipId: membershipId, requestId: `req-${suffix}`, idempotencyKey: `create-${suffix}`,
      };
      const [queued, replayed] = await Promise.all([
        queueManagedGitSource(engine!, input),
        queueManagedGitSource(engine!, input),
      ]);
      expect(replayed.operation.operationId).toBe(queued.operation.operationId);
      expect(await engine!.executeRaw(
      'SELECT operation_id FROM workspace_background_operations WHERE workspace_id=$1 AND resource_id=$2',
      [workspaceId, sourceId],
      )).toHaveLength(1);
      expect(await engine!.executeRaw(
        "SELECT event_id FROM workspace_audit_events WHERE action='source.create' AND target_id=$1",
        [sourceId],
      )).toHaveLength(1);
      const conflictKey = `conflict-${suffix}`;
      const conflicts = await Promise.allSettled([
        queueManagedGitSource(engine!, { ...input, sourceId: `source-a-${suffix}`, idempotencyKey: conflictKey }),
        queueManagedGitSource(engine!, { ...input, sourceId: `source-b-${suffix}`, idempotencyKey: conflictKey }),
      ]);
      expect(conflicts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = conflicts.find(result => result.status === 'rejected');
      expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'idempotency_key_reused' } });
      expect(await engine!.executeRaw(
        "SELECT operation_id FROM workspace_background_operations WHERE workspace_id=$1 AND idempotency_key=$2",
        [workspaceId, conflictKey],
      )).toHaveLength(1);
      await engine!.executeRaw(
        'DELETE FROM workspace_background_operations WHERE workspace_id=$1 AND idempotency_key=$2',
        [workspaceId, conflictKey],
      );
      await engine!.executeRaw(
        'DELETE FROM workspace_sources WHERE workspace_id=$1 AND source_id IN ($2,$3)',
        [workspaceId, `source-a-${suffix}`, `source-b-${suffix}`],
      );
      await armQueuedOperationsAgainstClockSteps(
        engine!, 'workspace_background_operations', 'workspace_id=$1', [workspaceId],
      );
      let executions = 0;
      const results = await Promise.all([
        runBackgroundOperationWorkerOnce(engine!, { workerId: `worker-a-${suffix}`, executeSourceProvisioning: async () => { executions += 1; } }),
        runBackgroundOperationWorkerOnce(engine!, { workerId: `worker-b-${suffix}`, executeSourceProvisioning: async () => { executions += 1; } }),
      ]);
      expect(executions).toBe(1);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)).toMatchObject({ operationId: queued.operation.operationId, state: 'completed' });
      expect(await engine!.executeRaw('SELECT source_id FROM workspace_source_grants WHERE source_id=$1', [sourceId])).toEqual([]);
    } finally {
      await engine!.executeRaw('DELETE FROM workspace_idempotency_keys WHERE workspace_id=$1', [workspaceId]);
      await engine!.executeRaw('DELETE FROM workspace_background_operations WHERE workspace_id=$1', [workspaceId]);
      await engine!.executeRaw('DELETE FROM workspace_sources WHERE workspace_id=$1', [workspaceId]);
      await engine!.executeRaw('DELETE FROM workspace_memberships WHERE membership_id=$1', [membershipId]);
      await engine!.executeRaw('DELETE FROM workspace_identities WHERE identity_id=$1', [identityId]);
      await engine!.executeRaw('DELETE FROM workspace_workspaces WHERE workspace_id=$1', [workspaceId]);
    }
  }, 20_000);

  test('persists and resolves the same deny-by-default Source Access policy as PGLite', async () => {
    const principal = { kind: 'agent' as const, id: 'agent-postgres' };
    expect(await resolvePrincipalSourceAccess(engine!, { remote: false }, ['source-a']))
      .toEqual({ kind: 'unrestricted_trusted_local' });
    expect(await resolvePrincipalSourceAccess(engine!, { remote: true }, ['default', 'source-a']))
      .toEqual({ kind: 'sources', sourceIds: [] });
    expect(await resolvePrincipalSourceAccess(engine!, { remote: true, principal }, ['source-a']))
      .toEqual({ kind: 'sources', sourceIds: [] });

    await setPrincipalSourceAccess(engine!, principal, {
      mode: 'specific',
      sourceIds: ['source-b', 'source-a'],
    });
    expect(await resolvePrincipalSourceAccess(
      engine!,
      { remote: true, principal },
      ['source-a', 'source-b', 'source-new'],
    )).toEqual({ kind: 'sources', sourceIds: ['source-a', 'source-b'] });

    await setPrincipalSourceAccess(engine!, principal, { mode: 'all' });
    expect(await resolvePrincipalSourceAccess(
      engine!,
      { remote: true, principal },
      ['source-a', 'source-b', 'source-new'],
    )).toEqual({ kind: 'sources', sourceIds: ['source-a', 'source-b', 'source-new'] });

    await setPrincipalSourceAccess(engine!, principal, { mode: 'none' });
    expect(await resolvePrincipalSourceAccess(
      engine!,
      { remote: true, principal },
      ['source-a', 'source-b', 'source-new'],
    )).toEqual({ kind: 'sources', sourceIds: [] });
    await expect(setPrincipalSourceAccess(
      engine!,
      principal,
      { mode: 'specific', sourceIds: ['../source-a'] },
    )).rejects.toThrow('invalid_source_access_grant');
  }, 20_000);

  test('legacy entry redirects follow live role and session changes with Postgres parity', async () => {
    const setupToken = await issueWorkspaceSetupToken(engine!, 'setup');
    const pending = await beginWorkspaceSetup(
      engine!,
      setupToken,
      'Postgres Authorization Workspace',
      'postgres-admin@example.test',
      'req-postgres-live-auth-setup',
      'workspace-token-secret-for-tests',
    );
    const auth = await confirmFirstAdministrator(
      engine!,
      pending.confirmationToken,
      'req-postgres-live-auth-confirm',
    );
    const membership = await engine!.executeRaw<{ membership_id: string }>(
      'SELECT membership_id FROM workspace_memberships',
    );
    const membershipId = membership[0]!.membership_id;

    expect(await authenticateWorkspaceSession(engine!, auth.session)).toMatchObject({
      membership_id: membershipId,
      role: 'administrator',
    });
    const app = express();
    app.use(createWorkspaceRouter(engine!));
    const listener = await new Promise<Server>(resolve => {
      const value = app.listen(0, '127.0.0.1', () => resolve(value));
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Postgres route test did not expose an address.');
    const base = `http://127.0.0.1:${address.port}`;
    const legacyEntry = (cookie?: string) => fetch(`${base}/admin`, {
      headers: cookie ? { cookie } : undefined,
      redirect: 'manual',
    });
    try {
      const unauthenticated = await legacyEntry();
      expect(unauthenticated.status).toBe(303);
      expect(unauthenticated.headers.get('location')).toBe('/login');

      const cookie = `workspace_session=${auth.session}`;
      const administrator = await legacyEntry(cookie);
      expect(administrator.status).toBe(303);
      expect(administrator.headers.get('location')).toBe('/app/settings/members');

      await engine!.executeRaw(
        "UPDATE workspace_memberships SET role='member' WHERE membership_id=$1",
        [membershipId],
      );
      expect(await authenticateWorkspaceSession(engine!, auth.session)).toMatchObject({ role: 'member' });
      const member = await legacyEntry(cookie);
      expect(member.status).toBe(303);
      expect(member.headers.get('location')).toBe('/app');

      await engine!.executeRaw(
        "UPDATE workspace_memberships SET status='disabled' WHERE membership_id=$1",
        [membershipId],
      );
      expect(await authenticateWorkspaceSession(engine!, auth.session)).toBeNull();
      const disabled = await legacyEntry(cookie);
      expect(disabled.headers.get('location')).toBe('/login');

      await engine!.executeRaw(
        "UPDATE workspace_memberships SET status='active' WHERE membership_id=$1",
        [membershipId],
      );
      expect(await revokeWorkspaceSession(engine!, auth.session, auth.csrf)).toBe(true);
      expect(await authenticateWorkspaceSession(engine!, auth.session)).toBeNull();
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  }, 20_000);

  test('marks outbox delivery state from the login flow with Postgres parity', async () => {
    const workspaceId = await isolatedWorkspace('Outbox delivery parity');
    const suffix = randomBytes(4).toString('hex');
    await engine!.executeRaw(
      'INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ($1,$2,now())',
      [`outbox-identity-${suffix}`, 'outbox-member@example.test'],
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,'member')",
      [`outbox-member-${suffix}`, workspaceId, `outbox-identity-${suffix}`],
    );

    const app = express();
    let failDelivery = true;
    app.use(createWorkspaceRouter(engine!, {
      tokenSecret: 'workspace-token-secret-for-tests',
      allowedOrigin: 'https://workspace.example.test',
      deliverConfirmation: async () => {
        if (failDelivery) throw new Error('resend_delivery_failed: status 500');
      },
    }));
    const listener = await new Promise<Server>(resolve => {
      const value = app.listen(0, '127.0.0.1', () => resolve(value));
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Outbox parity test did not expose an address.');
    const requestLogin = () => fetch(`http://127.0.0.1:${address.port}/api/workspace/v1/login/request`, {
      method: 'POST',
      headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'outbox-member@example.test' }),
    });
    const outboxStates = async () => {
      const rows = await engine!.executeRaw<{ delivery_state: string }>(
        "SELECT delivery_state FROM workspace_email_outbox WHERE template='workspace_sign_in'",
      );
      return rows.map(row => row.delivery_state).sort();
    };
    try {
      // A delivery failure keeps the enumeration-safe 202 and banks the failed
      // outbox row (the operator's retry signal) — same posture as PGLite.
      const failed = await requestLogin();
      expect(failed.status).toBe(202);
      expect(await outboxStates()).toEqual(['failed']);

      failDelivery = false;
      const sent = await requestLogin();
      expect(sent.status).toBe(202);
      expect(await outboxStates()).toEqual(['failed', 'sent']);
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  }, 20_000);

  test('applies canonical operation access and multi-Source version filtering with Postgres parity', async () => {
    const principal = { kind: 'member' as const, id: 'member-operation-postgres' };
    await engine!.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES
        ('source-a', 'Source A', '{}'::jsonb),
        ('source-b', 'Source B', '{}'::jsonb)`,
    );
    await engine!.putPage('shared/versioned', {
      type: 'note', title: 'A', compiled_truth: 'A', frontmatter: {},
    }, { sourceId: 'source-a' });
    await engine!.putPage('shared/versioned', {
      type: 'note', title: 'B', compiled_truth: 'B', frontmatter: {},
    }, { sourceId: 'source-b' });
    await engine!.createVersion('shared/versioned', { sourceId: 'source-a' });
    await engine!.createVersion('shared/versioned', { sourceId: 'source-b' });
    const restrictedFact = await engine!.insertFact(
      { fact: 'Restricted fact detail', kind: 'fact', source: 'restricted-provenance' },
      { source_id: 'source-b' },
    );
    const restrictedJobs = await engine!.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, data, result, progress, error_text, stacktrace)
       VALUES ('sync', $1::jsonb, $2::jsonb, $3::jsonb, 'restricted-job-error', $4::jsonb)
       RETURNING id`,
      [
        { source_id: 'source-b', secret: 'restricted-job-secret' },
        { detail: 'restricted-job-result' },
        { detail: 'restricted-job-progress' },
        ['restricted-job-stacktrace'],
      ],
    );
    const restrictedJobId = restrictedJobs[0]!.id;
    const legacyJobs = await engine!.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, data) VALUES ('sync', $1::jsonb) RETURNING id`,
      [{ detail: 'restricted-legacy-job' }],
    );
    const legacyJobId = legacyJobs[0]!.id;

    expect(await resolveOperationSourceAccess(engine!, { remote: true, principal }))
      .toEqual({ kind: 'sources', sourceIds: [] });
    const noAccessAuthorization = workspaceMemberAuthorization({
      membership_id: principal.id,
      role: 'administrator',
    });
    for (const [name, params] of sourceSensitiveDenialCases(restrictedFact.id, restrictedJobId, legacyJobId)) {
      const denied = await dispatchToolCall(engine!, name, params, {
        authorization: noAccessAuthorization,
      });
      expect(denied.isError, name).toBe(true);
      expect(JSON.parse(denied.content[0]!.text), name).toEqual(SOURCE_ACCESS_REQUIRED_DENIAL);
      const serialized = JSON.stringify(denied);
      for (const forbidden of restrictedDisclosureMarkers(restrictedFact.id, restrictedJobId, legacyJobId)) {
        expect(serialized, `${name} leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
    await setPrincipalSourceAccess(engine!, principal, { mode: 'specific', sourceIds: ['source-a'] });
    expect(await resolveOperationSourceAccess(engine!, { remote: true, principal }))
      .toEqual({ kind: 'sources', sourceIds: ['source-a'] });
    const grantedRead = await dispatchToolCall(engine!, 'list_pages', {}, {
      authorization: noAccessAuthorization,
    });
    expect(JSON.parse(grantedRead.content[0]!.text).map((page: any) => page.slug))
      .toEqual(['shared/versioned']);
    await engine!.executeRaw(
      `INSERT INTO minion_jobs (name, data, created_at) VALUES
        ('sync', $1::jsonb, now() - interval '1 second'),
        ('sync', $2::jsonb, now())`,
      [
        { source_id: 'source-a', detail: 'allowed-postgres-job' },
        { source_id: 'source-b', detail: 'restricted-postgres-job' },
      ],
    );
    const grantedJobs = await dispatchToolCall(engine!, 'list_jobs', { limit: 1 }, {
      authorization: noAccessAuthorization,
    });
    const grantedJobBody = JSON.parse(grantedJobs.content[0]!.text);
    expect(grantedJobBody).toHaveLength(1);
    expect(grantedJobBody[0].data.detail).toBe('allowed-postgres-job');
    expect(JSON.stringify(grantedJobs)).not.toContain('restricted-postgres-job');
    const identityCall = await dispatchToolCall(engine!, 'get_brain_identity', {}, {
      authorization: workspaceMemberAuthorization({ membership_id: principal.id, role: 'member' }),
    });
    expect(JSON.parse(identityCall.content[0]!.text).page_count).toBe(1);
    const takePages = await engine!.executeRaw<{ id: number; source_id: string }>(
      "SELECT id, source_id FROM pages WHERE slug='shared/versioned' ORDER BY source_id",
    );
    await engine!.addTakesBatch(takePages.map((page, index) => ({
      page_id: page.id,
      row_num: 1,
      claim: index === 0 ? 'Allowed take detail' : 'Restricted take detail',
      kind: 'bet' as const,
      holder: 'world',
      weight: 1,
    })));
    for (const [index, page] of takePages.entries()) {
      await engine!.resolveTake(page.id, 1, {
        quality: index === 0 ? 'correct' : 'incorrect',
        resolvedBy: 'world',
      });
    }
    await engine!.insertFact(
      { fact: 'Allowed recalled detail', kind: 'fact', visibility: 'world', source: 'test' },
      { source_id: 'source-a' },
    );
    await engine!.insertFact(
      { fact: 'Restricted recalled detail', kind: 'fact', visibility: 'world', source: 'test' },
      { source_id: 'source-b' },
    );
    const scopedKnowledge = await Promise.all([
      dispatchToolCall(engine!, 'takes_list', {}, { authorization: noAccessAuthorization }),
      dispatchToolCall(engine!, 'takes_search', { query: 'take detail' }, { authorization: noAccessAuthorization }),
      dispatchToolCall(engine!, 'takes_scorecard', {}, { authorization: noAccessAuthorization }),
      dispatchToolCall(engine!, 'takes_calibration', {}, { authorization: noAccessAuthorization }),
      dispatchToolCall(engine!, 'recall', {}, { authorization: noAccessAuthorization }),
    ]);
    const scopedKnowledgeText = JSON.stringify(scopedKnowledge);
    expect(scopedKnowledgeText).toContain('Allowed take detail');
    expect(scopedKnowledgeText).toContain('Allowed recalled detail');
    expect(scopedKnowledgeText).not.toContain('Restricted take detail');
    expect(scopedKnowledgeText).not.toContain('Restricted recalled detail');
    expect(JSON.parse(scopedKnowledge[2]!.content[0]!.text).total_bets).toBe(1);
    expect(JSON.parse(scopedKnowledge[3]!.content[0]!.text)
      .reduce((sum: number, bucket: { n: number }) => sum + bucket.n, 0)).toBe(1);

    await setPrincipalSourceAccess(engine!, principal, { mode: 'all' });
    const allKnowledge = await Promise.all([
      dispatchToolCall(engine!, 'takes_list', {}, { authorization: noAccessAuthorization }),
      dispatchToolCall(engine!, 'takes_search', { query: 'take detail' }, { authorization: noAccessAuthorization }),
      dispatchToolCall(engine!, 'takes_scorecard', {}, { authorization: noAccessAuthorization }),
      dispatchToolCall(engine!, 'takes_calibration', {}, { authorization: noAccessAuthorization }),
      dispatchToolCall(engine!, 'recall', {}, { authorization: noAccessAuthorization }),
    ]);
    expect(JSON.stringify(allKnowledge)).toContain('Restricted take detail');
    expect(JSON.stringify(allKnowledge)).toContain('Restricted recalled detail');
    expect(JSON.parse(allKnowledge[2]!.content[0]!.text).total_bets).toBe(2);
    expect(JSON.parse(allKnowledge[3]!.content[0]!.text)
      .reduce((sum: number, bucket: { n: number }) => sum + bucket.n, 0)).toBe(2);
    await setPrincipalSourceAccess(engine!, principal, { mode: 'specific', sourceIds: ['source-a'] });
    expect(await engine!.getVersions('shared/versioned', { sourceIds: ['source-a'] })).toHaveLength(1);
    expect(await engine!.getVersions('shared/versioned', { sourceIds: ['source-b'] })).toHaveLength(1);
    expect(await engine!.getVersions('shared/versioned', { sourceIds: [] })).toEqual([]);

    const codePages = await engine!.executeRaw<{ id: number; source_id: string }>(
      `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter)
       VALUES ('code/a', 'source-a', 'Allowed Code', 'code', 'code', '', '{}'::jsonb),
              ('code/b', 'source-b', 'Denied Code', 'code', 'code', '', '{}'::jsonb)
       RETURNING id, source_id`,
    );
    for (const page of codePages) {
      await engine!.executeRaw(
        `INSERT INTO content_chunks
          (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified, symbol_type)
         VALUES ($1, 0, $2, 'compiled_truth', 'typescript', 'SharedSymbol', 'SharedSymbol', 'function')`,
        [page.id, page.source_id === 'source-a' ? 'Allowed Code marker' : 'Denied Code marker'],
      );
    }
    const defsCall = await dispatchToolCall(engine!, 'code_def', { symbol: 'SharedSymbol', source_id: '__all__' }, {
      authorization: workspaceMemberAuthorization({ membership_id: principal.id, role: 'member' }),
    });
    const defs = JSON.parse(defsCall.content[0]!.text);
    expect(defs.count).toBe(1);
    expect(JSON.stringify(defs)).toContain('Allowed Code marker');
    expect(JSON.stringify(defs)).not.toContain('Denied Code marker');
    const deniedDefsCall = await dispatchToolCall(engine!, 'code_def', {
      symbol: 'SharedSymbol', source_id: 'source-b',
    }, {
      authorization: workspaceMemberAuthorization({ membership_id: principal.id, role: 'member' }),
    });
    const deniedDefs = JSON.parse(deniedDefsCall.content[0]!.text);
    expect(deniedDefsCall.isError).toBe(true);
    expect(deniedDefs.error).toBe('permission_denied');
    expect(JSON.stringify(deniedDefs)).not.toContain('source-b');

    await engine!.addLinksBatch([
      {
        from_slug: 'shared/versioned', to_slug: 'shared/versioned', link_type: 'related', link_source: 'manual',
        from_source_id: 'source-a', to_source_id: 'source-a',
      },
      {
        from_slug: 'shared/versioned', to_slug: 'shared/versioned', link_type: 'related', link_source: 'manual',
        from_source_id: 'source-b', to_source_id: 'source-a',
      },
    ]);
    expect((await engine!.getBacklinkCounts(['shared/versioned'], { sourceIds: ['source-a'] })).get('shared/versioned')).toBe(1);

    await setPrincipalSourceAccess(engine!, principal, { mode: 'none' });
    const revokedRead = await dispatchToolCall(engine!, 'list_pages', {}, {
      authorization: noAccessAuthorization,
    });
    expect(JSON.parse(revokedRead.content[0]!.text)).toEqual(SOURCE_ACCESS_REQUIRED_DENIAL);
  }, 20_000);

  test('redeems an email-bound invitation once and persists its independent role and Source Access', async () => {
    let memberships = await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      'SELECT workspace_id,membership_id FROM workspace_memberships LIMIT 1',
    );
    if (!memberships[0]) {
      const setup = await issueWorkspaceSetupToken(engine!, 'setup');
      const pending = await beginWorkspaceSetup(engine!, setup, 'Invitation parity', 'parity-admin@example.test', 'pg-invite-setup', 'secret');
      await confirmFirstAdministrator(engine!, pending.confirmationToken, 'pg-invite-confirm');
      memberships = await engine!.executeRaw("SELECT workspace_id,membership_id FROM workspace_memberships WHERE role='administrator' LIMIT 1");
    }
    const adminMembership = memberships[0]!;
    await engine!.executeRaw("UPDATE workspace_memberships SET role='administrator',status='active' WHERE membership_id=$1", [adminMembership.membership_id]);
    const invitation = await createWorkspaceInvitation(engine!, {
      workspaceId: adminMembership.workspace_id,
      email: 'pg-member@example.test',
      role: 'member',
      sourceAccess: { mode: 'none' },
      actorMembershipId: adminMembership.membership_id,
      requestId: 'pg-invitation',
    });
    const member = await redeemWorkspaceInvitation(engine!, invitation.token, 'pg-member@example.test', 'pg-redeem');
    expect(member.role).toBe('member');
    expect(await resolvePrincipalSourceAccess(engine!, { remote: true, principal: { kind: 'member', id: member.membershipId } }, ['source-a']))
      .toEqual({ kind: 'sources', sourceIds: [] });
    await expect(redeemWorkspaceInvitation(engine!, invitation.token, 'pg-member@example.test', 'pg-replay'))
      .rejects.toThrow('invalid_or_expired_invitation');
  }, 20_000);

  test('registers, authorizes, rotates, and revokes Agents with Postgres parity', async () => {
    const workspace = (await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
       ORDER BY m.membership_id LIMIT 1`,
    ))[0]!;
    const registered = await registerWorkspaceAgent(engine!, {
      workspaceId: workspace.workspace_id, name: 'Parity agent', purpose: 'Postgres parity coverage',
      ownerMembershipId: workspace.membership_id, actorMembershipId: workspace.membership_id,
      requestId: 'issue21-register',
    });
    expect(await engine!.executeRaw(
      'SELECT credential_id FROM workspace_agent_credentials WHERE agent_id=$1 AND token_hash=$2',
      [registered.agentId, hashWorkspaceSecret(registered.credential.token)],
    )).toHaveLength(1);
    const directory = await listWorkspaceAgents(engine!, workspace.workspace_id);
    expect(directory.find(agent => agent.agentId === registered.agentId)).toMatchObject({
      status: 'active', scope: 'read', sourceAccess: { mode: 'none', sourceIds: [] },
    });
    expect(JSON.stringify(directory)).not.toContain(registered.credential.token);

    // #58: the credential authenticates on the shared verifier with Postgres
    // parity — agent identity, faithful scopes, and the last_used_at stamp.
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine!) });
    const verified = await provider.verifyAccessToken(registered.credential.token);
    expect(verified.clientId).toBe(registered.agentId);
    expect(verified.scopes).toEqual(['read']);
    expect(await engine!.executeRaw<{ last_used_at: string | null }>(
      'SELECT last_used_at FROM workspace_agent_credentials WHERE agent_id=$1 AND revoked_at IS NULL',
      [registered.agentId],
    )).toMatchObject([{ last_used_at: expect.anything() }]);

    await setWorkspaceAgentSourceAccess(engine!, workspace.workspace_id, registered.agentId,
      { mode: 'specific', sourceIds: ['issue21-source'] }, workspace.membership_id, 'issue21-access', 'Scoped for parity');
    expect(await resolvePrincipalSourceAccess(engine!, { remote: true, principal: { kind: 'agent', id: registered.agentId } }, ['issue21-source', 'other']))
      .toEqual({ kind: 'sources', sourceIds: ['issue21-source'] });

    const rotated = await rotateWorkspaceAgentCredential(engine!, workspace.workspace_id, registered.agentId,
      workspace.membership_id, 'issue21-rotate', 'Scheduled rotation');
    expect(rotated.token).not.toBe(registered.credential.token);
    await setWorkspaceAgentStatus(engine!, workspace.workspace_id, registered.agentId, 'revoked',
      workspace.membership_id, 'issue21-revoke', 'Parity teardown');
    const detail = await getWorkspaceAgent(engine!, workspace.workspace_id, registered.agentId);
    expect(detail.status).toBe('revoked');
    expect(detail.credentials.every(credential => credential.revokedAt !== null)).toBe(true);
    expect(await engine!.executeRaw(
      "SELECT outcome FROM workspace_audit_events WHERE action='credential.rotate' AND target_id=$1",
      [registered.agentId],
    )).toEqual([{ outcome: 'succeeded' }]);

    // #58: revocation refuses fail-closed on the verifier too.
    await expect(provider.verifyAccessToken(rotated.token)).rejects.toThrow('Invalid token');
  }, 20_000);

  test('enforces durable Agent customer-access constraints with Postgres parity', async () => {
    const workspaceId = await isolatedWorkspace('Customer access parity');
    await engine!.executeRaw(
      "INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('issue68-identity','issue68@example.test',now())",
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('issue68-member',$1,'issue68-identity','administrator')",
      [workspaceId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_agents (agent_id,workspace_id,name,purpose,owner_membership_id,created_by_membership_id)
       VALUES ('issue68-agent',$1,'Bound agent','Shared customer access','issue68-member','issue68-member')`,
      [workspaceId],
    );

    // The binding is a singleton per Workspace and names a real Agent.
    await expect(engine!.executeRaw(
      "INSERT INTO workspace_agent_runtime_bindings (workspace_id,agent_id) VALUES ($1,'missing-agent')",
      [workspaceId],
    )).rejects.toThrow();
    await expect(engine!.executeRaw(
      "INSERT INTO workspace_agent_runtime_bindings (workspace_id,agent_id) VALUES ('missing-workspace','issue68-agent')",
    )).rejects.toThrow();
    await engine!.executeRaw(
      "INSERT INTO workspace_agent_runtime_bindings (workspace_id,agent_id) VALUES ($1,'issue68-agent')",
      [workspaceId],
    );
    expect(await engine!.executeRaw<{
      access_revision: number; access_confirmed_revision: number;
      mcp_generation: number; mcp_verified_generation: number;
      native_password_generation: number; native_password_applied_generation: number;
      ready_at: string | null; native_password_secret_fingerprint: string | null;
    }>('SELECT * FROM workspace_agent_runtime_bindings')).toMatchObject([{
      access_revision: 1, access_confirmed_revision: 0,
      mcp_generation: 1, mcp_verified_generation: 0,
      native_password_generation: 1, native_password_applied_generation: 0,
      ready_at: null, native_password_secret_fingerprint: null,
    }]);
    // Only a full-length, non-secret fingerprint of the deployment secret.
    await expect(engine!.executeRaw(
      "UPDATE workspace_agent_runtime_bindings SET native_password_secret_fingerprint='short'",
    )).rejects.toThrow();
    await engine!.executeRaw(
      'UPDATE workspace_agent_runtime_bindings SET native_password_secret_fingerprint=$1',
      ['b'.repeat(64)],
    );

    // Shared-state warning acknowledgment belongs to a real Membership.
    await expect(engine!.executeRaw(
      "INSERT INTO workspace_agent_warning_confirmations (workspace_id,membership_id,revision) VALUES ($1,'missing-member','openclaw-shared-state-v1')",
      [workspaceId],
    )).rejects.toThrow();
    await expect(engine!.executeRaw(
      "INSERT INTO workspace_agent_warning_confirmations (workspace_id,membership_id,revision) VALUES ('missing-workspace','issue68-member','openclaw-shared-state-v1')",
    )).rejects.toThrow();
    await expect(confirmAgentWarning(engine!, {
      workspaceId: 'missing-workspace', membershipId: 'issue68-member', revision: 'openclaw-shared-state-v1',
    })).rejects.toThrow('membership_not_found');
    expect(await hasConfirmedAgentWarning(
      engine!, 'missing-workspace', 'issue68-member', 'openclaw-shared-state-v1',
    )).toBe(false);
    await confirmAgentWarning(engine!, {
      workspaceId, membershipId: 'issue68-member', revision: 'openclaw-shared-state-v1',
    });

    const fingerprint = 'c'.repeat(64);
    const queue = (operationId: string, key: string, generation: number, type = 'mcp.configure') =>
      engine!.executeRaw(
        `INSERT INTO workspace_agent_runtime_operations
           (operation_id,workspace_id,operation_type,generation,idempotency_key,idempotency_fingerprint,request_id)
         VALUES ($1,$2,$3,$4,$5,$6,'issue68-req')`,
        [operationId, workspaceId, type, generation, key, fingerprint],
      );

    await expect(queue('op-bad-type', 'k0', 1, 'shell.run')).rejects.toThrow();
    await expect(engine!.executeRaw(
      `INSERT INTO workspace_agent_runtime_operations
         (operation_id,workspace_id,operation_type,generation,idempotency_key,idempotency_fingerprint,request_id)
       VALUES ('op-bad-fp',$1,'mcp.configure',1,'k0','short','issue68-req')`,
      [workspaceId],
    )).rejects.toThrow();
    await expect(queue('op-bad-gen', 'k0', 0)).rejects.toThrow();

    await queue('op-1', 'k1', 1);
    // One Operation per idempotency key, and one per (type, desired generation).
    await expect(queue('op-2', 'k1', 2)).rejects.toThrow();
    await expect(queue('op-3', 'k3', 1)).rejects.toThrow();
    // A different Operation type shares neither key space constraint.
    await queue('op-4', 'k4', 1, 'native_password.rotate');

    // A lease exists exactly while an Operation is running.
    await expect(engine!.executeRaw(
      "UPDATE workspace_agent_runtime_operations SET lease_owner='worker' WHERE operation_id='op-1'",
    )).rejects.toThrow();
    await expect(engine!.executeRaw(
      "UPDATE workspace_agent_runtime_operations SET state='running' WHERE operation_id='op-1'",
    )).rejects.toThrow();
    await engine!.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET state='running',lease_owner='worker',lease_token='token',lease_expires_at=now()
        WHERE operation_id='op-1'`,
    );
    await expect(engine!.executeRaw(
      "UPDATE workspace_agent_runtime_operations SET state='succeeded' WHERE operation_id='op-1'",
    )).rejects.toThrow();
    await engine!.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET state='succeeded',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
        WHERE operation_id='op-1'`,
    );
    expect(await engine!.executeRaw<{ operation_id: string; state: string }>(
      'SELECT operation_id,state FROM workspace_agent_runtime_operations ORDER BY operation_id',
    )).toEqual([
      { operation_id: 'op-1', state: 'succeeded' },
      { operation_id: 'op-4', state: 'queued' },
    ]);
  }, 30_000);

  // #68 Task 10 fix round 1 (finding 4): the readiness proofs decide whether to
  // keep or discard a result purely from the AFFECTED ROW COUNT of an
  // `UPDATE … WHERE model_generation=$captured … RETURNING workspace_id`. PGLite
  // and postgres.js return that result set through different code paths (an
  // array-shaped `Result` vs a postgres.js row list), so "zero rows means the
  // Administrator replaced the credential mid-check" is an engine-level claim
  // that has to be proved on real Postgres, not assumed from the PGLite run.
  test('records and discards model proofs by real Postgres RETURNING row counts', async () => {
    const workspaceId = await isolatedWorkspace('Model proof parity');
    const suffix = randomBytes(4).toString('hex');
    const adminId = `proof-admin-${suffix}`;
    await engine!.executeRaw(
      'INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ($1,$2,now())',
      [`${adminId}-identity`, `${adminId}@example.test`],
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,'administrator')",
      [adminId, workspaceId, `${adminId}-identity`],
    );
    await initializeBoundWorkspaceAgent(engine!, {
      workspaceId, ownerMembershipId: adminId, actorMembershipId: adminId, requestId: `init-${suffix}`,
    });

    const imports: string[] = [];
    const control = {
      importProviderCredential: async (input: { provider: string }) => { imports.push(input.provider); },
      listModels: async () => [CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL],
      probeModel: async () => ({ text: 'answered' }),
      probeDefaultAnswer: async () => ({ text: '2BRAIN_AGENT_READY' }),
    } as unknown as OpenClawControl;

    const binding = async () => (await engine!.executeRaw<{
      model_generation: number;
      codex_verified_generation: number; codex_verified_model: string | null;
      claude_verified_generation: number;
      answer_verified_generation: number; answer_verified_target: string | null;
    }>(
      `SELECT model_generation, codex_verified_generation, codex_verified_model,
              claude_verified_generation, answer_verified_generation, answer_verified_target
         FROM workspace_agent_runtime_bindings WHERE workspace_id=$1`,
      [workspaceId],
    ))[0]!;

    // The Anthropic import advances the generation and clears every proof
    // BEFORE the credential leaves the process — that ordering is the whole
    // safety property, and it is a committed Postgres transaction here.
    const before = Number((await binding()).model_generation);
    await importAgentAnthropicCredential(engine!, control, {
      workspaceId, setupToken: `sk-ant-oat01-${suffix}`,
      actorMembershipId: adminId, requestId: `import-${suffix}`,
    });
    expect(imports).toEqual(['anthropic']);
    const invalidated = await binding();
    expect(Number(invalidated.model_generation)).toBe(before + 1);
    expect(Number(invalidated.codex_verified_generation)).toBe(0);

    // A one-row UPDATE is recognized as one row: the proof is kept.
    expect(await checkAgentRequiredProvider(engine!, control, { workspaceId, provider: 'codex' }))
      .toEqual({ model: AGENT_REQUIRED_PROVIDER_MODELS.codex });
    await checkAgentRequiredProvider(engine!, control, { workspaceId, provider: 'claude' });
    expect(await proveAgentDefaultAnswer(engine!, control, { workspaceId }))
      .toEqual({ target: ANSWER_PROOF_TARGET });
    const proved = await binding();
    expect(Number(proved.codex_verified_generation)).toBe(before + 1);
    expect(proved.codex_verified_model).toBe(CODEX_DEFAULT_MODEL);
    expect(Number(proved.claude_verified_generation)).toBe(before + 1);
    expect(Number(proved.answer_verified_generation)).toBe(before + 1);
    expect(proved.answer_verified_target).toBe(ANSWER_PROOF_TARGET);

    // A ZERO-row UPDATE is recognized as zero rows, not as success. The
    // generation moves while the check is in flight, so the compare-and-set
    // matches nothing and the stale result is refused rather than written.
    const staleControl = {
      ...control,
      listModels: async () => {
        await engine!.executeRaw(
          `UPDATE workspace_agent_runtime_bindings
              SET model_generation=model_generation+1,
                  answer_verified_generation=0, answer_verified_target=NULL, answer_verified_at=NULL,
                  ready_at=NULL
            WHERE workspace_id=$1`,
          [workspaceId],
        );
        return [CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL];
      },
    } as unknown as OpenClawControl;
    await expect(
      checkAgentRequiredProvider(engine!, staleControl, { workspaceId, provider: 'codex' }),
    ).rejects.toThrow('proof_superseded');
    const stale = await binding();
    expect(Number(stale.model_generation)).toBe(before + 2);
    // The superseded write left the OLD proof exactly as it was.
    expect(Number(stale.codex_verified_generation)).toBe(before + 1);
    expect(Number(stale.answer_verified_generation)).toBe(0);
    expect(await engine!.executeRaw<{ ready_at: string | null }>(
      'SELECT ready_at FROM workspace_agent_runtime_bindings WHERE workspace_id=$1', [workspaceId],
    )).toEqual([{ ready_at: null }]);
  }, 30_000);

  // #68 Task 9 fix round 2 (Defect B): `Promise.all` alone does not guarantee
  // the two transactions' statements actually overlap — Node/postgres.js
  // connection setup and network scheduling can let one transaction fully
  // commit before the other's first query is even sent, in which case a
  // "concurrent" test can pass even with the covering `FOR UPDATE` lock
  // stripped, because no real contention ever occurred (observed: the round-1
  // version of this test CAUGHT the mutant in only 3 of 4 runs). This helper
  // forces genuine overlap deterministically with a `BEFORE UPDATE` trigger
  // scoped to the exact row under test: it sleeps while the row lock (if the
  // source still takes it) is held, giving the other transaction time to
  // reach and block on that same row's `FOR UPDATE` before the first
  // transaction commits. Table/column/value are test-controlled literals
  // (never user input), so string interpolation into DDL is safe here.
  async function withRowUpdateBarrier<T>(
    table: string, column: string, value: string, fn: () => Promise<T>,
  ): Promise<T> {
    const suffix = randomBytes(4).toString('hex');
    const fnName = `test_barrier_fn_${suffix}`;
    const trgName = `test_barrier_trg_${suffix}`;
    await engine!.executeRaw(`
      CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger AS $BARRIER$
      BEGIN
        PERFORM pg_sleep(0.3);
        RETURN NEW;
      END;
      $BARRIER$ LANGUAGE plpgsql;
    `);
    await engine!.executeRaw(
      `CREATE TRIGGER ${trgName} BEFORE UPDATE ON ${table} FOR EACH ROW
         WHEN (OLD.${column} = '${value}') EXECUTE FUNCTION ${fnName}()`,
    );
    try {
      return await fn();
    } finally {
      await engine!.executeRaw(`DROP TRIGGER IF EXISTS ${trgName} ON ${table}`);
      await engine!.executeRaw(`DROP FUNCTION IF EXISTS ${fnName}()`);
    }
  }

  // #68 Task 9 review finding I1: `setWorkspaceMembershipStatus` (memberships.ts)
  // takes `SELECT native_password_generation ... FOR UPDATE` on the runtime
  // binding row specifically so two concurrent `active -> disabled` transitions
  // (from two different Members leaving at once) cannot both read the same
  // "current" generation, compute the same "next" generation, and collide —
  // either losing one rotation Operation or reusing an idempotency key across
  // two different Members. PGLite cannot exercise real row-lock contention
  // (it is single-connection), so this is Postgres-only boundary coverage.
  //
  // #68 Task 9 fix round 2 (Defect B): wrapped in `withRowUpdateBarrier` on the
  // binding row so the race is forced on every run, not merely hoped for.
  test('serializes two concurrent Member disablements through the binding row lock: distinct generations, distinct idempotency keys, no lost update', async () => {
    const workspaceId = await isolatedWorkspace('Concurrent disablement parity');
    const suffix = randomBytes(4).toString('hex');
    const adminId = `concurrent-admin-${suffix}`;
    const memberAId = `concurrent-member-a-${suffix}`;
    const memberBId = `concurrent-member-b-${suffix}`;
    await engine!.executeRaw(
      `INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES
         ($1,$2,now()), ($3,$4,now()), ($5,$6,now())`,
      [
        `${adminId}-identity`, `${adminId}@example.test`,
        `${memberAId}-identity`, `${memberAId}@example.test`,
        `${memberBId}-identity`, `${memberBId}@example.test`,
      ],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES
         ($1,$2,$3,'administrator'), ($4,$2,$5,'member'), ($6,$2,$7,'member')`,
      [
        adminId, workspaceId, `${adminId}-identity`,
        memberAId, `${memberAId}-identity`,
        memberBId, `${memberBId}-identity`,
      ],
    );
    await initializeBoundWorkspaceAgent(engine!, {
      workspaceId, ownerMembershipId: adminId, actorMembershipId: adminId, requestId: `init-${suffix}`,
    });
    const initialBinding = await engine!.executeRaw<{ native_password_generation: number }>(
      'SELECT native_password_generation FROM workspace_agent_runtime_bindings WHERE workspace_id=$1', [workspaceId],
    );
    expect(initialBinding[0]?.native_password_generation).toBe(1);

    const [resultA, resultB] = await withRowUpdateBarrier(
      'workspace_agent_runtime_bindings', 'workspace_id', workspaceId,
      () => Promise.all([
        setWorkspaceMembershipStatus(engine!, workspaceId, memberAId, 'disabled', adminId, `disable-a-${suffix}`, 'Left team A.'),
        setWorkspaceMembershipStatus(engine!, workspaceId, memberBId, 'disabled', adminId, `disable-b-${suffix}`, 'Left team B.'),
      ]),
    );

    expect(resultA).toMatchObject({ previousStatus: 'active', status: 'disabled', nativeRotationQueued: true });
    expect(resultB).toMatchObject({ previousStatus: 'active', status: 'disabled', nativeRotationQueued: true });
    // No lost update: the binding lock serialized both readers, so the
    // generation actually advanced twice, not once.
    const finalBinding = await engine!.executeRaw<{ native_password_generation: number }>(
      'SELECT native_password_generation FROM workspace_agent_runtime_bindings WHERE workspace_id=$1', [workspaceId],
    );
    expect(finalBinding[0]?.native_password_generation).toBe(3);

    expect(resultA.nativeRotationOperationId).toBeString();
    expect(resultB.nativeRotationOperationId).toBeString();
    // Two distinct rotation Operations, not one Member's disablement silently
    // reconciling onto the other's queued Operation.
    expect(resultA.nativeRotationOperationId).not.toBe(resultB.nativeRotationOperationId);

    // `initializeBoundWorkspaceAgent` itself queues the initial generation-1
    // rotation as part of setup; only generations 2 and 3 come from the two
    // concurrent disablements under test here.
    const operations = await engine!.executeRaw<{ operation_id: string; generation: number; idempotency_key: string }>(
      `SELECT operation_id, generation, idempotency_key FROM workspace_agent_runtime_operations
        WHERE workspace_id=$1 AND operation_type='native_password.rotate' AND generation > 1 ORDER BY generation`,
      [workspaceId],
    );
    // Exactly generations 2 and 3 — never both landing on 2 (a lost update)
    // and never a gap.
    expect(operations.map(row => row.generation)).toEqual([2, 3]);
    // Every idempotency key is unique and correctly names the generation its
    // own row actually carries — the exact invariant the binding lock exists
    // to guarantee under concurrency.
    expect(new Set(operations.map(row => row.idempotency_key)).size).toBe(2);
    for (const row of operations) {
      expect(row.idempotency_key.endsWith(`:${row.generation}`)).toBe(true);
    }
    const operationIds = operations.map(row => row.operation_id).sort();
    expect([resultA.nativeRotationOperationId, resultB.nativeRotationOperationId].sort()).toEqual(operationIds);

    // Both Members are actually disabled — the concurrent race did not let
    // one clobber the other's status transition either.
    const statuses = await engine!.executeRaw<{ membership_id: string; status: string }>(
      'SELECT membership_id, status FROM workspace_memberships WHERE membership_id=ANY($1) ORDER BY membership_id',
      [[memberAId, memberBId]],
    );
    expect(statuses.every(row => row.status === 'disabled')).toBe(true);
  }, 30_000);

  // #68 Task 9 fix round 2 (Defect A): the review finding named TWO locks in
  // `setWorkspaceMembershipStatus` — the membership row lock at
  // `memberships.ts:213` and the binding row lock at `memberships.ts:238`.
  // The test above only ever contends on the binding row (it disables two
  // DIFFERENT Members). This test contends on a single membership row: two
  // concurrent `active -> disabled` transitions on the SAME Member. That is
  // the exact race `:213`'s `FOR UPDATE` exists to serialize — without it,
  // both transactions could read `previousStatus:'active'` concurrently and
  // both attempt to advance the shared generation, either colliding on the
  // same idempotency key (I2's guard would then reject one) or, absent I2,
  // silently double-advancing/losing an update.
  test('serializes two concurrent disablements of the SAME Member through the membership row lock: exactly one generation advance, no lost update', async () => {
    const workspaceId = await isolatedWorkspace('Concurrent single-member disablement parity');
    const suffix = randomBytes(4).toString('hex');
    const adminId = `single-admin-${suffix}`;
    const memberId = `single-member-${suffix}`;
    await engine!.executeRaw(
      `INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES
         ($1,$2,now()), ($3,$4,now())`,
      [
        `${adminId}-identity`, `${adminId}@example.test`,
        `${memberId}-identity`, `${memberId}@example.test`,
      ],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES
         ($1,$2,$3,'administrator'), ($4,$2,$5,'member')`,
      [
        adminId, workspaceId, `${adminId}-identity`,
        memberId, `${memberId}-identity`,
      ],
    );
    await initializeBoundWorkspaceAgent(engine!, {
      workspaceId, ownerMembershipId: adminId, actorMembershipId: adminId, requestId: `init-${suffix}`,
    });

    const [resultA, resultB] = await withRowUpdateBarrier(
      'workspace_memberships', 'membership_id', memberId,
      () => Promise.all([
        setWorkspaceMembershipStatus(engine!, workspaceId, memberId, 'disabled', adminId, `disable-a-${suffix}`, 'Race A.'),
        setWorkspaceMembershipStatus(engine!, workspaceId, memberId, 'disabled', adminId, `disable-b-${suffix}`, 'Race B.'),
      ]),
    );

    const results = [resultA, resultB];
    const winners = results.filter(r => r.previousStatus === 'active');
    const losers = results.filter(r => r.previousStatus === 'disabled');
    // Exactly one call actually observed the pre-disable state and performed
    // the transition + rotation; the lock serialized the other one behind it
    // rather than letting both observe 'active' concurrently.
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(winners[0]!.nativeRotationQueued).toBe(true);
    expect(winners[0]!.nativeRotationOperationId).toBeString();
    // The loser observed the already-disabled row (the lock's whole job) and
    // took the idempotent no-rotate path — not a second advance, not a lost
    // update masquerading as success.
    expect(losers[0]!.nativeRotationQueued).toBe(false);
    expect(losers[0]!.nativeRotationOperationId).toBeNull();

    const finalBinding = await engine!.executeRaw<{ native_password_generation: number }>(
      'SELECT native_password_generation FROM workspace_agent_runtime_bindings WHERE workspace_id=$1', [workspaceId],
    );
    // 1 (init) -> 2 (the single winning disable), never 3: with the
    // membership lock absent, both calls could read previousStatus:'active'
    // concurrently, and (absent I2's guard) both would land on generation 2
    // via a lost update, or (with I2) one would throw
    // `native_password_generation_advance_mismatch` instead of resolving.
    expect(finalBinding[0]?.native_password_generation).toBe(2);

    const operations = await engine!.executeRaw<{ operation_id: string; generation: number; idempotency_key: string }>(
      `SELECT operation_id, generation, idempotency_key FROM workspace_agent_runtime_operations
        WHERE workspace_id=$1 AND operation_type='native_password.rotate' AND generation > 1 ORDER BY generation`,
      [workspaceId],
    );
    expect(operations.length).toBe(1);
    expect(operations[0]!.idempotency_key).toBe(`member-disabled:${memberId}:2`);
    expect(winners[0]!.nativeRotationOperationId).toBe(operations[0]!.operation_id);

    const finalStatus = await engine!.executeRaw<{ status: string }>(
      'SELECT status FROM workspace_memberships WHERE membership_id=$1', [memberId],
    );
    expect(finalStatus[0]?.status).toBe('disabled');
  }, 30_000);

  test('filters structured Agent Activity by Source Access with Administrator oversight in Postgres parity', async () => {
    let workspaces = await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
       WHERE m.role='administrator' ORDER BY m.membership_id LIMIT 1`,
    );
    if (!workspaces[0]) {
      const setup = await issueWorkspaceSetupToken(engine!, 'setup');
      const pending = await beginWorkspaceSetup(
        engine!, setup, 'Agent activity parity', 'issue22-admin@example.test', 'issue22-setup', 'secret',
      );
      await confirmFirstAdministrator(engine!, pending.confirmationToken, 'issue22-confirm');
      workspaces = await engine!.executeRaw(
        `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
         JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
         WHERE m.role='administrator' ORDER BY m.membership_id LIMIT 1`,
      );
    }
    const workspace = workspaces[0]!;
    await engine!.executeRaw(
      `INSERT INTO workspace_sources (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id)
       VALUES ('issue22-allowed', $1, 'Issue22 allowed', 'https://example.test/allowed.git', 'daily', 'completed', $2),
              ('issue22-denied', $1, 'Issue22 denied', 'https://example.test/denied.git', 'daily', 'completed', $2)
       ON CONFLICT DO NOTHING`,
      [workspace.workspace_id, workspace.membership_id],
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('issue22-identity', 'issue22-member@example.test', now()) ON CONFLICT DO NOTHING",
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('issue22-member', $1, 'issue22-identity', 'member') ON CONFLICT DO NOTHING",
      [workspace.workspace_id],
    );
    await setPrincipalSourceAccess(engine!, { kind: 'member', id: 'issue22-member' }, { mode: 'specific', sourceIds: ['issue22-allowed'] });

    const registered = await registerWorkspaceAgent(engine!, {
      workspaceId: workspace.workspace_id, name: 'Issue22 activity agent', purpose: 'Structured activity parity coverage',
      ownerMembershipId: workspace.membership_id, actorMembershipId: workspace.membership_id,
      requestId: 'issue22-register',
    });
    const run = await recordWorkspaceAgentRun(engine!, {
      workspaceId: workspace.workspace_id, agentId: registered.agentId,
      correlationId: 'issue22-run', outcome: 'succeeded', metadata: { trigger: 'parity sweep' },
    });
    await recordWorkspaceAgentActivity(engine!, {
      workspaceId: workspace.workspace_id, agentId: registered.agentId, runId: run.runId,
      requestId: 'issue22-activity-1', operation: 'page.retrieve', outcome: 'succeeded', latencyMs: 120,
      sourceId: 'issue22-allowed', pageSlug: 'parity-guide', relationship: 'retrieved',
      requestDetail: {
        redacted: { operation_kind: 'read', prompt: 'parity secret prompt text' },
        fullParameters: { q: 'issue22 full parameters' }, fullParametersEnabled: true,
      },
    });
    await recordWorkspaceAgentActivity(engine!, {
      workspaceId: workspace.workspace_id, agentId: registered.agentId,
      operation: 'page.write', outcome: 'failed', sourceId: 'issue22-denied',
    });
    await expect(recordWorkspaceAgentActivity(engine!, {
      workspaceId: workspace.workspace_id, agentId: registered.agentId,
      operation: 'page.write', outcome: 'succeeded', relationship: 'written',
    })).rejects.toThrow('invalid_activity_evidence');

    const memberView = await listWorkspaceAgentActivity(engine!, {
      workspaceId: workspace.workspace_id, agentId: registered.agentId,
      viewer: { membershipId: 'issue22-member', role: 'member' },
    });
    expect(memberView.oversight).toBe(false);
    expect(memberView.entries).toHaveLength(1);
    expect(memberView.entries[0]).toMatchObject({ operation: 'page.retrieve', relationship: 'retrieved' });
    const memberPayload = JSON.stringify(memberView);
    expect(memberPayload).not.toContain('issue22-denied');
    expect(memberPayload).not.toContain('requestDetail');
    expect(memberPayload).not.toContain('issue22 full parameters');

    const adminView = await listWorkspaceAgentActivity(engine!, {
      workspaceId: workspace.workspace_id, agentId: registered.agentId,
      viewer: { membershipId: workspace.membership_id, role: 'administrator' },
    });
    expect(adminView.oversight).toBe(true);
    expect(adminView.entries).toHaveLength(2);
    const detailed = adminView.entries.find(entry => entry.operation === 'page.retrieve')!;
    expect(detailed.requestDetail!.redacted).toMatchObject({ operation_kind: 'read', prompt: '[REDACTED]' });
    expect(detailed.requestDetail!.fullParameters).toEqual({ q: 'issue22 full parameters' });
    expect(detailed.run).toMatchObject({ runId: run.runId, correlationId: 'issue22-run', outcome: 'succeeded' });
    expect(JSON.stringify(adminView)).not.toContain('parity secret prompt text');

    const stored = await engine!.executeRaw<{ captured_at: string | Date; full_parameters_expire_at: string | Date }>(
      'SELECT captured_at, full_parameters_expire_at FROM workspace_agent_request_details WHERE activity_id=$1',
      [detailed.activityId],
    );
    expect(new Date(stored[0]!.full_parameters_expire_at).getTime() - new Date(stored[0]!.captured_at).getTime())
      .toBe(7 * 24 * 60 * 60 * 1000);
    await engine!.executeRaw("UPDATE workspace_agent_request_details SET full_parameters_expire_at=now() - interval '1 minute' WHERE activity_id=$1", [detailed.activityId]);
    const expired = await listWorkspaceAgentActivity(engine!, {
      workspaceId: workspace.workspace_id, agentId: registered.agentId,
      viewer: { membershipId: workspace.membership_id, role: 'administrator' },
    });
    expect(expired.entries.find(entry => entry.activityId === detailed.activityId)!.requestDetail!.fullParameters).toBeUndefined();
    expect(await engine!.executeRaw(
      'SELECT activity_id FROM workspace_agent_request_details WHERE activity_id=$1 AND full_parameters IS NULL',
      [detailed.activityId],
    )).toHaveLength(1);

    // Remove the seeded Sources and grants so later parity tests keep their
    // exact Source-list expectations; recorded activity itself stays durable.
    await engine!.executeRaw("DELETE FROM workspace_source_grants WHERE principal_kind='member' AND principal_id='issue22-member'");
    await engine!.executeRaw("DELETE FROM workspace_principal_source_policies WHERE principal_kind='member' AND principal_id='issue22-member'");
    await engine!.executeRaw("DELETE FROM workspace_sources WHERE source_id IN ('issue22-allowed', 'issue22-denied')");
  }, 20_000);

  test('keeps Source maintenance evidence and projections in Postgres parity', async () => {
    const workspace = (await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
       WHERE m.role='administrator' ORDER BY m.membership_id LIMIT 1`,
    ))[0];
    await engine!.executeRaw(
      "INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member',$1,'all') ON CONFLICT (principal_kind,principal_id) DO UPDATE SET access_mode='all'",
      [workspace.membership_id],
    );
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id)
      VALUES ('issue14-source',$1,'Docs','https://example.test/docs.git','daily','completed',$2)`,
      [workspace.workspace_id, workspace.membership_id]);
    await queueSourceMaintenance(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue14-source', type: 'source.verify',
      actorMembershipId: workspace.membership_id, requestId: 'issue14-request', idempotencyKey: 'issue14-verify',
    });
    await runSourceMaintenanceWorkerOnce(engine!, {
      workerId: 'issue14-worker',
      execute: async () => ({ observedRevision: 'postgres-revision', changed: false }),
    });
    expect(await engine!.executeRaw(
      "SELECT observed_revision,content_state FROM workspace_source_verification_events WHERE source_id='issue14-source'",
    )).toEqual([{ observed_revision: 'postgres-revision', content_state: 'unchanged' }]);
    const trustworthyVerifiedAt = (await engine!.executeRaw<{ last_verified_at: string | Date }>(
      "SELECT last_verified_at FROM workspace_sources WHERE source_id='issue14-source'",
    ))[0].last_verified_at;
    expect(trustworthyVerifiedAt).not.toBeNull();

    await queueSourceMaintenance(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue14-source', type: 'source.verify',
      actorMembershipId: workspace.membership_id, requestId: 'issue15-failed-request',
      idempotencyKey: 'issue15-failed-verify',
    });
    const failedOperation = await runSourceMaintenanceWorkerOnce(engine!, {
      workerId: 'issue15-worker', execute: async () => { throw new Error('provider unavailable'); },
    });
    expect(failedOperation).toMatchObject({ state: 'failed', retryable: true });
    expect(await listManagedGitSources(engine!, workspace.workspace_id)).toMatchObject([{
      sourceId: 'issue14-source',
      lastVerifiedAt: new Date(trustworthyVerifiedAt).toISOString(),
      lastVerifiedRevision: 'postgres-revision',
      freshness: { state: 'stale', reason: 'requested_verification_failed', potentiallyOutdated: true },
      latestVerification: {
        outcome: 'failed', errorCode: 'source_maintenance_failed', requestId: 'issue15-failed-request',
      },
    }]);

    await Bun.sleep(5);
    await retryBackgroundOperation(engine!, {
      workspaceId: workspace.workspace_id,
      operationId: failedOperation!.operationId,
      actorMembershipId: workspace.membership_id,
      requestId: 'issue15-retry-request',
    });
    await runSourceMaintenanceWorkerOnce(engine!, {
      workerId: 'issue15-retry-worker',
      execute: async () => ({ observedRevision: 'postgres-revision', changed: false }),
    });
    const recovered = (await listManagedGitSources(engine!, workspace.workspace_id))[0]!;
    expect(recovered).toMatchObject({
      sourceId: 'issue14-source',
      lastVerifiedRevision: 'postgres-revision',
      freshness: { state: 'current', reason: 'verified_within_cadence', potentiallyOutdated: false },
      latestVerification: { outcome: 'succeeded', requestId: 'issue15-retry-request' },
    });
    expect(new Date(recovered.lastVerifiedAt!).getTime()).toBeGreaterThan(new Date(trustworthyVerifiedAt).getTime());

    await engine!.executeRaw(
      "INSERT INTO sources (id,name,config) VALUES ('issue14-source','Docs','{}'::jsonb)",
    );
    const archived = await archiveWorkspaceSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue14-source',
      actorMembershipId: workspace.membership_id, requestId: 'issue16-archive',
    });
    expect(archived).toMatchObject({ lifecycleState: 'archived', changed: true });
    expect(await listManagedGitSources(engine!, workspace.workspace_id)).toEqual([]);
    expect(await listArchivedManagedGitSources(engine!, workspace.workspace_id)).toMatchObject([
      { sourceId: 'issue14-source', lifecycleState: 'archived' },
    ]);
    expect(await engine!.executeRaw("SELECT archived,archive_expires_at FROM sources WHERE id='issue14-source'"))
      .toEqual([{ archived: true, archive_expires_at: null }]);
    await restoreWorkspaceSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue14-source',
      actorMembershipId: workspace.membership_id, requestId: 'issue16-restore',
    });
    const restored = (await listManagedGitSources(engine!, workspace.workspace_id))[0]!;
    expect(await engine!.executeRaw("SELECT archived FROM sources WHERE id='issue14-source'"))
      .toEqual([{ archived: false }]);
    expect(restored.lastVerifiedAt).toBe(recovered.lastVerifiedAt);
    expect(restored.lastVerifiedRevision).toBe(recovered.lastVerifiedRevision);

    const queuedRace = await queueManagedGitSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue16-race', name: 'Race',
      remoteUrl: 'https://example.test/race.git', expectedCadence: 'daily',
      actorMembershipId: workspace.membership_id, requestId: 'issue16-race-create',
      idempotencyKey: 'issue16-race',
    });
    await archiveWorkspaceSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue16-race',
      actorMembershipId: workspace.membership_id, requestId: 'issue16-race-archive',
    });
    expect(await engine!.executeRaw(
      'SELECT state,error_code FROM workspace_background_operations WHERE operation_id=$1',
      [queuedRace.operation.operationId],
    )).toEqual([{ state: 'failed', error_code: 'source_archived' }]);
    await restoreWorkspaceSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue16-race',
      actorMembershipId: workspace.membership_id, requestId: 'issue16-race-restore',
    });
    expect(await engine!.executeRaw(
      `SELECT o.state,o.error_code,s.provisioning_state
         FROM workspace_background_operations o
         JOIN workspace_sources s ON s.workspace_id=o.workspace_id AND s.source_id=o.resource_id
        WHERE o.operation_id=$1`,
      [queuedRace.operation.operationId],
    )).toEqual([{ state: 'queued', error_code: null, provisioning_state: 'queued' }]);
  });

  test('permanently deletes an Archived Source with Postgres parity', async () => {
    const workspace = (await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
       WHERE m.role='administrator' ORDER BY m.membership_id LIMIT 1`,
    ))[0];
    await engine!.executeRaw(
      "INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member',$1,'all') ON CONFLICT (principal_kind,principal_id) DO UPDATE SET access_mode='all'",
      [workspace.membership_id],
    );
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id,
       archived,archived_at,archived_by_membership_id)
      VALUES ('issue20-source',$1,'Deletion parity','https://example.test/deletion.git','daily','completed',$2,TRUE,now(),$2)`,
      [workspace.workspace_id, workspace.membership_id]);
    await engine!.executeRaw(
      "INSERT INTO sources (id,name,config,archived,archived_at) VALUES ('issue20-source','Deletion parity','{}'::jsonb,TRUE,now())",
    );
    await engine!.executeRaw(`INSERT INTO pages (source_id,slug,type,page_kind,title,compiled_truth)
      VALUES ('issue20-source','purge-a','document','markdown','Purge A','Body'),
             ('issue20-source','purge-b','document','markdown','Purge B','Body')`);
    await engine!.executeRaw(`INSERT INTO page_versions (page_id,compiled_truth)
      SELECT id,'Snapshot' FROM pages WHERE source_id='issue20-source'`);
    await engine!.executeRaw(
      "INSERT INTO ingest_log (source_id,source_type,source_ref,pages_updated) VALUES ('issue20-source','import','deletion.md','[]'::jsonb)",
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_source_grants (principal_kind,principal_id,source_id) VALUES ('member',$1,'issue20-source')",
      [workspace.membership_id],
    );
    await engine!.executeRaw(`INSERT INTO workspace_saved_views
      (view_id,workspace_id,owner_membership_id,name,filters,sort,visible_properties)
      VALUES ('issue20-view',$1,$2,'Deletion scope','{"source_ids":["issue20-source"]}'::jsonb,
              '{"property":"title","direction":"asc"}'::jsonb,'["title"]'::jsonb)`,
      [workspace.workspace_id, workspace.membership_id]);

    expect(await previewSourceDeletionImpact(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue20-source', actorMembershipId: workspace.membership_id,
    })).toEqual({
      sourceId: 'issue20-source', pages: 2, pageVersions: 2, savedViews: 1,
      backgroundOperations: 0, verificationEvents: 0, accessGrants: 1,
    });

    await expect(queueSourcePermanentDeletion(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue20-source', confirmationSourceId: 'Deletion parity',
      reason: 'Typed the display name.', actorMembershipId: workspace.membership_id,
      requestId: 'issue20-mismatch', idempotencyKey: 'issue20-delete-mismatch',
    })).rejects.toMatchObject({ code: 'confirmation_mismatch' });

    const queued = await queueSourcePermanentDeletion(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue20-source', confirmationSourceId: 'issue20-source',
      reason: 'Governance-approved removal.', actorMembershipId: workspace.membership_id,
      requestId: 'issue20-delete', idempotencyKey: 'issue20-delete',
    });
    expect(queued).toMatchObject({ type: 'source.permanent_delete', state: 'queued' });

    const finished = await runSourceDeletionWorkerOnce(engine!, { workerId: 'issue20-worker' });
    expect(finished).toMatchObject({ operationId: queued.operationId, state: 'completed', progress: 100 });

    expect(await engine!.executeRaw("SELECT id FROM sources WHERE id='issue20-source'")).toEqual([]);
    expect(await engine!.executeRaw("SELECT id FROM pages WHERE source_id='issue20-source'")).toEqual([]);
    expect(await engine!.executeRaw("SELECT id FROM ingest_log WHERE source_id='issue20-source'")).toEqual([]);
    expect(await engine!.executeRaw("SELECT source_id FROM workspace_source_grants WHERE source_id='issue20-source'")).toEqual([]);
    const retained = (await engine!.executeRaw<{ deleted: boolean; archived: boolean; name: string; remote_url: string }>(
      "SELECT deleted,archived,name,remote_url FROM workspace_sources WHERE source_id='issue20-source'",
    ))[0]!;
    expect(retained).toMatchObject({ deleted: true, archived: true });
    expect(retained.name).not.toContain('parity');
    expect(retained.remote_url).not.toContain('example.test');
    expect(await engine!.executeRaw(
      "SELECT outcome,reason FROM workspace_audit_events WHERE action='source.delete' AND target_id='issue20-source'",
    )).toEqual([{ outcome: 'succeeded', reason: 'Governance-approved removal.' }]);
    const archivedSources = await listArchivedManagedGitSources(engine!, workspace.workspace_id);
    expect(archivedSources.find(source => source.sourceId === 'issue20-source')).toBeUndefined();
    await expect(restoreWorkspaceSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue20-source',
      actorMembershipId: workspace.membership_id, requestId: 'issue20-restore-deleted',
    })).rejects.toMatchObject({ code: 'source_not_found' });

    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id,
       archived,archived_at,archived_by_membership_id)
      VALUES ('issue20-revalidated',$1,'Revalidation parity','https://example.test/revalidated.git','daily','completed',$2,TRUE,now(),$2)`,
      [workspace.workspace_id, workspace.membership_id]);
    await queueSourcePermanentDeletion(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue20-revalidated', confirmationSourceId: 'issue20-revalidated',
      reason: 'Queued before an unexpected restore.', actorMembershipId: workspace.membership_id,
      requestId: 'issue20-revalidate', idempotencyKey: 'issue20-revalidate',
    });
    await engine!.executeRaw(
      "UPDATE workspace_sources SET archived=FALSE,archived_at=NULL WHERE source_id='issue20-revalidated'",
    );
    expect(await runSourceDeletionWorkerOnce(engine!, { workerId: 'issue20-worker' })).toMatchObject({
      state: 'failed', retryable: false,
      error: expect.objectContaining({ code: 'source_not_archived' }),
    });
    expect(await engine!.executeRaw<{ deleted: boolean }>(
      "SELECT deleted FROM workspace_sources WHERE source_id='issue20-revalidated'",
    )).toEqual([{ deleted: false }]);
  }, 30_000);

  test('keeps Knowledge cursor, Saved View, and reauthorization behavior in Postgres parity', async () => {
    const workspace = (await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
       WHERE m.role='administrator' ORDER BY m.membership_id LIMIT 1`,
    ))[0];
    await engine!.executeRaw(
      "INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member',$1,'all') ON CONFLICT (principal_kind,principal_id) DO UPDATE SET access_mode='all'",
      [workspace.membership_id],
    );
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id)
      VALUES ('issue17-source',$1,'Knowledge parity','https://example.test/knowledge.git','daily','completed',$2)`,
      [workspace.workspace_id, workspace.membership_id]);
    await engine!.executeRaw(
      "INSERT INTO sources (id,name,config) VALUES ('issue17-source','Knowledge parity source','{}'::jsonb) ON CONFLICT (id) DO NOTHING",
    );
    await engine!.executeRaw(`INSERT INTO pages
      (source_id,slug,type,page_kind,title,compiled_truth,frontmatter,import_filename,updated_at)
      VALUES
        ('issue17-source','alpha','document','markdown','Alpha','Body','{}'::jsonb,'alpha.md','2026-07-12T10:00:00Z'),
        ('issue17-source','beta','document','markdown','Beta','Body','{"citations":["source"]}'::jsonb,'beta.md','2026-07-13T10:00:00Z')`);

    const first = await listWorkspaceKnowledge(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id,
      filters: { source_ids: ['issue17-source'] }, sort: { property: 'title', direction: 'asc' },
      visibleProperties: ['title', 'evidence_status'], limit: 1,
    });
    expect(first).toMatchObject({ state: 'ready', rows: [{ slug: 'alpha' }] });
    expect(first.next_cursor).toBeString();
    expect((await listWorkspaceKnowledge(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id,
      filters: { source_ids: ['issue17-source'] }, sort: { property: 'title', direction: 'asc' },
      visibleProperties: ['title', 'evidence_status'], limit: 1, cursor: first.next_cursor!,
    })).rows).toMatchObject([{ slug: 'beta', evidence_status: 'cited' }]);

    const view = await createWorkspaceSavedView(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id, name: 'Postgres Knowledge',
      filters: { source_ids: ['issue17-source'] }, sort: { property: 'title', direction: 'asc' },
      visibleProperties: ['title', 'source'],
    });
    expect(await engine!.executeRaw(
      `SELECT jsonb_typeof(filters) AS filters_type,
              jsonb_typeof(sort) AS sort_type,
              jsonb_typeof(visible_properties) AS properties_type
         FROM workspace_saved_views WHERE view_id=$1`,
      [view.view_id],
    )).toEqual([{ filters_type: 'object', sort_type: 'object', properties_type: 'array' }]);
    expect((await openWorkspaceSavedView(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id, viewId: view.view_id,
    })).knowledge.rows).toHaveLength(2);

    await archiveWorkspaceSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue17-source',
      actorMembershipId: workspace.membership_id, requestId: 'issue17-archive',
    });
    expect((await openWorkspaceSavedView(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id, viewId: view.view_id,
    })).knowledge).toMatchObject({ state: 'no_matches', rows: [] });

    await restoreWorkspaceSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue17-source',
      actorMembershipId: workspace.membership_id, requestId: 'issue17-restore',
    });
    await engine!.executeRaw(
      "UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id=$1",
      [workspace.membership_id],
    );
    expect((await openWorkspaceSavedView(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id, viewId: view.view_id,
    })).knowledge).toMatchObject({ state: 'access_required', rows: [] });
  }, 20_000);

  test('keeps Page detail provenance, versions, and rechecked denial in Postgres parity', async () => {
    const workspace = (await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
       WHERE m.role='administrator' ORDER BY m.membership_id LIMIT 1`,
    ))[0];
    await engine!.executeRaw(
      "INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member',$1,'all') ON CONFLICT (principal_kind,principal_id) DO UPDATE SET access_mode='all'",
      [workspace.membership_id],
    );
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id,last_verified_at)
      VALUES ('issue18-source',$1,'Page parity','https://example.test/pages.git','daily','completed',$2,now())`,
      [workspace.workspace_id, workspace.membership_id]);
    await engine!.executeRaw(
      "INSERT INTO sources (id,name,config) VALUES ('issue18-source','Page parity source','{}'::jsonb) ON CONFLICT (id) DO NOTHING",
    );
    await engine!.executeRaw(`INSERT INTO pages
      (source_id,slug,type,page_kind,title,compiled_truth,frontmatter,import_filename,created_at,updated_at)
      VALUES ('issue18-source','guide','document','markdown','Parity guide','Second truth','{"citations":["ref"]}'::jsonb,'guide.md','2026-07-01T09:00:00Z','2026-07-10T09:00:00Z')`);
    await engine!.executeRaw(`INSERT INTO page_versions (page_id,compiled_truth,frontmatter,snapshot_at)
      SELECT id,'First truth','{"revision":1}'::jsonb,'2026-07-05T09:00:00Z' FROM pages WHERE source_id='issue18-source' AND slug='guide'`);
    await engine!.executeRaw(`INSERT INTO page_versions (page_id,compiled_truth,frontmatter,snapshot_at)
      SELECT id,'Second truth','{"revision":2}'::jsonb,'2026-07-10T09:00:00Z' FROM pages WHERE source_id='issue18-source' AND slug='guide'`);
    await engine!.executeRaw(`INSERT INTO ingest_log (source_id,source_type,source_ref,pages_updated,created_at)
      VALUES ('issue18-source','sync','revision-abc','["guide"]'::jsonb,'2026-07-08T09:00:00Z')`);

    const request = {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id,
      sourceId: 'issue18-source', slug: 'guide', now: '2026-07-13T10:00:00Z',
    };
    expect(await getWorkspacePage(engine!, request)).toMatchObject({
      page: { source_id: 'issue18-source', slug: 'guide' },
      provenance: {
        original_location: 'guide.md',
        ingestion: { path: 'sync', reference: 'revision-abc' },
      },
      evidence_status: { state: 'cited', explanation: { citation_count: 1, has_traceable_original: true } },
      body: 'Second truth',
    });

    const versions = await listWorkspacePageVersions(engine!, request);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      actor: null,
      cause: { path: 'sync', reference: 'revision-abc' },
      content: 'Second truth',
      metadata: { revision: 2 },
    });
    expect(versions[1]).toMatchObject({ actor: null, cause: null, content: 'First truth' });

    await archiveWorkspaceSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue18-source',
      actorMembershipId: workspace.membership_id, requestId: 'issue18-archive',
    });
    await expect(getWorkspacePage(engine!, request)).rejects.toMatchObject({ code: 'page_not_found' });
    await restoreWorkspaceSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue18-source',
      actorMembershipId: workspace.membership_id, requestId: 'issue18-restore',
    });

    await engine!.executeRaw(
      "UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id=$1",
      [workspace.membership_id],
    );
    for (const call of [() => getWorkspacePage(engine!, request), () => listWorkspacePageVersions(engine!, request)]) {
      let failure: unknown;
      try { await call(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(WorkspacePageError);
      expect((failure as WorkspacePageError).code).toBe('page_not_found');
    }
  }, 20_000);

  test('keeps Search inclusion, explicit selection, and link recheck in Postgres parity', async () => {
    const workspace = (await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
       WHERE m.role='administrator' ORDER BY m.membership_id LIMIT 1`,
    ))[0];
    await engine!.executeRaw(
      "INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member',$1,'all') ON CONFLICT (principal_kind,principal_id) DO UPDATE SET access_mode='all'",
      [workspace.membership_id],
    );
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id,included_in_workspace_search)
      VALUES
        ('issue19-included',$1,'Search parity included','https://example.test/search-included.git','daily','completed',$2,TRUE),
        ('issue19-excluded',$1,'Search parity excluded','https://example.test/search-excluded.git','daily','completed',$2,FALSE)`,
      [workspace.workspace_id, workspace.membership_id]);
    await engine!.executeRaw(`INSERT INTO sources (id,name,config) VALUES
      ('issue19-included','Search parity included','{}'::jsonb),
      ('issue19-excluded','Search parity excluded','{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    await engine!.executeRaw(`INSERT INTO pages
      (source_id,slug,type,page_kind,title,compiled_truth,frontmatter,import_filename,updated_at)
      VALUES
        ('issue19-included','launch-plan','document','markdown','Launch plan','The launch checklist covers rollout readiness.','{}'::jsonb,'launch.md','2026-07-12T10:00:00Z'),
        ('issue19-excluded','launch-retro','document','markdown','Launch retro','Retro notes about the launch.','{}'::jsonb,'retro.md','2026-07-13T10:00:00Z')`);

    expect(await engine!.executeRaw(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND indexname IN ('idx_pages_slug_trgm','idx_pages_body_trgm')
        ORDER BY indexname`,
    )).toEqual([{ indexname: 'idx_pages_body_trgm' }, { indexname: 'idx_pages_slug_trgm' }]);

    const defaults = await searchWorkspaceKnowledge(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id, query: 'launch',
    });
    expect(defaults.mode).toBe('workspace_search');
    expect(defaults.results.map(row => row.page.source_id)).toEqual(['issue19-included']);
    expect(defaults.results[0].match).toMatchObject({ field: 'title', snippet: 'Launch plan' });

    const bodyMatch = await searchWorkspaceKnowledge(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id, query: 'rollout readiness',
    });
    expect(bodyMatch.results[0].match.field).toBe('body');
    expect(bodyMatch.results[0].match.snippet).toContain('rollout readiness');

    const explicit = await searchWorkspaceKnowledge(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id, query: 'launch',
      sourceIds: ['issue19-excluded'],
    });
    expect(explicit.mode).toBe('explicit_sources');
    expect(explicit.results.map(row => row.page.slug)).toEqual(['launch-retro']);

    expect(await listWorkspaceSearchSources(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id,
    })).toEqual(expect.arrayContaining([
      { source_id: 'issue19-excluded', name: 'Search parity excluded', included_in_workspace_search: false },
      { source_id: 'issue19-included', name: 'Search parity included', included_in_workspace_search: true },
    ]));

    await engine!.executeRaw(
      "UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id=$1",
      [workspace.membership_id],
    );
    expect((await searchWorkspaceKnowledge(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id, query: 'launch',
    })).state).toBe('access_required');
    let recheckFailure: unknown;
    try {
      await getWorkspacePage(engine!, {
        workspaceId: workspace.workspace_id, membershipId: workspace.membership_id,
        sourceId: 'issue19-included', slug: 'launch-plan',
      });
    } catch (error) { recheckFailure = error; }
    expect((recheckFailure as { code?: string })?.code).toBe('page_not_found');
  }, 20_000);

  test('keeps Ask synthesis, reauthorization, cancellation, and retention lifecycle in Postgres parity', async () => {
    const workspaceId = await isolatedWorkspace('Ask parity');
    await engine!.executeRaw("INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('issue29-identity','ask-parity@example.test',now()) ON CONFLICT DO NOTHING");
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('issue29-member',$1,'issue29-identity','member') ON CONFLICT DO NOTHING",
      [workspaceId],
    );
    await engine!.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member','issue29-member','specific') ON CONFLICT (principal_kind,principal_id) DO UPDATE SET access_mode='specific'");
    await engine!.executeRaw("INSERT INTO workspace_source_grants (principal_kind,principal_id,source_id) VALUES ('member','issue29-member','issue29-handbook') ON CONFLICT DO NOTHING");
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id,included_in_workspace_search,last_verified_at)
      VALUES
        ('issue29-handbook',$1,'Ask handbook','https://example.test/ask.git','daily','completed','issue29-member',TRUE,now()),
        ('issue29-denied',$1,'Restricted Ask source','https://example.test/ask-denied.git','daily','completed','issue29-member',TRUE,now())
      ON CONFLICT DO NOTHING`, [workspaceId]);
    await engine!.executeRaw(`INSERT INTO sources (id,name,config) VALUES
      ('issue29-handbook','Ask handbook','{}'::jsonb),
      ('issue29-denied','Restricted Ask source','{}'::jsonb)
      ON CONFLICT DO NOTHING`);
    await engine!.executeRaw(`INSERT INTO pages
      (source_id,slug,type,page_kind,title,compiled_truth,frontmatter,import_filename)
      VALUES
        ('issue29-handbook','leave-policy','document','markdown','Leave policy','Members receive 20 days of annual leave.','{}'::jsonb,'leave.md'),
        ('issue29-handbook','benefits-guide','document','markdown','Benefits guide','Benefits requests go to People Operations.','{}'::jsonb,'benefits.md'),
        ('issue29-denied','restricted-benefits','document','markdown','Restricted benefits','Executive benefits are confidential.','{}'::jsonb,'restricted.md')
      ON CONFLICT (source_id,slug) DO NOTHING`);
    await engine!.executeRaw(`INSERT INTO links (from_page_id,to_page_id,link_type)
      SELECT seed.id,neighbor.id,'related'
        FROM pages seed,pages neighbor
       WHERE seed.source_id='issue29-handbook' AND seed.slug='leave-policy'
         AND ((neighbor.source_id='issue29-handbook' AND neighbor.slug='benefits-guide')
           OR (neighbor.source_id='issue29-denied' AND neighbor.slug='restricted-benefits'))
      ON CONFLICT DO NOTHING`);

    const supported = await createWorkspaceAsk(engine!, {
      workspaceId, membershipId: 'issue29-member', question: 'leave policy',
    });
    const expandedPages: string[] = [];
    await runWorkspaceAsk(engine!, supported.id, async input => {
      expandedPages.push(...input.pages.map(page => `${page.sourceId}:${page.slug}`));
      return {
        kind: 'answer', answer: 'Members receive 20 days of annual leave.',
        citations: [{ sourceId: 'issue29-handbook', slug: 'leave-policy' }],
      };
    });
    expect(expandedPages).toEqual(['issue29-handbook:leave-policy', 'issue29-handbook:benefits-guide']);
    expect(await getWorkspaceAsk(engine!, {
      workspaceId, membershipId: 'issue29-member', askResultId: supported.id,
    })).toMatchObject({ state: 'answered', citations: [{ sourceId: 'issue29-handbook', slug: 'leave-policy' }] });

    await engine!.executeRaw(
      "UPDATE pages SET deleted_at=now() WHERE source_id='issue29-handbook' AND slug='leave-policy'",
    );
    await expect(getWorkspaceAsk(engine!, {
      workspaceId, membershipId: 'issue29-member', askResultId: supported.id,
    })).rejects.toThrow('ask_result_not_found');
    await engine!.executeRaw(
      "UPDATE pages SET deleted_at=NULL WHERE source_id='issue29-handbook' AND slug='leave-policy'",
    );

    const revoked = await createWorkspaceAsk(engine!, {
      workspaceId, membershipId: 'issue29-member', question: 'leave policy',
    });
    await runWorkspaceAsk(engine!, revoked.id, async () => {
      await engine!.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id='issue29-member'");
      return { kind: 'answer' as const, answer: 'Must not be delivered.', citations: [{ sourceId: 'issue29-handbook', slug: 'leave-policy' }] };
    });
    expect((await engine!.executeRaw<{ state: string; answer: string | null }>(
      'SELECT state,answer FROM workspace_ask_results WHERE ask_result_id=$1', [revoked.id],
    ))[0]).toEqual({ state: 'not_enough_evidence', answer: null });
    expect(await getWorkspaceAsk(engine!, {
      workspaceId, membershipId: 'issue29-member', askResultId: revoked.id,
    })).toMatchObject({ state: 'not_enough_evidence', searchedSources: [] });

    await engine!.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='specific' WHERE principal_kind='member' AND principal_id='issue29-member'");
    const cancellable = await createWorkspaceAsk(engine!, {
      workspaceId, membershipId: 'issue29-member', question: 'leave policy',
    });
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const running = runWorkspaceAsk(engine!, cancellable.id, async () => {
      await waiting;
      return { kind: 'answer' as const, answer: 'Too late.', citations: [{ sourceId: 'issue29-handbook', slug: 'leave-policy' }] };
    });
    while ((await engine!.executeRaw<{ state: string }>('SELECT state FROM workspace_ask_results WHERE ask_result_id=$1', [cancellable.id]))[0]?.state !== 'running') {
      await Bun.sleep(1);
    }
    expect((await cancelWorkspaceAsk(engine!, {
      workspaceId, membershipId: 'issue29-member', askResultId: cancellable.id,
    })).state).toBe('cancelled');
    release();
    await running;
    expect((await getWorkspaceAsk(engine!, {
      workspaceId, membershipId: 'issue29-member', askResultId: cancellable.id,
    })).state).toBe('cancelled');

    const oldestExpired = await createWorkspaceAsk(engine!, {
      workspaceId, membershipId: 'issue29-member', question: 'oldest expired result',
    });
    const newerExpired = await createWorkspaceAsk(engine!, {
      workspaceId, membershipId: 'issue29-member', question: 'newer expired result',
    });
    await engine!.executeRaw(
      `UPDATE workspace_ask_results
          SET expires_at=CASE ask_result_id
            WHEN $1 THEN now() - interval '2 days'
            WHEN $2 THEN now() - interval '1 day'
            ELSE expires_at END
        WHERE ask_result_id IN ($1,$2)`,
      [oldestExpired.id, newerExpired.id],
    );
    expect(await purgeExpiredWorkspaceAskResults(engine!, { limit: 1 })).toBe(1);
    expect(await engine!.executeRaw(
      'SELECT ask_result_id FROM workspace_ask_results WHERE ask_result_id=$1', [oldestExpired.id],
    )).toHaveLength(0);
    expect(await engine!.executeRaw(
      'SELECT ask_result_id FROM workspace_ask_results WHERE ask_result_id=$1', [newerExpired.id],
    )).toHaveLength(1);
  }, 60_000);

  test('derives Setup Checklist evidence and Member Home states with Postgres parity', async () => {
    const workspace = (await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
       WHERE m.role='administrator' ORDER BY m.membership_id LIMIT 1`,
    ))[0]!;
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id,last_sync_at)
      VALUES ('issue23-source',$1,'Checklist parity','https://example.test/checklist.git','daily','completed',$2,now())`,
      [workspace.workspace_id, workspace.membership_id]);

    const record = () => recordWorkspacePageProvenanceInspection(engine!, {
      workspaceId: workspace.workspace_id, membershipId: workspace.membership_id,
      sourceId: 'issue23-source', slug: 'parity-guide',
    });
    await record();
    await record();
    expect(await engine!.executeRaw(
      "SELECT slug FROM workspace_page_provenance_inspections WHERE source_id='issue23-source'",
    )).toHaveLength(1);

    let checklist = await getWorkspaceSetupChecklist(engine!, workspace.workspace_id);
    expect(checklist.steps.map(step => step.step)).toEqual([
      'connect_source', 'complete_synchronization', 'inspect_provenance', 'invite_members', 'register_agent',
    ]);
    expect(checklist.steps.find(step => step.step === 'complete_synchronization')).toMatchObject({
      complete: true, evidence: 'Source issue23-source completed synchronization',
    });
    expect(checklist.steps.find(step => step.step === 'inspect_provenance')).toMatchObject({
      complete: true, evidence: 'Provenance inspected for issue23-source/parity-guide',
    });

    await engine!.executeRaw(
      "INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('issue23-identity','issue23-member@example.test',now()) ON CONFLICT DO NOTHING",
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('issue23-member',$1,'issue23-identity','member') ON CONFLICT DO NOTHING",
      [workspace.workspace_id],
    );
    await setPrincipalSourceAccess(engine!, { kind: 'member', id: 'issue23-member' }, { mode: 'none' });
    expect(await getWorkspaceMemberHomeState(engine!, workspace.workspace_id, 'issue23-member')).toBe('access_required');
    await setPrincipalSourceAccess(engine!, { kind: 'member', id: 'issue23-member' }, { mode: 'specific', sourceIds: ['issue23-source'] });
    expect(await getWorkspaceMemberHomeState(engine!, workspace.workspace_id, 'issue23-member')).toBe('ready');

    await engine!.executeRaw("UPDATE workspace_sources SET archived=TRUE,archived_at=now() WHERE source_id='issue23-source'");
    checklist = await getWorkspaceSetupChecklist(engine!, workspace.workspace_id);
    expect(checklist.steps.find(step => step.step === 'complete_synchronization')!.complete).toBe(false);
    expect(checklist.steps.find(step => step.step === 'inspect_provenance')!.complete).toBe(false);
    expect(await getWorkspaceMemberHomeState(engine!, workspace.workspace_id, 'issue23-member')).toBe('setting_up');

    await engine!.executeRaw("UPDATE workspace_sources SET archived=FALSE,archived_at=NULL WHERE source_id='issue23-source'");
    checklist = await getWorkspaceSetupChecklist(engine!, workspace.workspace_id);
    expect(checklist.steps.find(step => step.step === 'inspect_provenance')!.complete).toBe(true);

    // Keep later suite expectations stable: remove the parity member's grants
    // and Source; the inspection record itself stays durable by design.
    await engine!.executeRaw("DELETE FROM workspace_source_grants WHERE principal_kind='member' AND principal_id='issue23-member'");
    await engine!.executeRaw("DELETE FROM workspace_principal_source_policies WHERE principal_kind='member' AND principal_id='issue23-member'");
    await engine!.executeRaw("DELETE FROM workspace_sources WHERE source_id='issue23-source'");
  }, 20_000);

  test('operates Source-health Attention Items through detection, dedup, dismissal, and verified recovery with Postgres parity', async () => {
    const workspace = (await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
       WHERE m.role='administrator' ORDER BY m.membership_id LIMIT 1`,
    ))[0]!;
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id)
      VALUES ('issue24-source',$1,'Attention parity','https://example.test/attention.git','daily','completed',$2)`,
      [workspace.workspace_id, workspace.membership_id]);
    await engine!.executeRaw(
      "INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('issue24-identity','issue24-member@example.test',now()) ON CONFLICT DO NOTHING",
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('issue24-member',$1,'issue24-identity','member') ON CONFLICT DO NOTHING",
      [workspace.workspace_id],
    );
    await setPrincipalSourceAccess(engine!, { kind: 'member', id: 'issue24-member' }, { mode: 'none' });
    await setPrincipalSourceAccess(engine!, { kind: 'member', id: workspace.membership_id }, { mode: 'all' });

    const runMaintenance = async (outcome: 'succeed' | 'fail', key: string) => {
      await queueSourceMaintenance(engine!, {
        workspaceId: workspace.workspace_id, sourceId: 'issue24-source', type: 'source.verify',
        actorMembershipId: workspace.membership_id, requestId: `issue24-${key}`, idempotencyKey: `issue24-${key}`,
      });
      await armQueuedOperationsAgainstClockSteps(
        engine!, 'workspace_background_operations',
        "workspace_id=$1 AND resource_id='issue24-source'", [workspace.workspace_id],
      );
      const completed = await runSourceMaintenanceWorkerOnce(engine!, {
        workerId: `issue24-worker-${key}`,
        execute: async () => {
          if (outcome === 'fail') throw new Error('remote unreachable');
          return { observedRevision: 'issue24-rev', changed: false };
        },
      });
      expect(completed?.resourceId).toBe('issue24-source');
    };
    const detect = (requestId: string) => runWorkspaceSourceHealthDetector(engine!, {
      workspaceId: workspace.workspace_id, requestId,
    });
    const mine = (run: { detectedItemIds: string[] }, all: { itemId: string; resource: { id: string } }[]) =>
      run.detectedItemIds.filter(id => all.some(item => item.itemId === id && item.resource.id === 'issue24-source'));
    const adminViewer = { membershipId: workspace.membership_id, role: 'administrator' as const };

    await runMaintenance('fail', 'verify-1');
    const first = await detect('issue24-detect-1');
    let items = await listWorkspaceAttentionItems(engine!, { workspaceId: workspace.workspace_id, viewer: adminViewer });
    const [itemId] = mine(first, items);
    expect(itemId).toBeTruthy();

    // Dedup during the uninterrupted episode.
    await runMaintenance('fail', 'verify-2');
    await detect('issue24-detect-2');
    items = await listWorkspaceAttentionItems(engine!, { workspaceId: workspace.workspace_id, viewer: adminViewer });
    expect(items.filter(item => item.resource.id === 'issue24-source')).toHaveLength(1);

    // Member without Source Access never sees the item.
    const memberItems = await listWorkspaceAttentionItems(engine!, {
      workspaceId: workspace.workspace_id, viewer: { membershipId: 'issue24-member', role: 'member' },
    });
    expect(memberItems.some(item => item.resource.id === 'issue24-source')).toBe(false);

    // Assign, progress, and a resolution request that verifies the condition
    // is still present.
    await assignWorkspaceAttentionItem(engine!, {
      workspaceId: workspace.workspace_id, itemId: itemId!, viewer: adminViewer, requestId: 'issue24-assign',
    });
    await startWorkspaceAttentionProgress(engine!, {
      workspaceId: workspace.workspace_id, itemId: itemId!, viewer: adminViewer, requestId: 'issue24-start',
    });
    const stillPresent = await requestWorkspaceAttentionResolution(engine!, {
      workspaceId: workspace.workspace_id, itemId: itemId!, viewer: adminViewer, requestId: 'issue24-resolve-1',
    });
    expect(stillPresent).toMatchObject({ conditionPresent: true, item: { status: 'in_progress' } });

    // Verified recovery resolves the item and ends the episode.
    await runMaintenance('succeed', 'verify-3');
    const recovered = await requestWorkspaceAttentionResolution(engine!, {
      workspaceId: workspace.workspace_id, itemId: itemId!, viewer: adminViewer, requestId: 'issue24-resolve-2',
    });
    expect(recovered.item).toMatchObject({ status: 'resolved', episode: { state: 'cleared' } });

    // Recurrence starts a new episode and a new item; dismissal then keeps
    // suppressing that continuing episode.
    await runMaintenance('fail', 'verify-4');
    const recurrence = await detect('issue24-detect-3');
    items = await listWorkspaceAttentionItems(engine!, { workspaceId: workspace.workspace_id, viewer: adminViewer });
    const [secondItemId] = mine(recurrence, items);
    expect(secondItemId).toBeTruthy();
    expect(secondItemId).not.toBe(itemId);
    await dismissWorkspaceAttentionItem(engine!, {
      workspaceId: workspace.workspace_id, itemId: secondItemId!, reason: 'Planned outage window.',
      viewer: adminViewer, requestId: 'issue24-dismiss',
    });
    const suppressed = await detect('issue24-detect-4');
    items = await listWorkspaceAttentionItems(engine!, { workspaceId: workspace.workspace_id, viewer: adminViewer });
    expect(mine(suppressed, items)).toHaveLength(0);

    // Archiving stops active Source health work; the dismissed item's episode
    // clears without resurrecting it.
    await archiveWorkspaceSource(engine!, {
      workspaceId: workspace.workspace_id, sourceId: 'issue24-source',
      actorMembershipId: workspace.membership_id, requestId: 'issue24-archive',
    });
    await detect('issue24-detect-5');
    const detail = await getWorkspaceAttentionItem(engine!, {
      workspaceId: workspace.workspace_id, itemId: secondItemId!, viewer: adminViewer,
    });
    expect(detail.status).toBe('dismissed');
    expect(detail.episode.state).toBe('cleared');
    expect(detail.history.map(entry => entry.event)).toContain('episode_cleared');

    const audits = await engine!.executeRaw<{ action: string }>(
      "SELECT action FROM workspace_audit_events WHERE action LIKE 'attention.%' AND target_id IN ($1,$2) AND outcome='succeeded'",
      [itemId, secondItemId],
    );
    expect(new Set(audits.map(row => row.action))).toEqual(new Set([
      'attention.detect', 'attention.assign', 'attention.status.change',
      'attention.resolve.request', 'attention.resolve', 'attention.dismiss',
    ]));

    // The Source stays archived (durable maintenance evidence references it);
    // only the parity member's policy is removed.
    await engine!.executeRaw("DELETE FROM workspace_principal_source_policies WHERE principal_kind='member' AND principal_id='issue24-member'");
  }, 30_000);

  test('detects Knowledge, Agent, and Automation Attention conditions with Postgres parity', async () => {
    const workspace = (await engine!.executeRaw<{ workspace_id: string; membership_id: string }>(
      `SELECT w.workspace_id,m.membership_id FROM workspace_workspaces w
       JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
       WHERE m.role='administrator' ORDER BY m.membership_id LIMIT 1`,
    ))[0]!;
    const adminViewer = { membershipId: workspace.membership_id, role: 'administrator' as const };
    await setPrincipalSourceAccess(engine!, { kind: 'member', id: workspace.membership_id }, { mode: 'all' });
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id)
      VALUES ('issue25-source',$1,'Detector parity','https://example.test/detectors.git','daily','completed',$2)`,
      [workspace.workspace_id, workspace.membership_id]);
    await engine!.executeRaw("INSERT INTO sources (id,name) VALUES ('issue25-source','Detector parity') ON CONFLICT (id) DO NOTHING");
    await engine!.executeRaw(
      "INSERT INTO pages (source_id,slug,type,title) VALUES ('issue25-source','evidence-gap','document','Evidence gap')",
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('issue25-identity','issue25-member@example.test',now()) ON CONFLICT DO NOTHING",
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('issue25-member',$1,'issue25-identity','member') ON CONFLICT DO NOTHING",
      [workspace.workspace_id],
    );
    await setPrincipalSourceAccess(engine!, { kind: 'member', id: 'issue25-member' }, { mode: 'specific', sourceIds: ['issue25-source'] });

    const registered = await registerWorkspaceAgent(engine!, {
      workspaceId: workspace.workspace_id, name: 'Detector parity agent', purpose: 'Issue 25 parity coverage.',
      ownerMembershipId: workspace.membership_id, scope: 'admin',
      actorMembershipId: workspace.membership_id, requestId: 'issue25-register',
    });
    for (const attempt of [1, 2, 3]) {
      await recordWorkspaceAgentActivity(engine!, {
        workspaceId: workspace.workspace_id, agentId: registered.agentId,
        operation: 'page.read', outcome: 'failed', sourceId: 'issue25-source', requestId: `issue25-fail-${attempt}`,
      });
    }
    await recordWorkspaceRuntimeHeartbeat(engine!, 'worker');
    await engine!.executeRaw("UPDATE workspace_runtime_heartbeats SET last_heartbeat_at = now() - interval '10 minutes' WHERE role='worker'");

    const detect = (requestId: string) => runWorkspaceAttentionDetectors(engine!, {
      workspaceId: workspace.workspace_id, requestId,
    });
    const mineKeys = new Set([
      'knowledge.missing_evidence issue25-source:evidence-gap',
      `agent.admin_scope_review ${registered.agentId}`,
      `agent.repeated_authorization_failure ${registered.agentId}`,
      'automation.runtime_stalled worker',
    ]);
    const mine = <T extends { conditionType: string; resource: { id: string } }>(items: T[]): T[] =>
      items.filter(item => mineKeys.has(`${item.conditionType} ${item.resource.id}`));

    await detect('issue25-detect-1');
    let items = mine(await listWorkspaceAttentionItems(engine!, { workspaceId: workspace.workspace_id, viewer: adminViewer }));
    expect(items.map(item => `${item.category}:${item.conditionType}`).sort()).toEqual([
      'agent_access:agent.admin_scope_review',
      'agent_access:agent.repeated_authorization_failure',
      'automation_health:automation.runtime_stalled',
      'knowledge_quality:knowledge.missing_evidence',
    ]);
    // Agent access evidence never carries credential material.
    expect(JSON.stringify(items)).not.toContain(registered.credential.token);

    // The parity Member sees only the Page-scoped Knowledge quality work.
    const memberItems = mine(await listWorkspaceAttentionItems(engine!, {
      workspaceId: workspace.workspace_id, viewer: { membershipId: 'issue25-member', role: 'member' },
    }));
    expect(memberItems.map(item => item.category)).toEqual(['knowledge_quality']);

    // Retries, concurrent evaluation, and a restarted worker never duplicate
    // active items: the partial unique active-episode index is authoritative.
    await Promise.all([
      detect('issue25-concurrent-1').catch(() => null),
      detect('issue25-concurrent-2').catch(() => null),
    ]);
    await runWorkspaceAttentionDetectors(engine!, {
      workspaceId: workspace.workspace_id, requestId: 'issue25-restart', detectorId: 'issue25-restarted-worker',
    });
    items = mine(await listWorkspaceAttentionItems(engine!, { workspaceId: workspace.workspace_id, viewer: adminViewer }));
    expect(items.filter(item => item.status === 'open')).toHaveLength(4);

    // Verified recovery per category.
    await engine!.executeRaw(
      `UPDATE pages SET frontmatter='{"citations":["https://example.test/spec"]}'::jsonb, updated_at=now()
        WHERE source_id='issue25-source' AND slug='evidence-gap'`,
    );
    await setWorkspaceAgentScope(engine!, workspace.workspace_id, registered.agentId, 'read',
      workspace.membership_id, 'issue25-scope', 'Least privilege review.');
    await recordWorkspaceAgentActivity(engine!, {
      workspaceId: workspace.workspace_id, agentId: registered.agentId,
      operation: 'page.read', outcome: 'succeeded', sourceId: 'issue25-source', requestId: 'issue25-recovered',
    });
    await recordWorkspaceRuntimeHeartbeat(engine!, 'worker');
    await detect('issue25-detect-2');
    items = mine(await listWorkspaceAttentionItems(engine!, { workspaceId: workspace.workspace_id, viewer: adminViewer }));
    expect(items).toHaveLength(4);
    expect(items.every(item => item.status === 'resolved' && item.episode.state === 'cleared')).toBe(true);

    // Recovery survives a backwards wall-clock step. Postgres `now()` is not
    // monotonic across transactions — an NTP correction or a VM suspend/resume
    // can stamp the recovery earlier than the failure streak it supersedes — so
    // "the three most recent events" must be read from the recorded order.
    for (const attempt of [4, 5, 6]) {
      await recordWorkspaceAgentActivity(engine!, {
        workspaceId: workspace.workspace_id, agentId: registered.agentId,
        operation: 'page.read', outcome: 'failed', sourceId: 'issue25-source', requestId: `issue25-refail-${attempt}`,
      });
    }
    const relapsed = await detect('issue25-detect-3');
    expect(relapsed.detectedItemIds).toHaveLength(1);
    await recordWorkspaceAgentActivity(engine!, {
      workspaceId: workspace.workspace_id, agentId: registered.agentId,
      operation: 'page.read', outcome: 'succeeded', sourceId: 'issue25-source', requestId: 'issue25-recovered-clock-step',
    });
    await engine!.executeRaw(
      `UPDATE workspace_agent_activity SET occurred_at = occurred_at - interval '1 hour'
        WHERE agent_id = $1 AND request_id = 'issue25-recovered-clock-step'`,
      [registered.agentId],
    );
    const afterStep = await detect('issue25-detect-4');
    expect(afterStep.resolvedItemIds).toEqual(relapsed.detectedItemIds);
    const stepped = await getWorkspaceAttentionItem(engine!, {
      workspaceId: workspace.workspace_id, itemId: relapsed.detectedItemIds[0]!, viewer: adminViewer,
    });
    expect(stepped.status).toBe('resolved');
    expect(stepped.episode.state).toBe('cleared');

    // Keep later suite expectations stable.
    await engine!.executeRaw("DELETE FROM workspace_source_grants WHERE principal_kind='member' AND principal_id='issue25-member'");
    await engine!.executeRaw("DELETE FROM workspace_principal_source_policies WHERE principal_kind='member' AND principal_id='issue25-member'");
  }, 30_000);

  test('serializes Change Event cursor allocation through transaction commit order', async () => {
    const workspaces = await engine!.executeRaw<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_workspaces ORDER BY workspace_id LIMIT 1',
    );
    const workspaceId = workspaces[0]!.workspace_id;
    let releaseFirst!: () => void;
    let markFirstInserted!: () => void;
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstInserted = new Promise<void>(resolve => { markFirstInserted = resolve; });
    let firstEventId = '';
    const firstTransaction = engine!.transaction(async transaction => {
      firstEventId = await appendWorkspaceChangeEvent(transaction, {
        actor: { kind: 'system', id: 'cursor-worker-a' }, action: 'workspace.setup.confirm',
        resource: { type: 'workspace', id: workspaceId }, requestId: 'cursor-order-a', workspaceId,
      });
      markFirstInserted();
      await firstRelease;
    });
    await firstInserted;

    let secondCommitted = false;
    const secondTransaction = engine!.transaction(async transaction => {
      const eventId = await appendWorkspaceChangeEvent(transaction, {
        actor: { kind: 'system', id: 'cursor-worker-b' }, action: 'workspace.setup.confirm',
        resource: { type: 'workspace', id: workspaceId }, requestId: 'cursor-order-b', workspaceId,
      });
      secondCommitted = true;
      return eventId;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(secondCommitted).toBe(false);
    releaseFirst();
    const [, secondEventId] = await Promise.all([firstTransaction, secondTransaction]);
    const sequences = await engine!.executeRaw<{ event_id: string; event_sequence: string }>(
      `SELECT event_id,event_sequence::text AS event_sequence FROM workspace_change_events
        WHERE event_id=ANY($1::text[]) ORDER BY event_sequence`,
      [[firstEventId, secondEventId]],
    );
    expect(sequences.map(row => row.event_id)).toEqual([firstEventId, secondEventId]);
  }, 20_000);

  test('keeps live-update cursor and current Source Access projection in Postgres parity', async () => {
    const suffix = randomBytes(4).toString('hex');
    const workspaces = await engine!.executeRaw<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_workspaces ORDER BY workspace_id LIMIT 1',
    );
    const workspaceId = workspaces[0]!.workspace_id;
    const membershipId = `live-member-${suffix}`;
    const identityId = `live-identity-${suffix}`;
    const allowedSourceId = `live-allowed-${suffix}`;
    const hiddenSourceId = `live-hidden-${suffix}`;
    await engine!.executeRaw('INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ($1,$2,now())', [identityId, `live-${suffix}@example.test`]);
    await engine!.executeRaw("INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,'member')", [membershipId, workspaceId, identityId]);
    await engine!.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member',$1,'specific')", [membershipId]);
    await engine!.executeRaw("INSERT INTO workspace_source_grants (principal_kind,principal_id,source_id) VALUES ('member',$1,$2)", [membershipId, allowedSourceId]);
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id,archived)
      VALUES ($1,$3,'Allowed','https://example.test/allowed.git','daily','completed',$2,FALSE),
             ($4,$3,'Hidden','https://example.test/hidden.git','daily','completed',$2,FALSE)`,
    [allowedSourceId, membershipId, workspaceId, hiddenSourceId]);
    const baseline = await listWorkspaceLiveUpdates(engine!, {
      workspaceId, membershipId, role: 'member',
    });

    const allowedEventId = await appendWorkspaceChangeEvent(engine!, {
      actor: { kind: 'system', id: 'postgres-live-worker' }, action: 'source.verify.complete',
      resource: { type: 'source', id: allowedSourceId }, requestId: `live-allowed-${suffix}`,
    });
    await appendWorkspaceChangeEvent(engine!, {
      actor: { kind: 'system', id: 'postgres-live-worker' }, action: 'source.verify.complete',
      resource: { type: 'source', id: hiddenSourceId }, requestId: `live-hidden-${suffix}`,
    });
    const first = await listWorkspaceLiveUpdates(engine!, {
      workspaceId, membershipId, role: 'member', cursor: baseline.cursor,
    });
    expect(first.events.map(event => [event.id, event.resource])).toEqual([[allowedEventId, 'sources']]);
    expect(first.cursor).toMatch(/^\d+$/);
    expect(JSON.stringify(first)).not.toContain(hiddenSourceId);

    await engine!.executeRaw("DELETE FROM workspace_source_grants WHERE principal_kind='member' AND principal_id=$1", [membershipId]);
    const accessEventId = await appendWorkspaceChangeEvent(engine!, {
      actor: { kind: 'member', id: membershipId }, action: 'membership.source_access.change',
      resource: { type: 'membership', id: membershipId }, requestId: `live-access-${suffix}`,
    });
    const afterReduction = await listWorkspaceLiveUpdates(engine!, {
      workspaceId, membershipId, role: 'member', cursor: first.cursor,
    });
    expect(afterReduction.events.map(event => [event.id, event.resource])).toEqual([[accessEventId, 'access']]);
    expect(await engine!.executeRaw(
      'SELECT event_sequence::text AS event_sequence,workspace_id FROM workspace_change_events WHERE event_id=$1',
      [accessEventId],
    )).toEqual([{ event_sequence: expect.stringMatching(/^\d+$/), workspace_id: workspaceId }]);
  }, 20_000);

  test('keeps Home trust evidence fail-closed under current Source Access in Postgres parity', async () => {
    const suffix = randomBytes(4).toString('hex');
    const workspaceId = await isolatedWorkspace('Home parity');
    const adminId = `home-admin-${suffix}`;
    const adminIdentityId = `home-admin-identity-${suffix}`;
    const memberId = `home-member-${suffix}`;
    const identityId = `home-identity-${suffix}`;
    const allowedSource = `home-allowed-${suffix}`;
    const hiddenSource = `home-hidden-${suffix}`;
    const allowedAttention = `home-attention-allowed-${suffix}`;
    const hiddenAttention = `home-attention-hidden-${suffix}`;
    await engine!.executeRaw(
      'INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ($1,$2,now())',
      [adminIdentityId, `home-admin-${suffix}@example.test`],
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,'administrator')",
      [adminId, workspaceId, adminIdentityId],
    );
    await engine!.executeRaw(
      'INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ($1,$2,now())',
      [identityId, `home-${suffix}@example.test`],
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,'member')",
      [memberId, workspaceId, identityId],
    );
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id,last_verified_at,last_sync_at)
      VALUES ($1,$3,'Allowed Home evidence','https://example.test/home-allowed.git','daily','completed',$2,now(),now()),
             ($4,$3,'Hidden Home secret','https://example.test/home-hidden.git','daily','completed',$2,now()-interval '10 days',now())`,
    [allowedSource, adminId, workspaceId, hiddenSource]);
    await setPrincipalSourceAccess(engine!, { kind: 'member', id: memberId }, { mode: 'specific', sourceIds: [allowedSource] });
    await engine!.executeRaw(`INSERT INTO workspace_condition_episodes
      (episode_id,workspace_id,category,condition_type,resource_type,resource_id)
      VALUES ($1,$3,'source_health','source_stale','source',$4),($2,$3,'source_health','source_stale','source',$5)`,
    [`home-episode-allowed-${suffix}`, `home-episode-hidden-${suffix}`, workspaceId, allowedSource, hiddenSource]);
    await engine!.executeRaw(`INSERT INTO workspace_attention_items
      (item_id,workspace_id,episode_id,category,condition_type,resource_type,resource_id,summary,evidence,status)
      VALUES ($1,$3,$4,'source_health','source_stale','source',$5,'Allowed Home Attention','{}','open'),
             ($2,$3,$6,'source_health','source_stale','source',$7,'Hidden Home Attention secret','{}','open')`,
    [allowedAttention, hiddenAttention, workspaceId, `home-episode-allowed-${suffix}`, allowedSource, `home-episode-hidden-${suffix}`, hiddenSource]);
    await engine!.executeRaw(`INSERT INTO workspace_background_operations
      (operation_id,workspace_id,operation_type,initiator_membership_id,resource_type,resource_id,state,progress,idempotency_key,idempotency_fingerprint,request_id)
      VALUES ($1,$3,'source.sync',$4,'source',$5,'running',35,$1,$1,$1),
             ($2,$3,'source.sync',$4,'source',$6,'failed',70,$2,$2,$2)`,
    [`home-operation-allowed-${suffix}`, `home-operation-hidden-${suffix}`, workspaceId, adminId, allowedSource, hiddenSource]);
    const allowedChange = await appendWorkspaceChangeEvent(engine!, {
      actor: { kind: 'system', id: 'home-parity-worker' }, action: 'source.sync.complete',
      resource: { type: 'source', id: allowedSource }, requestId: `home-change-allowed-${suffix}`,
    });
    await appendWorkspaceChangeEvent(engine!, {
      actor: { kind: 'system', id: 'home-parity-worker' }, action: 'source.sync.complete',
      resource: { type: 'source', id: hiddenSource }, requestId: `home-change-hidden-${suffix}`,
    });
    const pageChange = await appendWorkspaceChangeEvent(engine!, {
      actor: { kind: 'agent', id: 'home-parity-agent' }, action: 'source.sync.complete',
      resource: { type: 'page', id: `${allowedSource}:guide` }, workspaceId,
      requestId: `home-change-page-${suffix}`,
    });
    await appendWorkspaceChangeEvent(engine!, {
      actor: { kind: 'member', id: memberId }, action: 'workspace.login',
      resource: { type: 'workspace', id: workspaceId }, requestId: `home-login-${suffix}`,
    });

    const home = await getWorkspaceHome(engine!, {
      workspaceId,
      viewer: { membershipId: memberId, role: 'member' },
    });
    expect(home.attention.map(item => item.itemId)).toEqual([allowedAttention]);
    expect(home.operations.map(operation => operation.operationId)).toEqual([`home-operation-allowed-${suffix}`]);
    expect(home.recentChanges.map(change => change.eventId)).toEqual([pageChange, allowedChange]);
    expect(home.trustSummary.every(statement => statement.evidence.href.startsWith('/app'))).toBe(true);
    const serialized = JSON.stringify(home);
    expect(serialized).toContain('Allowed Home evidence');
    expect(serialized).not.toContain('Hidden Home secret');
    expect(serialized).not.toContain(hiddenSource);
    expect(serialized).not.toContain(hiddenAttention);
    expect(serialized).not.toContain('Signed in');

    await engine!.executeRaw('DELETE FROM workspace_change_events WHERE request_id LIKE $1', [`home-%-${suffix}`]);
    await engine!.executeRaw('DELETE FROM workspace_background_operations WHERE operation_id=ANY($1::text[])', [[`home-operation-allowed-${suffix}`, `home-operation-hidden-${suffix}`]]);
    await engine!.executeRaw('DELETE FROM workspace_attention_items WHERE item_id=ANY($1::text[])', [[allowedAttention, hiddenAttention]]);
    await engine!.executeRaw('DELETE FROM workspace_condition_episodes WHERE episode_id=ANY($1::text[])', [[`home-episode-allowed-${suffix}`, `home-episode-hidden-${suffix}`]]);
    await engine!.executeRaw("DELETE FROM workspace_source_grants WHERE principal_kind='member' AND principal_id=$1", [memberId]);
    await engine!.executeRaw("DELETE FROM workspace_principal_source_policies WHERE principal_kind='member' AND principal_id=$1", [memberId]);
    await engine!.executeRaw('DELETE FROM workspace_sources WHERE source_id=ANY($1::text[])', [[allowedSource, hiddenSource]]);
    await engine!.executeRaw('DELETE FROM workspace_memberships WHERE membership_id=$1', [memberId]);
    await engine!.executeRaw('DELETE FROM workspace_memberships WHERE membership_id=$1', [adminId]);
    await engine!.executeRaw('DELETE FROM workspace_identities WHERE identity_id=$1', [identityId]);
    await engine!.executeRaw('DELETE FROM workspace_identities WHERE identity_id=$1', [adminIdentityId]);
  }, 60_000);

  test('keeps personal Notification storage, authorization, mutation, and live projection in Postgres parity', async () => {
    const suffix = randomBytes(4).toString('hex');
    const workspaceId = await isolatedWorkspace('Notification parity');
    const membershipId = `notification-member-${suffix}`;
    const identityId = `notification-identity-${suffix}`;
    const sourceId = `notification-source-${suffix}`;
    const episodeId = `notification-episode-${suffix}`;
    const itemId = `notification-attention-${suffix}`;
    await engine!.executeRaw('INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ($1,$2,now())', [identityId, `notification-${suffix}@example.test`]);
    await engine!.executeRaw("INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,'member')", [membershipId, workspaceId, identityId]);
    await engine!.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member',$1,'specific')", [membershipId]);
    await engine!.executeRaw("INSERT INTO workspace_source_grants (principal_kind,principal_id,source_id) VALUES ('member',$1,$2)", [membershipId, sourceId]);
    await engine!.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id)
      VALUES ($1,$2,'Notification parity','https://example.test/notification.git','daily','completed',$3)`,
    [sourceId, workspaceId, membershipId]);
    await engine!.executeRaw(`INSERT INTO workspace_condition_episodes
      (episode_id,workspace_id,category,condition_type,resource_type,resource_id)
      VALUES ($1,$2,'source_health','source.verification_failure','source',$3)`,
    [episodeId, workspaceId, sourceId]);
    await engine!.executeRaw(`INSERT INTO workspace_attention_items
      (item_id,workspace_id,episode_id,category,condition_type,resource_type,resource_id,summary,assignee_membership_id)
      VALUES ($1,$2,$3,'source_health','source.verification_failure','source',$4,'Source verification is failing.',$5)`,
    [itemId, workspaceId, episodeId, sourceId, membershipId]);
    const baseline = await listWorkspaceLiveUpdates(engine!, { workspaceId, membershipId, role: 'member' });

    const notification = await createWorkspaceNotificationForEvent(engine!, {
      workspaceId, eventKey: `postgres-notification-${suffix}`, eventType: 'attention_assigned',
      target: { type: 'attention_item', id: itemId },
    });
    expect(notification).not.toBeNull();
    expect(await countWorkspaceUnreadNotifications(engine!, { workspaceId, membershipId })).toBe(1);
    expect((await listWorkspaceNotifications(engine!, { workspaceId, membershipId })).items.map(item => item.id)).toEqual([notification!.id]);
    expect((await listWorkspaceLiveUpdates(engine!, {
      workspaceId, membershipId, role: 'member', cursor: baseline.cursor,
    })).events.map(event => event.resource)).toEqual(['notifications']);

    expect((await setWorkspaceNotificationRead(engine!, {
      workspaceId, membershipId, notificationId: notification!.id, read: true,
    })).unread).toBe(false);
    expect((await archiveWorkspaceNotification(engine!, {
      workspaceId, membershipId, notificationId: notification!.id,
    })).archived).toBe(true);
    expect((await listWorkspaceNotifications(engine!, { workspaceId, membershipId })).items).toEqual([]);

    const restricted = await createWorkspaceNotificationForEvent(engine!, {
      workspaceId, eventKey: `postgres-notification-revoked-${suffix}`, eventType: 'attention_assigned',
      target: { type: 'attention_item', id: itemId },
    });
    expect(restricted).not.toBeNull();
    await engine!.executeRaw("DELETE FROM workspace_source_grants WHERE principal_kind='member' AND principal_id=$1", [membershipId]);
    expect((await listWorkspaceNotifications(engine!, { workspaceId, membershipId })).items).toEqual([]);
  }, 60_000);

  test('produces a secret-free Workspace Export under a consistent Postgres snapshot', async () => {
    const suffix = randomBytes(4).toString('hex');
    const workspaceId = await isolatedWorkspace('Export parity');
    const identityId = `export-identity-${suffix}`;
    const membershipId = `export-member-${suffix}`;
    const sourceId = `export-source-${suffix}`;
    const remoteSecret = `PG-REMOTE-TOKEN-${suffix}`;
    const invitationSecret = `PG-INVITATION-HASH-${suffix}`;
    const sessionSecret = `PG-SESSION-HASH-${suffix}`;
    const bootstrapSecret = `PG-BOOTSTRAP-HASH-${suffix}`;
    const providerSecret = `PG-PROVIDER-KEY-${suffix}`;
    const cloneSecret = `PG-CLONE-PATH-${suffix}`;

    await engine!.executeRaw(
      'INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ($1,$2,now())',
      [identityId, `${suffix}@example.test`],
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,'administrator')",
      [membershipId, workspaceId, identityId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_sources (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id)
       VALUES ($1,$2,'Export handbook',$3,'daily','completed',$4)`,
      [sourceId, workspaceId, `https://ci:${remoteSecret}@example.test/team/${sourceId}.git`, membershipId],
    );
    await engine!.executeRaw('INSERT INTO sources (id,name,local_path) VALUES ($1,$2,$3)', [
      sourceId, `Export handbook ${suffix}`, `/srv/2brain/clones/${cloneSecret}`,
    ]);
    await engine!.executeRaw('INSERT INTO config (key,value) VALUES ($1,$2)', [`llm_provider_key_${suffix}`, providerSecret]);
    await engine!.executeRaw(
      "INSERT INTO workspace_setup_tokens (token_hash,purpose,expires_at) VALUES ($1,'setup',now() + interval '1 day')",
      [bootstrapSecret],
    );
    await engine!.executeRaw(
      "INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter) VALUES ($1,'welcome','note','Welcome','# Export me','{}'::jsonb)",
      [sourceId],
    );
    // Planted secrets in excluded classes.
    await engine!.executeRaw(
      `INSERT INTO workspace_invitations (invitation_id,workspace_id,normalized_email,role,access_mode,token_hash,invited_by_membership_id,expires_at)
       VALUES ($1,$2,$3,'member','all',$4,$5,now() + interval '1 day')`,
      [`invitation-${suffix}`, workspaceId, `invitee-${suffix}@example.test`, invitationSecret, membershipId],
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_sessions (session_hash,membership_id,csrf_hash,expires_at) VALUES ($1,$2,$3,now() + interval '1 day')",
      [sessionSecret, membershipId, `csrf-${suffix}`],
    );

    const requested = await requestWorkspaceExport(engine!, {
      workspaceId, actorMembershipId: membershipId, requestId: `req-export-${suffix}`, idempotencyKey: `export-${suffix}`,
    });
    const worked = await runWorkspaceExportWorkerOnce(engine!, { workerId: `export-worker-${suffix}` });
    expect(worked).toMatchObject({ exportId: requested.exportId, state: 'completed', progress: 100 });
    expect(worked?.recordCounts).toMatchObject({ pages: 1, sources: 1 });

    const artifact = await retrieveWorkspaceExportArtifact(engine!, {
      workspaceId, exportId: requested.exportId, actorMembershipId: membershipId, requestId: `req-retrieve-${suffix}`,
    });
    for (const secret of [remoteSecret, invitationSecret, sessionSecret, bootstrapSecret, providerSecret, cloneSecret]) {
      expect(artifact.content).not.toContain(secret);
    }
    const parsed = JSON.parse(artifact.content) as { entries: { path: string; content: string }[] };
    const sources = JSON.parse(parsed.entries.find(entry => entry.path === 'sources.json')!.content) as { remote_url: string }[];
    expect(sources[0]!.remote_url).toBe(`https://example.test/team/${sourceId}.git`);
    expect(artifact.manifest?.integrity.algorithm).toBe('sha256');
    expect(artifact.manifest).toMatchObject({
      openclaw_state_included: false,
      openclaw_backup: false,
    });

    const retrieveAudit = await engine!.executeRaw(
      "SELECT event_id FROM workspace_audit_events WHERE action='export.retrieve' AND target_id=$1",
      [requested.exportId],
    );
    expect(retrieveAudit).toHaveLength(1);
  }, 60_000);

  test('keeps deterministic retention, concurrent claims, and restart recovery in Postgres parity', async () => {
    const suffix = randomBytes(4).toString('hex');
    const workspaceId = await isolatedWorkspace('Retention parity');
    const identityId = `retention-identity-${suffix}`;
    const membershipId = `retention-member-${suffix}`;
    const sourceId = `retention-source-${suffix}`;
    const agentId = `retention-agent-${suffix}`;
    const cutoff = '2026-07-14T12:00:00.000Z';
    await engine!.executeRaw(
      'INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ($1,$2,now())',
      [identityId, `retention-${suffix}@example.test`],
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,'administrator')",
      [membershipId, workspaceId, identityId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_sources
         (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id)
       VALUES ($1,$2,'Retention source','https://example.test/retention.git','daily','completed',$3)`,
      [sourceId, workspaceId, membershipId],
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member',$1,'all')",
      [membershipId],
    );
    await engine!.executeRaw(
      "INSERT INTO sources (id,name,config) VALUES ($1,'Retention source','{}'::jsonb)",
      [sourceId],
    );
    await engine!.executeRaw(
      `INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter)
       VALUES ($1,'retained','note','Retained Page','# retained','{}'::jsonb)`,
      [sourceId],
    );
    await engine!.executeRaw(
      `INSERT INTO page_versions (page_id,compiled_truth,frontmatter,snapshot_at)
       SELECT id,'# retained version','{}'::jsonb,'2020-01-01T00:00:00.000Z'
         FROM pages WHERE source_id=$1 AND slug='retained'`,
      [sourceId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_condition_episodes
         (episode_id,workspace_id,category,condition_type,resource_type,resource_id,detected_at)
       VALUES ($1,$2,'source_health','stale_source','source',$3,'2020-01-01T00:00:00.000Z')`,
      [`retention-episode-${suffix}`, workspaceId, sourceId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_attention_items
         (item_id,workspace_id,episode_id,category,condition_type,resource_type,resource_id,summary,detected_at)
       VALUES ($1,$2,$3,'source_health','stale_source','source',$4,'Retained Attention','2020-01-01T00:00:00.000Z')`,
      [`retention-attention-${suffix}`, workspaceId, `retention-episode-${suffix}`, sourceId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_attention_item_history
         (history_id,item_id,event,actor_kind,actor_id,occurred_at)
       VALUES ($1,$2,'detected','system','fixture','2020-01-01T00:00:00.000Z')`,
      [`retention-attention-history-${suffix}`, `retention-attention-${suffix}`],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_audit_events
         (event_id,actor_kind,actor_id,action,target_type,target_id,outcome,before_state,after_state,request_id,occurred_at)
       VALUES ($1,'system','fixture','retention.request','fixture','retained','succeeded','{}'::jsonb,'{}'::jsonb,$1,
               '2020-01-01T00:00:00.000Z')`,
      [`retention-audit-${suffix}`],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_agents
         (agent_id,workspace_id,name,purpose,owner_membership_id,created_by_membership_id)
       VALUES ($1,$2,'Retention agent','Parity coverage',$3,$3)`,
      [agentId, workspaceId, membershipId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_agent_runs (run_id,agent_id,started_at,ended_at,outcome)
       VALUES ($1,$3,'2026-04-15T11:00:00.000Z','2026-04-15T12:00:00.000Z','succeeded'),
              ($2,$3,'2026-04-15T11:00:00.000Z','2026-04-15T12:00:00.001Z','succeeded'),
              ($4,$3,'2026-04-15T12:00:00.000Z',NULL,NULL)`,
      [
        `retention-run-old-${suffix}`, `retention-run-new-${suffix}`, agentId,
        `retention-run-active-${suffix}`,
      ],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_agent_activity (activity_id,agent_id,run_id,operation,outcome,occurred_at)
       VALUES ($1,$3,$4,'search','succeeded','2026-04-15T12:00:00.000Z'),
              ($2,$3,$5,'search','succeeded','2026-04-15T12:00:00.001Z')`,
      [
        `retention-activity-old-${suffix}`, `retention-activity-new-${suffix}`, agentId,
        `retention-run-old-${suffix}`, `retention-run-new-${suffix}`,
      ],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_agent_request_details
         (activity_id,redacted_detail,full_parameters,full_parameters_expire_at)
       VALUES ($1,'{"safe":true}'::jsonb,'{"secret":"boundary"}'::jsonb,'2026-07-14T12:00:00.000Z')`,
      [`retention-activity-new-${suffix}`],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_change_events
         (event_id,workspace_id,actor_kind,actor_id,resource_type,resource_id,summary,request_id,occurred_at)
       VALUES ($1,$3,'system','fixture','source',$4,'old',$1,'2026-04-15T12:00:00.000Z'),
              ($2,$3,'system','fixture','source',$4,'new',$2,'2026-04-15T12:00:00.001Z')`,
      [`retention-change-old-${suffix}`, `retention-change-new-${suffix}`, workspaceId, sourceId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_ask_results
         (ask_result_id,workspace_id,requester_membership_id,question,expires_at)
       VALUES ($1,$3,$4,'Boundary?','2026-07-14T12:00:00.000Z'),
              ($2,$3,$4,'Newer?','2026-07-14T12:00:00.001Z')`,
      [`retention-ask-old-${suffix}`, `retention-ask-new-${suffix}`, workspaceId, membershipId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_notifications
         (notification_id,workspace_id,recipient_membership_id,event_key,event_type,target_type,target_id,summary,expires_at)
       VALUES ($1,$3,$4,$1,'membership_access_changed','membership',$4,'Boundary','2026-07-14T12:00:00.000Z'),
              ($2,$3,$4,$2,'membership_access_changed','membership',$4,'Newer','2026-07-14T12:00:00.001Z')`,
      [`retention-notification-old-${suffix}`, `retention-notification-new-${suffix}`, workspaceId, membershipId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_background_operations
         (operation_id,workspace_id,operation_type,initiator_membership_id,resource_type,resource_id,state,progress,
          outcome_summary,error_summary,initiator_reason,idempotency_key,idempotency_fingerprint,request_id,completed_at)
       VALUES ($1,$3,'source.verify',$4,'source',$5,'completed',100,'sensitive outcome','sensitive error',
               'sensitive reason',$1,$1,$1,'2026-06-14T12:00:00.000Z'),
              ($2,$3,'source.verify',$4,'source',$5,'completed',100,'newer outcome',NULL,NULL,
               $2,$2,$2,'2026-06-14T12:00:00.001Z')`,
      [`retention-operation-old-${suffix}`, `retention-operation-new-${suffix}`, workspaceId, membershipId, sourceId],
    );
    await engine!.executeRaw(
      `INSERT INTO workspace_exports
         (export_id,workspace_id,requested_by_membership_id,state,progress,idempotency_key,idempotency_fingerprint,
          request_id,artifact_content,manifest,record_counts,expires_at,completed_at)
       VALUES ($1,$3,$4,'completed',100,$1,$1,$1,'sensitive archive','{}'::jsonb,'{"pages":1}'::jsonb,
               '2026-07-14T12:00:00.000Z','2026-06-14T12:00:00.000Z'),
              ($2,$3,$4,'completed',100,$2,$2,$2,'newer archive','{}'::jsonb,'{"pages":2}'::jsonb,
               '2026-07-14T12:00:00.001Z','2026-06-14T12:00:00.001Z')`,
      [`retention-export-old-${suffix}`, `retention-export-new-${suffix}`, workspaceId, membershipId],
    );

    const queued = await enqueueWorkspaceRetention(engine!, {
      workspaceId, requestId: `retention-parity-${suffix}`, idempotencyKey: `retention-parity-${suffix}`,
    });
    const claims = await Promise.all([
      runWorkspaceRetentionWorkerOnce(engine!, { workerId: `retention-a-${suffix}`, now: cutoff, batchSize: 2 }),
      runWorkspaceRetentionWorkerOnce(engine!, { workerId: `retention-b-${suffix}`, now: cutoff, batchSize: 2 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({
      retentionId: queued.retentionId,
      state: 'completed',
      purgedCounts: {
        agentActivity: 1,
        agentRuns: 1,
        fullRequestParameters: 1,
        changeEvents: 1,
        askResults: 1,
        backgroundOperationDetails: 1,
        workspaceExportDetails: 1,
        notifications: 1,
      },
    });
    expect(await engine!.executeRaw<{ activity_id: string }>(
      'SELECT activity_id FROM workspace_agent_activity WHERE agent_id=$1', [agentId],
    )).toEqual([{ activity_id: `retention-activity-new-${suffix}` }]);
    expect(await engine!.executeRaw<{ full_parameters: unknown }>(
      'SELECT full_parameters FROM workspace_agent_request_details WHERE activity_id=$1',
      [`retention-activity-new-${suffix}`],
    )).toEqual([{ full_parameters: null }]);
    expect(await engine!.executeRaw<{ event_id: string }>(
      'SELECT event_id FROM workspace_change_events WHERE workspace_id=$1', [workspaceId],
    )).toEqual([{ event_id: `retention-change-new-${suffix}` }]);
    expect(await engine!.executeRaw<{ ask_result_id: string }>(
      'SELECT ask_result_id FROM workspace_ask_results WHERE workspace_id=$1', [workspaceId],
    )).toEqual([{ ask_result_id: `retention-ask-new-${suffix}` }]);
    expect(await engine!.executeRaw<{ run_id: string }>(
      'SELECT run_id FROM workspace_agent_runs WHERE agent_id=$1 ORDER BY run_id', [agentId],
    )).toEqual([
      { run_id: `retention-run-active-${suffix}` },
      { run_id: `retention-run-new-${suffix}` },
    ]);
    expect(await engine!.executeRaw<{ notification_id: string }>(
      'SELECT notification_id FROM workspace_notifications WHERE workspace_id=$1', [workspaceId],
    )).toEqual([{ notification_id: `retention-notification-new-${suffix}` }]);
    expect(await engine!.executeRaw<{
      outcome_summary: string | null; error_summary: string | null; initiator_reason: string | null;
    }>(
      'SELECT outcome_summary,error_summary,initiator_reason FROM workspace_background_operations WHERE operation_id=$1',
      [`retention-operation-old-${suffix}`],
    )).toEqual([{ outcome_summary: null, error_summary: null, initiator_reason: null }]);
    expect(await engine!.executeRaw<{ outcome_summary: string | null }>(
      'SELECT outcome_summary FROM workspace_background_operations WHERE operation_id=$1',
      [`retention-operation-new-${suffix}`],
    )).toEqual([{ outcome_summary: 'newer outcome' }]);
    expect(await engine!.executeRaw<{ artifact_content: string | null; manifest: unknown; record_counts: unknown }>(
      'SELECT artifact_content,manifest,record_counts FROM workspace_exports WHERE export_id=$1',
      [`retention-export-old-${suffix}`],
    )).toEqual([{ artifact_content: null, manifest: null, record_counts: { pages: 1 } }]);
    expect(await engine!.executeRaw<{ artifact_content: string | null; manifest: unknown; record_counts: unknown }>(
      'SELECT artifact_content,manifest,record_counts FROM workspace_exports WHERE export_id=$1',
      [`retention-export-new-${suffix}`],
    )).toEqual([{ artifact_content: 'newer archive', manifest: {}, record_counts: { pages: 2 } }]);
    expect(await engine!.executeRaw('SELECT source_id FROM workspace_sources WHERE source_id=$1', [sourceId])).toHaveLength(1);
    expect(await engine!.executeRaw(
      "SELECT principal_id FROM workspace_principal_source_policies WHERE principal_kind='member' AND principal_id=$1",
      [membershipId],
    )).toHaveLength(1);
    expect(await engine!.executeRaw('SELECT item_id FROM workspace_attention_items WHERE item_id=$1', [
      `retention-attention-${suffix}`,
    ])).toHaveLength(1);
    expect(await engine!.executeRaw('SELECT history_id FROM workspace_attention_item_history WHERE history_id=$1', [
      `retention-attention-history-${suffix}`,
    ])).toHaveLength(1);
    expect(await engine!.executeRaw('SELECT event_id FROM workspace_audit_events WHERE event_id=$1', [
      `retention-audit-${suffix}`,
    ])).toHaveLength(1);
    expect(await engine!.executeRaw(
      `SELECT version.id FROM page_versions version
       JOIN pages page ON page.id=version.page_id
       WHERE page.source_id=$1 AND page.slug='retained'`,
      [sourceId],
    )).toHaveLength(1);

    const restart = await enqueueWorkspaceRetention(engine!, {
      workspaceId, requestId: `retention-restart-${suffix}`, idempotencyKey: `retention-restart-${suffix}`,
    });
    await engine!.executeRaw(
      `UPDATE workspace_retention_jobs
          SET state='running', attempt=1, lease_owner='dead-worker',
              lease_expires_at=now() - interval '1 hour', cutoff_at=$2::timestamptz
        WHERE retention_id=$1`,
      [restart.retentionId, cutoff],
    );
    expect(await runWorkspaceRetentionWorkerOnce(engine!, {
      workerId: `retention-replacement-${suffix}`, now: '2030-01-01T00:00:00.000Z',
    })).toMatchObject({
      retentionId: restart.retentionId,
      state: 'completed',
      attempt: 2,
      cutoffAt: cutoff,
    });

    const plantedFailure = `PLANTED-RETENTION-FAILURE-${suffix}`;
    await engine!.executeRaw(
      `INSERT INTO workspace_change_events
         (event_id,workspace_id,actor_kind,actor_id,resource_type,resource_id,summary,request_id,occurred_at)
       VALUES ($1,$2,'system','fixture','source',$3,$4,$1,'2020-01-01T00:00:00.000Z')`,
      [`retention-change-failure-${suffix}`, workspaceId, sourceId, plantedFailure],
    );
    await engine!.executeRaw(`CREATE OR REPLACE FUNCTION workspace_test_reject_retention_delete()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION '${plantedFailure}'; END;
      $$`);
    await engine!.executeRaw(`CREATE TRIGGER workspace_test_reject_retention_delete
      BEFORE DELETE ON workspace_change_events
      FOR EACH ROW EXECUTE FUNCTION workspace_test_reject_retention_delete()`);
    const retryable = await enqueueWorkspaceRetention(engine!, {
      workspaceId, requestId: `retention-retry-${suffix}`, idempotencyKey: `retention-retry-${suffix}`,
    });
    const failed = await runWorkspaceRetentionWorkerOnce(engine!, {
      workerId: `retention-failure-worker-${suffix}`, now: cutoff,
    });
    expect(failed).toMatchObject({
      retentionId: retryable.retentionId,
      state: 'failed',
      retryable: true,
      error: {
        code: 'retention_failed',
        message: 'Workspace retention failed. Retry when the Workspace is reachable.',
      },
    });
    const failureAudit = await engine!.executeRaw<{ after_state: unknown }>(
      "SELECT after_state FROM workspace_audit_events WHERE action='retention.fail' AND target_id=$1",
      [retryable.retentionId],
    );
    expect(failureAudit).toHaveLength(1);
    expect(JSON.stringify({ failed, failureAudit })).not.toContain(plantedFailure);

    await engine!.executeRaw('DROP TRIGGER workspace_test_reject_retention_delete ON workspace_change_events');
    await engine!.executeRaw('DROP FUNCTION workspace_test_reject_retention_delete()');
    expect(await retryWorkspaceRetention(engine!, {
      workspaceId, retentionId: retryable.retentionId, requestId: `retention-retry-2-${suffix}`,
    })).toMatchObject({ state: 'queued', cutoffAt: cutoff });
    expect(await runWorkspaceRetentionWorkerOnce(engine!, {
      workerId: `retention-retry-worker-${suffix}`, now: '2030-01-01T00:00:00.000Z',
    })).toMatchObject({ retentionId: retryable.retentionId, state: 'completed', attempt: 2, cutoffAt: cutoff });

    await runWorkspaceRuntime(engine!, 'scheduler', { once: true, now: cutoff });
    await runWorkspaceRuntime(engine!, 'scheduler', { once: true, now: '2026-07-14T23:59:59.999Z' });
    expect(await engine!.executeRaw<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM workspace_retention_jobs WHERE idempotency_key='daily:2026-07-14'",
    )).toEqual([{ idempotency_key: 'daily:2026-07-14' }]);
  }, 60_000);

  // #47: member-bound OAuth tokens (session-gated consent) with Postgres
  // parity — code mint, DELETE ... RETURNING membership_id on exchange, the
  // verify-time membership JOIN + role clamp, live grant-following through
  // dispatch, and the Connected Apps list/revoke round-trip.
  test('member-bound OAuth consent tokens follow current grants and revoke on Postgres', async () => {
    const workspaceId = await isolatedWorkspace('Consent parity');
    const suffix = randomBytes(4).toString('hex');
    const membershipId = `consent-member-${suffix}`;
    await engine!.executeRaw(
      'INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ($1,$2,now())',
      [`consent-identity-${suffix}`, 'consent-admin@example.test'],
    );
    await engine!.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ($1,$2,$3,'administrator')",
      [membershipId, workspaceId, `consent-identity-${suffix}`],
    );
    const session = `consent-session-${suffix}`;
    await engine!.executeRaw(
      `INSERT INTO workspace_sessions (session_hash,membership_id,csrf_hash,expires_at)
       VALUES ($1,$2,$3,now() + interval '1 day')`,
      [hashWorkspaceSecret(session), membershipId, hashWorkspaceSecret(`consent-csrf-${suffix}`)],
    );
    await setPrincipalSourceAccess(engine!, { kind: 'member', id: membershipId }, {
      mode: 'specific', sourceIds: ['consent-source'],
    });
    await engine!.executeRaw("INSERT INTO sources (id,name) VALUES ('consent-source','Consent Source')");
    await engine!.executeRaw(
      "INSERT INTO pages (source_id,slug,type,title,compiled_truth) VALUES ('consent-source','consent-handbook','document','Consent handbook','Trusted text')",
    );

    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine!) });
    const redirectUri = 'https://client.example.test/callback';
    const registered = await provider.clientsStore.registerClient!({
      client_name: 'Parity Connector',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    } as Parameters<NonNullable<typeof provider.clientsStore.registerClient>>[0]);
    expect(registered.scope).toBe('admin');
    const clientId = registered.client_id;
    const client = (await provider.clientsStore.getClient(clientId))!;
    const verifier = `parity-verifier-${suffix}-0123456789-0123456789`;
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    const app = express();
    app.use(createWorkspaceRouter(engine!, { allowedOrigin: 'https://workspace.example.test' }));
    app.use(createOauthConsentRouter(engine!, provider, { allowedOrigin: 'https://workspace.example.test' }));
    const listener = await new Promise<Server>(resolve => {
      const value = app.listen(0, '127.0.0.1', () => resolve(value));
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Consent parity test did not expose an address.');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      // Unauthenticated authorize refuses before any mint.
      const anonymous = await fetch(
        `${base}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`,
        { redirect: 'manual' },
      );
      expect(anonymous.status).toBe(303);
      expect(anonymous.headers.get('location')).toBe('/login');

      const consent = await fetch(
        `${base}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256`,
        { redirect: 'manual', headers: { cookie: `workspace_session=${session}` } },
      );
      expect(consent.status).toBe(200);
      const consentHtml = await consent.text();
      expect(consentHtml).toMatch(/value="read"[^>]*selected/);
      expect(consentHtml).toMatch(/value="write"(?![^>]*disabled)/);
      expect(consentHtml).toMatch(/value="admin"(?![^>]*disabled)/);

      const approve = async (accessLevel?: 'admin') => {
        const decision = await fetch(`${base}/authorize/decision`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: `workspace_session=${session}`,
          },
          body: new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            scope: 'admin',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            decision: 'approve',
            ...(accessLevel ? { access_level: accessLevel } : {}),
          }).toString(),
        });
        expect(decision.status).toBe(302);
        const code = new URL(decision.headers.get('location')!).searchParams.get('code')!;
        expect(code).toBeTruthy();
        return provider.exchangeAuthorizationCode(client, code, verifier, redirectUri);
      };

      const readTokens = await approve();
      expect(readTokens.scope).toBe('read');
      const tokens = await approve('admin');
      expect(tokens.scope).toBe('admin');
      expect((await provider.verifyAccessToken(readTokens.access_token)).scopes).toEqual(['read']);
      const rotatedRead = await provider.exchangeRefreshToken(client, readTokens.refresh_token!);
      expect(rotatedRead.scope).toBe('read');
      const verified = await provider.verifyAccessToken(tokens.access_token) as { membershipId?: string; scopes: string[] };
      expect(verified.membershipId).toBe(membershipId);
      expect(verified.scopes).toEqual(['admin']);

      const getPage = () => dispatchToolCall(engine!, 'get_page', { slug: 'consent-handbook' }, {
        authorization: authorizationFromAuthInfo(verified as Parameters<typeof authorizationFromAuthInfo>[0]),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      const allowed = await getPage();
      expect(allowed.isError).toBeFalsy();
      expect(allowed.content[0]!.text).toContain('Consent handbook');

      // Grant removal is effective on the next request with the same token.
      await setPrincipalSourceAccess(engine!, { kind: 'member', id: membershipId }, { mode: 'none' });
      const refused = await getPage();
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain('permission_denied');

      // Connected Apps list + revoke round-trip ends verification.
      const cookieHeader = { cookie: `workspace_session=${session}` };
      const listed = await (await fetch(`${base}/api/workspace/v1/connected-apps`, { headers: cookieHeader })).json() as {
        data: {
          client_id: string;
          client_name: string;
          connected_at: string;
          configured_access_level: string;
          effective_access_level: string;
        }[];
      };
      expect(listed.data).toHaveLength(1);
      expect(listed.data[0]!.client_name).toBe('Parity Connector');
      expect(listed.data[0]).toMatchObject({
        configured_access_level: 'admin',
        effective_access_level: 'admin',
      });

      const changed = await fetch(`${base}/api/workspace/v1/connected-apps/${clientId}`, {
        method: 'PATCH',
        headers: {
          ...cookieHeader,
          'content-type': 'application/json',
          'x-csrf-token': `consent-csrf-${suffix}`,
          origin: 'https://workspace.example.test',
        },
        body: JSON.stringify({ access_level: 'read' }),
      });
      expect(changed.status).toBe(200);
      expect((await changed.json() as { data: { configured_access_level: string } }).data.configured_access_level).toBe('read');
      const clamped = await provider.verifyAccessToken(tokens.access_token) as { scopes: string[] };
      expect(clamped.scopes).toEqual(['read']);

      const revoke = await fetch(`${base}/api/workspace/v1/connected-apps/${clientId}`, {
        method: 'DELETE',
        headers: {
          ...cookieHeader,
          'x-csrf-token': `consent-csrf-${suffix}`,
          origin: 'https://workspace.example.test',
        },
      });
      expect(revoke.status).toBe(200);
      await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  }, 60_000);
});

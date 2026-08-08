import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  WORKSPACE_FOUNDATION_SCHEMA_VERSION,
  initializeWorkspaceFoundation,
  readWorkspaceFoundationState,
  recordWorkspaceRuntimeHeartbeat,
  workspaceDeploymentTopology,
} from '../src/workspace/foundation.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(engine);
  await engine.executeRaw('DROP TABLE IF EXISTS sources');
  await engine.executeRaw('DROP TABLE IF EXISTS links');
});

describe('2Brain clean-start foundation', () => {
  test('initializes idempotently without creating legacy product projections', async () => {
    const first = await initializeWorkspaceFoundation(engine);
    const second = await initializeWorkspaceFoundation(engine);

    expect(first).toEqual({
      schemaVersion: WORKSPACE_FOUNDATION_SCHEMA_VERSION,
      lifecycleState: 'uninitialized',
    });
    expect(second).toEqual(first);

    await engine.executeRaw('UPDATE workspace_deployments SET schema_version = 0');
    await expect(initializeWorkspaceFoundation(engine)).resolves.toEqual(first);

    const tables = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name`,
    );
    expect(tables.map(table => table.table_name)).toEqual([
      'workspace_agent_activity',
      'workspace_agent_credentials',
      'workspace_agent_request_details',
      'workspace_agent_runs',
      'workspace_agent_runtime_bindings',
      'workspace_agent_runtime_operations',
      'workspace_agent_warning_confirmations',
      'workspace_agents',
      'workspace_ask_results',
      'workspace_attention_item_history',
      'workspace_attention_items',
      'workspace_audit_events',
      'workspace_background_operations',
      'workspace_change_events',
      'workspace_condition_episodes',
      'workspace_deployments',
      'workspace_email_outbox',
      'workspace_exports',
      'workspace_idempotency_keys',
      'workspace_identities',
      'workspace_invitation_source_grants',
      'workspace_invitations',
      'workspace_memberships',
      'workspace_notifications',
      'workspace_page_provenance_inspections',
      'workspace_principal_source_policies',
      'workspace_retention_jobs',
      'workspace_runtime_heartbeats',
      'workspace_saved_views',
      'workspace_sessions',
      'workspace_setup_tokens',
      'workspace_source_grants',
      'workspace_source_operation_locks',
      'workspace_source_verification_events',
      'workspace_sources',
      'workspace_workspaces',
    ]);
  });

  test('records worker and scheduler liveness independently', async () => {
    await initializeWorkspaceFoundation(engine);
    await recordWorkspaceRuntimeHeartbeat(engine, 'worker');
    await recordWorkspaceRuntimeHeartbeat(engine, 'scheduler');

    const roles = await engine.executeRaw<{ role: string }>(
      'SELECT role FROM workspace_runtime_heartbeats ORDER BY role',
    );
    expect(roles.map(row => row.role)).toEqual(['scheduler', 'worker']);
  });

  test('keeps PGLite for local parity and reserves shared production for Postgres', async () => {
    await initializeWorkspaceFoundation(engine);
    expect(workspaceDeploymentTopology('pglite')).toEqual({
      sharedProduction: false,
      independentRoles: [],
    });
    expect(workspaceDeploymentTopology('postgres')).toEqual({
      sharedProduction: true,
      independentRoles: ['worker', 'scheduler'],
    });
    await expect(readWorkspaceFoundationState(engine)).resolves.toEqual({
      schemaVersion: WORKSPACE_FOUNDATION_SCHEMA_VERSION,
      lifecycleState: 'uninitialized',
    });
  });

  test('carries durable Agent customer-access state at schema version 17', async () => {
    const state = await initializeWorkspaceFoundation(engine);
    expect(state.schemaVersion).toBe(17);
    expect(WORKSPACE_FOUNDATION_SCHEMA_VERSION).toBe(17);

    const tables = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    const tableNames = tables.map(table => table.table_name);
    for (const table of [
      'workspace_agent_runtime_bindings',
      'workspace_agent_warning_confirmations',
      'workspace_agent_runtime_operations',
    ]) {
      expect(tableNames).toContain(table);
    }

    // A deployment holds exactly one Workspace (ADR-0035), so this test uses the
    // single real Workspace rather than fabricating a second one.
    await engine.executeRaw(
      "INSERT INTO workspace_workspaces (workspace_id,name) VALUES ('workspace-1','Agent tier')",
    );

    // The plan's canonical refusal: neither an unknown Operation type nor a
    // short fingerprint may reach the durable queue.
    await expect(engine.executeRaw(
      `INSERT INTO workspace_agent_runtime_operations
         (operation_id,workspace_id,operation_type,state,generation,idempotency_key,
          idempotency_fingerprint,request_id)
       VALUES ('bad','workspace-1','shell.run','queued',1,'bad','bad-fingerprint','req')`,
    )).rejects.toThrow();

    const fingerprint = 'a'.repeat(64);
    const queued = (operationId: string, key: string, generation: number) =>
      engine.executeRaw(
        `INSERT INTO workspace_agent_runtime_operations
           (operation_id,workspace_id,operation_type,state,generation,idempotency_key,
            idempotency_fingerprint,request_id)
         VALUES ($1,'workspace-1','mcp.configure','queued',$2,$3,$4,'req')`,
        [operationId, generation, key, fingerprint],
      );

    // A short fingerprint alone is still refused once the type is valid.
    await expect(engine.executeRaw(
      `INSERT INTO workspace_agent_runtime_operations
         (operation_id,workspace_id,operation_type,state,generation,idempotency_key,
          idempotency_fingerprint,request_id)
       VALUES ('short','workspace-1','mcp.configure','queued',1,'short','abc','req')`,
    )).rejects.toThrow();

    await queued('op-1', 'key-1', 1);
    // One Operation per idempotency key, and one per desired generation.
    await expect(queued('op-2', 'key-1', 2)).rejects.toThrow();
    await expect(queued('op-3', 'key-3', 1)).rejects.toThrow();

    // A lease belongs to a running Operation and to nothing else.
    await expect(engine.executeRaw(
      `UPDATE workspace_agent_runtime_operations SET lease_owner='worker'
        WHERE operation_id='op-1'`,
    )).rejects.toThrow();
    await expect(engine.executeRaw(
      `UPDATE workspace_agent_runtime_operations SET state='running'
        WHERE operation_id='op-1'`,
    )).rejects.toThrow();
    await engine.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET state='running', lease_owner='worker', lease_token='token',
              lease_expires_at=now()
        WHERE operation_id='op-1'`,
    );
  });

  test('rejects every existing public table instead of attaching clean-start tables to it', async () => {
    await engine.executeRaw('CREATE TABLE sources (id TEXT PRIMARY KEY)');
    await engine.executeRaw('CREATE TABLE links (id INTEGER PRIMARY KEY)');

    await expect(initializeWorkspaceFoundation(engine)).rejects.toThrow(
      'Existing public tables found: links, sources',
    );
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import {
  WorkspaceHttpError,
  sendWorkspaceError,
  workspaceRequestContext,
} from '../src/web/safe-errors.ts';
import {
  runProtectedWorkspaceMutation,
  type WorkspaceProtectedMutation,
} from '../src/workspace/events.ts';
import { initializeWorkspaceFoundation, WORKSPACE_FOUNDATION_SCHEMA_VERSION } from '../src/workspace/foundation.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';
import {
  confirmBoundAgentGrant,
  confirmAgentWarning,
  getAgentAccessStatus,
  hasConfirmedAgentWarning,
  initializeBoundWorkspaceAgent,
  requestNativePasswordRotation,
  setBoundAgentGrant,
} from '../src/workspace/agent-access.ts';
import {
  checkAgentRequiredProvider,
  importAgentAnthropicCredential,
  importAgentOpenRouterCredential,
  proveAgentDefaultAnswer,
} from '../src/workspace/agent-providers.ts';
import { retryAgentRuntimeOperation } from '../src/workspace/agent-runtime-queue.ts';
import type { OpenClawControl } from '../src/workspace/openclaw-control.ts';

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
  await initializeWorkspaceFoundation(engine);
});

function protectedMutation(): WorkspaceProtectedMutation {
  return {
    actor: { kind: 'member', id: 'member-1' },
    action: 'source.archive',
    target: { type: 'source', id: 'source-1' },
    requestId: 'req-test-1',
    reason: 'The source is no longer maintained.',
    before: { status: 'active', accessToken: 'do-not-store-me' },
    after: { status: 'archived', accessToken: 'do-not-store-me-either' },
  };
}

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
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

describe('2Brain Workspace boundary', () => {
  test('foreign Workspace IDs cannot read, confirm, grant, or rotate a real bound Agent', async () => {
    await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id,name) VALUES ('workspace-real','Real')");
    await engine.executeRaw("INSERT INTO workspace_identities (identity_id,normalized_email) VALUES ('identity-real','admin@example.test')");
    await engine.executeRaw("INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('member-real','workspace-real','identity-real','administrator')");
    await engine.executeRaw("INSERT INTO workspace_agents (agent_id,workspace_id,name,purpose,owner_membership_id,created_by_membership_id) VALUES ('agent-real','workspace-real','Agent','Bound','member-real','member-real')");
    await engine.executeRaw("INSERT INTO workspace_agent_runtime_bindings (workspace_id,agent_id) VALUES ('workspace-real','agent-real')");
    await engine.executeRaw("INSERT INTO workspace_agent_runtime_operations (operation_id,workspace_id,operation_type,generation,idempotency_key,idempotency_fingerprint,request_id) VALUES ('operation-real','workspace-real','mcp.configure',1,'operation-real',$1,'operation-real')", ['a'.repeat(64)]);

    const control = {
      importProviderCredential: async () => { throw new Error('control_must_not_run'); },
      listModels: async () => { throw new Error('control_must_not_run'); },
      probeModel: async () => { throw new Error('control_must_not_run'); },
      probeDefaultAnswer: async () => { throw new Error('control_must_not_run'); },
    } as unknown as OpenClawControl;

    const snapshot = async () => ({
      agents: await engine.executeRaw("SELECT * FROM workspace_agents WHERE workspace_id='workspace-real' ORDER BY agent_id"),
      bindings: await engine.executeRaw("SELECT * FROM workspace_agent_runtime_bindings WHERE workspace_id='workspace-real'"),
      operations: await engine.executeRaw("SELECT * FROM workspace_agent_runtime_operations WHERE workspace_id='workspace-real' ORDER BY operation_id"),
      confirmations: await engine.executeRaw("SELECT * FROM workspace_agent_warning_confirmations ORDER BY workspace_id,membership_id,revision"),
      auditEvents: await engine.executeRaw('SELECT * FROM workspace_audit_events ORDER BY event_id'),
      changeEvents: await engine.executeRaw('SELECT * FROM workspace_change_events ORDER BY event_id'),
    });
    const before = await snapshot();

    expect(await getAgentAccessStatus(engine, 'workspace-foreign')).toMatchObject({ initialized: false, agentId: null });
    await expect(setBoundAgentGrant(engine, {
      workspaceId: 'workspace-foreign', scope: 'admin', sourceAccess: { mode: 'all' },
      actorMembershipId: 'member-real', requestId: 'foreign-grant', reason: 'Boundary proof.',
    })).rejects.toThrow('agent_binding_not_found');
    await expect(confirmBoundAgentGrant(engine, {
      workspaceId: 'workspace-foreign', actorMembershipId: 'member-real',
      requestId: 'foreign-confirm', reason: 'Boundary proof.',
    })).rejects.toThrow('agent_binding_not_found');
    await expect(requestNativePasswordRotation(engine, {
      workspaceId: 'workspace-foreign', actorMembershipId: 'member-real', requestId: 'foreign-rotate',
      idempotencyKey: 'foreign-rotate', reason: 'Boundary proof.',
    })).rejects.toThrow('agent_binding_not_found');
    await expect(initializeBoundWorkspaceAgent(engine, {
      workspaceId: 'workspace-foreign', ownerMembershipId: 'member-real',
      actorMembershipId: 'member-real', requestId: 'foreign-initialize',
    })).rejects.toThrow();
    await expect(confirmAgentWarning(engine, {
      workspaceId: 'workspace-foreign', membershipId: 'member-real', revision: 'openclaw-shared-state-v1',
    })).rejects.toThrow('membership_not_found');
    expect(await hasConfirmedAgentWarning(
      engine, 'workspace-foreign', 'member-real', 'openclaw-shared-state-v1',
    )).toBe(false);
    await expect(importAgentAnthropicCredential(engine, control, {
      workspaceId: 'workspace-foreign', setupToken: 'secret', actorMembershipId: 'member-real', requestId: 'foreign-claude',
    })).rejects.toThrow('agent_binding_not_found');
    await expect(importAgentOpenRouterCredential(engine, control, {
      workspaceId: 'workspace-foreign', apiKey: 'secret', actorMembershipId: 'member-real', requestId: 'foreign-openrouter',
    })).rejects.toThrow('agent_binding_not_found');
    await expect(checkAgentRequiredProvider(engine, control, {
      workspaceId: 'workspace-foreign', provider: 'codex',
    })).rejects.toThrow('agent_binding_not_found');
    await expect(proveAgentDefaultAnswer(engine, control, {
      workspaceId: 'workspace-foreign',
    })).rejects.toThrow('agent_binding_not_found');
    await expect(retryAgentRuntimeOperation(engine, {
      workspaceId: 'workspace-foreign', operationId: 'operation-real', actorMembershipId: 'member-real',
      requestId: 'foreign-retry', reason: 'Boundary proof.',
    })).rejects.toThrow('agent_binding_not_found');

    const after = await snapshot();
    expect(after.agents).toEqual(before.agents);
    expect(after.bindings).toEqual(before.bindings);
    expect(after.operations).toEqual(before.operations);
    expect(after.confirmations).toEqual(before.confirmations);
    expect(after.changeEvents).toEqual(before.changeEvents);
    expect(after.auditEvents.slice(0, before.auditEvents.length)).toEqual(before.auditEvents);
    expect(after.auditEvents.slice(before.auditEvents.length)).toEqual([
      expect.objectContaining({
        action: 'agent.access.initialize', outcome: 'failed', request_id: 'foreign-initialize',
      }),
    ]);
  });
  test('records immutable, redacted Audit Events and Change Events for protected mutations', async () => {
    const event = protectedMutation();
    event.before = {
      status: 'active',
      accessToken: 'do-not-store-me',
      detail: 'postgresql://operator:db-password@private-host.example/workspace',
    };
    await runProtectedWorkspaceMutation(engine, event, async () => undefined);

    const auditRows = await engine.executeRaw<{
      outcome: string;
      before_state: unknown;
      after_state: unknown;
      request_id: string;
    }>('SELECT outcome, before_state, after_state, request_id FROM workspace_audit_events');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].outcome).toBe('succeeded');
    expect(auditRows[0].request_id).toBe('req-test-1');
    expect(JSON.stringify(auditRows[0].before_state)).not.toContain('do-not-store-me');
    expect(JSON.stringify(auditRows[0].before_state)).not.toContain('db-password');
    expect(JSON.stringify(auditRows[0].before_state)).not.toContain('private-host.example');
    expect(JSON.stringify(auditRows[0].before_state)).toContain('[REDACTED]');
    expect(JSON.stringify(auditRows[0].after_state)).not.toContain('do-not-store-me-either');

    await expect(
      engine.executeRaw("UPDATE workspace_audit_events SET action = 'tampered'"),
    ).rejects.toThrow('immutable');
    await expect(engine.executeRaw('DELETE FROM workspace_audit_events')).rejects.toThrow('immutable');

    const changeRows = await engine.executeRaw<{ summary: string }>('SELECT summary FROM workspace_change_events');
    expect(changeRows).toEqual([{ summary: 'Archived a Source.' }]);
  });

  test('records failed protected mutations without emitting a Change Event', async () => {
    await expect(
      runProtectedWorkspaceMutation(engine, protectedMutation(), async () => {
        throw new Error('database password and internal path must not be recorded');
      }),
    ).rejects.toThrow('database password');

    const audits = await engine.executeRaw<{ outcome: string }>('SELECT outcome FROM workspace_audit_events');
    expect(audits).toEqual([{ outcome: 'failed' }]);
    const changes = await engine.executeRaw('SELECT event_id FROM workspace_change_events');
    expect(changes).toEqual([]);
  });

  test('rejects a reason-required mutation before it runs and keeps the failed attempt', async () => {
    let mutationRan = false;
    const event = protectedMutation();
    event.action = 'attention.dismiss';
    event.reason = '   ';

    await expect(
      runProtectedWorkspaceMutation(engine, event, async () => {
        mutationRan = true;
      }),
    ).rejects.toThrow('reason is required');

    expect(mutationRan).toBe(false);
    const audits = await engine.executeRaw<{ outcome: string; reason: string | null }>(
      'SELECT outcome, reason FROM workspace_audit_events',
    );
    expect(audits).toEqual([{ outcome: 'failed', reason: null }]);
  });

  test('requires reasons for destructive actions without relying on a caller flag', async () => {
    let mutationRan = false;
    const event = protectedMutation();
    event.action = 'source.delete';
    event.reason = undefined;

    await expect(
      runProtectedWorkspaceMutation(engine, event, async () => {
        mutationRan = true;
      }),
    ).rejects.toThrow('reason is required');

    expect(mutationRan).toBe(false);
  });

  test('rolls back a successful mutation when its material Change Event cannot be recorded', async () => {
    await engine.executeRaw('CREATE TABLE workspace_test_mutations (id TEXT PRIMARY KEY)');
    await engine.executeRaw('DROP TABLE workspace_change_events');
    const event = protectedMutation();

    await expect(
      runProtectedWorkspaceMutation(engine, event, async transaction => {
        await transaction.executeRaw("INSERT INTO workspace_test_mutations (id) VALUES ('mutation-1')");
      }),
    ).rejects.toThrow('workspace_change_events');

    expect(await engine.executeRaw('SELECT id FROM workspace_test_mutations')).toEqual([]);
    expect(
      await engine.executeRaw<{ outcome: string }>('SELECT outcome FROM workspace_audit_events'),
    ).toEqual([{ outcome: 'failed' }]);
  });

  test('serves the Workspace boundary while legacy administration capability stays unreachable', async () => {
    const app = express();
    app.use(createWorkspaceRouter(engine, { requestId: () => 'req-http-1' }));

    await withServer(app, async baseUrl => {
      const status = await fetch(`${baseUrl}/api/workspace/v1/status`);
      expect(status.status).toBe(200);
      expect(status.headers.get('x-request-id')).toBe('req-http-1');
      expect(await status.json()).toEqual({
        data: { lifecycle_state: 'uninitialized', schema_version: WORKSPACE_FOUNDATION_SCHEMA_VERSION },
        request_id: 'req-http-1',
      });

      const appShell = await fetch(`${baseUrl}/app`);
      expect(appShell.status).toBe(200);
      expect(appShell.headers.get('x-request-id')).toBe('req-http-1');

      const loginWithSlash = await fetch(`${baseUrl}/login/`);
      expect(loginWithSlash.status).toBe(200);
      expect(loginWithSlash.headers.get('x-request-id')).toBe('req-http-1');

      const missing = await fetch(`${baseUrl}/api/workspace/v1/not-real`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('x-request-id')).toBe('req-http-1');
      const missingBody = await missing.json() as { error: Record<string, unknown> };
      expect(missingBody.error).toMatchObject({
          code: 'not_found',
          message: 'That Workspace resource does not exist.',
          recovery: 'Check the link and try again.',
          resource: 'workspace',
          request_id: 'req-http-1',
          retryable: false,
      });
      expect(Date.parse(String(missingBody.error.occurred_at))).not.toBeNaN();

      const legacyEntry = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
      expect(legacyEntry.status).toBe(303);
      expect(legacyEntry.headers.get('location')).toBe('/login');
      expect(legacyEntry.headers.get('set-cookie')).toBeNull();

      const legacyMutation = await fetch(`${baseUrl}/admin/api/register-client`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'must-not-run' }),
        redirect: 'manual',
      });
      expect(legacyMutation.status).toBe(404);
      expect(legacyMutation.headers.get('set-cookie')).toBeNull();
    });
  });

  test('never serializes raw diagnostics from an unexpected Workspace failure', async () => {
    const failingEngine = {
      executeRaw: async () => {
        throw new Error('password=hunter2 at C:\\private\\workspace.ts\nstack trace');
      },
      transaction: async () => {
        throw new Error('password=hunter2 at C:\\private\\workspace.ts\nstack trace');
      },
    };
    const app = express();
    app.use(createWorkspaceRouter(failingEngine, { requestId: () => 'req-safe-1' }));

    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/workspace/v1/status`);
      expect(response.status).toBe(500);
      expect(response.headers.get('x-request-id')).toBe('req-safe-1');
      const text = await response.text();
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('workspace.ts');
      expect(text).not.toContain('stack trace');
      expect(JSON.parse(text)).toMatchObject({
        error: {
          code: 'internal_error',
          message: '2Brain could not complete that request.',
          recovery: 'Retry the request. If it still fails, give an Administrator the request ID.',
          resource: 'workspace',
          request_id: 'req-safe-1',
          retryable: true,
        },
      });
    });
  });

  test('scrubs diagnostics even when a handler misclassifies them as safe text', async () => {
    const app = express();
    app.get(
      '/api/workspace/v1/leaky-error',
      workspaceRequestContext(() => 'req-scrub-1'),
      (_req, res) => {
        sendWorkspaceError(
          res,
          {
            status: 500,
            code: 'constructor',
            safeMessage: 'password=hunter2 at C:\\private\\handler.ts',
            recovery: 'SELECT secret FROM credentials',
            retryable: false,
            resource: 'C:\\private\\source-1',
          } as unknown as WorkspaceHttpError,
        );
      },
    );

    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/workspace/v1/leaky-error`);
      const text = await response.text();
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('handler.ts');
      expect(text).not.toContain('db-password');
      expect(text).not.toContain('private-host.example');
      expect(response.headers.get('x-request-id')).toBe('req-scrub-1');
      expect(JSON.parse(text).error.code).toBe('internal_error');
    });
  });
});

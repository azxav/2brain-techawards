import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  confirmBoundAgentGrant,
  deriveAgentNativePassword,
  getAgentAccessStatus,
  initializeBoundWorkspaceAgent,
  reconcileAgentRuntimeDriftOnce,
  reconcileAgentRuntimeOperation,
  requestNativePasswordRotation,
  retryAgentRuntimeOperation,
  runAgentRuntimeOperationWorkerOnce,
  setBoundAgentGrant,
} from '../src/workspace/agent-access.ts';
import {
  OpenClawControlError,
  type OpenClawControl,
  type OpenClawGBrainIdentity,
  type OpenClawProviderStatus,
} from '../src/workspace/openclaw-control.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

const SECRET = 'deployment-secret';

let engine: PGLiteEngine;
let control: FakeOpenClaw;

/**
 * A fake implementing the closed control interface. It models the only runtime
 * facts the worker may rely on: which password the Gateway currently accepts,
 * which MCP token it currently holds, and which identity it reports.
 */
class FakeOpenClaw implements OpenClawControl {
  appliedPasswords: string[] = [];
  configuredTokens: string[] = [];
  /**
   * Every password the fake Gateway currently accepts. It is a SET, not a
   * single value, so a Gateway that keeps honouring a retired credential is
   * expressible — that is the state a presence check would call a success.
   */
  accepted = new Set<string>();
  identity: OpenClawGBrainIdentity | null = null;

  failApply = false;
  failConfigure = false;
  failWhoAmI = false;
  /** Simulate a Gateway that cannot answer the current-password probe at all. */
  failVerify = false;
  /** Simulate a Gateway that cannot answer the retired-password probe at all. */
  failVerifyRejected = false;
  /** Simulate a Gateway that never comes back after the auth reload. */
  healthy = true;
  /** Simulate a Gateway that keeps honouring the retired password. */
  keepPreviousPassword = false;
  /** Simulate an apply that silently does not take effect. */
  applySilentlyIgnored = false;

  onApply?: () => Promise<void>;
  onConfigure?: () => Promise<void>;
  /** Fires inside the LAST external call of each flow, after every lease renewal. */
  onWhoAmI?: () => Promise<void>;
  onVerify?: () => Promise<void>;

  async runtimeHealth(): Promise<boolean> {
    return this.healthy;
  }

  async applyNativePassword(password: string): Promise<void> {
    if (this.failApply) throw new OpenClawControlError('openclaw_config_failed');
    this.appliedPasswords.push(password);
    if (!this.applySilentlyIgnored) {
      if (!this.keepPreviousPassword) this.accepted.clear();
      this.accepted.add(password);
    }
    await this.onApply?.();
  }

  async verifyNativePassword(password: string): Promise<boolean> {
    await this.onVerify?.();
    if (this.failVerify) throw new OpenClawControlError('openclaw_password_verification_failed');
    return this.accepted.has(password);
  }

  async verifyNativePasswordRejected(password: string): Promise<boolean> {
    if (this.failVerifyRejected) throw new OpenClawControlError('openclaw_password_verification_failed');
    return !this.accepted.has(password);
  }

  async configureGBrainMcp(input: { token: string }): Promise<void> {
    if (this.failConfigure) throw new OpenClawControlError('openclaw_config_failed');
    this.configuredTokens.push(input.token);
    await this.onConfigure?.();
  }

  async probeGBrainWhoAmI(): Promise<OpenClawGBrainIdentity> {
    await this.onWhoAmI?.();
    if (this.failWhoAmI || !this.identity) {
      throw new OpenClawControlError('openclaw_mcp_probe_failed');
    }
    return this.identity;
  }

  async importProviderCredential(): Promise<void> {
    throw new Error('unused');
  }

  async getProviderStatus(): Promise<OpenClawProviderStatus> {
    throw new Error('unused');
  }

  async listModels(): Promise<string[]> {
    throw new Error('unused');
  }

  async probeModel(): Promise<{ text: string }> {
    throw new Error('unused');
  }

  async probeDefaultAnswer(): Promise<{ text: string }> {
    throw new Error('unused');
  }
}

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
  control = new FakeOpenClaw();
});

async function initialize() {
  const bound = await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  control.identity = {
    workspaceId: 'workspace-1', agentId: bound.agentId, scopes: ['read'], sourceAccessMode: 'none',
  };
  return bound;
}

function workerInput(workerId = 'worker-1') {
  return { workerId, tokenSecret: SECRET, control };
}

/**
 * The real engine, except that the nth transaction steals the row's fencing
 * token first. That is the only way to lose a fence inside a flow that makes no
 * external call.
 */
function engineStealingFenceBeforeTransaction(nth: number): typeof engine {
  let seen = 0;
  return new Proxy(engine, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return async (fn: unknown) => {
        seen += 1;
        if (seen === nth) {
          await engine.executeRaw(
            "UPDATE workspace_agent_runtime_operations SET lease_token='stolen-by-another-worker' WHERE state='running'",
          );
        }
        return (target.transaction as (arg: unknown) => unknown)(fn);
      };
    },
  });
}

/** Run the queue to quiescence, the way the real runtime loop eventually does. */
async function drain(workerId = 'worker-1'): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    if (!await runAgentRuntimeOperationWorkerOnce(engine, workerInput(workerId))) return;
  }
  throw new Error('the Agent runtime queue never drained');
}

async function operations(type?: string) {
  return engine.executeRaw<{
    operation_id: string; operation_type: string; generation: number; state: string;
    attempt: number; safe_error_code: string | null; credential_id: string | null;
    lease_owner: string | null; lease_token: string | null; lease_expires_at: string | null;
  }>(
    `SELECT operation_id, operation_type, generation, state, attempt, safe_error_code,
            credential_id, lease_owner, lease_token, lease_expires_at
       FROM workspace_agent_runtime_operations
      WHERE ($1::text IS NULL OR operation_type=$1)
      ORDER BY operation_type, generation`,
    [type ?? null],
  );
}

async function operationOf(type: string, generation: number) {
  const rows = await operations(type);
  const row = rows.find(entry => Number(entry.generation) === generation);
  if (!row) throw new Error(`missing operation ${type}:${generation}`);
  return row;
}

async function readyAt(): Promise<string | null> {
  const rows = await engine.executeRaw<{ ready_at: string | null }>(
    'SELECT ready_at FROM workspace_agent_runtime_bindings WHERE workspace_id=$1', ['workspace-1'],
  );
  return rows[0]?.ready_at ?? null;
}

async function credentials() {
  return engine.executeRaw<{ credential_id: string; revoked_at: string | null }>(
    'SELECT credential_id, revoked_at FROM workspace_agent_credentials ORDER BY created_at, credential_id',
  );
}

/** Make every non-runtime readiness gate pass so runtime proof is the only variable. */
async function proveEverythingElse(): Promise<void> {
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_bindings
        SET access_confirmed_revision=access_revision,
            codex_verified_generation=model_generation, codex_verified_model='openai/gpt-5.6-sol',
            claude_verified_generation=model_generation, claude_verified_model='anthropic/claude-sonnet-5',
            answer_verified_generation=model_generation, answer_verified_target='openclaw/default'
      WHERE workspace_id=$1`,
    ['workspace-1'],
  );
}

// --- native password rotation ------------------------------------------------

test('a password operation applies and verifies the desired generation before unlocking native access', async () => {
  await initialize();
  const operation = await requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'req-1', idempotencyKey: 'manual-rotation-1', reason: 'Pilot rotation test',
  });
  await drain();

  // The retired generation-1 rotation is superseded rather than applied, so the
  // only password ever sent is the current desired generation.
  expect(control.appliedPasswords).toEqual([
    deriveAgentNativePassword(SECRET, 'workspace-1', operation.generation),
  ]);
  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status.nativePassword).toMatchObject({
    desiredGeneration: operation.generation, appliedGeneration: operation.generation,
  });
  expect(status.readiness.blockers).not.toContain('native_password_pending');
  expect((await operationOf('native_password.rotate', 1)).state).toBe('superseded');
  expect((await operationOf('native_password.rotate', 2)).state).toBe('succeeded');
});

test('a failed rotation leaves native access locked and retries without advancing generation', async () => {
  await initialize();
  await requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'req-1', idempotencyKey: 'manual-rotation-1', reason: 'Pilot rotation test',
  });
  control.failApply = true;
  await drain();

  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status.readiness.blockers).toContain('native_password_pending');
  expect(status.nativePassword.desiredGeneration).toBe(2);
  expect(status.nativePassword.appliedGeneration).toBe(0);
  const rows = (await operations('native_password.rotate')).filter(row => Number(row.generation) === 2);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('queued');
  expect(rows[0]!.safe_error_code).toBe('openclaw_config_failed');
  expect(rows[0]).toMatchObject({ lease_owner: null, lease_token: null, lease_expires_at: null });
});

test('a rotation whose new password does not actually authenticate fails closed', async () => {
  await initialize();
  control.applySilentlyIgnored = true;
  await drain();
  expect(control.appliedPasswords).toHaveLength(1);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(0);
  expect((await operationOf('native_password.rotate', 1)).safe_error_code)
    .toBe('agent_password_verification_failed');
});

test('a rotation whose retired password still authenticates fails closed', async () => {
  await initialize();
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(1);

  control.keepPreviousPassword = true;
  await requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'req-2', idempotencyKey: 'manual-rotation-1', reason: 'Rotate again',
  });
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(0);
  expect((await operationOf('native_password.rotate', 2)).safe_error_code)
    .toBe('agent_password_previous_not_rejected');
});

test('a Gateway that never returns healthy after the auth reload blocks the rotation without a second restart', async () => {
  await initialize();
  control.healthy = false;
  await drain();
  // Exactly one configuration patch: the reload is a side effect of that write.
  expect(control.appliedPasswords).toHaveLength(1);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(0);
  expect((await operationOf('native_password.rotate', 1)).safe_error_code).toBe('agent_runtime_unhealthy');
});

test('a changed deployment secret fails the rotation closed without touching OpenClaw', async () => {
  await initialize();
  await drain();
  expect(control.appliedPasswords).toHaveLength(1);

  await requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'req-2', idempotencyKey: 'manual-rotation-1', reason: 'Rotate again',
  });
  await runAgentRuntimeOperationWorkerOnce(engine, {
    workerId: 'worker-1', tokenSecret: 'a-different-deployment-secret', control,
  });
  expect(control.appliedPasswords).toHaveLength(1);
  const row = await operationOf('native_password.rotate', 2);
  expect(row.state).toBe('failed');
  expect(row.safe_error_code).toBe('agent_password_secret_changed');
  expect(await readyAt()).toBe(null);
});

// --- MCP configuration -------------------------------------------------------

test('an MCP operation issues one fresh credential, configures it, and proves the exact bound identity', async () => {
  await initialize();
  await drain();

  expect(control.configuredTokens).toHaveLength(1);
  const live = (await credentials()).filter(row => row.revoked_at === null);
  expect(live).toHaveLength(1);
  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status.mcpVerifiedGeneration).toBe(status.mcpGeneration);
  expect(status.readiness.blockers).not.toContain('mcp_unverified');
  const row = await operationOf('mcp.configure', 1);
  expect(row.state).toBe('succeeded');
  expect(row.credential_id).toBe(live[0]!.credential_id);
});

test('a whoami identity that differs in any dimension is refused', async () => {
  const bound = await initialize();
  const mismatches: Array<[string, OpenClawGBrainIdentity]> = [
    ['agent', { workspaceId: 'workspace-1', agentId: 'another-agent', scopes: ['read'], sourceAccessMode: 'none' }],
    ['workspace', { workspaceId: 'workspace-2', agentId: bound.agentId, scopes: ['read'], sourceAccessMode: 'none' }],
    ['scopes', { workspaceId: 'workspace-1', agentId: bound.agentId, scopes: ['read', 'write'], sourceAccessMode: 'none' }],
    ['source access', { workspaceId: 'workspace-1', agentId: bound.agentId, scopes: ['read'], sourceAccessMode: 'all' }],
  ];
  for (const [dimension, identity] of mismatches) {
    await engine.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET state='queued', attempt=0, safe_error_code=NULL, available_at=now(),
              lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
        WHERE operation_type='mcp.configure'`,
    );
    control.identity = identity;
    await drain();
    const status = await getAgentAccessStatus(engine, 'workspace-1');
    expect(status.mcpVerifiedGeneration, `a mismatched ${dimension} was accepted`).toBe(0);
    expect((await operationOf('mcp.configure', 1)).safe_error_code, `a mismatched ${dimension} was accepted`)
      .toBe('agent_mcp_identity_mismatch');
  }
});

test('a widened grant must be re-proven with the identity that matches the new grant', async () => {
  const bound = await initialize();
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(1);

  await setBoundAgentGrant(engine, {
    workspaceId: 'workspace-1', scope: 'write', sourceAccess: { mode: 'all' },
    actorMembershipId: 'admin-1', requestId: 'grant-1', reason: 'Administrator widened the grant.',
  });
  // The stale read-only identity no longer matches the recorded grant.
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(0);

  control.identity = {
    workspaceId: 'workspace-1', agentId: bound.agentId, scopes: ['read', 'write'], sourceAccessMode: 'all',
  };
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_operations
        SET state='queued', attempt=0, safe_error_code=NULL, available_at=now(),
            lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE operation_type='mcp.configure' AND generation=2`,
  );
  await drain();
  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status).toMatchObject({ mcpGeneration: 2, mcpVerifiedGeneration: 2 });
});

test('a crash between the credential commit and the HTTP call leaves an orphan the retry revokes', async () => {
  await initialize();
  control.onConfigure = async () => { throw new Error('process_crashed'); };
  await runAgentRuntimeOperationWorkerOnce(engine, workerInput());
  await runAgentRuntimeOperationWorkerOnce(engine, workerInput());

  const orphaned = await credentials();
  expect(orphaned.filter(row => row.revoked_at === null)).toHaveLength(1);
  const interrupted = await operationOf('mcp.configure', 1);
  expect(interrupted.credential_id).not.toBe(null);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(0);

  control.onConfigure = undefined;
  await engine.executeRaw(
    "UPDATE workspace_agent_runtime_operations SET available_at=now() - interval '1 hour'",
  );
  await drain();
  const after = await credentials();
  expect(after.length).toBeGreaterThan(orphaned.length);
  const live = after.filter(row => row.revoked_at === null);
  expect(live).toHaveLength(1);
  // Every credential from an interrupted attempt is retired.
  expect(orphaned.every(row => after.find(entry => entry.credential_id === row.credential_id)?.revoked_at !== null))
    .toBe(true);
  expect(control.configuredTokens[control.configuredTokens.length - 1])
    .not.toBe(control.configuredTokens[0]);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(1);
});

// --- leases, fencing, and concurrency ---------------------------------------

test('a second worker cannot claim an operation another worker still holds', async () => {
  await initialize();
  // Leave exactly one claimable Operation so the race is unambiguous.
  await engine.executeRaw(
    "DELETE FROM workspace_agent_runtime_operations WHERE operation_type='native_password.rotate'",
  );
  const raced: Array<{ requestId: string } | null> = [];
  control.onConfigure = async () => {
    raced.push(await runAgentRuntimeOperationWorkerOnce(engine, workerInput('worker-2')));
  };
  await runAgentRuntimeOperationWorkerOnce(engine, workerInput('worker-1'));
  expect(raced).toEqual([null]);
  expect(control.configuredTokens).toHaveLength(1);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(1);
});

test('an expired lease is reclaimed and the timed-out worker cannot record proof', async () => {
  await initialize();
  // Only the MCP Operation may be claimed, so the assertion cannot pass by the
  // worker having picked up unrelated work.
  await engine.executeRaw(
    "DELETE FROM workspace_agent_runtime_operations WHERE operation_type='native_password.rotate'",
  );
  control.onConfigure = async () => {
    // The original worker stalls past its lease; a replacement steals the row.
    await engine.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET lease_token='stolen-by-another-worker', attempt=attempt+1, updated_at=now()
        WHERE operation_type='mcp.configure'`,
    );
  };
  expect(await runAgentRuntimeOperationWorkerOnce(engine, workerInput())).not.toBe(null);
  expect(control.configuredTokens).toHaveLength(1);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(0);
  expect(await readyAt()).toBe(null);
});

test('a stale worker cannot record native password proof after losing its fence', async () => {
  await initialize();
  await engine.executeRaw(
    "DELETE FROM workspace_agent_runtime_operations WHERE operation_type='mcp.configure'",
  );
  control.onApply = async () => {
    // Only the fencing token moves: the attempt counter is untouched, so the
    // lease token alone must be enough to stop this worker.
    await engine.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET lease_token='stolen-by-another-worker', updated_at=now()
        WHERE operation_type='native_password.rotate'`,
    );
  };
  expect(await runAgentRuntimeOperationWorkerOnce(engine, workerInput())).not.toBe(null);
  expect(control.appliedPasswords).toHaveLength(1);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(0);
  // Losing the fence is not this worker's failure to record either.
  expect((await operationOf('native_password.rotate', 1)).safe_error_code).toBe(null);
});

test('a worker whose row was reclaimed at the same lease token cannot record proof', async () => {
  await initialize();
  await engine.executeRaw(
    "DELETE FROM workspace_agent_runtime_operations WHERE operation_type='native_password.rotate'",
  );
  control.onConfigure = async () => {
    // Only the attempt counter moves: a re-claim that happened to reuse this
    // token is still a different attempt and must not be able to finish.
    await engine.executeRaw(
      "UPDATE workspace_agent_runtime_operations SET attempt=attempt+1, updated_at=now() WHERE operation_type='mcp.configure'",
    );
  };
  expect(await runAgentRuntimeOperationWorkerOnce(engine, workerInput())).not.toBe(null);
  expect(control.configuredTokens).toHaveLength(1);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(0);
  expect(await readyAt()).toBe(null);
});

test('a desired generation that advances mid-flight is never overwritten by the older proof', async () => {
  await initialize();
  await engine.executeRaw(
    "DELETE FROM workspace_agent_runtime_operations WHERE operation_type='native_password.rotate'",
  );
  // The desired generation advances after the last lease renewal. This worker
  // still holds a valid fence and the live identity still matches the recorded
  // grant, so ONLY the generation predicate stands between it and a false proof.
  control.onWhoAmI = async () => {
    control.onWhoAmI = undefined;
    await engine.executeRaw(
      `UPDATE workspace_agent_runtime_bindings
          SET mcp_generation=mcp_generation+1, mcp_verified_generation=0, ready_at=NULL
        WHERE workspace_id=$1`,
      ['workspace-1'],
    );
  };
  expect(await runAgentRuntimeOperationWorkerOnce(engine, workerInput())).not.toBe(null);

  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status.mcpGeneration).toBe(2);
  expect(status.mcpVerifiedGeneration).toBe(0);
  expect(status.readiness.blockers).toContain('mcp_unverified');
  expect((await operationOf('mcp.configure', 1)).state).not.toBe('succeeded');
});

test('a native rotation whose generation advances mid-flight records no applied proof', async () => {
  await initialize();
  await engine.executeRaw(
    "DELETE FROM workspace_agent_runtime_operations WHERE operation_type='mcp.configure'",
  );
  control.onVerify = async () => {
    control.onVerify = undefined;
    await requestNativePasswordRotation(engine, {
      workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
      requestId: 'req-2', idempotencyKey: 'manual-rotation-1', reason: 'A concurrent rotation.',
    });
  };
  expect(await runAgentRuntimeOperationWorkerOnce(engine, workerInput())).not.toBe(null);

  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status.nativePassword).toEqual({ desiredGeneration: 2, appliedGeneration: 0 });
  expect(status.readiness.blockers).toContain('native_password_pending');
  expect((await operationOf('native_password.rotate', 1)).state).not.toBe('succeeded');
});

test('a fence lost during the final MCP probe records no proof', async () => {
  await initialize();
  await engine.executeRaw(
    "DELETE FROM workspace_agent_runtime_operations WHERE operation_type='native_password.rotate'",
  );
  // Stolen AFTER the last lease renewal, so only the completion predicate can
  // catch it. A zero-row completion must stop the worker dead.
  control.onWhoAmI = async () => {
    await engine.executeRaw(
      "UPDATE workspace_agent_runtime_operations SET lease_token='stolen-by-another-worker' WHERE operation_type='mcp.configure'",
    );
  };
  expect(await runAgentRuntimeOperationWorkerOnce(engine, workerInput())).not.toBe(null);
  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status.mcpVerifiedGeneration).toBe(0);
  expect(await readyAt()).toBe(null);
  expect((await operationOf('mcp.configure', 1)).state).not.toBe('succeeded');
});

test('a fence lost during the final password verification records no proof', async () => {
  await initialize();
  await engine.executeRaw(
    "DELETE FROM workspace_agent_runtime_operations WHERE operation_type='mcp.configure'",
  );
  control.onVerify = async () => {
    await engine.executeRaw(
      "UPDATE workspace_agent_runtime_operations SET lease_token='stolen-by-another-worker' WHERE operation_type='native_password.rotate'",
    );
  };
  expect(await runAgentRuntimeOperationWorkerOnce(engine, workerInput())).not.toBe(null);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(0);
  expect((await operationOf('native_password.rotate', 1)).state).not.toBe('succeeded');
});

test('an expired running lease is reclaimed by the next pass', async () => {
  await initialize();
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_operations
        SET state='running', lease_owner='dead-worker', lease_token='dead-token',
            lease_expires_at=now() - interval '1 minute'
      WHERE operation_type='mcp.configure'`,
  );
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(1);
});

test('a stale generation finishing after a newer generation never overwrites the newer proof', async () => {
  const bound = await initialize();
  await drain();
  await setBoundAgentGrant(engine, {
    workspaceId: 'workspace-1', scope: 'write', sourceAccess: { mode: 'all' },
    actorMembershipId: 'admin-1', requestId: 'grant-1', reason: 'Administrator widened the grant.',
  });
  control.identity = {
    workspaceId: 'workspace-1', agentId: bound.agentId, scopes: ['read', 'write'], sourceAccessMode: 'all',
  };
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(2);

  // Replay the retired generation-1 operation: it must supersede itself.
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_operations
        SET state='queued', attempt=0, available_at=now(),
            lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE operation_type='mcp.configure' AND generation=1`,
  );
  const before = control.configuredTokens.length;
  expect(await reconcileAgentRuntimeOperation(
    engine, (await operationOf('mcp.configure', 1)).operation_id, workerInput(),
  )).toBe('superseded');
  expect(control.configuredTokens).toHaveLength(before);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(2);
});

test('a supersede that loses its fence reports no success and leaves the row to its real owner', async () => {
  const bound = await initialize();
  await drain();
  await setBoundAgentGrant(engine, {
    workspaceId: 'workspace-1', scope: 'write', sourceAccess: { mode: 'all' },
    actorMembershipId: 'admin-1', requestId: 'grant-1', reason: 'Administrator widened the grant.',
  });
  control.identity = {
    workspaceId: 'workspace-1', agentId: bound.agentId, scopes: ['read', 'write'], sourceAccessMode: 'all',
  };
  await drain();

  // Replay the retired generation-1 operation, but have another worker steal the
  // fence between the claim and the supersede write.
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_operations
        SET state='queued', attempt=0, available_at=now(),
            lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE operation_type='mcp.configure' AND generation=1`,
  );
  const operationId = (await operationOf('mcp.configure', 1)).operation_id;
  expect(await reconcileAgentRuntimeOperation(
    engineStealingFenceBeforeTransaction(2), operationId, workerInput(),
  )).toBe('pending');
  // The row still belongs to whoever holds the stolen token.
  const row = await operationOf('mcp.configure', 1);
  expect(row.state).toBe('running');
  expect(row.lease_token).toBe('stolen-by-another-worker');
});

test('a current-password probe that cannot answer is drift, and the drift pass still completes', async () => {
  await initialize();
  await proveEverythingElse();
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(1);

  // The gateway is unreachable rather than wrong. An unprovable password is not
  // a proven one, and the pass must return rather than abort.
  control.failVerify = true;
  expect(await reconcileAgentRuntimeDriftOnce(engine, workerInput())).toBe('requeued');
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(0);
  expect((await operationOf('native_password.rotate', 1)).safe_error_code)
    .toBe('agent_password_verification_failed');
  expect(await readyAt()).toBe(null);
});

test('a drift pass with an unusable deployment secret surfaces the real error, not a secret-change diagnosis', async () => {
  await initialize();
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(1);

  // Deriving cannot fail for a *transient* reason. Anything it does throw is a
  // deployment or programming fault, and must not be dressed up as a rotation
  // an Administrator can repair.
  await expect(reconcileAgentRuntimeDriftOnce(engine, {
    workerId: 'worker-1', tokenSecret: '', control,
  })).rejects.toThrow('agent_password_secret_required');
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(1);
});

test('a retired-password probe that cannot answer is drift, and the drift pass still completes', async () => {
  await initialize();
  await drain();
  await requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'req-2', idempotencyKey: 'manual-rotation-1', reason: 'Rotate',
  });
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(2);

  control.failVerifyRejected = true;
  expect(await reconcileAgentRuntimeDriftOnce(engine, workerInput())).toBe('requeued');
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(0);
  expect((await operationOf('native_password.rotate', 2)).safe_error_code)
    .toBe('agent_password_verification_failed');
});

test('retries are bounded and a max-attempt failure is repairable by an Administrator', async () => {
  await initialize();
  control.failConfigure = true;
  const operationId = (await operationOf('mcp.configure', 1)).operation_id;
  for (let pass = 0; pass < 12; pass += 1) {
    await engine.executeRaw(
      "UPDATE workspace_agent_runtime_operations SET available_at=now() - interval '1 hour' WHERE operation_id=$1",
      [operationId],
    );
    await reconcileAgentRuntimeOperation(engine, operationId, workerInput());
  }
  const exhausted = await operationOf('mcp.configure', 1);
  expect(exhausted.state).toBe('failed');
  expect(Number(exhausted.attempt)).toBe(8);
  expect(exhausted).toMatchObject({ lease_owner: null, lease_token: null, lease_expires_at: null });

  control.failConfigure = false;
  const repaired = await retryAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-1', operationId, actorMembershipId: 'admin-1',
    requestId: 'repair-1', reason: 'Administrator repaired the shared runtime binding.',
  });
  expect(repaired).toEqual({ operationId, generation: 1 });
  const requeued = await operationOf('mcp.configure', 1);
  expect(requeued).toMatchObject({ state: 'queued', safe_error_code: null, lease_token: null });
  expect(Number(requeued.attempt)).toBe(0);
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(1);
});

test('Administrator repair is a no-op for work that is not failed and refuses a retired generation', async () => {
  await initialize();
  const queued = (await operationOf('mcp.configure', 1)).operation_id;
  expect(await retryAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-1', operationId: queued, actorMembershipId: 'admin-1',
    requestId: 'repair-1', reason: 'A queued operation needs no repair.',
  })).toEqual({ operationId: queued, generation: 1 });
  expect((await operationOf('mcp.configure', 1)).state).toBe('queued');

  await drain();
  expect((await operationOf('mcp.configure', 1)).state).toBe('succeeded');
  expect(await retryAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-1', operationId: queued, actorMembershipId: 'admin-1',
    requestId: 'repair-2', reason: 'A succeeded operation needs no repair.',
  })).toEqual({ operationId: queued, generation: 1 });
  expect((await operationOf('mcp.configure', 1)).state).toBe('succeeded');

  // A retired generation is never requeued, and no foreign Workspace can repair.
  await setBoundAgentGrant(engine, {
    workspaceId: 'workspace-1', scope: 'write', sourceAccess: { mode: 'all' },
    actorMembershipId: 'admin-1', requestId: 'grant-1', reason: 'Administrator widened the grant.',
  });
  await expect(retryAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-1', operationId: queued, actorMembershipId: 'admin-1',
    requestId: 'repair-3', reason: 'A retired generation must never be replayed.',
  })).rejects.toThrow('invalid_runtime_operation');
  await expect(retryAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-2', operationId: queued, actorMembershipId: 'admin-1',
    requestId: 'repair-4', reason: 'A foreign Workspace must not repair this operation.',
  })).rejects.toThrow('agent_binding_not_found');
});

// --- drift -------------------------------------------------------------------

test('drift reconciliation reports an uninitialized Workspace and a healthy proven runtime', async () => {
  expect(await reconcileAgentRuntimeDriftOnce(engine, workerInput())).toBe('uninitialized');
  await initialize();
  await drain();
  expect(await reconcileAgentRuntimeDriftOnce(engine, workerInput())).toBe('healthy');
});

test('drift clears native proof and requeues the current generation when the password stops working', async () => {
  await initialize();
  await proveEverythingElse();
  await drain();
  await confirmBoundAgentGrant(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'confirm-1', reason: 'Administrator confirmed the grant.',
  });
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).readiness.ready).toBe(true);
  expect(await readyAt()).not.toBe(null);

  // A late external side effect changed the Gateway password underneath us.
  control.accepted = new Set(['changed-out-of-band']);
  expect(await reconcileAgentRuntimeDriftOnce(engine, workerInput())).toBe('requeued');
  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status.nativePassword).toEqual({ desiredGeneration: 1, appliedGeneration: 0 });
  expect(status.readiness.ready).toBe(false);
  expect(await readyAt()).toBe(null);
  expect((await operationOf('native_password.rotate', 1)).state).toBe('queued');
  // No NEW generation is invented: the existing current-generation row repairs it.
  expect((await operations('native_password.rotate'))).toHaveLength(1);
});

test('drift clears native proof when the retired password starts working again', async () => {
  await initialize();
  await drain();
  await requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'req-2', idempotencyKey: 'manual-rotation-1', reason: 'Rotate',
  });
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(2);

  // A rollback restored the retired credential ALONGSIDE the current one. The
  // current password still authenticates, so only the retired-password probe
  // can notice; a presence check on the current password would call this clean.
  control.accepted.add(deriveAgentNativePassword(SECRET, 'workspace-1', 1));
  expect(await reconcileAgentRuntimeDriftOnce(engine, workerInput())).toBe('requeued');
  const drifted = await getAgentAccessStatus(engine, 'workspace-1');
  expect(drifted.nativePassword).toEqual({ desiredGeneration: 2, appliedGeneration: 0 });
  expect((await operationOf('native_password.rotate', 2)).state).toBe('queued');
});

test('drift refuses to treat an unprovable MCP identity as a proven one', async () => {
  await initialize();
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(1);

  // The probe cannot answer at all. That is not evidence the binding is intact.
  control.failWhoAmI = true;
  expect(await reconcileAgentRuntimeDriftOnce(engine, workerInput())).toBe('requeued');
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(0);
  expect(await readyAt()).toBe(null);
});

test('drift clears MCP proof and requeues when the live identity stops matching', async () => {
  await initialize();
  await drain();
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(1);

  control.identity = {
    workspaceId: 'workspace-1', agentId: 'a-different-agent', scopes: ['read'], sourceAccessMode: 'none',
  };
  expect(await reconcileAgentRuntimeDriftOnce(engine, workerInput())).toBe('requeued');
  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status.mcpVerifiedGeneration).toBe(0);
  expect(status.readiness.blockers).toContain('mcp_unverified');
  expect((await operationOf('mcp.configure', 1)).state).toBe('queued');
  expect(await readyAt()).toBe(null);
});

// --- redaction ---------------------------------------------------------------

test('no credential, token, or derived password ever reaches durable runtime state', async () => {
  await initialize();
  await drain();
  const token = control.configuredTokens[0]!;
  const password = deriveAgentNativePassword(SECRET, 'workspace-1', 1);

  for (const table of [
    'workspace_agent_runtime_operations', 'workspace_agent_runtime_bindings',
    'workspace_audit_events', 'workspace_change_events',
  ]) {
    const rows = await engine.executeRaw(`SELECT * FROM ${table}`);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(SECRET);
  }

  // Only closed safe codes are ever recorded.
  control.failConfigure = true;
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_operations
        SET state='queued', attempt=0, available_at=now(),
            lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
      WHERE operation_type='mcp.configure'`,
  );
  await drain();
  for (const row of await operations()) {
    if (row.safe_error_code === null) continue;
    expect(row.safe_error_code).toMatch(/^[a-z0-9_]+$/);
  }
});

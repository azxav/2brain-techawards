/**
 * The crash-recoverable queue behind the two OpenClaw side effects GBrain owns:
 * writing the bound Agent's credential into the runtime's MCP configuration, and
 * rotating the shared native password.
 *
 * Both are "do an external thing, then record that it worked". The dangerous
 * failure is recording success that never happened, or letting a slow worker
 * overwrite newer desired state. Three rules make that impossible:
 *
 * 1. **Leases with fencing tokens.** Claiming a row mints a fresh random
 *    `lease_token`. EVERY later transition carries
 *    `state='running' AND lease_token=$token AND attempt=$attempt`. A zero-row
 *    update means this worker lost its fence; it stops immediately rather than
 *    retrying, proceeding, or logging and continuing.
 * 2. **Generation comparison.** Desired state is a counter on the binding. An
 *    Operation whose generation is not the current desired generation is
 *    superseded without any external call, and every write that records proof
 *    additionally requires the desired generation to still equal it.
 * 3. **Proof, never presence.** A rotation is applied only after the new
 *    password is shown to authenticate AND the retired one is shown to be
 *    refused; an MCP binding is verified only after a live `gbrain__whoami`
 *    matches the recorded Agent, Workspace, Scope, and Source Access mode
 *    exactly. Anything else fails closed and leaves the gate locked.
 *
 * The two flows are deliberately asymmetric about credentials. `mcp.configure`
 * COMMITS the credential-issuing transaction before the HTTP call, because
 * OpenClaw immediately calls back with that token and GBrain's own MCP auth must
 * already be able to find it. The price is that a crash in between leaves an
 * orphan credential, which is why every attempt starts by revoking the
 * credential an interrupted attempt recorded.
 *
 * Nothing here ever writes a token, a derived password, the deployment secret,
 * or upstream error text into the database, an Audit Event, or a log line. Only
 * a closed `safe_error_code` is durable.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { AgentAccessError } from './agent-access-error.ts';
import {
  type BindingRow,
  loadBinding,
  readinessFromBinding,
  recomputeBindingReadiness,
  requireBinding,
} from './agent-binding.ts';
import { deriveAgentNativePassword, pinAgentPasswordSecretFingerprint } from './agent-native-password.ts';
import { replaceWorkspaceAgentCredentialInTransaction, type WorkspaceAgentScope } from './agents.ts';
import { runProtectedWorkspaceMutation } from './events.ts';
import { OpenClawControlError, type OpenClawControl } from './openclaw-control.ts';

/**
 * The engine shape every protected Agent-access mutation needs: raw reads plus
 * the transaction seam `runProtectedWorkspaceMutation` requires.
 */
export type AgentAccessEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;

export type AgentRuntimeOperationType = 'mcp.configure' | 'native_password.rotate';

/** Long enough to outlast the adapter's own 15s ceiling several times over. */
const LEASE_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 300;
/** Bounded wait for the `gateway.reload.mode=hybrid` restart the auth patch causes. */
const HEALTH_POLL_ATTEMPTS = 5;
const HEALTH_POLL_DELAY_MS = 200;

/**
 * The closed set of durable failure codes. Adapter codes pass through unchanged
 * because they are already free of upstream text; everything else collapses to
 * one of the codes below or to the generic code. No message is ever stored.
 */
type SafeErrorCode =
  | 'agent_password_secret_changed'
  | 'agent_password_verification_failed'
  | 'agent_password_previous_not_rejected'
  | 'agent_runtime_unhealthy'
  | 'agent_mcp_identity_mismatch'
  | 'agent_runtime_operation_failed'
  | string;

/** A deliberate, diagnosable refusal. `fatal` skips the retry budget entirely. */
class OperationFailure extends Error {
  constructor(readonly code: SafeErrorCode, readonly fatal = false) {
    super(code);
    this.name = 'AgentRuntimeOperationFailure';
  }
}

/**
 * This worker no longer owns the row. The only correct response is to stop
 * without touching OpenClaw, the Operation, or the binding again — another
 * worker is authoritative now.
 */
class LeaseLostError extends Error {
  constructor() {
    super('agent_runtime_operation_lease_lost');
    this.name = 'AgentRuntimeOperationLeaseLost';
  }
}

interface ClaimedOperation {
  operationId: string;
  workspaceId: string;
  type: AgentRuntimeOperationType;
  generation: number;
  attempt: number;
  maxAttempts: number;
  leaseToken: string;
  credentialId: string | null;
  requestId: string;
}

interface OperationRow {
  operation_id: string;
  workspace_id: string;
  operation_type: AgentRuntimeOperationType;
  state: string;
  generation: number;
  credential_id: string | null;
  attempt: number;
  max_attempts: number;
  lease_token: string;
  request_id: string;
}

function claimed(row: OperationRow): ClaimedOperation {
  return {
    operationId: row.operation_id,
    workspaceId: row.workspace_id,
    type: row.operation_type,
    generation: Number(row.generation),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    leaseToken: row.lease_token,
    credentialId: row.credential_id,
    requestId: row.request_id,
  };
}

// --- enqueueing --------------------------------------------------------------

function operationFingerprint(type: string, generation: number): string {
  return createHmac('sha256', 'gbrain:agent-runtime-operation:v1')
    .update(`${type}:${generation}`, 'utf8')
    .digest('hex');
}

/**
 * Queue one crash-recoverable runtime side effect. The same key asking for the
 * same work returns the existing Operation; the same key asking for different
 * work fails closed. Concurrent callers with different request IDs converge on
 * one Operation through the `(workspace, type, generation)` uniqueness.
 *
 * `tx` is narrowed to `executeRaw` deliberately: this helper always runs inside
 * a transaction the caller already owns, so it must never open its own.
 */
export async function enqueueAgentRuntimeOperation(
  tx: Pick<BrainEngine, 'executeRaw'>,
  input: {
    workspaceId: string;
    type: AgentRuntimeOperationType;
    generation: number;
    requestId: string;
    idempotencyKey: string;
  },
): Promise<string> {
  if (input.type !== 'mcp.configure' && input.type !== 'native_password.rotate') {
    throw new AgentAccessError('invalid_runtime_operation');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new AgentAccessError('invalid_runtime_operation');
  }
  const fingerprint = operationFingerprint(input.type, input.generation);
  const existing = await tx.executeRaw<{ operation_id: string; idempotency_key: string; idempotency_fingerprint: string }>(
    `SELECT operation_id, idempotency_key, idempotency_fingerprint
       FROM workspace_agent_runtime_operations
      WHERE workspace_id=$1
        AND (idempotency_key=$2 OR (operation_type=$3 AND generation=$4))`,
    [input.workspaceId, input.idempotencyKey, input.type, input.generation],
  );
  const byKey = existing.find(row => row.idempotency_key === input.idempotencyKey);
  if (byKey) {
    if (byKey.idempotency_fingerprint !== fingerprint) throw new AgentAccessError('idempotency_conflict');
    return byKey.operation_id;
  }
  if (existing[0]) return existing[0].operation_id;

  const operationId = randomUUID();
  const inserted = await tx.executeRaw<{ operation_id: string }>(
    `INSERT INTO workspace_agent_runtime_operations
       (operation_id, workspace_id, operation_type, generation, idempotency_key, idempotency_fingerprint, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING operation_id`,
    [operationId, input.workspaceId, input.type, input.generation, input.idempotencyKey, fingerprint, input.requestId],
  );
  if (inserted[0]) return inserted[0].operation_id;

  const winner = await tx.executeRaw<{ operation_id: string; idempotency_fingerprint: string }>(
    `SELECT operation_id, idempotency_fingerprint FROM workspace_agent_runtime_operations
      WHERE workspace_id=$1 AND (idempotency_key=$2 OR (operation_type=$3 AND generation=$4))`,
    [input.workspaceId, input.idempotencyKey, input.type, input.generation],
  );
  if (!winner[0]) throw new AgentAccessError('idempotency_conflict');
  if (winner[0].idempotency_fingerprint !== fingerprint) throw new AgentAccessError('idempotency_conflict');
  return winner[0].operation_id;
}

// --- claiming and fencing ----------------------------------------------------

/**
 * The claim predicate. `FOR UPDATE ... SKIP LOCKED` follows the existing
 * `workspace_background_operations` claim loop in `source-provisioning.ts`; both
 * engines run real PostgreSQL SQL, so no engine-specific variant exists.
 */
const CLAIMABLE = `(
  (o.state='queued' AND o.available_at <= now())
  OR (o.state='running' AND o.lease_expires_at < now())
) AND o.attempt < o.max_attempts`;

async function claimOperation(
  engine: AgentAccessEngine,
  workerId: string,
  operationId: string | null,
): Promise<ClaimedOperation | null> {
  const leaseToken = randomBytes(24).toString('base64url');
  return engine.transaction(async tx => {
    const rows = await tx.executeRaw<OperationRow>(
      `WITH candidate AS (
         SELECT o.operation_id
           FROM workspace_agent_runtime_operations o
          WHERE ${CLAIMABLE} AND ($3::text IS NULL OR o.operation_id=$3)
          ORDER BY o.available_at, o.created_at, o.operation_id
          FOR UPDATE OF o SKIP LOCKED
          LIMIT 1
       )
       UPDATE workspace_agent_runtime_operations operation
          SET state='running', attempt=operation.attempt+1,
              lease_owner=$1, lease_token=$2,
              lease_expires_at=now() + (${LEASE_SECONDS} * interval '1 second'),
              started_at=COALESCE(operation.started_at, now()), updated_at=now()
         FROM candidate
        WHERE operation.operation_id=candidate.operation_id
       RETURNING operation.*`,
      [workerId, leaseToken, operationId],
    );
    return rows[0] ? claimed(rows[0]) : null;
  });
}

/**
 * Retire a row whose lease expired after its final attempt. Without this the
 * claim predicate would ignore it forever and readiness would never report a
 * terminal failure an Administrator can repair.
 */
async function failExhaustedOperation(engine: AgentAccessEngine): Promise<{ requestId: string } | null> {
  return engine.transaction(async tx => {
    const rows = await tx.executeRaw<OperationRow>(
      `WITH exhausted AS (
         SELECT operation_id FROM workspace_agent_runtime_operations
          WHERE state='running' AND lease_expires_at < now() AND attempt >= max_attempts
          ORDER BY lease_expires_at, operation_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE workspace_agent_runtime_operations operation
          SET state='failed',
              safe_error_code=COALESCE(operation.safe_error_code, 'agent_runtime_operation_failed'),
              lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
              completed_at=now(), updated_at=now()
         FROM exhausted
        WHERE operation.operation_id=exhausted.operation_id
       RETURNING operation.*`,
    );
    if (!rows[0]) return null;
    await recordBindingError(tx, rows[0].workspace_id, 'agent_runtime_operation_failed');
    return { requestId: rows[0].request_id };
  });
}

/** The single fencing predicate. Every transition out of a claim uses it. */
const FENCE = "operation_id=$1 AND state='running' AND lease_token=$2 AND attempt=$3";

function fenceParams(operation: ClaimedOperation): [string, string, number] {
  return [operation.operationId, operation.leaseToken, operation.attempt];
}

/**
 * Re-assert the fence and push the expiry out. Called immediately before every
 * external call, so each call starts with far more fencing time than the
 * adapter's own 15-second ceiling can consume.
 */
async function renewLease(
  tx: Pick<BrainEngine, 'executeRaw'>,
  operation: ClaimedOperation,
): Promise<void> {
  const rows = await tx.executeRaw(
    `UPDATE workspace_agent_runtime_operations
        SET lease_expires_at=now() + (${LEASE_SECONDS} * interval '1 second'), updated_at=now()
      WHERE ${FENCE}
      RETURNING operation_id`,
    fenceParams(operation),
  );
  if (!rows[0]) throw new LeaseLostError();
}

/**
 * Re-read the desired generation under the fence. A worker that returns from a
 * slow external call into a newer desired generation must not record proof.
 */
async function requireCurrentGeneration(
  tx: Pick<BrainEngine, 'executeRaw'>,
  operation: ClaimedOperation,
): Promise<BindingRow> {
  const binding = await requireBinding(tx, operation.workspaceId);
  if (desiredGeneration(binding, operation.type) !== operation.generation) throw new LeaseLostError();
  return binding;
}

function desiredGeneration(binding: BindingRow, type: AgentRuntimeOperationType): number {
  return type === 'mcp.configure'
    ? Number(binding.mcp_generation)
    : Number(binding.native_password_generation);
}

/**
 * Recompute `ready_at` from whatever the binding now says. Never a shortcut.
 *
 * The rule lives in `agent-binding.ts` so this worker and the Administrator
 * provider proofs cannot drift into two different definitions of ready.
 */
const recomputeReadiness = recomputeBindingReadiness;

async function recordBindingError(
  tx: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  code: SafeErrorCode,
): Promise<void> {
  await tx.executeRaw(
    'UPDATE workspace_agent_runtime_bindings SET last_error_code=$2, ready_at=NULL, updated_at=now() WHERE workspace_id=$1',
    [workspaceId, code],
  );
}

function classifyFailure(error: unknown): { code: SafeErrorCode; fatal: boolean } {
  if (error instanceof OperationFailure) return { code: error.code, fatal: error.fatal };
  // Adapter codes are already redacted by construction.
  if (error instanceof OpenClawControlError) return { code: error.code, fatal: false };
  if (error instanceof AgentAccessError && error.code === 'agent_password_secret_changed') {
    // Retrying cannot help: every derived password would differ from the pinned
    // deployment secret until an operator resolves the mismatch.
    return { code: 'agent_password_secret_changed', fatal: true };
  }
  return { code: 'agent_runtime_operation_failed', fatal: false };
}

/**
 * Requeue with exponential backoff, or retire the row once the attempt budget is
 * spent. Both paths clear all three lease columns in the same statement, which
 * the table's lease-consistency CHECK requires.
 */
async function failOperation(
  engine: AgentAccessEngine,
  operation: ClaimedOperation,
  code: SafeErrorCode,
  fatal: boolean,
): Promise<'failed' | 'pending'> {
  const terminal = fatal || operation.attempt >= operation.maxAttempts;
  const backoff = Math.min(MAX_BACKOFF_SECONDS, 2 ** operation.attempt);
  return engine.transaction(async tx => {
    const rows = await tx.executeRaw(
      terminal
        ? `UPDATE workspace_agent_runtime_operations
              SET state='failed', safe_error_code=$4, completed_at=now(), updated_at=now(),
                  lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
            WHERE ${FENCE} RETURNING operation_id`
        : `UPDATE workspace_agent_runtime_operations
              SET state='queued', safe_error_code=$4, updated_at=now(),
                  available_at=now() + (${backoff} * interval '1 second'),
                  lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
            WHERE ${FENCE} RETURNING operation_id`,
      [...fenceParams(operation), code],
    );
    // A zero-row update means another worker owns this row. Recording the
    // failure anyway would let a stale worker lock a binding it no longer drives.
    if (!rows[0]) throw new LeaseLostError();
    await recordBindingError(tx, operation.workspaceId, code);
    return terminal ? 'failed' : 'pending';
  }).catch(error => {
    if (error instanceof LeaseLostError) return 'pending';
    throw error;
  });
}

async function supersedeOperation(
  engine: AgentAccessEngine,
  operation: ClaimedOperation,
): Promise<void> {
  await engine.transaction(async tx => {
    // Deliberately touches nothing else: a superseded row must not clear, set,
    // or record any verified or applied generation.
    const rows = await tx.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET state='superseded', completed_at=now(), updated_at=now(),
              lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
        WHERE ${FENCE} RETURNING operation_id`,
      fenceParams(operation),
    );
    // Retiring a row this worker no longer owns is not this worker's call to
    // make, and reporting it as retired would be a success it never earned.
    if (!rows[0]) throw new LeaseLostError();
  });
}

/**
 * The one completion write both flows share: retire the Operation under the
 * lease fence, record the proof under the desired generation, then recompute
 * readiness. Either fence failing means this worker earned nothing.
 */
async function recordProof(
  engine: AgentAccessEngine,
  operation: ClaimedOperation,
  binding: { assignment: string; column: string },
): Promise<void> {
  await engine.transaction(async tx => {
    const completed = await tx.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET state='succeeded', safe_error_code=NULL, completed_at=now(), updated_at=now(),
              lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
        WHERE ${FENCE} RETURNING operation_id`,
      fenceParams(operation),
    );
    if (!completed[0]) throw new LeaseLostError();
    const proven = await tx.executeRaw(
      `UPDATE workspace_agent_runtime_bindings
          SET ${binding.assignment}, last_error_code=NULL, updated_at=now()
        WHERE workspace_id=$1 AND ${binding.column}=$2
        RETURNING workspace_id`,
      [operation.workspaceId, operation.generation],
    );
    if (!proven[0]) throw new LeaseLostError();
    await recomputeReadiness(tx, operation.workspaceId);
  });
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// --- native password rotation ------------------------------------------------

async function runNativePasswordRotation(
  engine: AgentAccessEngine,
  operation: ClaimedOperation,
  input: { tokenSecret: string; control: OpenClawControl },
): Promise<void> {
  // Phase 1: pin or compare the immutable deployment secret before any password
  // is derived. A mismatch fails closed without ever reaching OpenClaw.
  await engine.transaction(async tx => {
    await renewLease(tx, operation);
    await requireCurrentGeneration(tx, operation);
    await pinAgentPasswordSecretFingerprint(tx, operation.workspaceId, input.tokenSecret);
  });

  const desired = deriveAgentNativePassword(input.tokenSecret, operation.workspaceId, operation.generation);
  const previous = operation.generation > 1
    ? deriveAgentNativePassword(input.tokenSecret, operation.workspaceId, operation.generation - 1)
    : null;

  // Phase 2: apply. The pinned `gateway.reload.mode=hybrid` in that same config
  // write is what restarts the Gateway; no second restart is ever requested.
  await engine.transaction(tx => renewLease(tx, operation));
  await input.control.applyNativePassword(desired);

  // Phase 3: prove the Gateway came back from the auth-generation reload.
  let healthy = false;
  for (let attempt = 0; attempt < HEALTH_POLL_ATTEMPTS && !healthy; attempt += 1) {
    if (attempt > 0) await delay(HEALTH_POLL_DELAY_MS);
    await engine.transaction(tx => renewLease(tx, operation));
    healthy = await input.control.runtimeHealth() === true;
  }
  if (!healthy) throw new OperationFailure('agent_runtime_unhealthy');

  // Phase 4: the desired password must actually authenticate. Anything other
  // than an explicit success — including an unreachable gateway — is a failure.
  await engine.transaction(tx => renewLease(tx, operation));
  if (await input.control.verifyNativePassword(desired) !== true) {
    throw new OperationFailure('agent_password_verification_failed');
  }

  // Phase 5: the retired password must actually be refused. A gateway that
  // still honours it has not rotated, whatever the apply call returned.
  if (previous !== null) {
    await engine.transaction(tx => renewLease(tx, operation));
    if (await input.control.verifyNativePasswordRejected(previous) !== true) {
      throw new OperationFailure('agent_password_previous_not_rejected');
    }
  }

  // Phase 6: record the proof under both the lease fence and the generation.
  await recordProof(engine, operation, {
    assignment: 'native_password_applied_generation=$2',
    column: 'native_password_generation',
  });
}

// --- MCP configuration -------------------------------------------------------

/**
 * The scope projection the Agent credential transport reports through
 * `whoami`. It mirrors `oauth-provider.ts` exactly; any divergence would make a
 * correct binding look like a mismatch, or worse, the reverse.
 */
function expectedAgentScopes(scope: WorkspaceAgentScope): string[] {
  if (scope === 'admin') return ['admin'];
  if (scope === 'write') return ['read', 'write'];
  return ['read'];
}

function scopesMatch(actual: string[], expected: string[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const sorted = [...actual].sort();
  const target = [...expected].sort();
  return sorted.every((scope, index) => scope === target[index]);
}

async function runMcpConfigure(
  engine: AgentAccessEngine,
  operation: ClaimedOperation,
  input: { control: OpenClawControl },
): Promise<void> {
  // Phase 1: issue the credential and COMMIT before the HTTP call, so GBrain's
  // own MCP auth can already resolve the token OpenClaw is about to present.
  const token = await engine.transaction(async tx => {
    await renewLease(tx, operation);
    const binding = await requireCurrentGeneration(tx, operation);
    // Revoke the credential an interrupted attempt recorded, then every other
    // live credential for the bound Agent, then issue exactly one replacement.
    if (operation.credentialId) {
      await tx.executeRaw(
        'UPDATE workspace_agent_credentials SET revoked_at=now() WHERE credential_id=$1 AND revoked_at IS NULL',
        [operation.credentialId],
      );
    }
    const issued = await replaceWorkspaceAgentCredentialInTransaction(
      tx, operation.workspaceId, binding.agent_id,
    );
    const recorded = await tx.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET credential_id=$4, updated_at=now()
        WHERE ${FENCE} RETURNING operation_id`,
      [...fenceParams(operation), issued.credentialId],
    );
    if (!recorded[0]) throw new LeaseLostError();
    // Only the credential ID is durable. The plaintext stays in worker memory.
    return issued.token;
  });

  // Phase 2: hand the one-time token to the runtime.
  await engine.transaction(tx => renewLease(tx, operation));
  await input.control.configureGBrainMcp({ token });

  // Phase 3: prove the runtime now calls back AS the bound Agent. A generic,
  // stale, or differently-scoped credential answers with a different identity.
  await engine.transaction(tx => renewLease(tx, operation));
  const identity = await input.control.probeGBrainWhoAmI();
  const binding = await requireBinding(engine, operation.workspaceId);
  if (
    identity.workspaceId !== operation.workspaceId
    || identity.agentId !== binding.agent_id
    || binding.scope === null
    || !scopesMatch(identity.scopes, expectedAgentScopes(binding.scope))
    || identity.sourceAccessMode !== (binding.access_mode ?? 'none')
  ) {
    throw new OperationFailure('agent_mcp_identity_mismatch');
  }

  // Phase 4: record the proof under both the lease fence and the generation.
  await recordProof(engine, operation, {
    assignment: 'mcp_verified_generation=$2, mcp_verified_at=now()',
    column: 'mcp_generation',
  });
}

// --- the reconciler ----------------------------------------------------------

async function executeClaimedOperation(
  engine: AgentAccessEngine,
  operation: ClaimedOperation,
  input: { tokenSecret: string; control: OpenClawControl },
): Promise<'succeeded' | 'pending' | 'failed' | 'superseded'> {
  try {
    const binding = await requireBinding(engine, operation.workspaceId);
    if (desiredGeneration(binding, operation.type) !== operation.generation) {
      await supersedeOperation(engine, operation);
      return 'superseded';
    }
    if (operation.type === 'native_password.rotate') {
      await runNativePasswordRotation(engine, operation, input);
    } else {
      await runMcpConfigure(engine, operation, input);
    }
    return 'succeeded';
  } catch (error) {
    // Losing the fence is never this worker's failure to record.
    if (error instanceof LeaseLostError) return 'pending';
    const { code, fatal } = classifyFailure(error);
    return failOperation(engine, operation, code, fatal);
  }
}

/**
 * Claim and drive at most one Agent runtime Operation. Returns null when there
 * is nothing due, which is how the runtime loop knows to fall through.
 */
export async function runAgentRuntimeOperationWorkerOnce(
  engine: AgentAccessEngine,
  input: {
    workerId: string;
    tokenSecret: string;
    control: OpenClawControl;
    now?: string;
  },
): Promise<{ requestId: string } | null> {
  const exhausted = await failExhaustedOperation(engine);
  if (exhausted) return exhausted;
  const operation = await claimOperation(engine, input.workerId, null);
  if (!operation) return null;
  await executeClaimedOperation(engine, operation, input);
  return { requestId: operation.requestId };
}

/** Drive one named Operation. `pending` means it was not claimable, or is unfinished. */
export async function reconcileAgentRuntimeOperation(
  engine: AgentAccessEngine,
  operationId: string,
  input: {
    workerId: string;
    tokenSecret: string;
    control: OpenClawControl;
  },
): Promise<'succeeded' | 'pending' | 'failed' | 'superseded'> {
  const operation = await claimOperation(engine, input.workerId, operationId);
  if (!operation) return 'pending';
  return executeClaimedOperation(engine, operation, input);
}

/**
 * The protected Administrator repair for an Operation that spent its retry
 * budget. It requeues only the CURRENT generation and grants no proof of its
 * own: readiness stays exactly as closed as it was until the worker re-earns it.
 */
export async function retryAgentRuntimeOperation(
  engine: AgentAccessEngine,
  input: {
    workspaceId: string;
    operationId: string;
    actorMembershipId: string;
    requestId: string;
    reason: string;
  },
): Promise<{ operationId: string; generation: number }> {
  const binding = await requireBinding(engine, input.workspaceId);
  const rows = await engine.executeRaw<{ operation_type: AgentRuntimeOperationType; generation: number; state: string }>(
    `SELECT operation_type, generation, state FROM workspace_agent_runtime_operations
      WHERE workspace_id=$1 AND operation_id=$2`,
    [input.workspaceId, input.operationId],
  );
  const row = rows[0];
  // A foreign Workspace, an unknown Operation, and a retired generation are all
  // the same refusal: none of them names repairable current-generation work.
  if (!row) throw new AgentAccessError('invalid_runtime_operation');
  const generation = Number(row.generation);
  if (desiredGeneration(binding, row.operation_type) !== generation) {
    throw new AgentAccessError('invalid_runtime_operation');
  }
  if (row.state === 'queued' || row.state === 'running' || row.state === 'succeeded') {
    return { operationId: input.operationId, generation };
  }

  await runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'operation.retry',
    target: { type: 'agent_runtime_operation', id: input.operationId },
    requestId: input.requestId,
    reason: input.reason,
    before: { state: row.state },
    after: { state: 'queued' },
  }, async tx => {
    const requeued = await tx.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET state='queued', attempt=0, safe_error_code=NULL, available_at=now(),
              completed_at=NULL, updated_at=now(),
              lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
        WHERE workspace_id=$1 AND operation_id=$2 AND generation=$3
          AND state IN ('failed','superseded')
        RETURNING operation_id`,
      [input.workspaceId, input.operationId, generation],
    );
    if (!requeued[0]) throw new AgentAccessError('invalid_runtime_operation');
  });
  return { operationId: input.operationId, generation };
}

/**
 * Re-prove what the database already claims, for the CURRENT generation only.
 * A late external side effect — an out-of-band password change, a rolled-back
 * configuration, a re-pointed MCP entry — is detected here, the false proof is
 * cleared, `ready_at` drops, and the existing current-generation Operation is
 * requeued. Because it never touches an older generation, it cannot resurrect
 * state a newer desired generation has already replaced.
 */
export async function reconcileAgentRuntimeDriftOnce(
  engine: AgentAccessEngine,
  input: {
    workerId: string;
    tokenSecret: string;
    control: OpenClawControl;
  },
): Promise<'healthy' | 'requeued' | 'uninitialized'> {
  const workspaces = await engine.executeRaw<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_agent_runtime_bindings ORDER BY workspace_id',
  );
  if (!workspaces[0]) return 'uninitialized';

  let requeued = false;
  for (const { workspace_id: workspaceId } of workspaces) {
    const binding = await loadBinding(engine, workspaceId);
    if (!binding) continue;

    const nativeGeneration = Number(binding.native_password_generation);
    if (Number(binding.native_password_applied_generation) === nativeGeneration) {
      const drift = await detectNativePasswordDrift(workspaceId, nativeGeneration, input);
      if (drift) {
        await clearProof(
          engine, workspaceId, 'native_password.rotate', nativeGeneration,
          'native_password_applied_generation=0', drift,
        );
        requeued = true;
        continue;
      }
    }

    const mcpGeneration = Number(binding.mcp_generation);
    if (Number(binding.mcp_verified_generation) === mcpGeneration) {
      if (await detectMcpDrift(binding, workspaceId, input)) {
        await clearProof(
          engine, workspaceId, 'mcp.configure', mcpGeneration,
          'mcp_verified_generation=0, mcp_verified_at=NULL', 'agent_mcp_identity_mismatch',
        );
        requeued = true;
      }
    }
  }
  return requeued ? 'requeued' : 'healthy';
}

async function detectNativePasswordDrift(
  workspaceId: string,
  generation: number,
  input: { tokenSecret: string; control: OpenClawControl },
): Promise<SafeErrorCode | null> {
  let current: string;
  let previous: string | null;
  try {
    current = deriveAgentNativePassword(input.tokenSecret, workspaceId, generation);
    previous = generation > 1
      ? deriveAgentNativePassword(input.tokenSecret, workspaceId, generation - 1)
      : null;
  } catch (error) {
    // Only the pinned-secret mismatch is a diagnosis; anything else is a bug
    // this function must not disguise as one.
    const { code } = classifyFailure(error);
    if (code === 'agent_password_secret_changed') return code;
    throw error;
  }
  // Both probes fail closed the way `detectMcpDrift` does: an unprovable
  // password is not a proven one, and one unreachable gateway must not abort
  // the whole drift pass.
  try {
    if (await input.control.verifyNativePassword(current) !== true) {
      return 'agent_password_verification_failed';
    }
  } catch {
    return 'agent_password_verification_failed';
  }
  if (previous === null) return null;
  try {
    if (await input.control.verifyNativePasswordRejected(previous) !== true) {
      return 'agent_password_previous_not_rejected';
    }
  } catch {
    return 'agent_password_verification_failed';
  }
  return null;
}

async function detectMcpDrift(
  binding: BindingRow,
  workspaceId: string,
  input: { control: OpenClawControl },
): Promise<boolean> {
  try {
    const identity = await input.control.probeGBrainWhoAmI();
    return identity.workspaceId !== workspaceId
      || identity.agentId !== binding.agent_id
      || binding.scope === null
      || !scopesMatch(identity.scopes, expectedAgentScopes(binding.scope))
      || identity.sourceAccessMode !== (binding.access_mode ?? 'none');
  } catch {
    // An unprovable identity is not a proven one.
    return true;
  }
}

/**
 * Drop one false proof and requeue the existing current-generation Operation.
 * The generation predicate on both statements is what keeps a drift repair from
 * clobbering desired state that advanced while the probe was running.
 */
async function clearProof(
  engine: AgentAccessEngine,
  workspaceId: string,
  type: AgentRuntimeOperationType,
  generation: number,
  assignment: string,
  code: SafeErrorCode,
): Promise<void> {
  await engine.transaction(async tx => {
    const column = type === 'mcp.configure' ? 'mcp_generation' : 'native_password_generation';
    await tx.executeRaw(
      `UPDATE workspace_agent_runtime_bindings
          SET ${assignment}, last_error_code=$3, ready_at=NULL, updated_at=now()
        WHERE workspace_id=$1 AND ${column}=$2`,
      [workspaceId, generation, code],
    );
    // Requeue the EXISTING row. A drift repair never invents a new generation
    // and never revives an Operation from a superseded one.
    await tx.executeRaw(
      `UPDATE workspace_agent_runtime_operations
          SET state='queued', attempt=0, safe_error_code=$4, available_at=now(),
              completed_at=NULL, updated_at=now(),
              lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL
        WHERE workspace_id=$1 AND operation_type=$2 AND generation=$3 AND state<>'running'`,
      [workspaceId, type, generation, code],
    );
  });
}

/**
 * The public seam for the one shared bound Agent per Workspace: its binding
 * lifecycle, its Workspace-visible status projection, the shared-state warning
 * acknowledgments, and the crash-recoverable runtime-operation queue.
 *
 * Four concerns that stand on their own live in sibling modules and are
 * re-exported here so this file stays the single import surface:
 * `agent-readiness.ts` (pure readiness evaluation), `agent-native-password.ts`
 * (password derivation and the deployment-secret fingerprint),
 * `agent-binding.ts` (the stored binding row), `agent-runtime-queue.ts`
 * (the leased, fenced runtime-operation queue and its reconciler), and
 * `agent-providers.ts` (Administrator provider setup and the live model proofs).
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { AgentAccessError } from './agent-access-error.ts';
import { type BindingRow, loadBinding, readinessFromBinding, requireBinding } from './agent-binding.ts';
import type { AgentReadiness } from './agent-readiness.ts';
import { type AgentAccessEngine, enqueueAgentRuntimeOperation } from './agent-runtime-queue.ts';
import {
  applyWorkspaceAgentGrantInTransaction,
  createWorkspaceAgentInTransaction,
  type WorkspaceAgentScope,
} from './agents.ts';
import { runProtectedWorkspaceMutation } from './events.ts';
import type { OpenClawProviderStatus } from './openclaw-control.ts';
import type { PrincipalSourceAccess } from './source-access.ts';

export { AgentAccessError } from './agent-access-error.ts';
export {
  type AgentReadiness,
  type AgentReadinessBlocker,
  type AgentReadinessInput,
  CLAUDE_FALLBACK_MODEL,
  CODEX_DEFAULT_MODEL,
  evaluateAgentReadiness,
} from './agent-readiness.ts';
export {
  deriveAgentNativePassword,
  pinAgentPasswordSecretFingerprint,
} from './agent-native-password.ts';
export {
  AGENT_REQUIRED_PROVIDER_MODELS,
  type AgentRequiredProvider,
  ANSWER_PROOF_PROMPT,
  ANSWER_PROOF_TARGET,
  checkAgentRequiredProvider,
  importAgentAnthropicCredential,
  importAgentOpenRouterCredential,
  proveAgentDefaultAnswer,
} from './agent-providers.ts';
export {
  type AgentAccessEngine,
  type AgentRuntimeOperationType,
  enqueueAgentRuntimeOperation,
  reconcileAgentRuntimeDriftOnce,
  reconcileAgentRuntimeOperation,
  retryAgentRuntimeOperation,
  runAgentRuntimeOperationWorkerOnce,
} from './agent-runtime-queue.ts';

/** Bump when the shared-state warning copy materially changes. */
export const AGENT_WARNING_REVISION = 'openclaw-shared-state-v1';

/**
 * Everything a Member becomes a full operator of by using the shared runtime.
 * The list is the warning: it is what makes "this may exceed your own direct
 * permissions" concrete, so it is data the API returns rather than prose baked
 * into one client.
 */
export const AGENT_SHARED_CATEGORIES = [
  'conversations',
  'memory',
  'files',
  'schedules',
  'model subscriptions and usage',
  'browser sessions',
  'credentials',
  'channels',
  'GBrain Sources and Agent authority',
] as const;

/** The closed vocabulary a customer ever sees for a provider's quota. */
export type AgentProviderLimitStatus = 'available' | 'limited' | 'exhausted' | 'unknown';

export interface AgentProviderLimitsView {
  status: AgentProviderLimitStatus;
  remainingPercent: number | null;
  resetsAt: string | null;
}

export interface AgentProviderView {
  required: boolean;
  connected: boolean;
  limits: AgentProviderLimitsView;
}

/** Below this much headroom the customer is told to expect throttling. */
const LIMITED_REMAINING_PERCENT = 20;
/** Reject a reset timestamp outside a plausible epoch-millisecond window. */
const MIN_RESET_MS = Date.UTC(2000, 0, 1);
const MAX_RESET_MS = Date.UTC(2100, 0, 1);

const UNKNOWN_LIMITS: AgentProviderLimitsView = { status: 'unknown', remainingPercent: null, resetsAt: null };

function safeResetTimestamp(resetsAt: number | null): string | null {
  if (resetsAt === null) return null;
  if (!Number.isSafeInteger(resetsAt) || resetsAt < MIN_RESET_MS || resetsAt > MAX_RESET_MS) return null;
  return new Date(resetsAt).toISOString();
}

/**
 * Map one adapter provider reading onto the customer view.
 *
 * Two collapses are deliberate and both fail CLOSED.
 *
 * `connected` is the adapter's own `authenticated`, which is true only for
 * `ok` and `expiring`. `static` — an api_key entry merely EXISTS — is not
 * authenticated, and neither are `expired`, `missing`, or `unknown`. The
 * customer view has no room for five states and must never read "a key is
 * configured" as "a key works".
 *
 * `limits` never invents availability. The gateway deletes credential-less
 * providers from the usage snapshot entirely, so "no limit found" and "plenty
 * of quota" are the identical wire observation; the adapter already reports
 * that as `state: 'unknown'` and this keeps it a distinct fourth value rather
 * than folding it into `exhausted` (0% left) or `available` (fine). A failed
 * or absent read is `unknown` for the same reason.
 */
export function projectAgentProvider(
  required: boolean,
  status: OpenClawProviderStatus | null,
): AgentProviderView {
  if (!status) return { required, connected: false, limits: UNKNOWN_LIMITS };
  const quota = status.quota;
  if (!quota || quota.state !== 'known') {
    return { required, connected: status.authenticated === true, limits: UNKNOWN_LIMITS };
  }
  const percent = quota.remainingPercent;
  // A percentage outside 0..100 is malformed upstream data, not a reading.
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { required, connected: status.authenticated === true, limits: UNKNOWN_LIMITS };
  }
  return {
    required,
    connected: status.authenticated === true,
    limits: {
      status: percent <= 0 ? 'exhausted' : percent < LIMITED_REMAINING_PERCENT ? 'limited' : 'available',
      remainingPercent: percent,
      resetsAt: safeResetTimestamp(quota.resetsAt),
    },
  };
}

const BOUND_AGENT_NAME = 'OpenClaw';
const BOUND_AGENT_PURPOSE = 'Shared OpenClaw runtime for this Workspace';

export interface AgentAccessStatus {
  initialized: boolean;
  agentId: string | null;
  scope: WorkspaceAgentScope | null;
  sourceAccess: PrincipalSourceAccess | null;
  accessRevision: number;
  accessConfirmedRevision: number;
  mcpGeneration: number;
  mcpVerifiedGeneration: number;
  modelGeneration: number;
  codexVerifiedModel: string | null;
  claudeVerifiedModel: string | null;
  nativePassword: { desiredGeneration: number; appliedGeneration: number };
  readiness: AgentReadiness;
}

export interface BoundAgentAccessStatus extends AgentAccessStatus {
  initialized: true;
  agentId: string;
  scope: WorkspaceAgentScope;
  sourceAccess: PrincipalSourceAccess;
}

async function statusFromBinding(
  engine: Pick<BrainEngine, 'executeRaw'>,
  binding: BindingRow,
): Promise<AgentAccessStatus> {
  const mode = binding.access_mode ?? 'none';
  let sourceAccess: PrincipalSourceAccess = mode === 'all' ? { mode: 'all' } : { mode: 'none' };
  if (mode === 'specific') {
    const grants = await engine.executeRaw<{ source_id: string }>(
      "SELECT source_id FROM workspace_source_grants WHERE principal_kind='agent' AND principal_id=$1 ORDER BY source_id",
      [binding.agent_id],
    );
    sourceAccess = { mode: 'specific', sourceIds: grants.map(grant => grant.source_id) };
  }
  return {
    initialized: true,
    agentId: binding.agent_id,
    scope: binding.scope,
    sourceAccess,
    accessRevision: binding.access_revision,
    accessConfirmedRevision: binding.access_confirmed_revision,
    mcpGeneration: binding.mcp_generation,
    mcpVerifiedGeneration: binding.mcp_verified_generation,
    modelGeneration: binding.model_generation,
    codexVerifiedModel: binding.codex_verified_model,
    claudeVerifiedModel: binding.claude_verified_model,
    nativePassword: {
      desiredGeneration: binding.native_password_generation,
      appliedGeneration: binding.native_password_applied_generation,
    },
    readiness: readinessFromBinding(binding),
  };
}

/**
 * The Workspace-visible view of the shared runtime. It never carries a
 * credential, a derived password, or the deployment-secret fingerprint.
 */
export async function getAgentAccessStatus(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
): Promise<AgentAccessStatus> {
  const binding = await loadBinding(engine, workspaceId);
  // An unbound Workspace gets a freshly built closed status rather than a shared
  // constant, so no caller can mutate the view another caller will receive.
  if (!binding) {
    return {
      initialized: false,
      agentId: null,
      scope: null,
      sourceAccess: null,
      accessRevision: 0,
      accessConfirmedRevision: 0,
      mcpGeneration: 0,
      mcpVerifiedGeneration: 0,
      modelGeneration: 0,
      codexVerifiedModel: null,
      claudeVerifiedModel: null,
      nativePassword: { desiredGeneration: 0, appliedGeneration: 0 },
      readiness: { ready: false, blockers: ['agent_missing'] },
    };
  }
  return statusFromBinding(engine, binding);
}

function assertBound(status: AgentAccessStatus): BoundAgentAccessStatus {
  if (!status.initialized || !status.agentId || !status.scope || !status.sourceAccess) {
    throw new AgentAccessError('agent_binding_not_found');
  }
  return status as BoundAgentAccessStatus;
}

/**
 * Create the one durable bound Agent for this Workspace at Read scope with No
 * Source Access and queue its generation-1 runtime work. Repeating it — or
 * losing a uniqueness race — reloads the winning binding instead of creating a
 * second shared Agent.
 */
export async function initializeBoundWorkspaceAgent(
  engine: AgentAccessEngine,
  input: {
    workspaceId: string;
    ownerMembershipId: string;
    actorMembershipId: string;
    requestId: string;
  },
): Promise<BoundAgentAccessStatus> {
  const existing = await loadBinding(engine, input.workspaceId);
  if (existing) return assertBound(await statusFromBinding(engine, existing));

  const agentId = randomUUID();
  try {
    await runProtectedWorkspaceMutation(engine, {
      actor: { kind: 'member', id: input.actorMembershipId },
      action: 'agent.access.initialize',
      target: { type: 'agent', id: agentId },
      requestId: input.requestId,
      before: null,
      after: { name: BOUND_AGENT_NAME, scope: 'read', sourceAccess: 'none', owner: input.ownerMembershipId },
    }, async tx => {
      await createWorkspaceAgentInTransaction(tx, {
        workspaceId: input.workspaceId,
        name: BOUND_AGENT_NAME,
        purpose: BOUND_AGENT_PURPOSE,
        ownerMembershipId: input.ownerMembershipId,
        scope: 'read',
        sourceAccess: { mode: 'none' },
        actorMembershipId: input.actorMembershipId,
        agentId,
      });
      await tx.executeRaw(
        'INSERT INTO workspace_agent_runtime_bindings (workspace_id, agent_id) VALUES ($1,$2)',
        [input.workspaceId, agentId],
      );
      // The MCP worker issues the bound Agent's one credential only when it can
      // immediately configure the runtime, so none is created here.
      await enqueueAgentRuntimeOperation(tx, {
        workspaceId: input.workspaceId, type: 'mcp.configure', generation: 1,
        requestId: input.requestId, idempotencyKey: 'initialize:mcp.configure:1',
      });
      await enqueueAgentRuntimeOperation(tx, {
        workspaceId: input.workspaceId, type: 'native_password.rotate', generation: 1,
        requestId: input.requestId, idempotencyKey: 'initialize:native_password.rotate:1',
      });
    });
  } catch (error) {
    const winner = await loadBinding(engine, input.workspaceId);
    if (!winner) throw error;
    return assertBound(await statusFromBinding(engine, winner));
  }
  return assertBound(await getAgentAccessStatus(engine, input.workspaceId));
}

/**
 * The one supported way to change the bound Agent's authorization. The generic
 * Agent API refuses this Agent outright, so Scope, Source Access, the access
 * revision, the desired MCP generation, readiness, and the queued
 * reconfiguration all move together in a single protected transaction. Nothing
 * here calls the guarded public mutations.
 */
export async function setBoundAgentGrant(
  engine: AgentAccessEngine,
  input: {
    workspaceId: string;
    scope: WorkspaceAgentScope;
    sourceAccess: PrincipalSourceAccess;
    actorMembershipId: string;
    requestId: string;
    reason: string;
  },
): Promise<AgentAccessStatus> {
  const binding = await requireBinding(engine, input.workspaceId);
  await runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'agent.access.grant',
    target: { type: 'agent', id: binding.agent_id },
    requestId: input.requestId,
    reason: input.reason,
    before: { scope: binding.scope, sourceAccess: binding.access_mode },
    after: { scope: input.scope, sourceAccess: input.sourceAccess.mode },
  }, async tx => {
    await applyWorkspaceAgentGrantInTransaction(
      tx, input.workspaceId, binding.agent_id, input.scope, input.sourceAccess,
    );
    // Re-lock readiness in the same statement that advances the generations, so
    // no window exists where a stale runtime configuration counts as verified.
    const advanced = await tx.executeRaw<{ access_revision: number; mcp_generation: number }>(
      `UPDATE workspace_agent_runtime_bindings
          SET access_revision=access_revision+1,
              mcp_generation=mcp_generation+1,
              mcp_verified_generation=0,
              ready_at=NULL, updated_at=now()
        WHERE workspace_id=$1
        RETURNING access_revision, mcp_generation`,
      [input.workspaceId],
    );
    if (!advanced[0]) throw new AgentAccessError('agent_binding_not_found');
    const { access_revision: revision, mcp_generation: generation } = advanced[0];
    await enqueueAgentRuntimeOperation(tx, {
      workspaceId: input.workspaceId,
      type: 'mcp.configure',
      generation,
      requestId: input.requestId,
      idempotencyKey: `grant:${revision}:mcp.configure:${generation}`,
    });
  });
  return getAgentAccessStatus(engine, input.workspaceId);
}

/** Durably record one Member's acknowledgment of one warning revision. */
export async function confirmAgentWarning(
  engine: Pick<BrainEngine, 'executeRaw'>,
  input: { workspaceId: string; membershipId: string; revision: string },
): Promise<void> {
  const membership = await engine.executeRaw(
    `WITH scoped_membership AS (
       SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND membership_id=$2
     ), inserted AS (
       INSERT INTO workspace_agent_warning_confirmations (workspace_id, membership_id, revision)
       SELECT $1,$2,$3 FROM scoped_membership
       ON CONFLICT (workspace_id, membership_id, revision) DO NOTHING
       RETURNING 1
     )
     SELECT 1 FROM scoped_membership`,
    [input.workspaceId, input.membershipId, input.revision],
  );
  if (!membership[0]) throw new Error('membership_not_found');
}

export async function hasConfirmedAgentWarning(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  membershipId: string,
  revision: string,
): Promise<boolean> {
  const rows = await engine.executeRaw(
    `SELECT 1 FROM workspace_agent_warning_confirmations
      WHERE workspace_id=$1 AND membership_id=$2 AND revision=$3`,
    [workspaceId, membershipId, revision],
  );
  return rows.length > 0;
}

/**
 * Record that an Administrator confirmed the current Agent grant. Readiness
 * stays closed until the confirmed revision matches the current one, so every
 * later widening re-locks access until it is confirmed again.
 */
export async function confirmBoundAgentGrant(
  engine: AgentAccessEngine,
  input: { workspaceId: string; actorMembershipId: string; requestId: string; reason: string },
): Promise<AgentAccessStatus> {
  const binding = await requireBinding(engine, input.workspaceId);
  await runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'agent.access.confirm',
    target: { type: 'agent', id: binding.agent_id },
    requestId: input.requestId,
    reason: input.reason,
    after: { accessConfirmed: true },
  }, async tx => {
    const updated = await tx.executeRaw(
      `UPDATE workspace_agent_runtime_bindings
          SET access_confirmed_revision=access_revision, updated_at=now()
        WHERE workspace_id=$1 RETURNING workspace_id`,
      [input.workspaceId],
    );
    if (!updated[0]) throw new AgentAccessError('agent_binding_not_found');
  });
  return getAgentAccessStatus(engine, input.workspaceId);
}

/**
 * Advance the desired native-password generation and queue its rotation inside
 * the caller's transaction. Readiness is cleared in the same statement, so no
 * window exists where a stale password still counts as applied.
 */
export async function advanceNativePasswordGenerationInTransaction(
  tx: Pick<BrainEngine, 'executeRaw'>,
  input: {
    workspaceId: string;
    requestId: string;
    idempotencyKey: string;
  },
): Promise<{ operationId: string; generation: number }> {
  const existing = await tx.executeRaw<{ operation_id: string; generation: number; operation_type: string }>(
    `SELECT operation_id, generation, operation_type FROM workspace_agent_runtime_operations
      WHERE workspace_id=$1 AND idempotency_key=$2`,
    [input.workspaceId, input.idempotencyKey],
  );
  if (existing[0]) {
    if (existing[0].operation_type !== 'native_password.rotate') throw new AgentAccessError('idempotency_conflict');
    return { operationId: existing[0].operation_id, generation: existing[0].generation };
  }

  // Resetting the applied generation to 0 is redundant while `generationProven`
  // in agent-readiness.ts demands `verified === desired` exactly, and becomes
  // load-bearing the moment that comparator is loosened. Any change there must
  // keep this reset.
  const advanced = await tx.executeRaw<{ native_password_generation: number }>(
    `UPDATE workspace_agent_runtime_bindings
        SET native_password_generation=native_password_generation+1,
            native_password_applied_generation=0,
            ready_at=NULL, updated_at=now()
      WHERE workspace_id=$1
      RETURNING native_password_generation`,
    [input.workspaceId],
  );
  if (!advanced[0]) throw new AgentAccessError('agent_binding_not_found');
  const generation = advanced[0].native_password_generation;
  const operationId = await enqueueAgentRuntimeOperation(tx, {
    workspaceId: input.workspaceId,
    type: 'native_password.rotate',
    generation,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
  });
  return { operationId, generation };
}

/** The audited Administrator-facing rotation of the shared native password. */
export async function requestNativePasswordRotation(
  engine: AgentAccessEngine,
  input: {
    workspaceId: string;
    actorMembershipId: string;
    requestId: string;
    idempotencyKey: string;
    reason: string;
  },
): Promise<{ operationId: string; generation: number }> {
  const binding = await requireBinding(engine, input.workspaceId);
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'agent.native_password.rotate',
    target: { type: 'agent', id: binding.agent_id },
    requestId: input.requestId,
    reason: input.reason,
    after: { nativePassword: 'rotated' },
  }, async tx => advanceNativePasswordGenerationInTransaction(tx, {
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
  }));
}

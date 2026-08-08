/**
 * The stored row behind the one bound Agent per Workspace, and the statements
 * every other Agent-access module starts from. Reads are always scoped by
 * Workspace, so a foreign Workspace ID finds nothing rather than another
 * Workspace's binding.
 */
import type { BrainEngine } from '../core/engine.ts';
import { AgentAccessError } from './agent-access-error.ts';
import { type AgentReadiness, evaluateAgentReadiness } from './agent-readiness.ts';
import type { WorkspaceAgentScope, WorkspaceAgentStatus } from './agents.ts';
import type { PrincipalSourceAccess } from './source-access.ts';

export interface BindingRow {
  agent_id: string;
  access_revision: number;
  access_confirmed_revision: number;
  mcp_generation: number;
  mcp_verified_generation: number;
  model_generation: number;
  codex_verified_generation: number;
  codex_verified_model: string | null;
  claude_verified_generation: number;
  claude_verified_model: string | null;
  answer_verified_generation: number;
  answer_verified_target: string | null;
  native_password_generation: number;
  native_password_applied_generation: number;
  last_error_code: string | null;
  agent_status: WorkspaceAgentStatus | null;
  scope: WorkspaceAgentScope | null;
  access_mode: PrincipalSourceAccess['mode'] | null;
}

export async function loadBinding(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
): Promise<BindingRow | undefined> {
  const rows = await engine.executeRaw<BindingRow>(
    `SELECT b.agent_id, b.access_revision, b.access_confirmed_revision,
            b.mcp_generation, b.mcp_verified_generation, b.model_generation,
            b.codex_verified_generation, b.codex_verified_model,
            b.claude_verified_generation, b.claude_verified_model,
            b.answer_verified_generation, b.answer_verified_target,
            b.native_password_generation, b.native_password_applied_generation,
            b.last_error_code, a.status agent_status, a.scope, p.access_mode
       FROM workspace_agent_runtime_bindings b
       LEFT JOIN workspace_agents a ON a.agent_id=b.agent_id AND a.workspace_id=b.workspace_id
       LEFT JOIN workspace_principal_source_policies p
              ON p.principal_kind='agent' AND p.principal_id=b.agent_id
      WHERE b.workspace_id=$1`,
    [workspaceId],
  );
  return rows[0];
}

/**
 * The single bound Workspace of this deployment, or undefined.
 *
 * One deployment is one Workspace (ADR-0035) and therefore at most one binding,
 * but callers that have no Workspace in hand — the drift reconciler and the
 * native-ready gate, neither of which is answering for a session — still have to
 * ask. `ORDER BY workspace_id` makes the answer deterministic if a future bug
 * ever writes a second row, rather than alternating between them.
 */
export async function resolveBoundWorkspaceId(
  engine: Pick<BrainEngine, 'executeRaw'>,
): Promise<string | undefined> {
  const rows = await engine.executeRaw<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_agent_runtime_bindings ORDER BY workspace_id LIMIT 1',
  );
  return rows[0]?.workspace_id;
}

/**
 * Close agent ingress for one Workspace by clearing its proven readiness.
 *
 * Only ever clears, so it is idempotent and safe to repeat — which matters
 * because the native gate that calls it runs on every native request. Repair
 * belongs to the runtime drift reconciler, which requeues from the same state;
 * refusal is all this does.
 */
export async function clearBindingReadiness(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
): Promise<void> {
  await engine.executeRaw(
    'UPDATE workspace_agent_runtime_bindings SET ready_at=NULL, updated_at=now() WHERE workspace_id=$1',
    [workspaceId],
  );
}

/**
 * The one projection from a stored binding to readiness. Every caller that
 * decides whether the shared runtime is ready — the status view and the
 * reconciler's `ready_at` recomputation — goes through this, so neither can
 * drift into a weaker rule than the other.
 */
export function readinessFromBinding(binding: BindingRow): AgentReadiness {
  return evaluateAgentReadiness({
    // A binding whose Agent row is gone is not a bound Agent at all.
    boundAgentState: binding.agent_status ?? 'missing',
    accessRevision: binding.access_revision,
    accessConfirmedRevision: binding.access_confirmed_revision,
    mcpGeneration: binding.mcp_generation,
    mcpVerifiedGeneration: binding.mcp_verified_generation,
    modelGeneration: binding.model_generation,
    codexVerifiedGeneration: binding.codex_verified_generation,
    codexVerifiedModel: binding.codex_verified_model,
    claudeVerifiedGeneration: binding.claude_verified_generation,
    claudeVerifiedModel: binding.claude_verified_model,
    answerVerifiedGeneration: binding.answer_verified_generation,
    answerVerifiedTarget: binding.answer_verified_target,
    nativePasswordGeneration: binding.native_password_generation,
    nativePasswordAppliedGeneration: binding.native_password_applied_generation,
    lastErrorCode: binding.last_error_code,
  });
}

/**
 * Recompute `ready_at` from whatever the binding now says, never a shortcut.
 *
 * It reloads the row inside the caller's transaction rather than trusting a
 * value the caller was holding, so a proof written moments earlier in the same
 * transaction is included and a concurrently cleared one is not. Both the
 * runtime-operation worker and the Administrator provider proofs go through
 * this single statement pair, so neither can open readiness under a weaker rule
 * than the other.
 */
export async function recomputeBindingReadiness(
  tx: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
): Promise<void> {
  const binding = await loadBinding(tx, workspaceId);
  if (!binding) return;
  await tx.executeRaw(
    readinessFromBinding(binding).ready
      ? 'UPDATE workspace_agent_runtime_bindings SET ready_at=now(), updated_at=now() WHERE workspace_id=$1'
      : 'UPDATE workspace_agent_runtime_bindings SET ready_at=NULL, updated_at=now() WHERE workspace_id=$1',
    [workspaceId],
  );
}

export async function requireBinding(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
): Promise<BindingRow> {
  const binding = await loadBinding(engine, workspaceId);
  if (!binding) throw new AgentAccessError('agent_binding_not_found');
  return binding;
}

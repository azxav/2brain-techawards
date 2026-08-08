/**
 * Whether the shared bound Agent is ready to serve, decided purely from the
 * counters and pinned identities the caller already loaded. This module performs
 * no I/O so the fail-closed rule can be exercised directly.
 */

export const CODEX_DEFAULT_MODEL = 'openai/gpt-5.6-sol';
export const CLAUDE_FALLBACK_MODEL = 'anthropic/claude-sonnet-5';
const ANSWER_TARGET = 'openclaw/default';

export type AgentReadinessBlocker =
  | 'agent_missing'
  | 'agent_revoked'
  | 'grant_unconfirmed'
  | 'mcp_unverified'
  | 'codex_unverified'
  | 'claude_unverified'
  | 'answer_unverified'
  | 'native_password_pending'
  | 'runtime_error';

export interface AgentReadiness {
  ready: boolean;
  blockers: AgentReadinessBlocker[];
}

export interface AgentReadinessInput {
  boundAgentState: 'missing' | 'active' | 'revoked';
  accessRevision: number;
  accessConfirmedRevision: number;
  mcpGeneration: number;
  mcpVerifiedGeneration: number;
  modelGeneration: number;
  codexVerifiedGeneration: number;
  codexVerifiedModel: string | null;
  claudeVerifiedGeneration: number;
  claudeVerifiedModel: string | null;
  answerVerifiedGeneration: number;
  answerVerifiedTarget: string | null;
  nativePasswordGeneration: number;
  nativePasswordAppliedGeneration: number;
  lastErrorCode?: string | null;
}

/**
 * A generation is proven only when the verified counter equals the desired
 * counter exactly. A stale counter is unfinished work and a counter ahead of
 * the desired generation is malformed state; both fail closed.
 */
function generationProven(desired: number, verified: number): boolean {
  return Number.isSafeInteger(desired) && desired >= 1
    && Number.isSafeInteger(verified) && verified === desired;
}

/**
 * Readiness is a conjunction, never a presence check: every current generation
 * must be proven and every pinned identity must match exactly.
 */
export function evaluateAgentReadiness(input: AgentReadinessInput): AgentReadiness {
  if (input.boundAgentState === 'missing') return { ready: false, blockers: ['agent_missing'] };
  if (input.boundAgentState !== 'active') return { ready: false, blockers: ['agent_revoked'] };

  const blockers: AgentReadinessBlocker[] = [];
  if (!generationProven(input.accessRevision, input.accessConfirmedRevision)) blockers.push('grant_unconfirmed');
  if (!generationProven(input.mcpGeneration, input.mcpVerifiedGeneration)) blockers.push('mcp_unverified');
  if (!generationProven(input.modelGeneration, input.codexVerifiedGeneration)
    || input.codexVerifiedModel !== CODEX_DEFAULT_MODEL) blockers.push('codex_unverified');
  if (!generationProven(input.modelGeneration, input.claudeVerifiedGeneration)
    || input.claudeVerifiedModel !== CLAUDE_FALLBACK_MODEL) blockers.push('claude_unverified');
  if (!generationProven(input.modelGeneration, input.answerVerifiedGeneration)
    || input.answerVerifiedTarget !== ANSWER_TARGET) blockers.push('answer_unverified');
  if (!generationProven(input.nativePasswordGeneration, input.nativePasswordAppliedGeneration)) {
    blockers.push('native_password_pending');
  }
  if (input.lastErrorCode) blockers.push('runtime_error');
  return { ready: blockers.length === 0, blockers };
}

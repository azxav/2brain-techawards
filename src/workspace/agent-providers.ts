/**
 * Administrator provider setup and the three live readiness proofs for the one
 * shared bound Agent: Codex, Claude, and the configured default answer chain.
 *
 * The concern this module owns is "readiness may only be granted by real calls".
 * Nothing here accepts a configured profile, a `models.authStatus` of `ok`, or a
 * catalog that merely contains something similar as evidence. Each proof is a
 * live OpenClaw call plus a compare-and-set against the exact `model_generation`
 * captured before that call, so a check that finishes after the Administrator
 * replaced a credential writes nothing.
 *
 * ## Credentials
 *
 * GBrain stores no Codex credential, no Anthropic setup token, and no OpenRouter
 * key. A credential passes through one function argument, into one adapter call,
 * and is never echoed, logged, persisted, audited, exported, or attached to an
 * error. The Audit Event this module writes names the provider and nothing else.
 *
 * ## Codex is not importable
 *
 * `OpenClawImportableProvider` excludes `openai` on purpose: the Codex
 * subscription is established by the customer's own OAuth device flow inside
 * OpenClaw (the pinned `/login codex` chat command), so there is no value for
 * GBrain to import. Only the CHECK exists on this side.
 */
import type { BrainEngine } from '../core/engine.ts';
import { AgentAccessError } from './agent-access-error.ts';
import { recomputeBindingReadiness, requireBinding } from './agent-binding.ts';
import { CLAUDE_FALLBACK_MODEL, CODEX_DEFAULT_MODEL } from './agent-readiness.ts';
import {
  appendWorkspaceAuditEvent,
  appendWorkspaceChangeEvent,
  runProtectedWorkspaceMutation,
} from './events.ts';
import type { OpenClawControl } from './openclaw-control.ts';

/**
 * The one prompt any proof ever sends. It carries no Workspace content, no
 * Member identity, and no Source data, so a model provider learns nothing about
 * this deployment from a readiness check.
 */
export const ANSWER_PROOF_PROMPT = 'Reply with exactly: 2BRAIN_AGENT_READY';

/**
 * The request target recorded by the default-answer proof.
 *
 * It is the AGENT target, not a backend model: `/v1/responses` requires `model`
 * to be `openclaw`, `openclaw/default`, or `openclaw/<agentId>`, and the pinned
 * gateway echoes it straight back in `response.model`. That echo is not evidence
 * of which backend answered, which is exactly why the recorded fact is the
 * requested target and never the echoed one.
 */
export const ANSWER_PROOF_TARGET = 'openclaw/default';

/** The two providers whose exact models readiness depends on. */
export type AgentRequiredProvider = 'codex' | 'claude';

export const AGENT_REQUIRED_PROVIDER_MODELS: Readonly<Record<AgentRequiredProvider, string>> = {
  codex: CODEX_DEFAULT_MODEL,
  claude: CLAUDE_FALLBACK_MODEL,
};

type ProofEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;

/**
 * Read the generation a proof will be recorded against.
 *
 * Captured BEFORE the live call, never after: reading it afterwards would make
 * the compare-and-set below compare a value to itself and prove nothing.
 */
async function captureModelGeneration(engine: ProofEngine, workspaceId: string): Promise<number> {
  const binding = await requireBinding(engine, workspaceId);
  return Number(binding.model_generation);
}

/**
 * Record one proof, or discard it.
 *
 * `WHERE model_generation=$2` is the whole guard, and the AFFECTED ROW COUNT is
 * the whole answer. A zero-row update means the Administrator replaced a
 * credential while this check was in flight, so the result describes a
 * configuration that no longer exists and must not be written. It is reported as
 * `proof_superseded` rather than swallowed, because a check that silently
 * "succeeded" without recording anything would leave the Administrator pressing
 * a button that never moves.
 *
 * `ready_at` is recomputed in the SAME transaction from the freshly written row,
 * so readiness can only ever open together with a current-generation proof.
 */
async function recordProofAtGeneration(
  engine: ProofEngine,
  workspaceId: string,
  generation: number,
  assignment: string,
  values: unknown[],
): Promise<void> {
  await engine.transaction(async tx => {
    const proven = await tx.executeRaw(
      `UPDATE workspace_agent_runtime_bindings
          SET ${assignment}, updated_at=now()
        WHERE workspace_id=$1 AND model_generation=$2
        RETURNING workspace_id`,
      [workspaceId, generation, ...values],
    );
    if (proven.length !== 1) throw new AgentAccessError('proof_superseded');
    await recomputeBindingReadiness(tx, workspaceId);
  });
}

/**
 * Append an import's outcome AFTER the external call has settled.
 *
 * The evidence trail may only claim "Connected a shared runtime model provider."
 * once OpenClaw has actually accepted the credential. Emitting that from a
 * transaction that commits BEFORE the adapter call would leave a durable
 * succeeded Audit Event and a Change Event behind an import that never
 * happened, with nothing recording the failure. So a failed import appends a
 * `failed` Audit Event and NO Change Event: nothing about the product changed.
 *
 * The provider NAME is the entire payload. The credential is not an argument to
 * this function and therefore cannot reach an event.
 */
async function auditProviderImport(
  engine: ProofEngine,
  input: {
    workspaceId: string;
    agentId: string;
    actorMembershipId: string;
    requestId: string;
    provider: 'anthropic' | 'openrouter';
    outcome: 'succeeded' | 'failed';
  },
): Promise<void> {
  const actor = { kind: 'member', id: input.actorMembershipId } as const;
  const target = { type: 'agent', id: input.agentId };
  const event = {
    actor,
    action: 'agent.provider.import',
    target,
    requestId: input.requestId,
    after: { provider: input.provider },
  } as const;
  if (input.outcome === 'failed') {
    await appendWorkspaceAuditEvent(engine, { ...event, outcome: 'failed' });
    return;
  }
  await engine.transaction(async tx => {
    await appendWorkspaceAuditEvent(tx, { ...event, outcome: 'succeeded' });
    await appendWorkspaceChangeEvent(tx, {
      actor,
      resource: target,
      action: 'agent.provider.import',
      requestId: input.requestId,
      workspaceId: input.workspaceId,
    });
  });
}

/**
 * Invalidate every model proof and advance `model_generation`, in one protected
 * transaction that COMMITS BEFORE the external import runs.
 *
 * The ordering is the point. If the import then fails, or the process dies
 * mid-call, setup is visibly incomplete and the Administrator retries the import
 * and reruns both exact-model checks. The opposite order — import first, record
 * afterwards — would leave a window in which OpenClaw is already answering from
 * a NEW Anthropic credential while GBrain still shows proofs earned under the
 * old one, which is a readiness claim about a configuration that no longer
 * exists.
 *
 * Its Audit Event is `agent.provider.invalidate`, not `…import`: at this moment
 * the only fact that is true is that the proofs are gone. The import itself is
 * audited separately once the adapter has answered. The event carries the
 * provider name only; the credential is not an argument here and cannot reach
 * the evidence trail.
 */
async function invalidateModelProofs(
  engine: ProofEngine,
  input: { workspaceId: string; agentId: string; actorMembershipId: string; requestId: string },
): Promise<number> {
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'agent.provider.invalidate',
    target: { type: 'agent', id: input.agentId },
    requestId: input.requestId,
    after: { provider: 'anthropic', modelProofs: 'invalidated' },
  }, async tx => {
    const advanced = await tx.executeRaw<{ model_generation: number }>(
      `UPDATE workspace_agent_runtime_bindings
          SET model_generation=model_generation+1,
              codex_verified_generation=0, codex_verified_model=NULL, codex_verified_at=NULL,
              claude_verified_generation=0, claude_verified_model=NULL, claude_verified_at=NULL,
              answer_verified_generation=0, answer_verified_target=NULL, answer_verified_at=NULL,
              ready_at=NULL, updated_at=now()
        WHERE workspace_id=$1
        RETURNING model_generation`,
      [input.workspaceId],
    );
    if (advanced.length !== 1) throw new AgentAccessError('agent_binding_not_found');
    return Number(advanced[0]!.model_generation);
  });
}

/**
 * Connect the required Claude fallback subscription.
 *
 * The setup token is handed to OpenClaw once and is not returned, stored, or
 * mentioned in the failure. A failed import still leaves the invalidation above
 * committed; that is the safe direction.
 */
export async function importAgentAnthropicCredential(
  engine: ProofEngine,
  control: OpenClawControl,
  input: {
    workspaceId: string;
    setupToken: string;
    actorMembershipId: string;
    requestId: string;
  },
): Promise<void> {
  const binding = await requireBinding(engine, input.workspaceId);
  const audit = {
    workspaceId: input.workspaceId,
    agentId: binding.agent_id,
    actorMembershipId: input.actorMembershipId,
    requestId: input.requestId,
    provider: 'anthropic',
  } as const;
  await invalidateModelProofs(engine, { ...input, agentId: binding.agent_id });
  try {
    await control.importProviderCredential({ provider: 'anthropic', credential: input.setupToken });
  } catch {
    await auditProviderImport(engine, { ...audit, outcome: 'failed' });
    // Collapsed at the throw site: no upstream body, plan, account, or provider
    // message may travel with this, and neither may the token we just sent.
    throw new AgentAccessError('provider_import_failed');
  }
  await auditProviderImport(engine, { ...audit, outcome: 'succeeded' });
}

/**
 * Connect the OPTIONAL OpenRouter provider.
 *
 * It never participates in readiness, so it deliberately does not advance
 * `model_generation` and does not invalidate the Codex or Claude proofs: doing
 * so would force an Administrator to redo two exact-model checks for a provider
 * that no blocker depends on. Its live status is visible through the ordinary
 * closed status projection.
 */
export async function importAgentOpenRouterCredential(
  engine: ProofEngine,
  control: OpenClawControl,
  input: {
    workspaceId: string;
    apiKey: string;
    actorMembershipId: string;
    requestId: string;
  },
): Promise<void> {
  const binding = await requireBinding(engine, input.workspaceId);
  const audit = {
    workspaceId: input.workspaceId,
    agentId: binding.agent_id,
    actorMembershipId: input.actorMembershipId,
    requestId: input.requestId,
    provider: 'openrouter',
  } as const;
  // Nothing local changes for OpenRouter, so there is nothing to commit first
  // and no reason to audit anything before the adapter has answered.
  try {
    await control.importProviderCredential({ provider: 'openrouter', credential: input.apiKey });
  } catch {
    await auditProviderImport(engine, { ...audit, outcome: 'failed' });
    throw new AgentAccessError('provider_import_failed');
  }
  await auditProviderImport(engine, { ...audit, outcome: 'succeeded' });
}

/**
 * Prove one required subscription by two live facts: the EXACT model is in the
 * runtime's catalog, and a real Responses call with that exact override answered.
 *
 * The catalog check is separate from `probeModel`'s own membership guard so a
 * missing subscription model answers its own `required_model_unavailable`
 * instead of collapsing into a generic probe failure — the Administrator's
 * recovery differs completely between "your plan does not include this model"
 * and "the call failed". Neither ever selects a substitute model.
 */
export async function checkAgentRequiredProvider(
  engine: ProofEngine,
  control: OpenClawControl,
  input: { workspaceId: string; provider: AgentRequiredProvider },
): Promise<{ model: string }> {
  const model = AGENT_REQUIRED_PROVIDER_MODELS[input.provider];
  const generation = await captureModelGeneration(engine, input.workspaceId);

  let catalog: string[];
  try {
    catalog = await control.listModels();
  } catch {
    throw new AgentAccessError('model_check_failed');
  }
  // Exact membership. Not a prefix, not a case-folded contains: `openai/gpt-5.6`
  // and `openai/gpt-5.6-sol` are different entitlements.
  if (!catalog.includes(model)) throw new AgentAccessError('required_model_unavailable');

  let answer: { text: string };
  try {
    answer = await control.probeModel(model, ANSWER_PROOF_PROMPT);
  } catch {
    throw new AgentAccessError('model_check_failed');
  }
  if (typeof answer?.text !== 'string' || answer.text.trim().length === 0) {
    throw new AgentAccessError('model_check_failed');
  }

  const column = input.provider === 'codex' ? 'codex' : 'claude';
  await recordProofAtGeneration(
    engine, input.workspaceId, generation,
    `${column}_verified_generation=$2, ${column}_verified_model=$3, ${column}_verified_at=now(), last_error_code=NULL`,
    [model],
  );
  return { model };
}

/**
 * Prove the default answer chain: the shared Agent answers with NO backend
 * override, i.e. under whatever default and fallback order is configured.
 *
 * Only two facts are recorded — the requested target and the generation. The
 * response text is never persisted, and it is not compared against the prompt's
 * requested string either: this proves that the configured chain produced an
 * answer, not that a particular model is obedient.
 */
export async function proveAgentDefaultAnswer(
  engine: ProofEngine,
  control: OpenClawControl,
  input: { workspaceId: string },
): Promise<{ target: string }> {
  const generation = await captureModelGeneration(engine, input.workspaceId);

  let answer: { text: string };
  try {
    answer = await control.probeDefaultAnswer(ANSWER_PROOF_PROMPT);
  } catch {
    throw new AgentAccessError('answer_proof_failed');
  }
  if (typeof answer?.text !== 'string' || answer.text.trim().length === 0) {
    throw new AgentAccessError('answer_proof_failed');
  }

  await recordProofAtGeneration(
    engine, input.workspaceId, generation,
    'answer_verified_generation=$2, answer_verified_target=$3, answer_verified_at=now(), last_error_code=NULL',
    [ANSWER_PROOF_TARGET],
  );
  return { target: ANSWER_PROOF_TARGET };
}

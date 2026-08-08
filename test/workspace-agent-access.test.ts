import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  AGENT_WARNING_REVISION,
  ANSWER_PROOF_PROMPT,
  ANSWER_PROOF_TARGET,
  CLAUDE_FALLBACK_MODEL,
  CODEX_DEFAULT_MODEL,
  advanceNativePasswordGenerationInTransaction,
  checkAgentRequiredProvider,
  confirmAgentWarning,
  confirmBoundAgentGrant,
  deriveAgentNativePassword,
  enqueueAgentRuntimeOperation,
  evaluateAgentReadiness,
  getAgentAccessStatus,
  hasConfirmedAgentWarning,
  importAgentAnthropicCredential,
  importAgentOpenRouterCredential,
  initializeBoundWorkspaceAgent,
  pinAgentPasswordSecretFingerprint,
  projectAgentProvider,
  proveAgentDefaultAnswer,
  reconcileAgentRuntimeOperation,
  requestNativePasswordRotation,
  runAgentRuntimeOperationWorkerOnce,
  setBoundAgentGrant,
  type AgentReadinessInput,
} from '../src/workspace/agent-access.ts';
import { listWorkspaceAgents } from '../src/workspace/agents.ts';
import { setWorkspaceMembershipStatus } from '../src/workspace/memberships.ts';
import type {
  OpenClawControl,
  OpenClawGBrainIdentity,
  OpenClawProviderId,
  OpenClawProviderStatus,
} from '../src/workspace/openclaw-control.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

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
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-member', 'member@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-member', 'member')");
});

function readyInput(overrides: Partial<AgentReadinessInput> = {}): AgentReadinessInput {
  return {
    boundAgentState: 'active',
    accessRevision: 2,
    accessConfirmedRevision: 2,
    mcpGeneration: 3,
    mcpVerifiedGeneration: 3,
    modelGeneration: 4,
    codexVerifiedGeneration: 4,
    codexVerifiedModel: CODEX_DEFAULT_MODEL,
    claudeVerifiedGeneration: 4,
    claudeVerifiedModel: CLAUDE_FALLBACK_MODEL,
    answerVerifiedGeneration: 4,
    answerVerifiedTarget: 'openclaw/default',
    nativePasswordGeneration: 5,
    nativePasswordAppliedGeneration: 5,
    ...overrides,
  };
}

test('native passwords are deterministic per workspace and generation', () => {
  const one = deriveAgentNativePassword('deployment-secret', 'workspace-1', 1);
  expect(one).toBe(deriveAgentNativePassword('deployment-secret', 'workspace-1', 1));
  expect(one).not.toBe(deriveAgentNativePassword('deployment-secret', 'workspace-1', 2));
  expect(one).not.toBe(deriveAgentNativePassword('deployment-secret', 'workspace-2', 1));
  expect(one).not.toBe(deriveAgentNativePassword('other-secret', 'workspace-1', 1));
  expect(one).toHaveLength(43);
});

test('password derivation refuses a missing secret or a malformed generation', () => {
  expect(() => deriveAgentNativePassword('', 'workspace-1', 1)).toThrow('agent_password_secret_required');
  expect(() => deriveAgentNativePassword('s', 'workspace-1', 0)).toThrow('invalid_agent_password_generation');
  expect(() => deriveAgentNativePassword('s', 'workspace-1', 1.5)).toThrow('invalid_agent_password_generation');
  expect(() => deriveAgentNativePassword('s', 'workspace-1', Number.NaN)).toThrow('invalid_agent_password_generation');
});

test('readiness is open only when every current generation is proven', () => {
  expect(evaluateAgentReadiness(readyInput())).toEqual({ ready: true, blockers: [] });
});

test('readiness is closed until every current generation is proven', () => {
  expect(evaluateAgentReadiness({
    boundAgentState: 'active',
    accessRevision: 2,
    accessConfirmedRevision: 2,
    mcpGeneration: 3,
    mcpVerifiedGeneration: 3,
    modelGeneration: 4,
    codexVerifiedGeneration: 4,
    codexVerifiedModel: 'openai/gpt-5.6-sol',
    claudeVerifiedGeneration: 4,
    claudeVerifiedModel: 'anthropic/claude-sonnet-5',
    answerVerifiedGeneration: 4,
    answerVerifiedTarget: 'openclaw/default',
    nativePasswordGeneration: 5,
    nativePasswordAppliedGeneration: 4,
  })).toEqual({ ready: false, blockers: ['native_password_pending'] });
});

test('readiness fails closed for a missing or revoked bound Agent', () => {
  expect(evaluateAgentReadiness(readyInput({ boundAgentState: 'missing' })))
    .toEqual({ ready: false, blockers: ['agent_missing'] });
  expect(evaluateAgentReadiness(readyInput({ boundAgentState: 'revoked' })))
    .toEqual({ ready: false, blockers: ['agent_revoked'] });
});

test('a stale or future generation both fail closed rather than counting as proven', () => {
  for (const stale of [
    { accessConfirmedRevision: 1, blocker: 'grant_unconfirmed' },
    { mcpVerifiedGeneration: 2, blocker: 'mcp_unverified' },
    { codexVerifiedGeneration: 3, blocker: 'codex_unverified' },
    { claudeVerifiedGeneration: 3, blocker: 'claude_unverified' },
    { answerVerifiedGeneration: 3, blocker: 'answer_unverified' },
    { nativePasswordAppliedGeneration: 4, blocker: 'native_password_pending' },
  ] as const) {
    const { blocker, ...override } = stale;
    expect(evaluateAgentReadiness(readyInput(override))).toEqual({ ready: false, blockers: [blocker] });
  }
  // A verified generation ahead of the desired generation is malformed state.
  for (const future of [
    { accessConfirmedRevision: 3, blocker: 'grant_unconfirmed' },
    { mcpVerifiedGeneration: 9, blocker: 'mcp_unverified' },
    { codexVerifiedGeneration: 9, blocker: 'codex_unverified' },
    { claudeVerifiedGeneration: 9, blocker: 'claude_unverified' },
    { answerVerifiedGeneration: 9, blocker: 'answer_unverified' },
    { nativePasswordAppliedGeneration: 9, blocker: 'native_password_pending' },
  ] as const) {
    const { blocker, ...override } = future;
    expect(evaluateAgentReadiness(readyInput(override))).toEqual({ ready: false, blockers: [blocker] });
  }
});

test('readiness requires the exact pinned model identities and answer target', () => {
  expect(evaluateAgentReadiness(readyInput({ codexVerifiedModel: null })))
    .toEqual({ ready: false, blockers: ['codex_unverified'] });
  expect(evaluateAgentReadiness(readyInput({ codexVerifiedModel: 'openai/gpt-5.6-sol-mini' })))
    .toEqual({ ready: false, blockers: ['codex_unverified'] });
  expect(evaluateAgentReadiness(readyInput({ codexVerifiedModel: CLAUDE_FALLBACK_MODEL })))
    .toEqual({ ready: false, blockers: ['codex_unverified'] });
  expect(evaluateAgentReadiness(readyInput({ claudeVerifiedModel: null })))
    .toEqual({ ready: false, blockers: ['claude_unverified'] });
  expect(evaluateAgentReadiness(readyInput({ claudeVerifiedModel: 'anthropic/claude-sonnet-5-legacy' })))
    .toEqual({ ready: false, blockers: ['claude_unverified'] });
  expect(evaluateAgentReadiness(readyInput({ answerVerifiedTarget: null })))
    .toEqual({ ready: false, blockers: ['answer_unverified'] });
  expect(evaluateAgentReadiness(readyInput({ answerVerifiedTarget: 'openclaw/other' })))
    .toEqual({ ready: false, blockers: ['answer_unverified'] });
});

test('a recorded runtime error blocks readiness and every blocker is reported', () => {
  expect(evaluateAgentReadiness(readyInput({ lastErrorCode: 'mcp_probe_failed' })))
    .toEqual({ ready: false, blockers: ['runtime_error'] });
  expect(evaluateAgentReadiness(readyInput({
    accessConfirmedRevision: 1,
    mcpVerifiedGeneration: 0,
    codexVerifiedGeneration: 0,
    claudeVerifiedGeneration: 0,
    answerVerifiedGeneration: 0,
    nativePasswordAppliedGeneration: 0,
    lastErrorCode: 'runtime_unreachable',
  }))).toEqual({
    ready: false,
    blockers: [
      'grant_unconfirmed', 'mcp_unverified', 'codex_unverified',
      'claude_unverified', 'answer_unverified', 'native_password_pending', 'runtime_error',
    ],
  });
});

test('an uninitialized Workspace reports a closed, unbound status', async () => {
  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status).toMatchObject({
    initialized: false,
    agentId: null,
    scope: null,
    sourceAccess: null,
    readiness: { ready: false, blockers: ['agent_missing'] },
  });
});

test('initialization binds one shared Agent at Read scope with No Source Access', async () => {
  const status = await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  expect(status).toMatchObject({
    initialized: true,
    scope: 'read',
    sourceAccess: { mode: 'none' },
    accessRevision: 1,
    accessConfirmedRevision: 0,
    mcpGeneration: 1,
    mcpVerifiedGeneration: 0,
    modelGeneration: 1,
    codexVerifiedModel: null,
    claudeVerifiedModel: null,
    nativePassword: { desiredGeneration: 1, appliedGeneration: 0 },
    readiness: { ready: false },
  });
  expect(status.readiness.blockers).toContain('grant_unconfirmed');
  expect(status.readiness.blockers).toContain('native_password_pending');

  const agents = await engine.executeRaw<{ agent_id: string; name: string; purpose: string; scope: string; status: string }>(
    'SELECT agent_id, name, purpose, scope, status FROM workspace_agents',
  );
  expect(agents).toEqual([{
    agent_id: status.agentId!, name: 'OpenClaw',
    purpose: 'Shared OpenClaw runtime for this Workspace', scope: 'read', status: 'active',
  }]);
  // The bound Agent gets no credential here; the MCP worker issues one only
  // when it can immediately configure the runtime.
  expect(await engine.executeRaw('SELECT credential_id FROM workspace_agent_credentials')).toEqual([]);

  const operations = await engine.executeRaw<{ operation_type: string; generation: number; idempotency_key: string; state: string }>(
    'SELECT operation_type, generation, idempotency_key, state FROM workspace_agent_runtime_operations ORDER BY operation_type',
  );
  expect(operations).toEqual([
    { operation_type: 'mcp.configure', generation: 1, idempotency_key: 'initialize:mcp.configure:1', state: 'queued' },
    { operation_type: 'native_password.rotate', generation: 1, idempotency_key: 'initialize:native_password.rotate:1', state: 'queued' },
  ]);
});

test('repeated initialization returns the same binding and never creates a second shared Agent', async () => {
  const first = await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  const second = await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'member-1',
    actorMembershipId: 'admin-1', requestId: 'init-2',
  });
  expect(second.agentId).toBe(first.agentId);
  expect(await engine.executeRaw('SELECT agent_id FROM workspace_agents')).toHaveLength(1);
  expect(await engine.executeRaw('SELECT operation_id FROM workspace_agent_runtime_operations')).toHaveLength(2);
});

test('concurrent initialization converges on one binding', async () => {
  const results = await Promise.allSettled([1, 2, 3].map(index => initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: `init-${index}`,
  })));
  const bindings = await engine.executeRaw<{ agent_id: string }>('SELECT agent_id FROM workspace_agent_runtime_bindings');
  expect(bindings).toHaveLength(1);
  for (const result of results) {
    if (result.status === 'fulfilled') expect(result.value.agentId).toBe(bindings[0]!.agent_id);
  }
});

test('a mismatched Workspace ID can neither claim nor read the bound Agent', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });

  // Reads are scoped by Workspace and never leak the binding.
  const foreign = await getAgentAccessStatus(engine, 'workspace-2');
  expect(foreign.initialized).toBe(false);
  expect(foreign.agentId).toBe(null);
  expect(foreign.readiness).toEqual({ ready: false, blockers: ['agent_missing'] });

  // Claiming under a foreign Workspace ID is refused, never redirected to the
  // existing binding, and creates no second shared Agent.
  await expect(initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-2', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-2',
  })).rejects.toThrow('agent_owner_not_found');
  expect(await engine.executeRaw('SELECT agent_id FROM workspace_agent_runtime_bindings')).toHaveLength(1);
  expect(await engine.executeRaw('SELECT agent_id FROM workspace_agents')).toHaveLength(1);

  await expect(confirmBoundAgentGrant(engine, {
    workspaceId: 'workspace-2', actorMembershipId: 'admin-1',
    requestId: 'confirm-1', reason: 'A foreign Workspace must not confirm this grant.',
  })).rejects.toThrow('agent_binding_not_found');
  await expect(requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-2', actorMembershipId: 'admin-1',
    requestId: 'rotate-1', idempotencyKey: 'rotate:1',
    reason: 'A foreign Workspace must not rotate this password.',
  })).rejects.toThrow('agent_binding_not_found');
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.desiredGeneration).toBe(1);
});

test('warning confirmation is durable and revision-specific', async () => {
  await confirmAgentWarning(engine, {
    workspaceId: 'workspace-1',
    membershipId: 'member-1',
    revision: AGENT_WARNING_REVISION,
  });
  expect(await hasConfirmedAgentWarning(
    engine, 'workspace-1', 'member-1', AGENT_WARNING_REVISION,
  )).toBe(true);
  expect(await hasConfirmedAgentWarning(
    engine, 'workspace-1', 'member-1', 'openclaw-shared-state-v2',
  )).toBe(false);
  expect(await hasConfirmedAgentWarning(
    engine, 'workspace-1', 'admin-1', AGENT_WARNING_REVISION,
  )).toBe(false);
  // Repeating the same acknowledgment stays a single durable record.
  await confirmAgentWarning(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', revision: AGENT_WARNING_REVISION,
  });
  expect(await engine.executeRaw('SELECT membership_id FROM workspace_agent_warning_confirmations')).toHaveLength(1);
});

test('grant confirmation records the current access revision and is idempotent', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  const confirmed = await confirmBoundAgentGrant(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'confirm-1', reason: 'Administrator granted the shared runtime.',
  });
  expect(confirmed.accessConfirmedRevision).toBe(1);
  expect(confirmed.readiness.blockers).not.toContain('grant_unconfirmed');

  // A later access revision re-locks the grant until it is confirmed again.
  await engine.executeRaw('UPDATE workspace_agent_runtime_bindings SET access_revision=2 WHERE workspace_id=$1', ['workspace-1']);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).readiness.blockers).toContain('grant_unconfirmed');
  const again = await confirmBoundAgentGrant(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'confirm-2', reason: 'Administrator re-confirmed the widened grant.',
  });
  expect(again.accessConfirmedRevision).toBe(2);
});

test('grant confirmation refuses an unbound Workspace', async () => {
  await expect(confirmBoundAgentGrant(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'confirm-1', reason: 'No binding exists yet.',
  })).rejects.toThrow('agent_binding_not_found');
});

test('runtime operations converge by idempotency key and by desired generation', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  const first = await enqueueAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-1', type: 'mcp.configure', generation: 2,
    requestId: 'req-a', idempotencyKey: 'grant:2:mcp.configure:2',
  });
  // Same key, same (type, generation) fingerprint: the existing operation.
  expect(await enqueueAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-1', type: 'mcp.configure', generation: 2,
    requestId: 'req-b', idempotencyKey: 'grant:2:mcp.configure:2',
  })).toBe(first);
  // A different caller, a different key, the same desired generation.
  expect(await enqueueAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-1', type: 'mcp.configure', generation: 2,
    requestId: 'req-c', idempotencyKey: 'other:mcp.configure:2',
  })).toBe(first);
  // The same key asking for different work fails closed.
  await expect(enqueueAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-1', type: 'mcp.configure', generation: 3,
    requestId: 'req-d', idempotencyKey: 'grant:2:mcp.configure:2',
  })).rejects.toThrow('idempotency_conflict');
  await expect(enqueueAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-1', type: 'native_password.rotate', generation: 2,
    requestId: 'req-e', idempotencyKey: 'grant:2:mcp.configure:2',
  })).rejects.toThrow('idempotency_conflict');
  // A malformed generation is refused outright.
  await expect(enqueueAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-1', type: 'mcp.configure', generation: 0,
    requestId: 'req-f', idempotencyKey: 'bad:0',
  })).rejects.toThrow('invalid_runtime_operation');

  // Every key is namespaced by Workspace, so a foreign Workspace's key finds
  // nothing rather than colliding with this Workspace's Operation.
  await expect(enqueueAgentRuntimeOperation(engine, {
    workspaceId: 'workspace-2', type: 'mcp.configure', generation: 2,
    requestId: 'req-g', idempotencyKey: 'grant:2:mcp.configure:2',
  })).rejects.toThrow();
});

test('a native password rotation advances the generation once per idempotency key', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  const rotated = await requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'rotate-1', idempotencyKey: 'rotate:manual:1',
    reason: 'Administrator rotated the shared native password.',
  });
  expect(rotated.generation).toBe(2);
  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status.nativePassword).toEqual({ desiredGeneration: 2, appliedGeneration: 0 });
  expect(status.readiness.blockers).toContain('native_password_pending');

  const repeated = await requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'rotate-2', idempotencyKey: 'rotate:manual:1',
    reason: 'A retry must not advance the generation again.',
  });
  expect(repeated).toEqual(rotated);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.desiredGeneration).toBe(2);

  const next = await requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'rotate-3', idempotencyKey: 'rotate:manual:2',
    reason: 'A second explicit rotation.',
  });
  expect(next.generation).toBe(3);
});

test('advancing the native password generation clears a proven readiness', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_bindings
        SET access_confirmed_revision=1, mcp_verified_generation=1,
            codex_verified_generation=1, codex_verified_model=$2,
            claude_verified_generation=1, claude_verified_model=$3,
            answer_verified_generation=1, answer_verified_target='openclaw/default',
            native_password_applied_generation=1, ready_at=now()
      WHERE workspace_id=$1`,
    ['workspace-1', CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL],
  );
  expect((await getAgentAccessStatus(engine, 'workspace-1')).readiness).toEqual({ ready: true, blockers: [] });

  await requestNativePasswordRotation(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'rotate-1', idempotencyKey: 'rotate:manual:1',
    reason: 'Rotation must re-lock access.',
  });
  const after = await getAgentAccessStatus(engine, 'workspace-1');
  expect(after.readiness).toEqual({ ready: false, blockers: ['native_password_pending'] });
  expect(await engine.executeRaw<{ ready_at: string | null }>('SELECT ready_at FROM workspace_agent_runtime_bindings'))
    .toEqual([{ ready_at: null }]);
});

test('a revoked bound Agent closes readiness even with every generation proven', async () => {
  const bound = await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_bindings
        SET access_confirmed_revision=1, mcp_verified_generation=1,
            codex_verified_generation=1, codex_verified_model=$2,
            claude_verified_generation=1, claude_verified_model=$3,
            answer_verified_generation=1, answer_verified_target='openclaw/default',
            native_password_applied_generation=1
      WHERE workspace_id=$1`,
    ['workspace-1', CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL],
  );
  await engine.executeRaw("UPDATE workspace_agents SET status='revoked' WHERE agent_id=$1", [bound.agentId]);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).readiness)
    .toEqual({ ready: false, blockers: ['agent_revoked'] });
});

test('the first native operation pins the deployment secret and a changed secret fails closed', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  const expected = createHmac('sha256', 'deployment-secret')
    .update('gbrain:openclaw-native-secret:v1', 'utf8').digest('hex');

  await pinAgentPasswordSecretFingerprint(engine, 'workspace-1', 'deployment-secret');
  expect(await engine.executeRaw<{ native_password_secret_fingerprint: string }>(
    'SELECT native_password_secret_fingerprint FROM workspace_agent_runtime_bindings',
  )).toEqual([{ native_password_secret_fingerprint: expected }]);

  // The same secret converges; a different one fails before any runtime call.
  await pinAgentPasswordSecretFingerprint(engine, 'workspace-1', 'deployment-secret');
  await expect(pinAgentPasswordSecretFingerprint(engine, 'workspace-1', 'other-secret'))
    .rejects.toThrow('agent_password_secret_changed');
  expect(await engine.executeRaw<{ native_password_secret_fingerprint: string }>(
    'SELECT native_password_secret_fingerprint FROM workspace_agent_runtime_bindings',
  )).toEqual([{ native_password_secret_fingerprint: expected }]);

  await expect(pinAgentPasswordSecretFingerprint(engine, 'workspace-1', ''))
    .rejects.toThrow('agent_password_secret_required');
  await expect(pinAgentPasswordSecretFingerprint(engine, 'workspace-missing', 'deployment-secret'))
    .rejects.toThrow('agent_binding_not_found');
});

test('no status view carries a secret, a token, or the deployment fingerprint', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  await pinAgentPasswordSecretFingerprint(engine, 'workspace-1', 'deployment-secret');
  const fingerprint = createHmac('sha256', 'deployment-secret')
    .update('gbrain:openclaw-native-secret:v1', 'utf8').digest('hex');
  const password = deriveAgentNativePassword('deployment-secret', 'workspace-1', 1);

  const serialized = JSON.stringify(await getAgentAccessStatus(engine, 'workspace-1'));
  expect(serialized).not.toContain(fingerprint);
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain('deployment-secret');
  expect(serialized.toLowerCase()).not.toContain('password_secret');
  expect(serialized.toLowerCase()).not.toContain('token');

  // The derived password is never written anywhere in the Workspace record.
  const audit = await engine.executeRaw<{ before_state: unknown; after_state: unknown }>(
    'SELECT before_state, after_state FROM workspace_audit_events',
  );
  expect(JSON.stringify(audit)).not.toContain(password);
  expect(JSON.stringify(audit)).not.toContain('deployment-secret');
});

async function initialize() {
  return initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
}

test('the synchronized grant seam changes Scope and Source Access and re-locks readiness', async () => {
  const bound = await initialize();
  await confirmBoundAgentGrant(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'confirm-1', reason: 'Administrator confirmed the initial grant.',
  });
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_bindings
        SET mcp_verified_generation=1, ready_at=now() WHERE workspace_id=$1`,
    ['workspace-1'],
  );

  const granted = await setBoundAgentGrant(engine, {
    workspaceId: 'workspace-1',
    scope: 'write',
    sourceAccess: { mode: 'specific', sourceIds: ['source-b', 'source-a', 'source-a'] },
    actorMembershipId: 'admin-1',
    requestId: 'grant-1',
    reason: 'Administrator granted Write on the docs Sources.',
  });

  expect(granted).toMatchObject({
    agentId: bound.agentId,
    scope: 'write',
    sourceAccess: { mode: 'specific', sourceIds: ['source-a', 'source-b'] },
    accessRevision: 2,
    accessConfirmedRevision: 1,
    mcpGeneration: 2,
    mcpVerifiedGeneration: 0,
  });
  expect(granted.readiness.blockers).toEqual(expect.arrayContaining(['grant_unconfirmed', 'mcp_unverified']));
  expect(await engine.executeRaw<{ ready_at: string | null }>('SELECT ready_at FROM workspace_agent_runtime_bindings'))
    .toEqual([{ ready_at: null }]);

  // The Agent row itself carries the new grant, and the reconfiguration is queued.
  expect((await listWorkspaceAgents(engine, 'workspace-1'))[0]).toMatchObject({
    agentId: bound.agentId, scope: 'write',
    sourceAccess: { mode: 'specific', sourceIds: ['source-a', 'source-b'] },
  });
  expect(await engine.executeRaw<{ idempotency_key: string; generation: number }>(
    "SELECT idempotency_key, generation FROM workspace_agent_runtime_operations WHERE operation_type='mcp.configure' ORDER BY generation",
  )).toEqual([
    { idempotency_key: 'initialize:mcp.configure:1', generation: 1 },
    { idempotency_key: 'grant:2:mcp.configure:2', generation: 2 },
  ]);
});

test('the synchronized grant seam validates Scope and Source Access and stays atomic', async () => {
  await initialize();
  const base = {
    workspaceId: 'workspace-1', actorMembershipId: 'admin-1',
    requestId: 'grant-bad', reason: 'An invalid grant must change nothing.',
  };
  await expect(setBoundAgentGrant(engine, {
    ...base, scope: 'root' as never, sourceAccess: { mode: 'all' },
  })).rejects.toThrow('invalid_agent_scope');
  await expect(setBoundAgentGrant(engine, {
    ...base, scope: 'write', sourceAccess: { mode: 'specific', sourceIds: [] },
  })).rejects.toThrow('specific_source_access_required');
  await expect(setBoundAgentGrant(engine, {
    ...base, scope: 'write', sourceAccess: { mode: 'everything' as never },
  })).rejects.toThrow('invalid_source_access_grant');
  await expect(setBoundAgentGrant(engine, {
    ...base, scope: 'write', sourceAccess: { mode: 'all' }, reason: '',
  })).rejects.toThrow('reason is required');

  const status = await getAgentAccessStatus(engine, 'workspace-1');
  expect(status).toMatchObject({ scope: 'read', sourceAccess: { mode: 'none' }, accessRevision: 1, mcpGeneration: 1 });
  expect(await engine.executeRaw('SELECT operation_id FROM workspace_agent_runtime_operations')).toHaveLength(2);
});

test('the synchronized grant seam refuses an unbound Workspace', async () => {
  await expect(setBoundAgentGrant(engine, {
    workspaceId: 'workspace-1', scope: 'write', sourceAccess: { mode: 'all' },
    actorMembershipId: 'admin-1', requestId: 'grant-1', reason: 'No binding exists yet.',
  })).rejects.toThrow('agent_binding_not_found');
});

test('advancing the generation inside a caller transaction stays atomic with it', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  await expect(engine.transaction(async tx => {
    await advanceNativePasswordGenerationInTransaction(tx, {
      workspaceId: 'workspace-1', requestId: 'req-1', idempotencyKey: 'tx:1',
    });
    throw new Error('caller_failed');
  })).rejects.toThrow('caller_failed');
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.desiredGeneration).toBe(1);
  expect(await engine.executeRaw('SELECT operation_id FROM workspace_agent_runtime_operations')).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// #68 Task 8 — `projectAgentProvider` as a pure function.
//
// It was previously reachable only through GET /agent, where the fixtures were
// all well-formed. Three of the clauses its docstring describes were therefore
// deletable with the whole HTTP suite green: the percentage bounds, the reset
// timestamp bounds, and the `=== true` that stops a truthy non-boolean reading
// as authenticated. Malformed upstream values are exactly what those clauses
// exist for, so they are fed in directly here.
// ---------------------------------------------------------------------------

const UNREADABLE = { status: 'unknown', remainingPercent: null, resetsAt: null } as const;

test('a quota percentage outside 0..100 is malformed upstream data, not a reading', async () => {
  for (const remainingPercent of [150, -5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    const view = projectAgentProvider(true, {
      authenticated: true,
      authStatus: 'ok',
      quota: { state: 'known', remainingPercent, resetsAt: null },
    });
    expect(view.limits, `remainingPercent ${String(remainingPercent)} must not read as a quota`).toEqual(UNREADABLE);
    // The credential is a separate signal and survives an unusable quota.
    expect(view.connected).toBe(true);
  }

  // The boundaries themselves are legitimate readings and must be kept.
  expect(projectAgentProvider(true, {
    authenticated: true, authStatus: 'ok',
    quota: { state: 'known', remainingPercent: 100, resetsAt: null },
  }).limits).toEqual({ status: 'available', remainingPercent: 100, resetsAt: null });
  expect(projectAgentProvider(true, {
    authenticated: true, authStatus: 'ok',
    quota: { state: 'known', remainingPercent: 0, resetsAt: null },
  }).limits).toEqual({ status: 'exhausted', remainingPercent: 0, resetsAt: null });
});

test('a reset timestamp outside a plausible epoch window is dropped, not rendered', async () => {
  // 1ms after the epoch and a year-128000 value are both units confusion —
  // seconds mistaken for milliseconds, or the reverse — not real deadlines.
  for (const resetsAt of [1, 4e15, 0, -1, 1.5]) {
    const view = projectAgentProvider(true, {
      authenticated: true,
      authStatus: 'ok',
      quota: { state: 'known', remainingPercent: 50, resetsAt },
    });
    expect(view.limits.resetsAt, `resetsAt ${String(resetsAt)} must not be rendered`).toBeNull();
    // Dropping an implausible deadline must not discard the usable percentage.
    expect(view.limits.status).toBe('available');
    expect(view.limits.remainingPercent).toBe(50);
  }

  const real = Date.UTC(2026, 6, 30, 12);
  expect(projectAgentProvider(true, {
    authenticated: true, authStatus: 'ok',
    quota: { state: 'known', remainingPercent: 50, resetsAt: real },
  }).limits.resetsAt).toBe(new Date(real).toISOString());
});

test('only a literal true reads as connected, whatever the upstream sent', async () => {
  // The adapter types `authenticated` as boolean, so this is a defence against
  // an upstream or adapter change, not against today's call site. A truthy
  // non-boolean is precisely the input `=== true` exists to refuse, and it is
  // the input no HTTP fixture supplies.
  for (const authenticated of ['yes', 1, {}, [], 'false']) {
    const view = projectAgentProvider(true, {
      authenticated: authenticated as unknown as boolean,
      authStatus: 'ok',
      quota: { state: 'unknown', remainingPercent: null, resetsAt: null },
    });
    expect(view.connected, `authenticated ${JSON.stringify(authenticated)} must not read as connected`).toBe(false);
  }
  expect(projectAgentProvider(true, {
    authenticated: true, authStatus: 'ok',
    quota: { state: 'unknown', remainingPercent: null, resetsAt: null },
  }).connected).toBe(true);
});

test('every unauthenticated auth status stays unconnected, including static', async () => {
  // `static` means an api_key ENTRY exists and says nothing about whether it
  // works. The adapter already reports it as unauthenticated; the projection
  // must not upgrade it on the strength of the entry existing.
  for (const authStatus of ['static', 'expired', 'missing', 'unknown'] as const) {
    const view = projectAgentProvider(false, {
      authenticated: false, authStatus,
      quota: { state: 'unknown', remainingPercent: null, resetsAt: null },
    });
    expect(view.connected, `${authStatus} must not read as connected`).toBe(false);
    expect(view.limits).toEqual(UNREADABLE);
  }
});

test('an absent reading is unknown, never a fabricated availability', async () => {
  // The gateway deletes credential-less providers from the usage snapshot
  // entirely, so "no limit found" and "plenty of quota" are the same wire
  // observation. Reporting the absence as available would be a guaranteed
  // fail-open.
  expect(projectAgentProvider(true, null)).toEqual({ required: true, connected: false, limits: UNREADABLE });
  expect(projectAgentProvider(false, {
    authenticated: true, authStatus: 'ok',
    quota: { state: 'unknown', remainingPercent: null, resetsAt: null },
  })).toEqual({ required: false, connected: true, limits: UNREADABLE });
});

test('the limited threshold sits between available and exhausted', async () => {
  const status = (remainingPercent: number) => projectAgentProvider(true, {
    authenticated: true, authStatus: 'ok',
    quota: { state: 'known', remainingPercent, resetsAt: null },
  }).limits.status;
  expect(status(20)).toBe('available');
  expect(status(19.9)).toBe('limited');
  expect(status(0.1)).toBe('limited');
  expect(status(0)).toBe('exhausted');
});

/**
 * The storage constraint that makes the `accessRevision >= 1` branch
 * unreachable, asserted rather than restated in code. `grantConfirmed` in the
 * router compares the two revisions and nothing else; this is what entitles it
 * to.
 */
test('a non-positive access revision is refused by the binding schema itself', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'req-revision-constraint',
  });
  for (const revision of [0, -1]) {
    await expect(engine.executeRaw(
      'UPDATE workspace_agent_runtime_bindings SET access_revision=$1 WHERE workspace_id=$2',
      [revision, 'workspace-1'],
    )).rejects.toThrow();
  }
});

// ---------------------------------------------------------------------------
// #68 Task 9 — disabling a Member only ever touches the shared native
// password. It must never reach for a provider credential, a provider status
// read, or an MCP reconfiguration: those are the OTHER shared-runtime
// concerns Task 9 is not the owner of.
// ---------------------------------------------------------------------------

/**
 * A control that actually drives `mcp.configure` and `native_password.rotate`
 * to completion, and records every provider call it would be a defect for
 * Member disablement to ever make.
 */
class RecordingControl implements OpenClawControl {
  identity: OpenClawGBrainIdentity | null = null;
  accepted = new Set<string>();
  configuredTokens: string[] = [];
  providerState: Record<string, OpenClawProviderStatus> = {
    claude: { authenticated: true, authStatus: 'ok', quota: { state: 'known', remainingPercent: 42, resetsAt: null } },
  };
  providerReads: OpenClawProviderId[] = [];
  importedCredentials: unknown[] = [];

  async runtimeHealth(): Promise<boolean> { return true; }

  async applyNativePassword(password: string): Promise<void> {
    this.accepted.clear();
    this.accepted.add(password);
  }

  async verifyNativePassword(password: string): Promise<boolean> { return this.accepted.has(password); }
  async verifyNativePasswordRejected(password: string): Promise<boolean> { return !this.accepted.has(password); }

  async configureGBrainMcp(input: { token: string }): Promise<void> { this.configuredTokens.push(input.token); }

  async probeGBrainWhoAmI(): Promise<OpenClawGBrainIdentity> {
    if (!this.identity) throw new Error('no identity seeded');
    return this.identity;
  }

  async importProviderCredential(input: unknown): Promise<void> {
    this.importedCredentials.push(input);
  }

  async getProviderStatus(provider: OpenClawProviderId): Promise<OpenClawProviderStatus> {
    this.providerReads.push(provider);
    const status = this.providerState[provider];
    if (!status) throw new Error('unused');
    return status;
  }

  async listModels(): Promise<string[]> { throw new Error('unused'); }
  async probeModel(): Promise<{ text: string }> { throw new Error('unused'); }
  async probeDefaultAnswer(): Promise<{ text: string }> { throw new Error('unused'); }
}

async function drainQueue(engine: Parameters<typeof runAgentRuntimeOperationWorkerOnce>[0], control: OpenClawControl): Promise<void> {
  for (let guard = 0; guard < 10; guard += 1) {
    const operation = await runAgentRuntimeOperationWorkerOnce(engine, {
      workerId: 'drain-worker', tokenSecret: 'deployment-secret', control,
    });
    if (!operation) return;
  }
  throw new Error('queue did not drain within the test guard');
}

test('Member disablement does not alter provider status or credentials', async () => {
  const bound = await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  const control = new RecordingControl();
  control.identity = { workspaceId: 'workspace-1', agentId: bound.agentId, scopes: ['read'], sourceAccessMode: 'none' };
  await drainQueue(engine, control);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).mcpVerifiedGeneration).toBe(1);
  expect((await getAgentAccessStatus(engine, 'workspace-1')).nativePassword.appliedGeneration).toBe(1);

  const before = structuredClone(control.providerState);
  const providerReadsBefore = control.providerReads.length;
  const importsBefore = control.importedCredentials.length;
  const configuredBefore = control.configuredTokens.length;

  const result = await setWorkspaceMembershipStatus(
    engine, 'workspace-1', 'member-1', 'disabled', 'admin-1', 'disable-1', 'Left the team.',
  );
  expect(result.nativeRotationQueued).toBe(true);
  const outcome = await reconcileAgentRuntimeOperation(engine, result.nativeRotationOperationId!, {
    workerId: 'reconcile-worker', tokenSecret: 'deployment-secret', control,
  });
  expect(outcome).toBe('succeeded');

  // Only the native password moved. Nothing about a provider connection, its
  // quota, or the MCP credential was ever read, written, or reconfigured.
  expect(control.providerState).toEqual(before);
  expect(control.providerReads).toHaveLength(providerReadsBefore);
  expect(control.importedCredentials).toHaveLength(importsBefore);
  expect(control.configuredTokens).toHaveLength(configuredBefore);
});

// ---------------------------------------------------------------------------
// #68 Task 10 — Administrator provider setup and the three real readiness
// proofs.
//
// Every proof is a LIVE call plus a compare-and-set against the exact
// `model_generation` captured before that call. A configured profile, an
// `authStatus` of `ok`, or a catalog that merely contains something similar is
// never proof. The assertions therefore check the affected column and the
// SPECIFIC refusal, never "some refusal fired".
// ---------------------------------------------------------------------------

/** A control that answers the provider/model surface and records every call. */
class ProviderControl implements OpenClawControl {
  models: string[] = [CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL];
  imports: { provider: string; credential: string }[] = [];
  probes: { model: string | null; prompt: string }[] = [];
  importError: Error | null = null;
  probeError: Error | null = null;
  answerText = '2BRAIN_AGENT_READY';
  /** Runs INSIDE the probe, i.e. while the check is in flight. */
  onProbe: (() => Promise<void>) | null = null;

  async runtimeHealth(): Promise<boolean> { return true; }
  async applyNativePassword(): Promise<void> { throw new Error('unused'); }
  async verifyNativePassword(): Promise<boolean> { throw new Error('unused'); }
  async verifyNativePasswordRejected(): Promise<boolean> { throw new Error('unused'); }
  async configureGBrainMcp(): Promise<void> { throw new Error('unused'); }
  async probeGBrainWhoAmI(): Promise<OpenClawGBrainIdentity> { throw new Error('unused'); }

  async importProviderCredential(input: { provider: string; credential: string }): Promise<void> {
    this.imports.push({ provider: input.provider, credential: input.credential });
    if (this.importError) throw this.importError;
  }

  async getProviderStatus(): Promise<OpenClawProviderStatus> {
    return {
      authenticated: true,
      authStatus: 'ok',
      quota: { state: 'unknown', remainingPercent: null, resetsAt: null },
    };
  }

  async listModels(): Promise<string[]> { return [...this.models]; }

  async probeModel(model: string, prompt: string): Promise<{ text: string }> {
    this.probes.push({ model, prompt });
    await this.onProbe?.();
    if (this.probeError) throw this.probeError;
    if (!this.models.includes(model)) throw new Error('openclaw_model_unavailable');
    return { text: 'answered' };
  }

  async probeDefaultAnswer(prompt: string): Promise<{ text: string }> {
    this.probes.push({ model: null, prompt });
    await this.onProbe?.();
    if (this.probeError) throw this.probeError;
    return { text: this.answerText };
  }
}

async function bindAgent(): Promise<void> {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-providers',
  });
}

async function bindingColumns(): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT model_generation, codex_verified_generation, codex_verified_model,
            claude_verified_generation, claude_verified_model,
            answer_verified_generation, answer_verified_target, ready_at
       FROM workspace_agent_runtime_bindings WHERE workspace_id='workspace-1'`,
  );
  return rows[0]!;
}

const IMPORT_INPUT = {
  workspaceId: 'workspace-1', actorMembershipId: 'admin-1', requestId: 'req-import-1',
};

async function seedModelProofs(): Promise<void> {
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_bindings
        SET codex_verified_generation=model_generation, codex_verified_model=$1,
            claude_verified_generation=model_generation, claude_verified_model=$2,
            answer_verified_generation=model_generation, answer_verified_target='openclaw/default'
      WHERE workspace_id='workspace-1'`,
    [CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL],
  );
}

test('the answer proof prompt and target are the pinned literals', () => {
  expect(ANSWER_PROOF_PROMPT).toBe('Reply with exactly: 2BRAIN_AGENT_READY');
  expect(ANSWER_PROOF_TARGET).toBe('openclaw/default');
});

test('an Anthropic import invalidates every model proof BEFORE the external call', async () => {
  await bindAgent();
  await seedModelProofs();
  await engine.executeRaw("UPDATE workspace_agent_runtime_bindings SET ready_at=now() WHERE workspace_id='workspace-1'");

  const control = new ProviderControl();
  control.importError = new Error('openclaw_provider_import_failed');
  await expect(importAgentAnthropicCredential(engine, control, {
    ...IMPORT_INPUT, setupToken: 'sk-ant-oat01-valid-fixture',
  })).rejects.toThrow('provider_import_failed');
  // The external call really was attempted, so the ordering under test is
  // "invalidate, then call" and not "never got there".
  expect(control.imports).toHaveLength(1);

  // The invalidation is committed even though the side effect failed, so the
  // Administrator is never left believing a stale proof still holds.
  const after = await bindingColumns();
  expect(Number(after.model_generation)).toBe(2);
  expect(Number(after.codex_verified_generation)).toBe(0);
  expect(after.codex_verified_model).toBeNull();
  expect(Number(after.claude_verified_generation)).toBe(0);
  expect(after.claude_verified_model).toBeNull();
  expect(Number(after.answer_verified_generation)).toBe(0);
  expect(after.answer_verified_target).toBeNull();
  expect(after.ready_at).toBeNull();
});

test('the Anthropic setup token reaches OpenClaw once and is never persisted', async () => {
  await bindAgent();
  const control = new ProviderControl();
  const token = 'sk-ant-oat01-secret-fixture-value';
  await importAgentAnthropicCredential(engine, control, { ...IMPORT_INPUT, setupToken: token });
  expect(control.imports).toEqual([{ provider: 'anthropic', credential: token }]);

  for (const table of [
    'workspace_agent_runtime_bindings', 'workspace_audit_events',
    'workspace_change_events', 'workspace_agent_runtime_operations',
  ]) {
    const rows = await engine.executeRaw(`SELECT * FROM ${table}`);
    expect(JSON.stringify(rows), `${table} must not carry the setup token`).not.toContain(token);
  }
});

test('an OpenRouter import never touches the model generation or the required proofs', async () => {
  await bindAgent();
  await seedModelProofs();
  const before = await bindingColumns();

  const control = new ProviderControl();
  await importAgentOpenRouterCredential(engine, control, { ...IMPORT_INPUT, apiKey: 'sk-or-v1-fixture' });
  expect(control.imports).toEqual([{ provider: 'openrouter', credential: 'sk-or-v1-fixture' }]);
  expect(await bindingColumns()).toEqual(before);

  const rows = await engine.executeRaw('SELECT * FROM workspace_audit_events');
  expect(JSON.stringify(rows)).not.toContain('sk-or-v1-fixture');
});

test('a catalog without the exact required model fails closed and never probes', async () => {
  await bindAgent();
  const control = new ProviderControl();
  // Near misses on purpose: a different minor version and a different Claude.
  control.models = ['openai/gpt-5.5', 'anthropic/claude-opus-5'];
  for (const provider of ['codex', 'claude'] as const) {
    await expect(checkAgentRequiredProvider(engine, control, { workspaceId: 'workspace-1', provider }))
      .rejects.toThrow('required_model_unavailable');
  }
  expect(control.probes).toHaveLength(0);
  const after = await bindingColumns();
  expect(Number(after.codex_verified_generation)).toBe(0);
  expect(Number(after.claude_verified_generation)).toBe(0);
});

test('a successful check records the exact requested model at the captured generation', async () => {
  await bindAgent();
  const control = new ProviderControl();
  const codex = await checkAgentRequiredProvider(engine, control, { workspaceId: 'workspace-1', provider: 'codex' });
  expect(codex.model).toBe(CODEX_DEFAULT_MODEL);
  expect(control.probes).toEqual([{ model: CODEX_DEFAULT_MODEL, prompt: ANSWER_PROOF_PROMPT }]);
  let after = await bindingColumns();
  expect(Number(after.codex_verified_generation)).toBe(1);
  expect(after.codex_verified_model).toBe(CODEX_DEFAULT_MODEL);
  // One check is one proof; the other two are untouched.
  expect(Number(after.claude_verified_generation)).toBe(0);
  expect(Number(after.answer_verified_generation)).toBe(0);

  await checkAgentRequiredProvider(engine, control, { workspaceId: 'workspace-1', provider: 'claude' });
  after = await bindingColumns();
  expect(after.claude_verified_model).toBe(CLAUDE_FALLBACK_MODEL);
});

test('a failed probe never advances a proof', async () => {
  await bindAgent();
  const control = new ProviderControl();
  control.probeError = new Error('openclaw_probe_failed');
  await expect(checkAgentRequiredProvider(engine, control, { workspaceId: 'workspace-1', provider: 'codex' }))
    .rejects.toThrow('model_check_failed');
  expect(Number((await bindingColumns()).codex_verified_generation)).toBe(0);

  await expect(proveAgentDefaultAnswer(engine, control, { workspaceId: 'workspace-1' }))
    .rejects.toThrow('answer_proof_failed');
  expect(Number((await bindingColumns()).answer_verified_generation)).toBe(0);
});

test('a check that finishes after a replacement cannot write a stale proof', async () => {
  await bindAgent();
  const control = new ProviderControl();
  // The Administrator replaces the Anthropic credential mid-flight, so
  // `model_generation` moves from 1 to 2 underneath the check.
  control.onProbe = async () => {
    control.onProbe = null;
    await engine.executeRaw(
      "UPDATE workspace_agent_runtime_bindings SET model_generation=model_generation+1 WHERE workspace_id='workspace-1'",
    );
  };
  await expect(checkAgentRequiredProvider(engine, control, { workspaceId: 'workspace-1', provider: 'codex' }))
    .rejects.toThrow('proof_superseded');

  const after = await bindingColumns();
  expect(Number(after.model_generation)).toBe(2);
  // The zero-row compare-and-set discarded the result entirely.
  expect(Number(after.codex_verified_generation)).toBe(0);
  expect(after.codex_verified_model).toBeNull();
});

test('an answer proof that finishes after a replacement is discarded too', async () => {
  await bindAgent();
  const control = new ProviderControl();
  control.onProbe = async () => {
    control.onProbe = null;
    await engine.executeRaw(
      "UPDATE workspace_agent_runtime_bindings SET model_generation=model_generation+1 WHERE workspace_id='workspace-1'",
    );
  };
  await expect(proveAgentDefaultAnswer(engine, control, { workspaceId: 'workspace-1' }))
    .rejects.toThrow('proof_superseded');
  const after = await bindingColumns();
  expect(Number(after.answer_verified_generation)).toBe(0);
  expect(after.answer_verified_target).toBeNull();
});

test('an empty default answer is not a proof', async () => {
  await bindAgent();
  const control = new ProviderControl();
  for (const text of ['', '   ']) {
    control.answerText = text;
    await expect(proveAgentDefaultAnswer(engine, control, { workspaceId: 'workspace-1' }))
      .rejects.toThrow('answer_proof_failed');
  }
  expect(Number((await bindingColumns()).answer_verified_generation)).toBe(0);
});

test('the default answer proof sends the fixed prompt with no override and records only the target', async () => {
  await bindAgent();
  const control = new ProviderControl();
  await proveAgentDefaultAnswer(engine, control, { workspaceId: 'workspace-1' });
  // `model: null` records that no `x-openclaw-model` override was requested —
  // which is the whole point of proving the CONFIGURED chain.
  expect(control.probes).toEqual([{ model: null, prompt: ANSWER_PROOF_PROMPT }]);
  const after = await bindingColumns();
  expect(Number(after.answer_verified_generation)).toBe(1);
  expect(after.answer_verified_target).toBe(ANSWER_PROOF_TARGET);
  const rows = await engine.executeRaw('SELECT * FROM workspace_agent_runtime_bindings');
  expect(JSON.stringify(rows)).not.toContain('2BRAIN_AGENT_READY');
});

test('readiness opens only after all three proofs land at the current generation', async () => {
  await bindAgent();
  const control = new ProviderControl();
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_bindings
        SET access_confirmed_revision=access_revision,
            mcp_verified_generation=mcp_generation,
            native_password_applied_generation=native_password_generation
      WHERE workspace_id='workspace-1'`,
  );
  const blockers = async () => (await getAgentAccessStatus(engine, 'workspace-1')).readiness.blockers;
  expect(await blockers()).toEqual(['codex_unverified', 'claude_unverified', 'answer_unverified']);

  await checkAgentRequiredProvider(engine, control, { workspaceId: 'workspace-1', provider: 'codex' });
  expect(await blockers()).toEqual(['claude_unverified', 'answer_unverified']);
  expect((await bindingColumns()).ready_at).toBeNull();

  await checkAgentRequiredProvider(engine, control, { workspaceId: 'workspace-1', provider: 'claude' });
  expect(await blockers()).toEqual(['answer_unverified']);
  expect((await bindingColumns()).ready_at).toBeNull();

  await proveAgentDefaultAnswer(engine, control, { workspaceId: 'workspace-1' });
  expect(await blockers()).toEqual([]);
  // `ready_at` is set in the same compare-and-set transaction as the last proof.
  expect((await bindingColumns()).ready_at).not.toBeNull();
});

test('proofs and imports refuse a Workspace with no bound Agent', async () => {
  const control = new ProviderControl();
  await expect(checkAgentRequiredProvider(engine, control, { workspaceId: 'workspace-1', provider: 'codex' }))
    .rejects.toThrow('agent_binding_not_found');
  await expect(proveAgentDefaultAnswer(engine, control, { workspaceId: 'workspace-1' }))
    .rejects.toThrow('agent_binding_not_found');
  await expect(importAgentAnthropicCredential(engine, control, { ...IMPORT_INPUT, setupToken: 'sk-ant-oat01-x' }))
    .rejects.toThrow('agent_binding_not_found');
  expect(control.imports).toHaveLength(0);
  expect(control.probes).toHaveLength(0);
});

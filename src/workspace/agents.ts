import { randomBytes, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { hashWorkspaceSecret } from './auth.ts';
import { runProtectedWorkspaceMutation } from './events.ts';
import { replacePrincipalSourceAccessInTransaction, type PrincipalSourceAccess } from './source-access.ts';

type AgentEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;
export type WorkspaceAgentScope = 'read' | 'write' | 'admin';
export type WorkspaceAgentStatus = 'active' | 'revoked';

const AGENT_SCOPE_RANK: Record<WorkspaceAgentScope, number> = { read: 0, write: 1, admin: 2 };

export class WorkspaceAgentError extends Error {
  constructor(readonly code:
    | 'agent_not_found'
    | 'agent_name_required'
    | 'agent_purpose_required'
    | 'agent_owner_not_found'
    | 'agent_revoked'
    | 'credential_not_found'
    | 'invalid_agent_scope'
    | 'invalid_agent_status'
    | 'invalid_source_access_grant'
    | 'managed_agent_operation_required'
    | 'specific_source_access_required') {
    super(code);
    this.name = 'WorkspaceAgentError';
  }
}

/** Read → Write → Admin is cumulative; Source Access never widens through it. */
export function workspaceAgentScopeIncludes(scope: WorkspaceAgentScope, capability: WorkspaceAgentScope): boolean {
  return AGENT_SCOPE_RANK[scope] >= AGENT_SCOPE_RANK[capability];
}

function validateScope(scope: unknown): WorkspaceAgentScope {
  if (scope !== 'read' && scope !== 'write' && scope !== 'admin') throw new WorkspaceAgentError('invalid_agent_scope');
  return scope;
}

function validateName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 80) throw new WorkspaceAgentError('agent_name_required');
  return normalized;
}

function validatePurpose(purpose: string): string {
  const normalized = purpose.trim();
  if (!normalized || normalized.length > 240) throw new WorkspaceAgentError('agent_purpose_required');
  return normalized;
}

function validateAccess(access: PrincipalSourceAccess): string[] {
  if (access.mode !== 'all' && access.mode !== 'specific' && access.mode !== 'none') {
    throw new WorkspaceAgentError('invalid_source_access_grant');
  }
  const sourceIds = access.mode === 'specific' ? [...new Set(access.sourceIds)].sort() : [];
  if (sourceIds.some(sourceId => !isValidSourceId(sourceId))) throw new WorkspaceAgentError('invalid_source_access_grant');
  if (access.mode === 'specific' && sourceIds.length === 0) throw new WorkspaceAgentError('specific_source_access_required');
  return sourceIds;
}

async function requireOwnerMembership(tx: Pick<BrainEngine, 'executeRaw'>, workspaceId: string, membershipId: string): Promise<void> {
  const rows = await tx.executeRaw(
    'SELECT membership_id FROM workspace_memberships WHERE workspace_id=$1 AND membership_id=$2',
    [workspaceId, membershipId],
  );
  if (!rows[0]) throw new WorkspaceAgentError('agent_owner_not_found');
}

async function requireAgent(
  tx: Pick<BrainEngine, 'executeRaw'>, workspaceId: string, agentId: string,
): Promise<{ status: WorkspaceAgentStatus; scope: WorkspaceAgentScope }> {
  const rows = await tx.executeRaw<{ status: WorkspaceAgentStatus; scope: WorkspaceAgentScope }>(
    'SELECT status, scope FROM workspace_agents WHERE workspace_id=$1 AND agent_id=$2',
    [workspaceId, agentId],
  );
  if (!rows[0]) throw new WorkspaceAgentError('agent_not_found');
  return rows[0];
}

/**
 * The Agent bound to the OpenClaw runtime cannot be mutated through the generic
 * Agent API: its authorization is coupled to generation counters and queued
 * runtime work, so an unsynchronized change would leave the live runtime
 * configured against a grant GBrain no longer records. Every generic mutation
 * calls this inside its own transaction, never as a pre-flight check.
 */
async function assertAgentIsNotRuntimeBound(
  tx: Pick<BrainEngine, 'executeRaw'>, workspaceId: string, agentId: string,
): Promise<void> {
  const rows = await tx.executeRaw(
    'SELECT 1 FROM workspace_agent_runtime_bindings WHERE workspace_id=$1 AND agent_id=$2',
    [workspaceId, agentId],
  );
  if (rows[0]) throw new WorkspaceAgentError('managed_agent_operation_required');
}

async function replaceAccess(tx: Pick<BrainEngine, 'executeRaw'>, agentId: string, access: PrincipalSourceAccess): Promise<void> {
  const sourceIds = validateAccess(access);
  await replacePrincipalSourceAccessInTransaction(tx, { kind: 'agent', id: agentId }, access.mode, sourceIds);
}

async function issueCredential(tx: Pick<BrainEngine, 'executeRaw'>, agentId: string): Promise<{ credentialId: string; token: string }> {
  const credentialId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await tx.executeRaw(
    "INSERT INTO workspace_agent_credentials (credential_id, agent_id, credential_type, token_hash) VALUES ($1, $2, 'api_key', $3)",
    [credentialId, agentId, hashWorkspaceSecret(token)],
  );
  return { credentialId, token };
}

/**
 * @internal Create one Agent identity inside an already-protected transaction.
 * It issues no credential; callers that need one call
 * {@link replaceWorkspaceAgentCredentialInTransaction} explicitly.
 */
export async function createWorkspaceAgentInTransaction(
  tx: Pick<BrainEngine, 'executeRaw'>,
  input: {
    workspaceId: string;
    name: string;
    purpose: string;
    ownerMembershipId: string;
    scope: WorkspaceAgentScope;
    sourceAccess: PrincipalSourceAccess;
    actorMembershipId: string;
    agentId?: string;
  },
): Promise<string> {
  const name = validateName(input.name);
  const purpose = validatePurpose(input.purpose);
  const scope = validateScope(input.scope);
  validateAccess(input.sourceAccess);
  const agentId = input.agentId ?? randomUUID();
  await requireOwnerMembership(tx, input.workspaceId, input.ownerMembershipId);
  await tx.executeRaw(
    `INSERT INTO workspace_agents (agent_id, workspace_id, name, purpose, owner_membership_id, scope, created_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [agentId, input.workspaceId, name, purpose, input.ownerMembershipId, scope, input.actorMembershipId],
  );
  await replaceAccess(tx, agentId, input.sourceAccess);
  return agentId;
}

/**
 * @internal Revoke every live credential for one Agent and issue exactly one
 * replacement, inside an already-protected transaction.
 */
export async function replaceWorkspaceAgentCredentialInTransaction(
  tx: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  agentId: string,
): Promise<{ credentialId: string; token: string }> {
  const owned = await tx.executeRaw(
    'SELECT agent_id FROM workspace_agents WHERE workspace_id=$1 AND agent_id=$2',
    [workspaceId, agentId],
  );
  if (!owned[0]) throw new WorkspaceAgentError('agent_not_found');
  await tx.executeRaw('UPDATE workspace_agent_credentials SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL', [agentId]);
  return issueCredential(tx, agentId);
}

/**
 * @internal Apply one Agent's Scope and Source Access inside an already-protected
 * transaction, using exactly the generic validation rules. It deliberately skips
 * {@link assertAgentIsNotRuntimeBound}: it is the seam the synchronized bound-Agent
 * grant builds on, and it never emits its own audit evidence.
 */
export async function applyWorkspaceAgentGrantInTransaction(
  tx: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  agentId: string,
  scope: WorkspaceAgentScope,
  sourceAccess: PrincipalSourceAccess,
): Promise<void> {
  validateScope(scope);
  validateAccess(sourceAccess);
  await requireAgent(tx, workspaceId, agentId);
  await tx.executeRaw(
    'UPDATE workspace_agents SET scope=$3, updated_at=now() WHERE workspace_id=$1 AND agent_id=$2',
    [workspaceId, agentId, scope],
  );
  await replaceAccess(tx, agentId, sourceAccess);
}

export async function registerWorkspaceAgent(engine: AgentEngine, input: {
  workspaceId: string;
  name: string;
  purpose: string;
  ownerMembershipId: string;
  scope?: WorkspaceAgentScope;
  sourceAccess?: PrincipalSourceAccess;
  actorMembershipId: string;
  requestId: string;
}): Promise<{ agentId: string; credential: { credentialId: string; token: string } }> {
  const name = validateName(input.name);
  const purpose = validatePurpose(input.purpose);
  const scope = validateScope(input.scope ?? 'read');
  const sourceAccess = input.sourceAccess ?? { mode: 'none' as const };
  validateAccess(sourceAccess);
  const agentId = randomUUID();
  const credential = await runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId }, action: 'agent.register',
    target: { type: 'agent', id: agentId }, requestId: input.requestId,
    before: null, after: { name, scope, sourceAccess: sourceAccess.mode, owner: input.ownerMembershipId },
  }, async tx => {
    await createWorkspaceAgentInTransaction(tx, {
      workspaceId: input.workspaceId, name, purpose, ownerMembershipId: input.ownerMembershipId,
      scope, sourceAccess, actorMembershipId: input.actorMembershipId, agentId,
    });
    return replaceWorkspaceAgentCredentialInTransaction(tx, input.workspaceId, agentId);
  });
  return { agentId, credential };
}

export interface WorkspaceAgentDirectoryEntry {
  agentId: string;
  name: string;
  purpose: string;
  owner: { membershipId: string; email: string };
  status: WorkspaceAgentStatus;
  scope: WorkspaceAgentScope;
  sourceAccess: { mode: PrincipalSourceAccess['mode']; sourceIds: string[] };
  lastActivityAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

async function directoryEntries(
  engine: Pick<BrainEngine, 'executeRaw'>, workspaceId: string, agentId?: string,
): Promise<WorkspaceAgentDirectoryEntry[]> {
  const rows = await engine.executeRaw<{
    agent_id: string; name: string; purpose: string; owner_membership_id: string; normalized_email: string;
    status: WorkspaceAgentStatus; scope: WorkspaceAgentScope; access_mode: PrincipalSourceAccess['mode'];
    last_activity_at: string | null; created_at: string; revoked_at: string | null;
  }>(
    `SELECT a.agent_id, a.name, a.purpose, a.owner_membership_id, i.normalized_email,
            a.status, a.scope, COALESCE(p.access_mode, 'none') access_mode,
            (SELECT max(c.last_used_at) FROM workspace_agent_credentials c WHERE c.agent_id=a.agent_id) last_activity_at,
            a.created_at, a.revoked_at
       FROM workspace_agents a
       JOIN workspace_memberships m ON m.membership_id=a.owner_membership_id
       JOIN workspace_identities i ON i.identity_id=m.identity_id
       LEFT JOIN workspace_principal_source_policies p ON p.principal_kind='agent' AND p.principal_id=a.agent_id
      WHERE a.workspace_id=$1 ${agentId === undefined ? '' : 'AND a.agent_id=$2'}
      ORDER BY a.name, a.agent_id`,
    agentId === undefined ? [workspaceId] : [workspaceId, agentId],
  );
  return Promise.all(rows.map(async row => {
    const grants = row.access_mode === 'specific'
      ? await engine.executeRaw<{ source_id: string }>("SELECT source_id FROM workspace_source_grants WHERE principal_kind='agent' AND principal_id=$1 ORDER BY source_id", [row.agent_id])
      : [];
    return {
      agentId: row.agent_id,
      name: row.name,
      purpose: row.purpose,
      owner: { membershipId: row.owner_membership_id, email: row.normalized_email },
      status: row.status,
      scope: row.scope,
      sourceAccess: { mode: row.access_mode, sourceIds: grants.map(grant => grant.source_id) },
      lastActivityAt: row.last_activity_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }));
}

/** Organization-visible Directory: identity and authorization summary, never secrets. */
export async function listWorkspaceAgents(engine: Pick<BrainEngine, 'executeRaw'>, workspaceId: string): Promise<WorkspaceAgentDirectoryEntry[]> {
  return directoryEntries(engine, workspaceId);
}

export interface WorkspaceAgentDetail extends WorkspaceAgentDirectoryEntry {
  credentials: { credentialId: string; type: 'api_key'; createdAt: string; revokedAt: string | null; lastUsedAt: string | null }[];
}

export async function getWorkspaceAgent(engine: Pick<BrainEngine, 'executeRaw'>, workspaceId: string, agentId: string): Promise<WorkspaceAgentDetail> {
  const entries = await directoryEntries(engine, workspaceId, agentId);
  const entry = entries[0];
  if (!entry) throw new WorkspaceAgentError('agent_not_found');
  const credentials = await engine.executeRaw<{ credential_id: string; credential_type: 'api_key'; created_at: string; revoked_at: string | null; last_used_at: string | null }>(
    'SELECT credential_id, credential_type, created_at, revoked_at, last_used_at FROM workspace_agent_credentials WHERE agent_id=$1 ORDER BY created_at, credential_id',
    [agentId],
  );
  return {
    ...entry,
    credentials: credentials.map(credential => ({
      credentialId: credential.credential_id,
      type: credential.credential_type,
      createdAt: credential.created_at,
      revokedAt: credential.revoked_at,
      lastUsedAt: credential.last_used_at,
    })),
  };
}

export async function setWorkspaceAgentOwner(engine: AgentEngine, workspaceId: string, agentId: string, ownerMembershipId: string, actorMembershipId: string, requestId: string, reason: string) {
  return runProtectedWorkspaceMutation(engine, { actor: { kind: 'member', id: actorMembershipId }, action: 'agent.owner.change', target: { type: 'agent', id: agentId }, requestId, reason, after: { owner: ownerMembershipId } }, async tx => {
    await requireAgent(tx, workspaceId, agentId);
    await assertAgentIsNotRuntimeBound(tx, workspaceId, agentId);
    await requireOwnerMembership(tx, workspaceId, ownerMembershipId);
    await tx.executeRaw('UPDATE workspace_agents SET owner_membership_id=$3, updated_at=now() WHERE workspace_id=$1 AND agent_id=$2', [workspaceId, agentId, ownerMembershipId]);
  });
}

export async function setWorkspaceAgentPurpose(engine: AgentEngine, workspaceId: string, agentId: string, purpose: string, actorMembershipId: string, requestId: string, reason: string) {
  const normalized = validatePurpose(purpose);
  return runProtectedWorkspaceMutation(engine, { actor: { kind: 'member', id: actorMembershipId }, action: 'agent.purpose.change', target: { type: 'agent', id: agentId }, requestId, reason, after: { purpose: normalized } }, async tx => {
    await requireAgent(tx, workspaceId, agentId);
    await assertAgentIsNotRuntimeBound(tx, workspaceId, agentId);
    await tx.executeRaw('UPDATE workspace_agents SET purpose=$3, updated_at=now() WHERE workspace_id=$1 AND agent_id=$2', [workspaceId, agentId, normalized]);
  });
}

export async function setWorkspaceAgentScope(engine: AgentEngine, workspaceId: string, agentId: string, scope: WorkspaceAgentScope, actorMembershipId: string, requestId: string, reason: string) {
  validateScope(scope);
  return runProtectedWorkspaceMutation(engine, { actor: { kind: 'member', id: actorMembershipId }, action: 'agent.scope.change', target: { type: 'agent', id: agentId }, requestId, reason, after: { scope } }, async tx => {
    const before = await requireAgent(tx, workspaceId, agentId);
    await assertAgentIsNotRuntimeBound(tx, workspaceId, agentId);
    await tx.executeRaw('UPDATE workspace_agents SET scope=$3, updated_at=now() WHERE workspace_id=$1 AND agent_id=$2', [workspaceId, agentId, scope]);
    return before;
  });
}

export async function setWorkspaceAgentSourceAccess(engine: AgentEngine, workspaceId: string, agentId: string, access: PrincipalSourceAccess, actorMembershipId: string, requestId: string, reason: string) {
  return runProtectedWorkspaceMutation(engine, { actor: { kind: 'member', id: actorMembershipId }, action: 'agent.source_access.change', target: { type: 'agent', id: agentId }, requestId, reason, after: { sourceAccess: access.mode } }, async tx => {
    await requireAgent(tx, workspaceId, agentId);
    await assertAgentIsNotRuntimeBound(tx, workspaceId, agentId);
    await replaceAccess(tx, agentId, access);
  });
}

export async function setWorkspaceAgentStatus(engine: AgentEngine, workspaceId: string, agentId: string, status: WorkspaceAgentStatus, actorMembershipId: string, requestId: string, reason: string) {
  if (status !== 'active' && status !== 'revoked') throw new WorkspaceAgentError('invalid_agent_status');
  return runProtectedWorkspaceMutation(engine, { actor: { kind: 'member', id: actorMembershipId }, action: 'agent.status.change', target: { type: 'agent', id: agentId }, requestId, reason, after: { status } }, async tx => {
    await requireAgent(tx, workspaceId, agentId);
    await assertAgentIsNotRuntimeBound(tx, workspaceId, agentId);
    await tx.executeRaw(
      "UPDATE workspace_agents SET status=$3, revoked_at=CASE WHEN $3='revoked' THEN now() ELSE NULL END, updated_at=now() WHERE workspace_id=$1 AND agent_id=$2",
      [workspaceId, agentId, status],
    );
    // A revoked Agent must stop authenticating immediately; identity and
    // history remain durable while its credentials fail closed.
    if (status === 'revoked') {
      await tx.executeRaw('UPDATE workspace_agent_credentials SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL', [agentId]);
    }
  });
}

export async function rotateWorkspaceAgentCredential(engine: AgentEngine, workspaceId: string, agentId: string, actorMembershipId: string, requestId: string, reason: string): Promise<{ credentialId: string; token: string }> {
  return runProtectedWorkspaceMutation(engine, { actor: { kind: 'member', id: actorMembershipId }, action: 'credential.rotate', target: { type: 'agent', id: agentId }, requestId, reason, after: { credential: 'rotated' } }, async tx => {
    const agent = await requireAgent(tx, workspaceId, agentId);
    await assertAgentIsNotRuntimeBound(tx, workspaceId, agentId);
    if (agent.status === 'revoked') throw new WorkspaceAgentError('agent_revoked');
    return replaceWorkspaceAgentCredentialInTransaction(tx, workspaceId, agentId);
  });
}

export async function revokeWorkspaceAgentCredential(engine: AgentEngine, workspaceId: string, agentId: string, credentialId: string, actorMembershipId: string, requestId: string, reason: string) {
  return runProtectedWorkspaceMutation(engine, { actor: { kind: 'member', id: actorMembershipId }, action: 'credential.revoke', target: { type: 'agent', id: agentId }, requestId, reason, after: { credential: credentialId } }, async tx => {
    await requireAgent(tx, workspaceId, agentId);
    await assertAgentIsNotRuntimeBound(tx, workspaceId, agentId);
    const rows = await tx.executeRaw(
      'UPDATE workspace_agent_credentials SET revoked_at=now() WHERE agent_id=$1 AND credential_id=$2 AND revoked_at IS NULL RETURNING credential_id',
      [agentId, credentialId],
    );
    if (!rows[0]) throw new WorkspaceAgentError('credential_not_found');
  });
}

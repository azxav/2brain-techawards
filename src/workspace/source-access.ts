import type { BrainEngine } from '../core/engine.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { isUndefinedTableError } from '../core/utils.ts';

type SourceAccessEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;

export type SourceAccessPrincipal = {
  kind: 'member' | 'agent';
  id: string;
};

export type PrincipalSourceAccess =
  | { mode: 'all' }
  | { mode: 'specific'; sourceIds: readonly string[] }
  | { mode: 'none' };

export type SourceAccessCaller = {
  remote: boolean;
  principal?: SourceAccessPrincipal;
  /** Explicit credential grant used only when no canonical policy exists. */
  credentialSourceIds?: readonly string[];
};

export type EffectiveSourceAccess =
  | { kind: 'unrestricted_trusted_local' }
  | { kind: 'sources'; sourceIds: string[] };

/**
 * Operation-dispatch resolver. A canonical policy takes precedence; a caller
 * without one receives only its explicit validated credential grant. Missing
 * or malformed remote identity/grant state resolves to zero Sources.
 */
export async function resolveOperationSourceAccess(
  engine: Pick<BrainEngine, 'executeRaw'>,
  caller: SourceAccessCaller,
): Promise<EffectiveSourceAccess> {
  if (caller.remote === false) return { kind: 'unrestricted_trusted_local' };
  if (!isValidPrincipal(caller.principal)) return { kind: 'sources', sourceIds: [] };

  let policies: { access_mode: string }[];
  try {
    policies = await engine.executeRaw<{ access_mode: string }>(
      `SELECT access_mode FROM workspace_principal_source_policies
        WHERE principal_kind = $1 AND principal_id = $2`,
      [caller.principal.kind, caller.principal.id],
    );
  } catch (error) {
    if (isUndefinedTableError(error)) return resolveCredentialSourceAccess(caller.credentialSourceIds);
    throw error;
  }
  if (policies.length === 0) {
    return resolveCredentialSourceAccess(caller.credentialSourceIds);
  }

  const sources = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources ORDER BY id`,
  );
  return resolvePersistedSourceAccess(
    engine,
    caller.principal,
    policies[0]!.access_mode,
    sources.map(source => source.id),
  );
}

function isValidPrincipal(principal: SourceAccessPrincipal | undefined): principal is SourceAccessPrincipal {
  return principal !== undefined
    && (principal.kind === 'member' || principal.kind === 'agent')
    && typeof principal.id === 'string'
    && principal.id.length > 0;
}

function canonicalSourceIds(sourceIds: readonly string[]): string[] {
  return [...new Set(sourceIds)].sort();
}

function resolveCredentialSourceAccess(sourceIds: readonly string[] | undefined): EffectiveSourceAccess {
  if (!sourceIds || sourceIds.some(sourceId => !isValidSourceId(sourceId))) {
    return { kind: 'sources', sourceIds: [] };
  }
  return { kind: 'sources', sourceIds: canonicalSourceIds(sourceIds) };
}

/**
 * Replace one principal's Source Access atomically. Workspace role and Agent
 * Scope are intentionally absent: neither dimension can widen this policy.
 */
export async function setPrincipalSourceAccess(
  engine: SourceAccessEngine,
  principal: SourceAccessPrincipal,
  access: PrincipalSourceAccess,
): Promise<void> {
  if (!isValidPrincipal(principal)) throw new Error('invalid_source_access_principal');
  const sourceIds = access.mode === 'specific' ? canonicalSourceIds(access.sourceIds) : [];
  if (sourceIds.some(sourceId => !isValidSourceId(sourceId))) {
    throw new Error('invalid_source_access_grant');
  }

  await engine.transaction(async tx => {
    await replacePrincipalSourceAccessInTransaction(tx, principal, access.mode, sourceIds);
  });
}

/**
 * Transaction-scoped variant for callers that must replace a policy inside a
 * larger protected mutation. The caller validates the grant before entry.
 */
export async function replacePrincipalSourceAccessInTransaction(
  tx: Pick<BrainEngine, 'executeRaw'>,
  principal: SourceAccessPrincipal,
  mode: PrincipalSourceAccess['mode'],
  sourceIds: readonly string[],
): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO workspace_principal_source_policies
       (principal_kind, principal_id, access_mode)
     VALUES ($1, $2, $3)
     ON CONFLICT (principal_kind, principal_id) DO UPDATE
       SET access_mode = EXCLUDED.access_mode, updated_at = now()`,
    [principal.kind, principal.id, mode],
  );
  await tx.executeRaw(
    `DELETE FROM workspace_source_grants
      WHERE principal_kind = $1 AND principal_id = $2`,
    [principal.kind, principal.id],
  );
  for (const sourceId of sourceIds) {
    await tx.executeRaw(
      `INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id)
       VALUES ($1, $2, $3)`,
      [principal.kind, principal.id, sourceId],
    );
  }
}

/**
 * Resolve access without inventing a Source. Only an explicitly trusted local
 * caller is unrestricted; every remote failure mode returns an explicit empty
 * Source set.
 */
export async function resolvePrincipalSourceAccess(
  engine: Pick<BrainEngine, 'executeRaw'>,
  caller: SourceAccessCaller,
  currentSourceIds: readonly string[],
): Promise<EffectiveSourceAccess> {
  if (caller.remote === false) return { kind: 'unrestricted_trusted_local' };
  if (!isValidPrincipal(caller.principal)) return { kind: 'sources', sourceIds: [] };

  const policies = await engine.executeRaw<{ access_mode: string }>(
    `SELECT access_mode FROM workspace_principal_source_policies
      WHERE principal_kind = $1 AND principal_id = $2`,
    [caller.principal.kind, caller.principal.id],
  );
  return resolvePersistedSourceAccess(engine, caller.principal, policies[0]?.access_mode, currentSourceIds);
}

async function resolvePersistedSourceAccess(
  engine: Pick<BrainEngine, 'executeRaw'>,
  principal: SourceAccessPrincipal,
  mode: string | undefined,
  currentSourceIds: readonly string[],
): Promise<EffectiveSourceAccess> {
  if (mode === 'all') {
    return { kind: 'sources', sourceIds: canonicalSourceIds(currentSourceIds.filter(isValidSourceId)) };
  }
  if (mode !== 'specific') return { kind: 'sources', sourceIds: [] };

  const grants = await engine.executeRaw<{ source_id: string }>(
    `SELECT source_id FROM workspace_source_grants
      WHERE principal_kind = $1 AND principal_id = $2
      ORDER BY source_id`,
    [principal.kind, principal.id],
  );
  if (grants.some(grant => !isValidSourceId(grant.source_id))) {
    return { kind: 'sources', sourceIds: [] };
  }
  const current = new Set(currentSourceIds.filter(isValidSourceId));
  return {
    kind: 'sources',
    sourceIds: grants.map(grant => grant.source_id).filter(sourceId => current.has(sourceId)),
  };
}

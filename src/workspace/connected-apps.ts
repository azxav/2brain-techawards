import type { BrainEngine } from '../core/engine.ts';
import { hasScope } from '../core/scope.ts';
import type { WorkspaceMembershipRole, WorkspaceMembershipStatus } from './memberships.ts';

type ConnectedAppQueryEngine = Pick<BrainEngine, 'executeRaw'>;
type ConnectedAppMutationEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;

export const CONNECTED_APP_ACCESS_LEVELS = ['read', 'write', 'admin'] as const;

export type ConnectedAppAccessLevel = typeof CONNECTED_APP_ACCESS_LEVELS[number];
export type ConnectedAppEffectiveAccessLevel = ConnectedAppAccessLevel | 'none';
export type ConnectedAppAccessLevelLimiter =
  | 'client_scope'
  | 'membership_role'
  | 'membership_status';
export type ConnectedAppLimitingReason =
  | 'configured_access_level'
  | 'client_scope'
  | 'membership_role'
  | 'membership_status'
  | 'credential_scope'
  | 'invalid_policy';

const ACCESS_RANK: Record<ConnectedAppEffectiveAccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

export class ConnectedAppNotFoundError extends Error {
  constructor() {
    super('Connected App was not found.');
    this.name = 'ConnectedAppNotFoundError';
  }
}

export class InvalidConnectedAppAccessLevelError extends Error {
  constructor() {
    super('Connected App access level is invalid.');
    this.name = 'InvalidConnectedAppAccessLevelError';
  }
}

export class ConnectedAppAccessDeniedError extends Error {
  constructor() {
    super('Connected App access level is not available.');
    this.name = 'ConnectedAppAccessDeniedError';
  }
}

export function isConnectedAppAccessLevel(value: unknown): value is ConnectedAppAccessLevel {
  return typeof value === 'string' && CONNECTED_APP_ACCESS_LEVELS.includes(value as ConnectedAppAccessLevel);
}

export function connectedAppAccessLevelFromScopes(
  scopes: readonly string[] | null | undefined,
): ConnectedAppEffectiveAccessLevel {
  if (!scopes || scopes.length === 0) return 'none';
  if (hasScope(scopes, 'admin')) return 'admin';
  if (hasScope(scopes, 'write')) return 'write';
  if (hasScope(scopes, 'read')) return 'read';
  return 'none';
}

export function connectedAppScopesForAccessLevel(level: ConnectedAppAccessLevel): ConnectedAppAccessLevel[] {
  return [level];
}

function roleCeiling(role: WorkspaceMembershipRole): ConnectedAppAccessLevel {
  return role === 'administrator' ? 'admin' : 'write';
}

type ConnectedAppAvailabilityInput = {
  clientScopes: readonly string[];
  membershipRole: WorkspaceMembershipRole;
  membershipStatus: WorkspaceMembershipStatus;
};

export function connectedAppAccessLevelLimiters(
  input: ConnectedAppAvailabilityInput,
  requestedLevel: ConnectedAppAccessLevel,
): ConnectedAppAccessLevelLimiter[] {
  if (input.membershipStatus !== 'active') return ['membership_status'];
  const requestedRank = ACCESS_RANK[requestedLevel];
  const reasons: ConnectedAppAccessLevelLimiter[] = [];
  if (requestedRank > ACCESS_RANK[connectedAppAccessLevelFromScopes(input.clientScopes)]) {
    reasons.push('client_scope');
  }
  if (requestedRank > ACCESS_RANK[roleCeiling(input.membershipRole)]) {
    reasons.push('membership_role');
  }
  return reasons;
}

function lowestLevel(
  candidates: Array<{ level: ConnectedAppEffectiveAccessLevel; reason: ConnectedAppLimitingReason }>,
): { effectiveAccessLevel: ConnectedAppEffectiveAccessLevel; limitingReason: ConnectedAppLimitingReason } {
  let lowest = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (ACCESS_RANK[candidate.level] < ACCESS_RANK[lowest.level]) lowest = candidate;
  }
  return { effectiveAccessLevel: lowest.level, limitingReason: lowest.reason };
}

export function resolveConnectedAppAccess(input: {
  configuredAccessLevel: unknown;
  clientScopes: readonly string[] | null | undefined;
  membershipRole: WorkspaceMembershipRole;
  membershipStatus: WorkspaceMembershipStatus;
  credentialScopes?: readonly string[] | null;
}): { effectiveAccessLevel: ConnectedAppEffectiveAccessLevel; limitingReason: ConnectedAppLimitingReason } {
  if (!isConnectedAppAccessLevel(input.configuredAccessLevel)) {
    return { effectiveAccessLevel: 'none', limitingReason: 'invalid_policy' };
  }
  if (input.membershipStatus !== 'active') {
    return { effectiveAccessLevel: 'none', limitingReason: 'membership_status' };
  }

  const candidates: Array<{
    level: ConnectedAppEffectiveAccessLevel;
    reason: ConnectedAppLimitingReason;
  }> = [
    { level: input.configuredAccessLevel, reason: 'configured_access_level' },
    { level: connectedAppAccessLevelFromScopes(input.clientScopes), reason: 'client_scope' },
    { level: roleCeiling(input.membershipRole), reason: 'membership_role' },
  ];
  if (input.credentialScopes !== undefined) {
    candidates.push({
      level: connectedAppAccessLevelFromScopes(input.credentialScopes),
      reason: 'credential_scope',
    });
  }
  return lowestLevel(candidates);
}

export function availableConnectedAppAccessLevels(
  input: ConnectedAppAvailabilityInput,
): ConnectedAppAccessLevel[] {
  return CONNECTED_APP_ACCESS_LEVELS.filter(
    level => connectedAppAccessLevelLimiters(input, level).length === 0,
  );
}

interface ConnectedAppRow {
  membership_id: string;
  member_email: string;
  membership_role: WorkspaceMembershipRole;
  membership_status: WorkspaceMembershipStatus;
  client_id: string;
  client_name: string;
  client_scope: string | null;
  configured_access_level: string;
  connected_at: Date | string;
  updated_at: Date | string;
}

export interface ConnectedAppProjection {
  membershipId: string;
  memberEmail?: string;
  clientId: string;
  clientName: string;
  connectedAt: Date;
  updatedAt: Date;
  configuredAccessLevel: ConnectedAppAccessLevel;
  effectiveAccessLevel: ConnectedAppEffectiveAccessLevel;
  limitingReason: ConnectedAppLimitingReason;
  availableAccessLevels: ConnectedAppAccessLevel[];
  unavailableAccessLevelReasons: Partial<
    Record<ConnectedAppAccessLevel, ConnectedAppAccessLevelLimiter[]>
  >;
}

function splitScopes(scope: string | null): string[] {
  return scope?.split(/\s+/).filter(Boolean) ?? [];
}

function projectConnectedApp(row: ConnectedAppRow, includeMemberIdentity: boolean): ConnectedAppProjection {
  const clientScopes = splitScopes(row.client_scope);
  const resolved = resolveConnectedAppAccess({
    configuredAccessLevel: row.configured_access_level,
    clientScopes,
    membershipRole: row.membership_role,
    membershipStatus: row.membership_status,
  });
  const configuredAccessLevel = isConnectedAppAccessLevel(row.configured_access_level)
    ? row.configured_access_level
    : 'read';
  const availabilityInput = {
    clientScopes,
    membershipRole: row.membership_role,
    membershipStatus: row.membership_status,
  };
  const unavailableAccessLevelReasons = Object.fromEntries(
    CONNECTED_APP_ACCESS_LEVELS
      .map(level => [level, connectedAppAccessLevelLimiters(availabilityInput, level)] as const)
      .filter(([, reasons]) => reasons.length > 0),
  ) as ConnectedAppProjection['unavailableAccessLevelReasons'];
  return {
    membershipId: row.membership_id,
    ...(includeMemberIdentity ? { memberEmail: row.member_email } : {}),
    clientId: row.client_id,
    clientName: row.client_name,
    connectedAt: new Date(row.connected_at),
    updatedAt: new Date(row.updated_at),
    configuredAccessLevel,
    effectiveAccessLevel: resolved.effectiveAccessLevel,
    limitingReason: resolved.limitingReason,
    availableAccessLevels: availableConnectedAppAccessLevels(availabilityInput),
    unavailableAccessLevelReasons,
  };
}

async function loadConnectedApp(
  engine: ConnectedAppQueryEngine,
  membershipId: string,
  clientId: string,
  forUpdate = false,
): Promise<ConnectedAppRow | undefined> {
  const rows = await engine.executeRaw<ConnectedAppRow>(`
    SELECT p.membership_id,
           i.normalized_email AS member_email,
           m.role AS membership_role,
           m.status AS membership_status,
           c.client_id,
           c.client_name,
           c.scope AS client_scope,
           p.configured_access_level,
           p.connected_at,
           p.updated_at
    FROM workspace_connected_app_policies p
    JOIN oauth_clients c ON c.client_id = p.client_id AND c.deleted_at IS NULL
    JOIN workspace_memberships m ON m.membership_id = p.membership_id
    JOIN workspace_identities i ON i.identity_id = m.identity_id
    WHERE p.membership_id = $1 AND p.client_id = $2
    ${forUpdate ? 'FOR UPDATE OF p' : ''}
  `, [membershipId, clientId]);
  return rows[0];
}

export async function listConnectedApps(
  engine: ConnectedAppQueryEngine,
  actor: { membershipId: string; role: WorkspaceMembershipRole },
): Promise<ConnectedAppProjection[]> {
  const administrator = actor.role === 'administrator';
  const rows = await engine.executeRaw<ConnectedAppRow>(`
    SELECT p.membership_id,
           i.normalized_email AS member_email,
           m.role AS membership_role,
           m.status AS membership_status,
           c.client_id,
           c.client_name,
           c.scope AS client_scope,
           p.configured_access_level,
           p.connected_at,
           p.updated_at
    FROM workspace_connected_app_policies p
    JOIN oauth_clients c ON c.client_id = p.client_id AND c.deleted_at IS NULL
    JOIN workspace_memberships m ON m.membership_id = p.membership_id
    JOIN workspace_identities i ON i.identity_id = m.identity_id
    WHERE ($1::boolean OR p.membership_id = $2)
    ORDER BY i.normalized_email, lower(c.client_name), c.client_id
  `, [administrator, actor.membershipId]);
  return rows.map(row => projectConnectedApp(row, administrator));
}

export async function changeConnectedAppAccess(
  engine: ConnectedAppMutationEngine,
  input: { membershipId: string; clientId: string; accessLevel: unknown },
): Promise<ConnectedAppProjection> {
  return engine.transaction(async transaction => {
    const result = await changeConnectedAppAccessInTransaction(transaction, input);
    return result.after;
  });
}

export async function changeConnectedAppAccessInTransaction(
  engine: ConnectedAppQueryEngine,
  input: { membershipId: string; clientId: string; accessLevel: unknown },
): Promise<{ before: ConnectedAppProjection; after: ConnectedAppProjection }> {
  if (!isConnectedAppAccessLevel(input.accessLevel)) throw new InvalidConnectedAppAccessLevelError();
  const current = await loadConnectedApp(engine, input.membershipId, input.clientId, true);
  if (!current) throw new ConnectedAppNotFoundError();
  const available = availableConnectedAppAccessLevels({
    clientScopes: splitScopes(current.client_scope),
    membershipRole: current.membership_role,
    membershipStatus: current.membership_status,
  });
  if (!available.includes(input.accessLevel)) throw new ConnectedAppAccessDeniedError();
  const before = projectConnectedApp(current, true);
  await engine.executeRaw(`UPDATE workspace_connected_app_policies
    SET configured_access_level = $3, updated_at = now()
    WHERE membership_id = $1 AND client_id = $2`, [input.membershipId, input.clientId, input.accessLevel]);
  const changed = await loadConnectedApp(engine, input.membershipId, input.clientId);
  if (!changed) throw new ConnectedAppNotFoundError();
  return { before, after: projectConnectedApp(changed, true) };
}

export async function revokeConnectedApp(
  engine: ConnectedAppMutationEngine,
  input: { membershipId: string; clientId: string },
): Promise<void> {
  await engine.transaction(async transaction => {
    await revokeConnectedAppInTransaction(transaction, input);
  });
}

export async function revokeConnectedAppInTransaction(
  engine: ConnectedAppQueryEngine,
  input: { membershipId: string; clientId: string },
): Promise<ConnectedAppProjection> {
  const current = await loadConnectedApp(engine, input.membershipId, input.clientId, true);
  if (!current) throw new ConnectedAppNotFoundError();
  const before = projectConnectedApp(current, true);
  await engine.executeRaw(`DELETE FROM oauth_tokens
    WHERE membership_id = $1 AND client_id = $2`, [input.membershipId, input.clientId]);
  await engine.executeRaw(`DELETE FROM oauth_codes
    WHERE membership_id = $1 AND client_id = $2`, [input.membershipId, input.clientId]);
  await engine.executeRaw(`DELETE FROM workspace_connected_app_policies
    WHERE membership_id = $1 AND client_id = $2`, [input.membershipId, input.clientId]);
  return before;
}

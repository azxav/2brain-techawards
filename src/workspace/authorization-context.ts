import type { AuthInfo } from '../core/operations.ts';
import { isValidSourceId } from '../core/source-id.ts';
import type { EffectiveSourceAccess, SourceAccessPrincipal } from './source-access.ts';

export interface RemoteAuthorizationContext {
  readonly principal: SourceAccessPrincipal;
  readonly capabilities: readonly string[];
  readonly sourceAccess: Extract<EffectiveSourceAccess, { kind: 'sources' }>;
  readonly resolvePrincipalPolicy: boolean;
  readonly writeSourceId?: string;
  readonly auth?: AuthInfo;
}

function canonicalCredentialSources(auth: Pick<AuthInfo, 'sourceId' | 'allowedSources'>): string[] {
  const allowedSources = auth.allowedSources;
  if (allowedSources !== undefined) {
    if (!Array.isArray(allowedSources) || allowedSources.some(sourceId => !isValidSourceId(sourceId))) {
      return [];
    }
    return [...new Set(allowedSources)].sort();
  }
  return isValidSourceId(auth.sourceId) ? [auth.sourceId] : [];
}

/** Build the single remote authorization contract shared by OAuth and legacy credentials. */
export function authorizationFromAuthInfo(auth: AuthInfo): RemoteAuthorizationContext {
  // #47: a member-bound token (session-gated consent) acts AS the consenting
  // Member. The principal switches to that Member so operation dispatch
  // resolves the Member's CURRENT Source Access policy per request; the
  // credential itself carries no Source grant of its own (fail-closed when
  // the Member has no policy).
  if (auth.membershipId) {
    return {
      principal: { kind: 'member', id: auth.membershipId },
      capabilities: [...auth.scopes],
      sourceAccess: { kind: 'sources', sourceIds: [] },
      resolvePrincipalPolicy: true,
      auth,
    };
  }
  const sourceIds = canonicalCredentialSources(auth);
  return {
    principal: { kind: 'agent', id: auth.clientId },
    capabilities: [...auth.scopes],
    sourceAccess: { kind: 'sources', sourceIds },
    resolvePrincipalPolicy: true,
    ...(isValidSourceId(auth.sourceId) && sourceIds.includes(auth.sourceId)
      ? { writeSourceId: auth.sourceId }
      : {}),
    auth,
  };
}

/** Build the same contract for authenticated Workspace HTTP requests. */
export function workspaceMemberAuthorization(member: {
  membership_id: string;
  role: string;
}): RemoteAuthorizationContext {
  return {
    principal: { kind: 'member', id: member.membership_id },
    capabilities: member.role === 'administrator' ? ['admin'] : member.role === 'member' ? ['read'] : [],
    sourceAccess: { kind: 'sources', sourceIds: [] },
    resolvePrincipalPolicy: true,
  };
}

/** Explicitly ungranted stdio MCP identity: read capability, zero Source Access. */
export function ungrantedMcpAuthorization(): RemoteAuthorizationContext {
  return {
    principal: { kind: 'agent', id: 'stdio-mcp' },
    capabilities: ['read'],
    sourceAccess: { kind: 'sources', sourceIds: [] },
    resolvePrincipalPolicy: false,
  };
}

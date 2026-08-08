/**
 * Session-gated OAuth authorization (issue #47).
 *
 * Intercepts GET/POST /authorize AHEAD of the MCP SDK's mcpAuthRouter so no
 * authorization code is ever minted without an authenticated Workspace
 * Member's consent. The gate is unconditional wherever this router is
 * mounted — there is no issuance mode that skips the Member, hosted or
 * self-hosted.
 *
 * Flow:
 *   1. GET/POST /authorize — validate the Connector Client and redirect_uri.
 *      No signed-in Workspace Session → 303 /login. Signed in → render a
 *      consent page naming the Connector Client.
 *   2. POST /authorize/decision — same-origin form post carrying the original
 *      authorization parameters. Approval mints a Member-bound authorization
 *      code via `provider.authorizeWithMember` and 302s back to the client;
 *      denial redirects with `error=access_denied`.
 *
 * Cross-site request forgery posture: the `workspace_session` cookie is
 * `SameSite=Lax` (cross-site POSTs never carry it) and the decision endpoint
 * additionally refuses mismatched Origin headers — the same two-layer pattern
 * the Workspace mutation routes use.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import type { BrainEngine } from '../core/engine.ts';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { GBrainOAuthProvider } from '../core/oauth-provider.ts';
import { authenticateWorkspaceSession } from '../workspace/auth.ts';
import { parseScopeString, hasScope } from '../core/scope.ts';
import { escapeHtml } from './workspace-shell.ts';
import { cookie, envInt } from './request-helpers.ts';
import {
  CONNECTED_APP_ACCESS_LEVELS,
  availableConnectedAppAccessLevels,
  connectedAppAccessLevelLimiters,
  isConnectedAppAccessLevel,
  type ConnectedAppAccessLevel,
  type ConnectedAppAccessLevelLimiter,
} from '../workspace/connected-apps.ts';

type ConsentEngine = Pick<BrainEngine, 'executeRaw'>;

export interface OauthConsentRouterOptions {
  /** Per-IP protection for the authorization surface. Defaults mirror the Workspace auth endpoints. */
  authRateLimit?: { windowMs?: number; limit?: number };
  /** Expected Origin for the consent decision post. Defaults to the request's own origin. */
  allowedOrigin?: string;
}

interface AuthorizeRequestParams {
  clientId?: string;
  redirectUri?: string;
  responseType?: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return undefined;
}

function readParams(source: Record<string, unknown>): AuthorizeRequestParams {
  return {
    clientId: firstString(source.client_id),
    redirectUri: firstString(source.redirect_uri),
    responseType: firstString(source.response_type),
    scope: firstString(source.scope),
    state: firstString(source.state),
    codeChallenge: firstString(source.code_challenge),
    codeChallengeMethod: firstString(source.code_challenge_method),
    resource: firstString(source.resource),
  };
}

function errorRedirect(redirectUri: string, error: string, state: string | undefined, description?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Resolve and validate the Connector Client + redirect_uri. Client or
 * redirect_uri problems must NEVER redirect (open-redirect risk) — they
 * return a `badRequest` string rendered as 400 instead.
 */
async function resolveClient(
  provider: GBrainOAuthProvider,
  params: AuthorizeRequestParams,
): Promise<{ client: OAuthClientInformationFull; redirectUri: string } | { badRequest: string }> {
  if (!params.clientId) return { badRequest: 'client_id is required' };
  const client = await provider.clientsStore.getClient(params.clientId);
  if (!client) return { badRequest: 'Unknown client' };
  const registered = client.redirect_uris?.map(String) ?? [];
  if (params.redirectUri) {
    if (!registered.includes(params.redirectUri)) return { badRequest: 'redirect_uri is not registered for this client' };
    return { client, redirectUri: params.redirectUri };
  }
  if (registered.length === 1) return { client, redirectUri: registered[0]! };
  return { badRequest: 'redirect_uri is required' };
}

/** Scopes the consent page shows and the decision grants: requested ∩ registered, defaulting to the registered set. */
function requestedScopes(client: OAuthClientInformationFull, scope: string | undefined): string[] {
  const allowed = parseScopeString(client.scope);
  const requested = scope ? parseScopeString(scope) : allowed;
  return requested.filter(s => hasScope(allowed, s));
}

function consentPage(input: {
  clientName: string;
  workspaceName: string;
  scopes: string[];
  params: AuthorizeRequestParams;
  redirectUri: string;
  availableAccessLevels: ConnectedAppAccessLevel[];
  unavailableAccessLevelReasons: Partial<
    Record<ConnectedAppAccessLevel, ConnectedAppAccessLevelLimiter[]>
  >;
}): string {
  const hidden = (name: string, value: string | undefined) =>
    value === undefined ? '' : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
  const scopeList = input.scopes.length
    ? `<ul>${input.scopes.map(s => `<li><code>${escapeHtml(s)}</code></li>`).join('')}</ul>`
    : '<p>No scopes requested.</p>';
  const fields = [
    hidden('client_id', input.params.clientId),
    hidden('redirect_uri', input.redirectUri),
    hidden('scope', input.scopes.join(' ')),
    hidden('state', input.params.state),
    hidden('code_challenge', input.params.codeChallenge),
    hidden('code_challenge_method', input.params.codeChallengeMethod ?? 'S256'),
    hidden('resource', input.params.resource),
  ].join('');
  const accessOptions = CONNECTED_APP_ACCESS_LEVELS.map(level => {
    const label = level[0]!.toUpperCase() + level.slice(1);
    const selected = level === 'read' ? ' selected' : '';
    const disabled = input.availableAccessLevels.includes(level) ? '' : ' disabled';
    const explanation = disabled
      ? unavailableAccessLevelCopy(input.unavailableAccessLevelReasons[level] ?? [])
      : '';
    return `<option value="${level}"${selected}${disabled}>${label}${explanation}</option>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ${escapeHtml(input.clientName)} · 2Brain</title><style>
  body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f6f8;color:#16181d}
  main{background:#fff;border:1px solid #dfe2e8;border-radius:12px;padding:32px;max-width:26rem;box-shadow:0 8px 24px rgba(22,24,29,.06)}
  h1{font-size:1.2rem;margin:0 0 8px}
  p{margin:8px 0;line-height:1.5}
  ul{padding-left:1.2rem}
  .actions{display:flex;gap:12px;margin-top:20px}
  button{flex:1;padding:10px 16px;border-radius:8px;border:1px solid #dfe2e8;background:#fff;font-size:1rem;cursor:pointer}
  button[value=approve]{background:#16181d;border-color:#16181d;color:#fff}
  </style></head><body><main>
  <h1>Connect ${escapeHtml(input.clientName)}?</h1>
  <p><strong>${escapeHtml(input.clientName)}</strong> is asking to access the <strong>${escapeHtml(input.workspaceName)}</strong> Workspace as you.</p>
  <p>It will act with your current Source Access — access ends if your membership or grants change, and you can revoke it any time from Settings → Connected apps.</p>
  <p>Requested capabilities:</p>${scopeList}
  <form method="post" action="/authorize/decision">${fields}
  <label for="access-level"><strong>Access level</strong></label>
  <select id="access-level" name="access_level">${accessOptions}</select>
  <div class="actions"><button type="submit" name="decision" value="deny">Deny</button><button type="submit" name="decision" value="approve">Approve</button></div>
  </form></main></body></html>`;
}

function unavailableAccessLevelCopy(reasons: readonly ConnectedAppAccessLevelLimiter[]): string {
  const client = reasons.includes('client_scope');
  const role = reasons.includes('membership_role');
  if (client && role) return ' — unavailable for the Member role and this client registration';
  if (client) return ' — unavailable because of this client registration';
  if (role) return ' — unavailable for the Member role';
  return ' — unavailable because the Membership is inactive';
}

/**
 * Router factory. Mount BEFORE the SDK's mcpAuthRouter — Express dispatches
 * in registration order, so these handlers shadow the SDK's ungated
 * /authorize implementation entirely (they never call `next()` for a
 * matching path).
 */
export function createOauthConsentRouter(
  engine: ConsentEngine,
  provider: GBrainOAuthProvider,
  options: OauthConsentRouterOptions = {},
): express.Router {
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: options.authRateLimit?.windowMs ?? envInt('GBRAIN_WORKSPACE_AUTH_RATE_WINDOW_MS', 15 * 60 * 1000),
    limit: options.authRateLimit?.limit ?? envInt('GBRAIN_WORKSPACE_AUTH_RATE_LIMIT', 20),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'too_many_requests', error_description: 'Rate limit exceeded. Try again later.' });
    },
  });
  const sessionMember = (req: express.Request) =>
    authenticateWorkspaceSession(engine as Parameters<typeof authenticateWorkspaceSession>[0], cookie(req, 'workspace_session'));

  const renderAuthorize = async (req: express.Request, res: express.Response, params: AuthorizeRequestParams) => {
    const resolved = await resolveClient(provider, params);
    if ('badRequest' in resolved) {
      res.status(400).json({ error: 'invalid_request', error_description: resolved.badRequest });
      return;
    }
    const { client, redirectUri } = resolved;
    if (params.responseType !== 'code') {
      res.redirect(errorRedirect(redirectUri, 'unsupported_response_type', params.state));
      return;
    }
    if (!params.codeChallenge) {
      res.redirect(errorRedirect(redirectUri, 'invalid_request', params.state, 'code_challenge is required'));
      return;
    }
    if ((params.codeChallengeMethod ?? 'S256') !== 'S256') {
      res.redirect(errorRedirect(redirectUri, 'invalid_request', params.state, 'Only S256 code_challenge_method is supported'));
      return;
    }
    const member = await sessionMember(req);
    if (!member) {
      // The Member signs in, then restarts the connection from the client.
      // A signed-in retry of the same /authorize URL lands on consent.
      res.redirect(303, '/login');
      return;
    }
    const memberRole: 'administrator' | 'member' | undefined =
      member.role === 'administrator' || member.role === 'member' ? member.role : undefined;
    const availabilityInput = memberRole
      ? {
          clientScopes: parseScopeString(client.scope),
          membershipRole: memberRole,
          membershipStatus: 'active' as const,
        }
      : undefined;
    const availableAccessLevels = availabilityInput
      ? availableConnectedAppAccessLevels(availabilityInput)
      : [];
    const unavailableAccessLevelReasons = Object.fromEntries(
      CONNECTED_APP_ACCESS_LEVELS
        .map(level => [
          level,
          availabilityInput
            ? connectedAppAccessLevelLimiters(availabilityInput, level)
            : ['membership_status'],
        ] as const)
        .filter(([, reasons]) => reasons.length > 0),
    ) as Partial<Record<ConnectedAppAccessLevel, ConnectedAppAccessLevelLimiter[]>>;
    res.status(200).type('html').send(consentPage({
      clientName: client.client_name ?? client.client_id,
      workspaceName: member.name,
      scopes: requestedScopes(client, params.scope),
      params: { ...params, redirectUri },
      redirectUri,
      availableAccessLevels,
      unavailableAccessLevelReasons,
    }));
  };

  router.get('/authorize', limiter, async (req, res, next) => {
    try { await renderAuthorize(req, res, readParams(req.query as Record<string, unknown>)); } catch (err) { next(err); }
  });
  router.post('/authorize', limiter, express.urlencoded({ extended: false }), async (req, res, next) => {
    try { await renderAuthorize(req, res, readParams((req.body ?? {}) as Record<string, unknown>)); } catch (err) { next(err); }
  });

  router.post('/authorize/decision', limiter, express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const origin = req.header('origin');
      const expected = options.allowedOrigin ?? `${req.protocol}://${req.get('host')}`;
      if (origin && origin !== expected) {
        res.status(403).json({ error: 'invalid_request', error_description: 'Cross-origin consent is not allowed' });
        return;
      }
      const params = readParams((req.body ?? {}) as Record<string, unknown>);
      const resolved = await resolveClient(provider, params);
      if ('badRequest' in resolved) {
        res.status(400).json({ error: 'invalid_request', error_description: resolved.badRequest });
        return;
      }
      const { client, redirectUri } = resolved;
      const member = await sessionMember(req);
      if (!member) {
        res.redirect(303, '/login');
        return;
      }
      if (firstString((req.body ?? {}).decision) !== 'approve') {
        res.redirect(errorRedirect(redirectUri, 'access_denied', params.state, 'The Member denied the request'));
        return;
      }
      if (!params.codeChallenge) {
        res.redirect(errorRedirect(redirectUri, 'invalid_request', params.state, 'code_challenge is required'));
        return;
      }
      const selectedAccessLevel = firstString((req.body ?? {}).access_level) ?? 'read';
      if ((member.role !== 'administrator' && member.role !== 'member')
        || !isConnectedAppAccessLevel(selectedAccessLevel)
        || !availableConnectedAppAccessLevels({
          clientScopes: parseScopeString(client.scope),
          membershipRole: member.role,
          membershipStatus: 'active',
        }).includes(selectedAccessLevel)) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'The selected Connected App access level is not available',
        });
        return;
      }
      const authorizationParams: AuthorizationParams = {
        state: params.state,
        scopes: requestedScopes(client, params.scope),
        codeChallenge: params.codeChallenge,
        redirectUri,
        resource: params.resource ? new URL(params.resource) : undefined,
      };
      const target = await provider.authorizeWithMember(client, authorizationParams, {
        membershipId: member.membership_id,
        role: member.role,
        accessLevel: selectedAccessLevel,
      });
      res.redirect(target);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

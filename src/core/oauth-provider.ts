/**
 * GBrain OAuth 2.1 Provider — implements MCP SDK's OAuthServerProvider.
 *
 * Backed by raw SQL (PGLite or Postgres), not the BrainEngine interface.
 * OAuth is infrastructure, not brain operations.
 *
 * Supports:
 * - Client registration (manual via CLI or Dynamic Client Registration)
 * - Authorization code flow with PKCE (for ChatGPT, browser-based clients)
 * - Client credentials flow (for machine-to-machine: Perplexity, Claude)
 * - Token refresh with rotation
 * - Token revocation
 * - Legacy access_tokens fallback for backward compat
 */

import type { Response } from 'express';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo as SdkAuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { hashToken, generateToken, isUndefinedColumnError, isUndefinedTableError } from './utils.ts';
import { hasScope, assertAllowedScopes, parseScopeString, InvalidScopeError } from './scope.ts';
import type { AuthInfo as CoreAuthInfo } from './operations.ts';
import { parseLegacyTokenScope } from './legacy-token-scope.ts';
import type { SqlQuery, SqlValue } from './sql-query.ts';
import {
  availableConnectedAppAccessLevels,
  connectedAppScopesForAccessLevel,
  isConnectedAppAccessLevel,
  resolveConnectedAppAccess,
  type ConnectedAppAccessLevel,
} from '../workspace/connected-apps.ts';
export type { SqlQuery, SqlValue };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Convert a JS array to a PostgreSQL array literal for PGLite compat.
 *
 * PGLite's `db.query(sql, params)` rejects JS arrays bound directly to TEXT[]
 * columns ("insufficient data left in message"), so we hand-build the array
 * literal `{...}` and let Postgres parse it on insert.
 *
 * SECURITY: every element is wrapped in double quotes with `"` and `\`
 * escaped. Without this, an element containing a comma (e.g., a malicious
 * `redirect_uri` containing `,`) would be parsed by Postgres as MULTIPLE
 * array elements, smuggling values past validation. See CSO finding #5.
 */
function pgArray(arr: string[]): string {
  if (!arr || arr.length === 0) return '{}';
  const escaped = arr.map(s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}

/**
 * Issue #47 — scope ceiling a Workspace role can consent to. Mirrors
 * `workspaceMemberAuthorization` (authorization-context.ts): administrators
 * carry the full capability set (no extra clamp), members are capped at Write.
 * `undefined` = unknown role, callers must refuse (fail-closed).
 */
export function roleScopeCeiling(role: string): string[] | null | undefined {
  if (role === 'administrator') return null;
  if (role === 'member') return ['write'];
  return undefined;
}

/**
 * Allow-list of RFC 7591 §2 `token_endpoint_auth_method` values gbrain
 * accepts at registration. Three values, chosen because the SDK's
 * `mcpAuthRouter` advertises exactly these three in
 * `token_endpoint_auth_methods_supported`:
 *
 * - `client_secret_post` — confidential client; secret in body (default)
 * - `client_secret_basic` — confidential client; secret in Authorization header
 * - `none` — public PKCE-only client (Claude Code, Cursor, ChatGPT custom connector)
 *
 * Two call sites enforce this set:
 *   1. CLI `gbrain auth register-client` (src/commands/auth.ts)
 *   2. DCR `POST /register` (this file, GBrainClientsStore.registerClient)
 *
 * **Read-tolerant by design.** `getClient` returns whatever is stored
 * verbatim — legacy rows with non-allowlist values (e.g. pre-v0.41.3
 * direct UPDATEs) continue to function. The validator gates new writes
 * ONLY; we don't break operators with hand-edited rows on upgrade.
 */
export type TokenEndpointAuthMethod = 'client_secret_post' | 'client_secret_basic' | 'none';

export const ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS = new Set<TokenEndpointAuthMethod>([
  'client_secret_post',
  'client_secret_basic',
  'none',
]);

export class InvalidTokenEndpointAuthMethodError extends Error {
  readonly code = 'invalid_token_endpoint_auth_method';
  constructor(value: unknown) {
    super(
      `Invalid token_endpoint_auth_method: ${JSON.stringify(value)}. ` +
      `Expected one of: ${Array.from(ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS).join(', ')}. ` +
      `RFC 7591 §2 — see https://datatracker.ietf.org/doc/html/rfc7591#section-2.`,
    );
    this.name = 'InvalidTokenEndpointAuthMethodError';
  }
}

/**
 * Validate a token_endpoint_auth_method value at the registration boundary.
 * Throws `InvalidTokenEndpointAuthMethodError` on rejection; returns the
 * typed value on success. Returns `'client_secret_post'` for undefined input
 * (RFC 7591 default).
 *
 * Apply at every registration entry point (CLI, admin endpoint, DCR). Do
 * NOT apply on read — legacy oauth_clients rows with non-allowlist values
 * must continue to function unchanged.
 */
export function validateTokenEndpointAuthMethod(value: unknown): TokenEndpointAuthMethod {
  if (value === undefined || value === null || value === '') return 'client_secret_post';
  if (typeof value !== 'string') throw new InvalidTokenEndpointAuthMethodError(value);
  if (!ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS.has(value as TokenEndpointAuthMethod)) {
    throw new InvalidTokenEndpointAuthMethodError(value);
  }
  return value as TokenEndpointAuthMethod;
}

/**
 * Validate a redirect_uri per RFC 6749 §3.1.2.1.
 *
 * Production redirect_uris MUST be HTTPS. The only allowed plaintext
 * exceptions are loopback (127.0.0.1, ::1, localhost) which are unreachable
 * from the network. Throws a descriptive error on rejection.
 *
 * Used by the DCR (Dynamic Client Registration) path; the CLI registration
 * path trusts the operator and bypasses this gate.
 */
function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid redirect_uri: not a parseable URL: ${uri}`);
  }
  const isLoopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
    || parsed.hostname === '::1';
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopback) return;
  throw new Error(
    `redirect_uri must use https:// (or http://localhost for loopback): ${uri}`,
  );
}

/**
 * Coerce an OAuth timestamp column (Unix epoch seconds, BIGINT) into a JS
 * number, or undefined for SQL NULL.
 *
 * Why this exists: postgres.js with `prepare: false` (the auto-detected setting
 * on Supabase PgBouncer / port 6543; see src/core/db.ts:resolvePrepare) returns
 * BIGINT columns as strings. Two surfaces break on that: (1) the MCP SDK's
 * bearerAuth middleware checks `typeof authInfo.expiresAt === 'number'` and
 * rejects strings; (2) RFC 7591 §3.2.1 requires `client_id_issued_at` and
 * `client_secret_expires_at` to be JSON numbers in DCR responses, not strings.
 *
 * Throws on non-finite (NaN/Infinity) so corrupt rows fail loud at the boundary
 * instead of letting `expiresAt: NaN` flow through to the SDK as a fake-valid
 * token. Returns undefined for SQL NULL so callers decide NULL semantics
 * explicitly. For OAuth, the comparison sites treat NULL as "expired"
 * (fail-closed); the DCR response sites preserve undefined per RFC 7591
 * (the `client_secret_expires_at` field is optional, undefined means
 * "did not expire").
 */
export function coerceTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`coerceTimestamp: non-finite timestamp value ${JSON.stringify(value)}`);
  }
  return n;
}

interface GBrainOAuthProviderOptions {
  sql: SqlQuery;
  /** Default token TTL in seconds (default: 3600 = 1 hour) */
  tokenTtl?: number;
  /** Default refresh token TTL in seconds (default: 30 days) */
  refreshTtl?: number;
  /**
   * Disable Dynamic Client Registration (RFC 7591) while keeping the rest of
   * the OAuth surface intact. When true, `clientsStore.registerClient` is not
   * surfaced to the SDK router, so POST `/register` returns 404 even though
   * the underlying provider can still register clients programmatically via
   * `registerClientManual`. Replaces the previous monkey-patching pattern in
   * serve-http.ts (cleanup, not a security fix — DCR was never reachable
   * before mcpAuthRouter ran).
   */
  dcrDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Clients Store
// ---------------------------------------------------------------------------

class GBrainClientsStore implements OAuthRegisteredClientsStore {
  constructor(private sql: SqlQuery) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const rows = await this.sql`
      SELECT client_id, client_secret_hash, client_name, redirect_uris,
             grant_types, scope, token_endpoint_auth_method,
             client_id_issued_at, client_secret_expires_at
      FROM oauth_clients WHERE client_id = ${clientId}
    `;
    if (rows.length === 0) return undefined;
    const r = rows[0];
    // v0.34.1 (#909): public clients (token_endpoint_auth_method='none')
    // have client_secret_hash = NULL. Normalize SQL NULL to JS undefined
    // so SDK middleware that checks `client.client_secret === undefined`
    // (not `=== null`) correctly identifies the client as public and
    // skips the secret-comparison branch on /token.
    const rawSecret = r.client_secret_hash;
    return {
      client_id: r.client_id as string,
      client_secret: rawSecret == null ? undefined : (rawSecret as string),
      client_name: r.client_name as string,
      redirect_uris: (r.redirect_uris as string[]) || [],
      grant_types: (r.grant_types as string[]) || ['client_credentials'],
      scope: r.scope as string | undefined,
      token_endpoint_auth_method: r.token_endpoint_auth_method as string | undefined,
      client_id_issued_at: coerceTimestamp(r.client_id_issued_at),
      client_secret_expires_at: coerceTimestamp(r.client_secret_expires_at),
    };
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    // Enforce HTTPS for all redirect_uris on the DCR path (RFC 6749 §3.1.2.1).
    // Without this, an attacker could register a non-loopback http:// URI and
    // exfiltrate auth codes over plaintext. CLI registrations bypass this gate
    // (operators are trusted; they can register http:// for testing).
    for (const uri of client.redirect_uris || []) {
      validateRedirectUri(String(uri));
    }

    // v0.28: ALLOWED_SCOPES allowlist. RFC 6749 §5.2 invalid_scope. The DCR
    // path is reachable by any unauthenticated network caller when --enable-dcr
    // is on, so this is the security-relevant gate (manual CLI registration
    // is operator-trusted).
    //
    // Registration is a consent ceiling, not the live grant. Omitted or empty
    // DCR scope therefore permits the full cumulative range; consent still
    // preselects and grants Read unless the Member chooses a higher level.
    const scope = parseScopeString(client.scope).length > 0
      ? (client.scope as string)
      : 'admin';
    assertAllowedScopes(parseScopeString(scope));

    // v0.41.3 (T5): validate token_endpoint_auth_method on the DCR path so
    // `--enable-dcr` is not the looser entry point. CLI and admin paths gate
    // through the same `validateTokenEndpointAuthMethod` helper — all three
    // registration entry points share one allow-list.
    const authMethod = validateTokenEndpointAuthMethod(client.token_endpoint_auth_method);

    // #47: DCR clients may ONLY use the session-gated authorization-code
    // flow (+ refresh). Without this clamp, an unauthenticated caller could
    // register a confidential client and mint a member-less token straight
    // through the client_credentials grant — the exact issuance mode the
    // consent gate exists to close. client_credentials stays available to
    // operator-registered clients (CLI `gbrain auth register-client`).
    const requestedGrants = client.grant_types && client.grant_types.length
      ? client.grant_types
      : ['authorization_code', 'refresh_token'];
    const disallowed = requestedGrants.filter(g => g !== 'authorization_code' && g !== 'refresh_token');
    if (disallowed.length > 0) {
      throw new Error(
        `grant_types not available via dynamic registration: ${disallowed.join(', ')}. ` +
        'Dynamically registered clients use the Member-consented authorization_code flow; ' +
        'client_credentials requires operator registration.',
      );
    }
    const grantTypes = requestedGrants;

    const clientId = generateToken('gbrain_cl_');
    // v0.34.1 (#909): RFC 7591 §2 — clients that authenticate at the token
    // endpoint via PKCE alone declare `token_endpoint_auth_method: "none"`.
    // For those clients the authorization server MUST NOT issue a client
    // secret. Pre-fix, unconditional secret generation made the MCP SDK's
    // clientAuth middleware check `client.client_secret` on every request,
    // rejecting valid public-client (Claude Code, Cursor) flows.
    //
    // We persist secret_hash = NULL for public clients so `getClient` and
    // the SDK's clientAuth path can detect them via `client_secret_hash IS
    // NULL` and skip the secret comparison. Confidential clients (default
    // `client_secret_post` and explicit `client_secret_basic`) still mint
    // a secret as before.
    const isPublicClient = authMethod === 'none';
    const clientSecret = isPublicClient ? undefined : generateToken('gbrain_cs_');
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);

    // v0.34.1 (#861, D2 + D13 + #876): DCR clients get source_id='default'
    // (matches legacy fallback) and federated_read=['default'] (read scope
    // == write scope). Operators who need narrower / wider scope rescope
    // via the CLI later. Pre-v60/v61 brain falls through to the legacy
    // projection (no source_id / federated_read column yet).
    try {
      await this.sql`
        INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                    grant_types, scope, token_endpoint_auth_method,
                                    client_id_issued_at, source_id, federated_read)
        VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                ${pgArray((client.redirect_uris || []).map(String))},
                ${pgArray(grantTypes)},
                ${scope}, ${authMethod},
                ${now}, ${'default'}, ${pgArray(['default'])})
      `;
    } catch (err) {
      if (isUndefinedColumnError(err, 'federated_read')) {
        try {
          await this.sql`
            INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                        grant_types, scope, token_endpoint_auth_method,
                                        client_id_issued_at, source_id)
            VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                    ${pgArray((client.redirect_uris || []).map(String))},
                    ${pgArray(grantTypes)},
                    ${scope}, ${authMethod},
                    ${now}, ${'default'})
          `;
        } catch (err2) {
          if (isUndefinedColumnError(err2, 'source_id')) {
            await this.sql`
              INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                          grant_types, scope, token_endpoint_auth_method,
                                          client_id_issued_at)
              VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                      ${pgArray((client.redirect_uris || []).map(String))},
                      ${pgArray(grantTypes)},
                      ${scope}, ${authMethod},
                      ${now})
            `;
          } else {
            throw err2;
          }
        }
      } else if (isUndefinedColumnError(err, 'source_id')) {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at)
          VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                  ${pgArray((client.redirect_uris || []).map(String))},
                  ${pgArray(grantTypes)},
                  ${scope}, ${authMethod},
                  ${now})
        `;
      } else {
        throw err;
      }
    }

    // Public clients: omit `client_secret` entirely from the response so
    // the wire payload matches RFC 7591 §3.2.1 ("if the client is a
    // public client, the authorization server MUST NOT issue a client
    // secret"). Confidential clients return the freshly-generated secret
    // exactly once — same shape as before.
    const response: OAuthClientInformationFull = {
      ...client,
      // Echo the EFFECTIVE grant list (RFC 7591 §3.2.1: the response reflects
      // server policy), so a client that omitted grant_types learns it got
      // the consent-gated default, not client_credentials.
      grant_types: grantTypes,
      // Echo the effective registration ceiling, including Admin for omitted scope.
      scope,
      client_id: clientId,
      client_id_issued_at: now,
    };
    if (clientSecret) response.client_secret = clientSecret;
    return response;
  }
}

// ---------------------------------------------------------------------------
// OAuth Provider
// ---------------------------------------------------------------------------

export class GBrainOAuthProvider implements OAuthServerProvider {
  private sql: SqlQuery;
  private _clientsStore: GBrainClientsStore;
  private readonly dcrDisabled: boolean;
  private tokenTtl: number;
  private refreshTtl: number;

  constructor(options: GBrainOAuthProviderOptions) {
    this.sql = options.sql;
    this._clientsStore = new GBrainClientsStore(this.sql);
    this.dcrDisabled = options.dcrDisabled === true;
    this.tokenTtl = options.tokenTtl || 3600;
    this.refreshTtl = options.refreshTtl || 30 * 24 * 3600;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    if (this.dcrDisabled) {
      // Surface getClient only — without registerClient the SDK's mcpAuthRouter
      // does not wire up the /register DCR endpoint. Replaces the prior
      // monkey-patch in serve-http.ts; the outcome is identical (DCR off-by-
      // default), but the API expresses intent on the constructor instead of
      // requiring callers to mutate `_clientsStore` after construction.
      return {
        getClient: this._clientsStore.getClient.bind(this._clientsStore),
      } as OAuthRegisteredClientsStore;
    }
    return this._clientsStore;
  }

  // -------------------------------------------------------------------------
  // Authorization Code Flow
  // -------------------------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const redirectUrl = await this.mintAuthorizationCode(client, params, null);
    res.redirect(redirectUrl);
  }

  /**
   * Issue #47 — session-gated consent path. Mints an authorization code bound
   * to the consenting Member; the resulting tokens resolve that Member's
   * CURRENT Source Access at verification time (fail-closed, ADR-0013).
   * Scopes are additionally clamped by the Member's Workspace role: a
   * `member` role consents at most `write`; an `administrator` keeps the
   * client-registered ceiling. Unknown roles refuse (fail-closed).
   *
   * Returns the redirect URL (code + state appended) for the HTTP layer to
   * 302 to. The plain SDK `authorize()` above stays member-less for
   * programmatic/CLI use — the HTTP /authorize route is intercepted by the
   * consent router and never reaches it.
   */
  async authorizeWithMember(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    member: { membershipId: string; role: string; accessLevel: unknown },
  ): Promise<string> {
    if (member.role !== 'administrator' && member.role !== 'member') {
      throw new Error('Unknown Workspace role; refusing consent');
    }
    if (!isConnectedAppAccessLevel(member.accessLevel)) {
      throw new Error('Invalid Connected App access level');
    }
    const available = availableConnectedAppAccessLevels({
      clientScopes: parseScopeString(client.scope),
      membershipRole: member.role,
      membershipStatus: 'active',
    });
    if (!available.includes(member.accessLevel)) {
      throw new Error('Connected App access level is not available');
    }
    return this.mintAuthorizationCode(client, params, member.membershipId, member.accessLevel);
  }

  private async mintAuthorizationCode(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    membershipId: string | null,
    accessLevel?: ConnectedAppAccessLevel,
  ): Promise<string> {
    const code = generateToken('gbrain_code_');
    const codeHash = hashToken(code);
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minute TTL

    // Scope clamp (RFC 6749 §3.3): the SDK's authorize handler splits
    // `?scope=...` verbatim and forwards the raw list to the provider, so
    // the provider MUST clamp against the client's registered grant. Without
    // this, a `read`-registered client requesting `?scope=admin` would have
    // `['admin']` stored in oauth_codes and returned by exchangeAuthorizationCode
    // as a fully-admin access token. Mirrors the filter pattern already used
    // by exchangeClientCredentials (this file) and exchangeRefreshToken's F3
    // subset enforcement (RFC 6749 §6) so all three grant entry points clamp
    // consistently. When the client requests NO scope, RFC 6749 §3.3 lets the
    // server fall back to a default — we default to the client's full
    // registered scope (matching exchangeClientCredentials, which already does
    // `requestedScope ? ... : allowedScopes`). Previously an omitted request
    // granted the empty set, which then propagated into the access+refresh
    // tokens and never self-healed: every op failed `insufficient_scope` even
    // though the client was registered with `read write`. Clients that omit
    // `scope` on /authorize (e.g. some MCP connectors) hit this. Still clamped
    // to the allowed set, so an explicit over-broad request can't escalate.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes = (params.scopes && params.scopes.length) ? params.scopes : allowedScopes;
    const grantedScopes = membershipId !== null && accessLevel
      ? connectedAppScopesForAccessLevel(accessLevel)
      : requestedScopes.filter(s => hasScope(allowedScopes, s));

    if (membershipId !== null) {
      // NO missing-column fallback on the member-bound path: silently minting
      // a member-less code would strip the binding the whole model rests on.
      // A pre-v122 brain fails loudly until apply-migrations runs.
      await this.sql`
        WITH policy AS (
          INSERT INTO workspace_connected_app_policies
            (membership_id, client_id, configured_access_level)
          VALUES (${membershipId}, ${client.client_id}, ${accessLevel!})
          ON CONFLICT (membership_id, client_id) DO UPDATE
            SET configured_access_level = EXCLUDED.configured_access_level,
                updated_at = now()
          RETURNING membership_id, client_id
        )
        INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
                                  code_challenge_method, redirect_uri, state, resource, expires_at,
                                  membership_id)
        SELECT ${codeHash}, policy.client_id,
               ${pgArray(grantedScopes)},
               ${params.codeChallenge}, ${'S256'},
               ${params.redirectUri}, ${params.state || null},
               ${params.resource?.toString() || null}, ${expiresAt},
               policy.membership_id
        FROM policy
      `;
    } else {
      await this.sql`
        INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
                                  code_challenge_method, redirect_uri, state, resource, expires_at)
        VALUES (${codeHash}, ${client.client_id},
                ${pgArray(grantedScopes)},
                ${params.codeChallenge}, ${'S256'},
                ${params.redirectUri}, ${params.state || null},
                ${params.resource?.toString() || null}, ${expiresAt})
      `;
    }

    // Redirect back with the code
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) redirectUrl.searchParams.set('state', params.state);
    return redirectUrl.toString();
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const codeHash = hashToken(authorizationCode);
    // F1 hardening: bind client_id atomically so a wrong client cannot read
    // another client's PKCE challenge. Pre-fix the SELECT didn't filter on
    // client_id at all.
    const rows = await this.sql`
      SELECT code_challenge FROM oauth_codes
      WHERE code_hash = ${codeHash}
        AND client_id = ${client.client_id}
        AND expires_at > ${Math.floor(Date.now() / 1000)}
    `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');
    return rows[0].code_challenge as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = hashToken(authorizationCode);
    const now = Math.floor(Date.now() / 1000);

    // F1 + F7c hardening: bind client_id AND redirect_uri atomically into the
    // DELETE WHERE clause. RFC 6749 §10.5 requires auth codes be single-use;
    // RFC 6749 §4.1.3 requires the token endpoint validate redirect_uri
    // matches the value sent at /authorize. The previous SELECT-then-compare
    // pattern (a) burned the code on the wrong-client path so the legitimate
    // client could not retry, and (b) ignored redirect_uri on exchange
    // entirely. With RETURNING, the second request — or any wrong-client /
    // wrong-redirect-uri attempt — gets zero rows back and fails cleanly.
    // The legitimate client's code stays available for one valid redemption.
    //
    // Use `redirectUri !== undefined` rather than truthy — an attacker
    // submitting `redirect_uri=""` (empty string) at /token would otherwise
    // hit the falsy branch and bypass the binding entirely.
    // #47: RETURNING membership_id so member-bound codes propagate their
    // binding into the minted tokens. Pre-v122 brains lack the column —
    // fall back to the legacy projection (member-bound codes cannot exist
    // there, so nothing is lost).
    const runDelete = (withMembership: boolean): Promise<Record<string, unknown>[]> => {
      if (redirectUri !== undefined) {
        return withMembership
          ? this.sql`
              DELETE FROM oauth_codes
              WHERE code_hash = ${codeHash}
                AND client_id = ${client.client_id}
                AND redirect_uri = ${redirectUri}
                AND expires_at > ${now}
              RETURNING client_id, scopes, resource, membership_id, created_at
            `
          : this.sql`
              DELETE FROM oauth_codes
              WHERE code_hash = ${codeHash}
                AND client_id = ${client.client_id}
                AND redirect_uri = ${redirectUri}
                AND expires_at > ${now}
              RETURNING client_id, scopes, resource
            `;
      }
      return withMembership
        ? this.sql`
            DELETE FROM oauth_codes
            WHERE code_hash = ${codeHash}
              AND client_id = ${client.client_id}
              AND expires_at > ${now}
            RETURNING client_id, scopes, resource, membership_id, created_at
          `
        : this.sql`
            DELETE FROM oauth_codes
            WHERE code_hash = ${codeHash}
              AND client_id = ${client.client_id}
              AND expires_at > ${now}
            RETURNING client_id, scopes, resource
          `;
    };
    let rows: Record<string, unknown>[];
    try {
      rows = await runDelete(true);
    } catch (err) {
      if (!isUndefinedColumnError(err, 'membership_id')) throw err;
      rows = await runDelete(false);
    }
    if (rows.length === 0) throw new Error('Authorization code not found or expired');

    const codeRow = rows[0];

    // Issue tokens. The consent moment (the code row's created_at) travels
    // onto member-bound token rows so Connected Apps shows the ORIGINAL
    // consent date, not the latest rotation.
    let scopes = (codeRow.scopes as string[]) || [];
    const membershipId = (codeRow.membership_id as string | null | undefined) ?? null;
    if (membershipId !== null) {
      const effective = await this.resolveMemberBoundCredentialAccess(
        membershipId,
        client.client_id,
        scopes,
      );
      scopes = connectedAppScopesForAccessLevel(effective);
    }
    const consentedAt = membershipId !== null ? (codeRow.created_at as string | Date | undefined) ?? null : null;
    return this.issueTokens(client.client_id, scopes, resource, true, undefined, membershipId, consentedAt);
  }

  // -------------------------------------------------------------------------
  // Refresh Token
  // -------------------------------------------------------------------------

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokenHash = hashToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);

    // F2 hardening: bind client_id atomically into the DELETE WHERE clause.
    // RFC 6749 §10.4 detection of stolen refresh tokens depends on second-use
    // failure. The previous SELECT-then-DELETE pattern + post-hoc client
    // compare let an attacker who guessed/stole a refresh token burn it on
    // the wrong-client path, defeating the stolen-token signal for the
    // legitimate client. With the predicate in the DELETE, wrong-client
    // attempts get zero rows back; the legitimate client retains the row
    // for one valid rotation.
    // #47: RETURNING membership_id so rotation preserves the Member binding.
    // Pre-v122 fallback mirrors exchangeAuthorizationCode.
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sql`
        DELETE FROM oauth_tokens
        WHERE token_hash = ${tokenHash}
          AND token_type = 'refresh'
          AND client_id = ${client.client_id}
        RETURNING client_id, scopes, expires_at, membership_id, created_at
      `;
    } catch (err) {
      if (!isUndefinedColumnError(err, 'membership_id')) throw err;
      rows = await this.sql`
        DELETE FROM oauth_tokens
        WHERE token_hash = ${tokenHash}
          AND token_type = 'refresh'
          AND client_id = ${client.client_id}
        RETURNING client_id, scopes, expires_at
      `;
    }
    if (rows.length === 0) throw new Error('Refresh token not found');

    const row = rows[0];
    // NULL expires_at is treated as expired (fail-closed). Schema permits NULL
    // even though issueTokens always sets it, so a corrupt or hand-modified row
    // can't ride past validation.
    const expiresAt = coerceTimestamp(row.expires_at);
    if (expiresAt === undefined || expiresAt < now) throw new Error('Refresh token expired');

    // F3 hardening: requested scopes on refresh MUST be a subset of the
    // original grant on this refresh token's row. RFC 6749 §6: "the scope of
    // the access token … MUST NOT include any scope not originally granted by
    // the resource owner." Scope is checked against the row's scopes (the
    // grant), NOT against the client's currently-allowed scopes (which can
    // expand later). Omitted scope (`undefined`) inherits the original grant
    // verbatim and stays distinct from an explicit empty array.
    //
    // v0.28: hasScope replaces exact-string-match so an `admin` grant CAN
    // refresh down to `sources_admin` (admin implies all). Without this,
    // gstack /setup-gbrain Path 4 — which mints a sources_admin-scoped
    // refresh — would fail when the brain admin's bootstrap token was
    // issued at the `admin` tier.
    const grantedScopes = (row.scopes as string[]) || [];
    if (scopes && scopes.some(s => !hasScope(grantedScopes, s))) {
      throw new Error('Requested scope exceeds refresh token grant');
    }
    let tokenScopes = scopes ?? grantedScopes;
    const membershipId = (row.membership_id as string | null | undefined) ?? null;
    if (membershipId !== null) {
      const effective = await this.resolveMemberBoundCredentialAccess(
        membershipId,
        client.client_id,
        tokenScopes,
      );
      tokenScopes = connectedAppScopesForAccessLevel(effective);
    }
    // Preserve the original consent moment across rotations (Connected Apps
    // shows the first consent, not the latest refresh).
    const consentedAt = membershipId !== null ? (row.created_at as string | Date | undefined) ?? null : null;
    return this.issueTokens(client.client_id, tokenScopes, resource, true, undefined, membershipId, consentedAt);
  }

  // -------------------------------------------------------------------------
  // Token Verification
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<SdkAuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    // Try OAuth tokens first. JOIN oauth_clients in the same query so
    // verifyAccessToken returns client_name AND source_id in AuthInfo —
    // eliminates the separate per-request lookup at serve-http.ts that
    // was the N+1 hot path (see PR #586 review D14=B; v0.34.1 #861 D2
    // adds the source_id thread on the same JOIN).
    //
    // v0.34.1 (#861): the JOIN guards on a c.source_id column that
    // migration v60 adds. Pre-v60 brains throw a "column does not exist"
    // error here — caught at the boundary via isUndefinedColumnError so
    // unmigrated brains degrade to "no source scope" rather than refusing
    // every token verification.
    let oauthRows: Record<string, unknown>[];
    try {
      // #47 (v122): membership_id joins the projection so member-bound tokens
      // resolve their consenting Member below.
      oauthRows = await this.sql`
        SELECT t.client_id, t.scopes, t.expires_at, t.resource, t.membership_id, c.client_name,
               c.source_id, c.federated_read
        FROM oauth_tokens t
        LEFT JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
      `;
    } catch (err) {
      // Pre-v122 brain → membership_id missing. v0.34.1: pre-v60 brain →
      // source_id column missing. Pre-v61 brain → federated_read column
      // missing. All classes degrade projection-by-projection so auth keeps
      // working until the operator runs apply-migrations. Member-bound rows
      // cannot exist on a pre-v122 brain, so the step-down loses nothing.
      if (!isUndefinedColumnError(err, 'membership_id')
        && !isUndefinedColumnError(err, 'source_id')
        && !isUndefinedColumnError(err, 'federated_read')) {
        throw err;
      }
      try {
        oauthRows = await this.sql`
          SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name,
                 c.source_id, c.federated_read
          FROM oauth_tokens t
          LEFT JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
        `;
      } catch (err1) {
        if (!isUndefinedColumnError(err1, 'source_id') && !isUndefinedColumnError(err1, 'federated_read')) {
          throw err1;
        }
        // Try the v60-only projection first (source_id but no federated_read).
        try {
          oauthRows = await this.sql`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.source_id
            FROM oauth_tokens t
            LEFT JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          `;
        } catch (err2) {
          if (isUndefinedColumnError(err2, 'source_id')) {
            // Truly pre-v60: no source_id either. Pre-v0.34 projection.
            oauthRows = await this.sql`
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
            `;
          } else {
            throw err2;
          }
        }
      }
    }

    if (oauthRows.length > 0) {
      const row = oauthRows[0];
      // NULL expires_at is treated as expired (fail-closed). Schema permits NULL,
      // and the SDK's bearerAuth requires `typeof expiresAt === 'number'` — we
      // throw here rather than return an undefined-bearing AuthInfo.
      const expiresAt = coerceTimestamp(row.expires_at);
      if (expiresAt === undefined || expiresAt < now) {
        throw new InvalidTokenError('Token expired');
      }
      // v0.34.1 (#876): federated_read normalization. SELECT returns
      // either a JS array (Postgres / PGLite text[] driver mapping) or
      // undefined when the legacy projection ran (pre-v61 brain). Empty
      // array vs undefined matters: empty array = explicit no-federated-
      // read; undefined = column missing on this brain.
      const federatedRaw = row.federated_read;
      const allowedSources = Array.isArray(federatedRaw)
        ? (federatedRaw as string[])
        : undefined;

      // #47: member-bound token. Resolve the consenting Member's CURRENT
      // state — a removed/disabled membership, a missing workspace table, or
      // an unknown role all refuse (fail-closed, ADR-0013). Scopes re-clamp
      // to the Member's current role so a demoted administrator's connectors
      // drop to the write ceiling without re-consent. The client's own source_id /
      // federated_read grants are explicitly NOT inherited: the Member's
      // Source Access policy is the single authorization model.
      const membershipId = (row.membership_id as string | null | undefined) ?? undefined;
      let scopes = (row.scopes as string[]) || [];
      if (membershipId) {
        const effective = await this.resolveMemberBoundCredentialAccess(
          membershipId,
          row.client_id as string,
          scopes,
        );
        scopes = connectedAppScopesForAccessLevel(effective);
        return {
          token,
          clientId: row.client_id as string,
          clientName: (row.client_name as string | null) ?? undefined,
          scopes,
          expiresAt,
          resource: row.resource ? new URL(row.resource as string) : undefined,
          membershipId,
        } as CoreAuthInfo as SdkAuthInfo;
      }

      return {
        token,
        clientId: row.client_id as string,
        clientName: (row.client_name as string | null) ?? undefined,
        scopes,
        expiresAt,
        resource: row.resource ? new URL(row.resource as string) : undefined,
        // v0.34.1 (#861, D2): source-isolation scope from oauth_clients.
        // Undefined when the row predates v60 or when the brain itself
        // predates v60 (fell through to the legacy projection above).
        sourceId: (row.source_id as string | null) ?? undefined,
        // v0.34.1 (#876): federated read scope. sourceScopeOpts in
        // operations.ts prefers this array over scalar sourceId when set
        // and non-empty.
        allowedSources,
      } as CoreAuthInfo as SdkAuthInfo;
    }

    // #58 (D1): Workspace Agent credentials. Placed between the OAuth lookup
    // and the legacy access_tokens fallback so an Agent token can never fall
    // through to legacy's blanket admin grant. hashWorkspaceSecret (the
    // writer, workspace/agents.ts) and hashToken above are both sha256-hex,
    // so tokenHash matches rows written by issueCredential.
    //
    // Fail closed by construction: once a token_hash matches ANY credential
    // row this branch always terminates — it either returns an Agent AuthInfo
    // or throws. The agent parent is LEFT JOINed precisely so an orphaned
    // credential refuses rather than skipping the branch and inheriting the
    // legacy fallback's blanket admin grant.
    let agentRows: Record<string, unknown>[] = [];
    try {
      agentRows = await this.sql`
        SELECT c.credential_id, c.revoked_at AS credential_revoked_at,
               a.agent_id, a.workspace_id, a.name, a.scope, a.status
        FROM workspace_agent_credentials c
        LEFT JOIN workspace_agents a ON a.agent_id = c.agent_id
        WHERE c.token_hash = ${tokenHash}
      `;
    } catch (err) {
      // A brain without the Workspace foundation simply has no Agent
      // credentials — keep the legacy fallback reachable.
      if (!isUndefinedTableError(err)) throw err;
    }
    if (agentRows.length > 0) {
      const row = agentRows[0];
      // Fail closed: a revoked credential, a revoked Agent, or an orphaned
      // credential whose Agent row is missing (null agent_id/status from the
      // LEFT JOIN) refuses outright and never reaches the legacy fallback.
      if (
        row.credential_revoked_at !== null
        || row.agent_id == null
        || row.status !== 'active'
      ) {
        throw new InvalidTokenError('Invalid token');
      }
      // D8: faithful scope mapping. `admin` implies the *_admin siblings via
      // the hasScope hierarchy — accepted explicitly in the #58 decisions.
      const scope = row.scope as string;
      const scopes = scope === 'admin' ? ['admin'] : scope === 'write' ? ['read', 'write'] : ['read'];
      await this.sql`
        UPDATE workspace_agent_credentials SET last_used_at = now()
        WHERE credential_id = ${row.credential_id as string}
      `;
      return {
        token,
        clientId: row.agent_id as string,
        clientName: row.name as string,
        scopes,
        // Agent credentials expire by revocation, not by clock; the SDK's
        // bearerAuth still requires a numeric expiresAt.
        expiresAt: now + 3600,
        // sourceId/allowedSources stay undefined so the Agent's principal
        // Source Access policy is the single authorization model.
        agentId: row.agent_id as string,
        workspaceId: row.workspace_id as string,
      } as CoreAuthInfo as SdkAuthInfo;
    }

    // Fallback: legacy access_tokens table (backward compat). Modern legacy
    // rows may carry permissions.source_id from the pre-OAuth bearer-token
    // path; OAuth transport must preserve that same source grant instead of
    // pinning every legacy token to `default`.
    let legacyRows: Record<string, unknown>[];
    try {
      legacyRows = await this.sql`
        SELECT id, name, permissions FROM access_tokens
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
      `;
    } catch (err) {
      if (isUndefinedColumnError(err, 'permissions')) {
        legacyRows = await this.sql`
          SELECT id, name FROM access_tokens
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
        `;
      } else if (isUndefinedTableError(err)) {
        // A brain without the legacy table simply has no legacy tokens —
        // fail closed on the credential, not with a 500.
        legacyRows = [];
      } else {
        throw err;
      }
    }

    if (legacyRows.length > 0) {
      // Legacy tokens get full admin access (grandfather in).
      // Legacy tokens use the immutable row id as principal identity; name is display-only.
      // Update last_used_at
      await this.sql`
        UPDATE access_tokens SET last_used_at = now() WHERE token_hash = ${tokenHash}
      `;
      const name = legacyRows[0].name as string;
      const id = legacyRows[0].id as string;
      const permissionsRaw = legacyRows[0].permissions;
      let permissions: unknown = permissionsRaw;
      if (typeof permissionsRaw === 'string') {
        try {
          permissions = JSON.parse(permissionsRaw);
        } catch {
          permissions = undefined;
        }
      }
      const sourceGrant = permissions && typeof permissions === 'object'
        ? (permissions as Record<string, unknown>).source_id
        : undefined;
      const { sourceId, allowedSources } = parseLegacyTokenScope(sourceGrant);
      return {
        token,
        clientId: id,
        clientName: name,
        scopes: ['read', 'write', 'admin'],
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600, // Legacy tokens never expire — set 1yr future
        // Missing or malformed legacy grants remain an explicit empty Source
        // set. Array grants match the direct legacy HTTP transport.
        sourceId,
        allowedSources,
      } as CoreAuthInfo as SdkAuthInfo;
    }

    throw new InvalidTokenError('Invalid token');
  }

  private async resolveMemberBoundCredentialAccess(
    membershipId: string,
    clientId: string,
    credentialScopes: readonly string[],
  ): Promise<ConnectedAppAccessLevel> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.sql`
        SELECT p.configured_access_level, m.role, m.status, c.scope AS client_scope
        FROM workspace_connected_app_policies p
        JOIN workspace_memberships m ON m.membership_id = p.membership_id
        JOIN oauth_clients c ON c.client_id = p.client_id AND c.deleted_at IS NULL
        WHERE p.membership_id = ${membershipId} AND p.client_id = ${clientId}
      `;
    } catch (err) {
      if (isUndefinedTableError(err)) throw new InvalidTokenError('Invalid token');
      throw err;
    }
    const row = rows[0];
    if (!row || (row.role !== 'member' && row.role !== 'administrator')
      || (row.status !== 'active' && row.status !== 'disabled')) {
      throw new InvalidTokenError('Invalid token');
    }
    const resolved = resolveConnectedAppAccess({
      configuredAccessLevel: row.configured_access_level,
      clientScopes: parseScopeString(row.client_scope as string | null | undefined),
      membershipRole: row.role,
      membershipStatus: row.status,
      credentialScopes,
    });
    if (resolved.effectiveAccessLevel === 'none') throw new InvalidTokenError('Invalid token');
    return resolved.effectiveAccessLevel;
  }

  // -------------------------------------------------------------------------
  // Token Revocation
  // -------------------------------------------------------------------------

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);
    // F4 hardening: bind client_id so a client can only revoke its own
    // tokens. RFC 7009 §2.1: "The authorization server first validates the
    // client credentials … and then verifies whether the token was issued
    // to the client making the revocation request." Pre-fix, any
    // authenticated client that knew (or guessed) another client's token
    // hash could revoke it.
    await this.sql`
      DELETE FROM oauth_tokens
      WHERE token_hash = ${tokenHash}
        AND client_id = ${client.client_id}
    `;
  }

  // -------------------------------------------------------------------------
  // Client Credentials (called by custom handler, not SDK)
  // -------------------------------------------------------------------------

  /**
   * v0.37.7.0 #1166 — verify a confidential client's secret without
   * spending it. Returns the validated client info on success, throws
   * with an opaque "Invalid client" message on failure (mirrors RFC 6749
   * §5.2 invalid_client semantics). Used by the serve-http custom
   * /token handler for `authorization_code` + `refresh_token` grants on
   * confidential clients, since the SDK's plaintext compare in
   * clientAuth.js can't see our hash-only storage.
   *
   * Public clients (token_endpoint_auth_method === 'none') return
   * `client_secret_hash = NULL` from getClient; this method refuses
   * them so the SDK's PKCE path stays the canonical surface.
   */
  async verifyConfidentialClientSecret(
    clientId: string,
    presentedSecret: string,
  ): Promise<OAuthClientInformationFull> {
    const client = await this._clientsStore.getClient(clientId);
    if (!client) throw new Error('Invalid client');
    // Public client — refuse to use this hash-compare path.
    if (client.client_secret === undefined) {
      throw new Error('Invalid client');
    }
    const presentedHash = hashToken(presentedSecret);
    // client.client_secret is the stored SHA-256 hash (getClient returns
    // it as the `client_secret` field per the v0.34.1.0 normalization).
    // Compare via SHA-256-then-equals; constant-time compare a follow-up.
    if (client.client_secret !== presentedHash) {
      throw new Error('Invalid client');
    }
    // Soft-delete probe — same shape as exchangeClientCredentials.
    try {
      const [revoked] = await this.sql`SELECT deleted_at FROM oauth_clients WHERE client_id = ${clientId} AND deleted_at IS NOT NULL`;
      if (revoked) throw new Error('Client has been revoked');
    } catch (e) {
      if (e instanceof Error && e.message === 'Client has been revoked') throw e;
      if (!isUndefinedColumnError(e, 'deleted_at')) throw e;
    }
    return client;
  }

  async exchangeClientCredentials(
    clientId: string,
    clientSecret: string,
    requestedScope?: string,
  ): Promise<OAuthTokens> {
    const client = await this._clientsStore.getClient(clientId);
    if (!client) throw new Error('Client not found');

    // Check if client has been revoked (soft-deleted). The deleted_at column
    // is recent — pre-migration brains don't have it, so the probe must
    // tolerate that one specific failure mode without swallowing real errors
    // (lock timeouts, network blips, auth failures).
    try {
      const [revoked] = await this.sql`SELECT deleted_at FROM oauth_clients WHERE client_id = ${clientId} AND deleted_at IS NOT NULL`;
      if (revoked) throw new Error('Client has been revoked');
    } catch (e) {
      // F5 hardening: surface anything that ISN'T a missing-column error.
      // Bare `catch {}` masked DB outages as "client not revoked" — fail-open
      // posture in a security-sensitive code path.
      if (e instanceof Error && e.message === 'Client has been revoked') throw e;
      if (!isUndefinedColumnError(e, 'deleted_at')) throw e;
    }

    // Check grant type first (before verifying secret)
    const grants = (client.grant_types as string[]) || [];
    if (!grants.includes('client_credentials')) {
      throw new Error('Client credentials grant not authorized for this client');
    }

    // Verify secret
    const secretHash = hashToken(clientSecret);
    if (client.client_secret !== secretHash) throw new Error('Invalid client secret');

    // Determine scopes. v0.28 swaps exact-string-match for hasScope so a
    // client whose grant is `admin` can mint tokens that include implied
    // scopes like `sources_admin` (admin implies all). Tokens are still
    // capped by what the client was registered for — this only changes how
    // the cap is computed.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes = requestedScope ? parseScopeString(requestedScope) : allowedScopes;
    const grantedScopes = requestedScopes.filter(s => hasScope(allowedScopes, s));

    // Per-client TTL override (stored in oauth_clients.token_ttl)
    // Column may not exist on PGLite/older schemas — graceful fallback
    let clientTtl: number | undefined;
    try {
      const ttlRows = await this.sql`SELECT token_ttl FROM oauth_clients WHERE client_id = ${clientId}`;
      if (ttlRows.length > 0 && ttlRows[0].token_ttl) clientTtl = Number(ttlRows[0].token_ttl);
    } catch (e) {
      // F5 hardening: same posture as the deleted_at probe above. Only the
      // "column doesn't exist" path is a non-fatal fall-through.
      if (!isUndefinedColumnError(e, 'token_ttl')) throw e;
    }

    // Client credentials: access token only, NO refresh token (RFC 6749 4.4.3)
    return this.issueTokens(clientId, grantedScopes, undefined, false, clientTtl);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async sweepExpiredTokens(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    // F6 hardening: postgres.js and PGLite expose deleted-row count on
    // different shapes; `(result as any).count` returned 0 on at least one
    // engine even when rows were deleted, and codes were never counted at
    // all. RETURNING 1 + array length is portable across both engines.
    const result = await this.sql`
      DELETE FROM oauth_tokens WHERE expires_at < ${now} RETURNING 1
    `;
    const deletedCodes = await this.sql`
      DELETE FROM oauth_codes WHERE expires_at < ${now} RETURNING 1
    `;
    return result.length + deletedCodes.length;
  }

  // -------------------------------------------------------------------------
  // CLI Registration Helper
  // -------------------------------------------------------------------------

  async registerClientManual(
    name: string,
    grantTypes: string[],
    scopes: string,
    redirectUris: string[] = [],
    sourceId: string = 'default',
    federatedRead?: string[],
    tokenEndpointAuthMethod?: string,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    // v0.28: ALLOWED_SCOPES allowlist. Reject `--scopes "read flying-unicorn"`
    // at registration so meaningless scope strings can't pile up in the DB.
    // Pre-allowlist clients keep working (allowlist is registration-time;
    // existing rows aren't re-validated).
    assertAllowedScopes(parseScopeString(scopes));

    // v0.41.3 (T1+T2): validate token_endpoint_auth_method at the registration
    // boundary. Throws InvalidTokenEndpointAuthMethodError on bad input.
    // Default is `client_secret_post` (RFC 7591 §2).
    const authMethod = validateTokenEndpointAuthMethod(tokenEndpointAuthMethod);

    const clientId = generateToken('gbrain_cl_');
    // v0.41.3 (T2): atomic public-client INSERT. When the caller declares
    // `tokenEndpointAuthMethod: 'none'` we mint NO secret and INSERT with
    // client_secret_hash = NULL in a single statement. Pre-fix, the admin
    // endpoint did INSERT-then-UPDATE which left a confidential row stranded
    // if the UPDATE failed mid-flight (codex F4). Confidential clients
    // (`client_secret_post` / `client_secret_basic`) get the secret minted
    // and hashed as before.
    const isPublicClient = authMethod === 'none';
    const clientSecret = isPublicClient ? undefined : generateToken('gbrain_cs_');
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);

    // v0.34.1 (#861 + #876): persist source_id AND federated_read so
    // verifyAccessToken can populate both AuthInfo fields. Defaults:
    //   source_id = 'default' (matches v60 backfill)
    //   federated_read = [source_id] when omitted (a non-federated client
    //                    has read scope == write scope, the v0.33 default)
    const federated = federatedRead && federatedRead.length > 0 ? federatedRead : [sourceId];
    try {
      await this.sql`
        INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                    grant_types, scope, token_endpoint_auth_method,
                                    client_id_issued_at,
                                    source_id, federated_read)
        VALUES (${clientId}, ${secretHash}, ${name},
                ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now},
                ${sourceId}, ${pgArray(federated)})
      `;
    } catch (err) {
      // Pre-v60 / pre-v61 brain: column missing. Fall back through both
      // projections so registration still works until apply-migrations.
      if (isUndefinedColumnError(err, 'federated_read')) {
        // v60-only brain: source_id but no federated_read.
        try {
          await this.sql`
            INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                        grant_types, scope, token_endpoint_auth_method,
                                        client_id_issued_at, source_id)
            VALUES (${clientId}, ${secretHash}, ${name},
                    ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now}, ${sourceId})
          `;
        } catch (err2) {
          if (isUndefinedColumnError(err2, 'source_id')) {
            await this.sql`
              INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                          grant_types, scope, token_endpoint_auth_method,
                                          client_id_issued_at)
              VALUES (${clientId}, ${secretHash}, ${name},
                      ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now})
            `;
          } else {
            throw err2;
          }
        }
      } else if (isUndefinedColumnError(err, 'source_id')) {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at)
          VALUES (${clientId}, ${secretHash}, ${name},
                  ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now})
        `;
      } else {
        throw err;
      }
    }

    return { clientId, clientSecret };
  }

  // -------------------------------------------------------------------------
  // Internal: Issue access + optional refresh tokens
  // -------------------------------------------------------------------------

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
    includeRefresh: boolean,
    ttlOverride?: number,
    membershipId: string | null = null,
    consentedAt: string | Date | null = null,
  ): Promise<OAuthTokens> {
    const accessToken = generateToken('gbrain_at_');
    const accessHash = hashToken(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const effectiveTtl = ttlOverride || this.tokenTtl;
    const accessExpiry = now + effectiveTtl;

    // #47: member-bound rows write membership_id with NO missing-column
    // fallback — dropping the binding silently would sever revocation and
    // grant-following. Member-less rows keep the legacy statement so
    // pre-v122 brains continue to work for every non-consent flow.
    const consentedAtValue = consentedAt instanceof Date ? consentedAt.toISOString() : consentedAt;
    const insertToken = (hash: string, type: 'access' | 'refresh', expiry: number) => {
      if (membershipId !== null && consentedAtValue !== null) {
        // Member-bound with a known consent moment: created_at carries the
        // ORIGINAL consent time through exchanges and rotations so
        // Connected Apps reports when the Member consented.
        return this.sql`
          INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource, membership_id, created_at)
          VALUES (${hash}, ${type}, ${clientId},
                  ${pgArray(scopes)}, ${expiry}, ${resource?.toString() || null}, ${membershipId}, ${consentedAtValue})
        `;
      }
      if (membershipId !== null) {
        return this.sql`
          INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource, membership_id)
          VALUES (${hash}, ${type}, ${clientId},
                  ${pgArray(scopes)}, ${expiry}, ${resource?.toString() || null}, ${membershipId})
        `;
      }
      return this.sql`
        INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
        VALUES (${hash}, ${type}, ${clientId},
                ${pgArray(scopes)}, ${expiry}, ${resource?.toString() || null})
      `;
    };

    await insertToken(accessHash, 'access', accessExpiry);

    const result: OAuthTokens = {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: effectiveTtl,
      scope: scopes.join(' '),
    };

    if (includeRefresh) {
      const refreshToken = generateToken('gbrain_rt_');
      const refreshHash = hashToken(refreshToken);
      const refreshExpiry = now + this.refreshTtl;
      await insertToken(refreshHash, 'refresh', refreshExpiry);
      result.refresh_token = refreshToken;
    }

    return result;
  }
}

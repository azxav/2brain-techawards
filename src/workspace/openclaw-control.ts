/**
 * The only seam through which GBrain talks to the colocated OpenClaw runtime.
 *
 * Direction of trust: GBrain reaches OUT to OpenClaw as an internal trusted
 * operator of OpenClaw. That is the opposite of the inbound direction, where
 * OpenClaw is an untrusted agent-facing MCP client and never receives
 * `OperationContext.remote === false`.
 *
 * The surface is deliberately closed. There is no generic `rpc(method, params)`
 * and no caller-supplied URL, header, or RPC name. Callers cannot widen it:
 *
 * - the target is loopback-only and validated at construction;
 * - the RPC name is a compile-time union checked again at runtime;
 * - every response body is capped and every thrown error carries a fixed code
 *   with no upstream text, so neither a secret we sent nor an OpenClaw message
 *   can reach a GBrain-visible error, log line, or HTTP response.
 *
 * ## Pinned OpenClaw 2026.7.1-2 contracts consumed here
 *
 * Wire contract verified against the pinned npm artifact openclaw@2026.7.1-2
 * (sha512 ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==,
 * matching cloud/image/openclaw/package-lock.json). Sources inside that tarball:
 *   admin RPC envelope + allowlist : dist/extensions/admin-http-rpc/index.js
 *                                    docs/plugins/admin-http-rpc.md
 *   401 body                       : dist/http-common-DGvb9gWN.js  (sendUnauthorized)
 *   config.get/.patch + baseHash   : dist/config-DQFoEP4y.js       (configHandlers)
 *                                    docs/gateway/configuration.md ("Config RPC")
 *   health payload                 : dist/types-DaHgOqFX.d.ts      (type HealthSummary)
 *   /tools/invoke                  : docs/gateway/tools-invoke-http-api.md
 *   /v1/responses schema           : dist/openresponses-http-DPyXZf-A.js (CreateResponseBodySchema)
 *   models.authStatus payload      : dist/models-auth-status-D40INXDR.js (handler,
 *                                    lines 253-300; models group of the admin allowlist)
 *                                    providers is an ARRAY of provider snapshots,
 *                                    each carrying `status` and an embedded `usage`
 * Admin RPC answers { id, ok, payload } — NOT { result }. /tools/invoke answers
 * { ok, result }. The two envelopes differ; do not share an unwrapper.
 *
 * `POST /api/v1/gbrain/provider` is a GBrain-authored plugin route, not an
 * OpenClaw surface; its `{ ok }` acknowledgement is our own contract.
 */

/** Loopback address the pinned gateway binds. Never configurable to a remote host. */
const OPENCLAW_LOOPBACK_HOST = '127.0.0.1';
const OPENCLAW_DEFAULT_BASE_URL = `http://${OPENCLAW_LOOPBACK_HOST}:3334`;

const OPENCLAW_ADMIN_RPC = '/api/v1/admin/rpc';
const OPENCLAW_TOOLS_INVOKE = '/tools/invoke';
const OPENCLAW_RESPONSES = '/v1/responses';
const OPENCLAW_PROVIDER_IMPORT = '/api/v1/gbrain/provider';

const OPENCLAW_USER_HEADER = 'X-GBrain-OpenClaw-User';
const OPENCLAW_PROXY_HEADER = 'X-GBrain-OpenClaw-Proxy';
const OPENCLAW_MODEL_HEADER = 'x-openclaw-model';

const DEFAULT_INTERNAL_USER = 'gbrain-control';
/**
 * ROUTING MARKER, NOT AUTHENTICATION.
 *
 * `gateway.auth.trustedProxy.requiredHeaders` is a PRESENCE check only — the
 * pinned Gateway never compares the header's value
 * (docs/gateway/trusted-proxy-auth.md, "requiredHeaders ... must be present and
 * non-blank"). This string therefore proves nothing and is not a shared secret;
 * treating it as one would be a mistake.
 *
 * The real boundary is (a) the Gateway binding loopback only, and (b) Caddy
 * stripping any client-supplied copy of these headers at the edge. With
 * `allowLoopback: true`, any local process that can reach 127.0.0.1:3334 and
 * sets both headers obtains full trusted-operator scope. That is the plan's
 * accepted design; it is documented here so nobody mistakes the constant for
 * a credential.
 */
const DEFAULT_REQUIRED_HEADER = 'gbrain-loopback-v1';

/**
 * The agent target for `/v1/responses`. `CreateResponseBodySchema` requires
 * `model` (it is `string()` with no `.optional()`, inside a `.strict()` object),
 * and the endpoint only accepts `openclaw`, `openclaw/default`, or
 * `openclaw/<agentId>` there. The BACKEND model is selected exclusively by the
 * `x-openclaw-model` header, which is what makes the probe's target explicit.
 */
const OPENCLAW_AGENT_TARGET_MODEL = 'openclaw/default';

/** Hard ceilings. A hung or chatty gateway must not stall or exhaust GBrain. */
const MAX_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** The pinned Gateway allows three configuration writes per 60 seconds. */
const MAX_CONFIG_PATCH_ATTEMPTS = 3;

/** The MCP endpoint OpenClaw calls back into. Not caller-configurable. */
const GBRAIN_MCP_URL = 'http://127.0.0.1:3131/mcp';
/** The projected MCP tool whose presence proves the bound Agent is reachable. */
const GBRAIN_MCP_TOOL = 'gbrain__whoami';
const GBRAIN_MCP_BUNDLE = 'bundle-mcp';

/**
 * Tool profiles under which `bundle-mcp` (configured MCP servers) is reachable.
 * `full` is also the behavior of an UNSET `tools.profile`. `minimal` exposes
 * only `session_status` and is therefore absent. Per docs/gateway/config-tools.md.
 */
const MCP_EXPOSING_TOOL_PROFILES: ReadonlySet<string> = new Set(['coding', 'messaging', 'full']);

/**
 * The `admin-http-rpc` allowlist entries this plan needs. The gateway's own
 * `ADMIN_HTTP_RPC_ALLOWED_METHODS` is far wider (~50 methods, including
 * `config.apply`, `agents.*`, `cron.*`, and `gateway.restart.request`); this
 * narrower private union is a deliberate self-restriction, and keeping it
 * private denies callers an arbitrary-method escape hatch.
 */
type OpenClawRpcMethod =
  | 'health'
  | 'config.get'
  | 'config.patch'
  | 'models.list'
  | 'models.authStatus';

const ALLOWED_RPC_METHODS: ReadonlySet<string> = new Set<OpenClawRpcMethod>([
  'health', 'config.get', 'config.patch', 'models.list', 'models.authStatus',
]);

export type OpenClawControlErrorCode =
  | 'openclaw_unavailable'
  | 'openclaw_invalid_response'
  | 'openclaw_config_failed'
  | 'openclaw_password_verification_failed'
  | 'openclaw_mcp_probe_failed'
  | 'openclaw_provider_import_failed'
  | 'openclaw_model_probe_failed'
  | 'openclaw_required_model_missing';

/**
 * The message is the code and nothing else. Any upstream body, credential, or
 * configuration payload is dropped at the throw site rather than filtered
 * later, so no downstream formatter can resurrect it.
 */
export class OpenClawControlError extends Error {
  public readonly code: OpenClawControlErrorCode;

  constructor(code: OpenClawControlErrorCode) {
    super(code);
    this.code = code;
    this.name = 'OpenClawControlError';
  }
}

function openClawSafeError(code: OpenClawControlErrorCode): OpenClawControlError {
  return new OpenClawControlError(code);
}

/**
 * The pinned `models.authStatus` credential states. There is NO `connected`
 * boolean on the wire; `status` is the only authentication signal.
 *
 *   ok       refreshable credential, not near expiry
 *   expiring valid, but inside the warn window
 *   expired  present but dead
 *   missing  configured, no credential
 *   static   a non-expiring api_key entry EXISTS — says nothing about validity
 *   unknown  our own fail-closed value for an absent or unrecognized snapshot
 *
 * Only `ok` and `expiring` mean authenticated. `static` deliberately does not.
 */
export type OpenClawAuthStatus = 'ok' | 'expiring' | 'expired' | 'missing' | 'static' | 'unknown';

/**
 * Quota is THREE-STATE, not a boolean, because an unauthenticated provider and
 * a provider comfortably within quota are the identical wire observation: the
 * gateway deletes credential-less providers from the usage snapshot entirely.
 * "No limit found, therefore within quota" is a guaranteed fail-open, so the
 * absence of data is reported as `unknown` and callers must treat `unknown` as
 * "do not proceed as if quota is available".
 *
 * `remainingPercent` is derived as `100 - max(usedPercent)`; the wire carries
 * USED percent, not remaining. `resetsAt` is epoch milliseconds, not a string.
 */
export type OpenClawQuota =
  | { state: 'unknown'; remainingPercent: null; resetsAt: null }
  | { state: 'known'; remainingPercent: number; resetsAt: number | null };

/**
 * Every provider this adapter can be asked ABOUT.
 *
 * `openai` is deliberately absent from `OpenClawImportableProvider` below: the
 * Codex credential is established by the user's own OAuth device flow inside
 * OpenClaw, so GBrain never holds a value to import for it. The asymmetry is
 * intentional — state it once here rather than leaving two hand-written unions
 * to drift.
 */
export type OpenClawProviderId = 'openai' | 'anthropic' | 'openrouter';

/** The subset for which GBrain can hand OpenClaw a credential to import. */
export type OpenClawImportableProvider = Exclude<OpenClawProviderId, 'openai'>;

export interface OpenClawProviderStatus {
  authenticated: boolean;
  authStatus: OpenClawAuthStatus;
  quota: OpenClawQuota;
}

export interface OpenClawGBrainIdentity {
  workspaceId: string;
  agentId: string;
  scopes: string[];
  sourceAccessMode: 'none' | 'specific' | 'all';
}

export interface OpenClawControl {
  runtimeHealth(): Promise<boolean>;
  applyNativePassword(password: string): Promise<void>;
  verifyNativePassword(password: string): Promise<boolean>;
  verifyNativePasswordRejected(password: string): Promise<boolean>;
  configureGBrainMcp(input: { token: string }): Promise<void>;
  probeGBrainWhoAmI(): Promise<OpenClawGBrainIdentity>;
  importProviderCredential(
    input: { provider: OpenClawImportableProvider; credential: string },
  ): Promise<void>;
  getProviderStatus(provider: OpenClawProviderId): Promise<OpenClawProviderStatus>;
  listModels(): Promise<string[]>;
  probeModel(model: string, prompt: string): Promise<{ text: string }>;
  probeDefaultAnswer(prompt: string): Promise<{ text: string }>;
}

export interface LoopbackOpenClawControlOptions {
  /** Must be `http://127.0.0.1:<port>`. Only the port varies (tests use an ephemeral one). */
  baseUrl?: string;
  internalUser?: string;
  requiredHeader?: string;
  /** Must be positive. Clamped to the 15s ceiling; only ever lowered. */
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Absent stays absent; PRESENT-but-wrong-typed is a defect, never a default.
 *
 * These two exist for the tool-policy walk below, where every "coerce a bad
 * value to an empty one" shortcut degrades into "nothing is denied, nothing is
 * required, therefore the tool is exposed". An array `tools` silently becoming
 * `{}`, or a string `deny` becoming `[]`, is the same fail-open that let an
 * ARRAY `providers` pass a naive object check and read as `undefined` forever.
 * Refusing to evaluate a policy we cannot parse is the only closed answer.
 */
function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw openClawSafeError('openclaw_mcp_probe_failed');
  return value;
}

function optionalArray(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw openClawSafeError('openclaw_mcp_probe_failed');
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

interface OpenClawResponse {
  status: number;
  body: unknown;
}

export class LoopbackOpenClawControl implements OpenClawControl {
  private readonly baseUrl: string;
  private readonly internalUser: string;
  private readonly requiredHeader: string;
  private readonly timeoutMs: number;

  constructor(options: LoopbackOpenClawControlOptions = {}) {
    const raw = options.baseUrl ?? OPENCLAW_DEFAULT_BASE_URL;
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new Error('openclaw_base_url_not_loopback'); }
    // Only the numeric loopback literal over plain HTTP. `localhost` is refused
    // because it resolves through DNS and can be repointed.
    if (parsed.protocol !== 'http:' || parsed.hostname !== OPENCLAW_LOOPBACK_HOST) {
      throw new Error('openclaw_base_url_not_loopback');
    }
    this.baseUrl = `${parsed.protocol}//${parsed.host}`;
    this.internalUser = options.internalUser ?? DEFAULT_INTERNAL_USER;
    this.requiredHeader = options.requiredHeader ?? DEFAULT_REQUIRED_HEADER;
    // A non-positive timeout is refused the same way a non-loopback URL is:
    // `AbortSignal.timeout(0)` aborts immediately, so it would silently turn
    // every call into `openclaw_unreachable` — a self-inflicted outage that
    // reads as a dead gateway. NaN fails this test too, deliberately.
    const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
    if (!(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0)) {
      throw new Error('openclaw_timeout_not_positive');
    }
    this.timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
  }

  // --- transport -----------------------------------------------------------

  /**
   * The single outbound call site. Headers are built here and nowhere else, so
   * no caller can attach a cookie, forwarded, or authorization header.
   */
  private async post(
    path: string,
    payload: unknown,
    identity: { kind: 'operator'; model?: string } | { kind: 'password'; password: string },
  ): Promise<OpenClawResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (identity.kind === 'operator') {
      headers[OPENCLAW_USER_HEADER] = this.internalUser;
      headers[OPENCLAW_PROXY_HEADER] = this.requiredHeader;
      if (identity.model !== undefined) headers[OPENCLAW_MODEL_HEADER] = identity.model;
    } else {
      // Deliberate exception: a password probe carries ONLY the candidate
      // credential. Sending the trusted-proxy identity here would authenticate
      // the request regardless of the password and make every probe pass.
      headers.authorization = `Bearer ${identity.password}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw openClawSafeError('openclaw_unavailable');
    }

    const text = await readCappedText(response);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw openClawSafeError('openclaw_invalid_response'); }
    return { status: response.status, body };
  }

  /** Unwrap the admin-RPC `{ id, ok, payload | error }` envelope. */
  private async rpc(method: OpenClawRpcMethod, params: Record<string, unknown>): Promise<unknown> {
    if (!ALLOWED_RPC_METHODS.has(method)) throw openClawSafeError('openclaw_config_failed');
    const response = await this.post(OPENCLAW_ADMIN_RPC, { method, params }, { kind: 'operator' });
    return unwrapAdminRpc(response, 'openclaw_unavailable');
  }

  // --- health --------------------------------------------------------------

  async runtimeHealth(): Promise<boolean> {
    try {
      return isHealthSummary(await this.rpc('health', {}));
    } catch {
      // A non-2xx, malformed, oversized, or unreachable gateway is not healthy.
      return false;
    }
  }

  // --- configuration -------------------------------------------------------

  /**
   * Merge-patch an existing configuration under its current hash. `config.apply`
   * is never used: it replaces the whole configuration and would silently drop
   * everything the image baked in.
   */
  private async patchConfig(mergePatch: Record<string, unknown>, replacePaths: string[]): Promise<void> {
    for (let attempt = 0; attempt < MAX_CONFIG_PATCH_ATTEMPTS; attempt += 1) {
      // `config.get` returns a SECRET-REDACTED snapshot. Only `hash` is read
      // from it, and `mergePatch` is built entirely from this adapter's own
      // arguments, so no redaction sentinel can ever be written back.
      const current = await this.rpc('config.get', {});
      if (!isRecord(current) || !nonEmptyString(current.hash)) {
        // The snapshot's `hash` is optional in the pinned type; the gateway then
        // derives it from `raw`, which reaches us redacted and would hash to the
        // wrong value. Refuse rather than guess.
        throw openClawSafeError('openclaw_config_failed');
      }
      // JSON is a strict subset of JSON5, so the serialized patch is a valid
      // `raw` document without pulling in a JSON5 dependency.
      const response = await this.post(OPENCLAW_ADMIN_RPC, {
        method: 'config.patch',
        params: { raw: JSON.stringify(mergePatch), baseHash: current.hash, replacePaths },
      }, { kind: 'operator' });
      if (isAdminRpcSuccess(response)) return;
      if (!isConfigBaseHashConflict(response)) throw openClawSafeError('openclaw_config_failed');
    }
    throw openClawSafeError('openclaw_config_failed');
  }

  async applyNativePassword(password: string): Promise<void> {
    // `gateway.reload.mode: hybrid` is pinned in the same write so the auth
    // change itself triggers the Gateway restart; no second explicit restart.
    await this.patchConfig({
      gateway: { reload: { mode: 'hybrid' }, auth: { password } },
    }, []);
  }

  async configureGBrainMcp(input: { token: string }): Promise<void> {
    await this.patchConfig({
      mcp: {
        servers: {
          gbrain: {
            url: GBRAIN_MCP_URL,
            transport: 'streamable-http',
            headers: { Authorization: `Bearer ${input.token}` },
          },
        },
      },
    }, []);
  }

  // --- native password proof ----------------------------------------------

  /**
   * True only on the pinned `HealthSummary` payload under the candidate
   * credential. `HealthSummary` is `{ ok: true, ts, durationMs, ... }` — there
   * is no `status` field; `{"status":"ok"}` belongs to the unauthenticated
   * `GET /health` liveness probe, which is a different endpoint.
   *
   * A `429` rate-limit answer is NOT acceptance: it means the gateway never
   * evaluated the credential.
   */
  async verifyNativePassword(password: string): Promise<boolean> {
    let response: OpenClawResponse;
    try {
      response = await this.probeWithPassword(password);
    } catch {
      return false;
    }
    if (!isAdminRpcSuccess(response)) return false;
    return isHealthSummary((response.body as Record<string, unknown>).payload);
  }

  /**
   * True only on the pinned auth refusal — `401 { error: { message, type:
   * 'unauthorized' } }` (there is no `ok` field and no `error.code` on this
   * body). A network error, timeout, parse failure, or unrelated 5xx proves
   * nothing about the credential and must not be reported as a rejection —
   * otherwise an unreachable gateway would let a rotation claim the old
   * password was retired.
   *
   * `429 { error: { type: 'rate_limited' } }` (with `Retry-After`) is likewise
   * NOT a rejection: repeated auth failures rate-limit the endpoint before the
   * credential is checked, so the answer is "unknown" in BOTH directions. Both
   * probes return false for it, which fails closed — a rotation cannot be
   * confirmed accepted or confirmed retired on a rate-limited gateway.
   */
  async verifyNativePasswordRejected(password: string): Promise<boolean> {
    let response: OpenClawResponse;
    try {
      response = await this.probeWithPassword(password);
    } catch {
      return false;
    }
    if (response.status !== 401 || !isRecord(response.body)) return false;
    const error = response.body.error;
    return isRecord(error) && error.type === 'unauthorized';
  }

  private probeWithPassword(password: string): Promise<OpenClawResponse> {
    return this.post(OPENCLAW_ADMIN_RPC, { method: 'health', params: {} }, { kind: 'password', password });
  }

  // --- MCP identity probe --------------------------------------------------

  async probeGBrainWhoAmI(): Promise<OpenClawGBrainIdentity> {
    await this.assertProjectedToolExposed();
    const response = await this.post(
      OPENCLAW_TOOLS_INVOKE,
      { tool: GBRAIN_MCP_TOOL, args: {} },
      { kind: 'operator' },
    );
    // `/tools/invoke` answers `{ ok, result }` — a different envelope from the
    // admin RPC `{ id, ok, payload }` above. Deliberately a separate unwrapper.
    const result = unwrapToolsInvoke(response, 'openclaw_mcp_probe_failed');
    return projectAgentIdentity(result);
  }

  /**
   * A tool policy that hides the projected MCP tool is a configuration defect,
   * not a runtime failure — distinguishing them keeps readiness diagnosable.
   *
   * Evaluated against the pinned profile table (docs/gateway/config-tools.md):
   * an ABSENT `tools.profile` is the `full` profile ("No restriction (same as
   * unset)"), `coding` and `messaging` implicitly allow `bundle-mcp`, and
   * `minimal` exposes `session_status` only. `gateway.tools.deny` is a separate
   * hard-deny list that also applies to `/tools/invoke`, so it is checked too.
   */
  private async assertProjectedToolExposed(): Promise<void> {
    const snapshot = await this.rpc('config.get', {});
    // An invalid config comes back with `config` redacted to `{}`, which would
    // otherwise read as an unrestricted policy. Refuse to evaluate it.
    if (!isRecord(snapshot) || snapshot.valid !== true) {
      throw openClawSafeError('openclaw_mcp_probe_failed');
    }
    const config = snapshot.config;
    if (!isRecord(config)) throw openClawSafeError('openclaw_mcp_probe_failed');

    const names = [GBRAIN_MCP_TOOL, GBRAIN_MCP_BUNDLE];
    const tools = optionalRecord(config.tools) ?? {};
    const profile = tools.profile;
    // Unset is `full`. Any other value must be a known MCP-exposing profile;
    // an unrecognized profile string fails closed rather than being assumed open.
    if (profile !== undefined && !(typeof profile === 'string' && MCP_EXPOSING_TOOL_PROFILES.has(profile))) {
      throw openClawSafeError('openclaw_mcp_probe_failed');
    }
    const deny = optionalArray(tools.deny) ?? [];
    if (names.some(name => deny.includes(name))) {
      throw openClawSafeError('openclaw_mcp_probe_failed');
    }
    const allow = optionalArray(tools.allow);
    if (allow !== undefined && !names.some(name => allow.includes(name))) {
      throw openClawSafeError('openclaw_mcp_probe_failed');
    }
    const gateway = optionalRecord(config.gateway);
    const gatewayTools = optionalRecord(gateway?.tools);
    const hardDeny = optionalArray(gatewayTools?.deny) ?? [];
    if (names.some(name => hardDeny.includes(name))) {
      throw openClawSafeError('openclaw_mcp_probe_failed');
    }
  }

  // --- providers -----------------------------------------------------------

  async importProviderCredential(
    input: { provider: OpenClawImportableProvider; credential: string },
  ): Promise<void> {
    let response: OpenClawResponse;
    try {
      response = await this.post(
        OPENCLAW_PROVIDER_IMPORT,
        { provider: input.provider, credential: input.credential },
        { kind: 'operator' },
      );
    } catch {
      // Collapse transport failures into the single import code so no captured
      // request or response text can travel with the error.
      throw openClawSafeError('openclaw_provider_import_failed');
    }
    if (response.status !== 200 || !isRecord(response.body) || response.body.ok !== true) {
      throw openClawSafeError('openclaw_provider_import_failed');
    }
  }

  /**
   * One call, deliberately. Quota is read from the `usage` field EMBEDDED in the
   * `models.authStatus` provider snapshot rather than from a second
   * `usage.status` RPC, because the two surfaces use different provider-id
   * namespaces — `models.authStatus[].provider` is the CONFIG id while
   * `usage.status[].provider` is the USAGE id (e.g. `minimax-portal` and
   * `minimax-cn` collapse to `minimax`). Joining them by string equality
   * silently mismatches for those providers. The gateway already performs that
   * join correctly and embeds the result, so reading the embedded field is both
   * the cheaper and the only correct option. No existing caller needs the raw
   * `usage.status` snapshot, so that method is not in this adapter's allowlist.
   *
   * The gateway's enrichment is wrapped in a swallowing try/catch upstream, so
   * the embedded field is also absent-on-failure — which is exactly why the
   * quota projection below fails closed on absence.
   *
   * `refresh: true` bypasses the gateway's 60s auth cache, so a logout is not
   * masked by up to a minute of stale `ok`. The shipped CLI does the same.
   */
  async getProviderStatus(provider: OpenClawProviderId): Promise<OpenClawProviderStatus> {
    const payload = await this.rpc('models.authStatus', { refresh: true });
    const entry = authProviderEntry(payload, provider);
    const authStatus = projectAuthStatus(entry);
    return {
      // `static` is NOT authentication: it only says a non-expiring api_key
      // entry exists, never that the key works.
      authenticated: authStatus === 'ok' || authStatus === 'expiring',
      authStatus,
      quota: projectQuota(entry?.usage),
    };
  }

  /**
   * `models.list` answers `{ models: ModelCatalogEntry[] }`, where each entry is
   * an object with a bare `id` plus its `provider` — not a flat string list.
   * Entries are projected to the gateway's own `provider/model` key form
   * (`modelKey()`), which is what `x-openclaw-model` accepts.
   */
  async listModels(): Promise<string[]> {
    const payload = await this.rpc('models.list', {});
    const models = isRecord(payload) ? payload.models : undefined;
    if (!Array.isArray(models)) throw openClawSafeError('openclaw_invalid_response');
    return models.map(entry => {
      if (!isRecord(entry) || !nonEmptyString(entry.id) || !nonEmptyString(entry.provider)) {
        throw openClawSafeError('openclaw_invalid_response');
      }
      const id = entry.id.trim();
      const provider = entry.provider.trim();
      return id.toLowerCase().startsWith(`${provider.toLowerCase()}/`) ? id : `${provider}/${id}`;
    });
  }

  /**
   * Catalog membership plus the exact outbound override is the only evidence
   * that the requested backend answered. `response.model` merely echoes the
   * request target and is deliberately ignored.
   */
  async probeModel(model: string, prompt: string): Promise<{ text: string }> {
    const catalog = await this.listModels();
    if (!catalog.includes(model)) throw openClawSafeError('openclaw_required_model_missing');

    let response: OpenClawResponse;
    try {
      // `model` is required by `CreateResponseBodySchema` and must be an AGENT
      // target; the backend override travels in `x-openclaw-model`. The schema
      // is `.strict()`, so no extra keys may be sent.
      response = await this.post(
        OPENCLAW_RESPONSES,
        { model: OPENCLAW_AGENT_TARGET_MODEL, input: prompt, stream: false },
        { kind: 'operator', model },
      );
    } catch {
      throw openClawSafeError('openclaw_model_probe_failed');
    }
    if (response.status !== 200) throw openClawSafeError('openclaw_model_probe_failed');
    const text = extractResponseText(response.body);
    if (text === undefined) throw openClawSafeError('openclaw_model_probe_failed');
    return { text };
  }

  /**
   * The same call as `probeModel` with the `x-openclaw-model` header OMITTED,
   * which is what makes it a proof of the CONFIGURED default/fallback chain
   * rather than of one hand-picked backend.
   *
   * Verified against the pinned openclaw@2026.7.1-2 tarball rather than assumed:
   *
   *   dist/http-utils-B0BcglUl.js:62-63 — `resolveOpenAiCompatModelOverride`
   *     reads the header and, when it is absent or blank, returns `{}`: no
   *     `modelOverride` and, crucially, no `errorMessage`.
   *   dist/openresponses-http-DPyXZf-A.js:652-663 — only a truthy `errorMessage`
   *     produces a 400, so an absent header is not an error.
   *   dist/openresponses-http-DPyXZf-A.js:592,599 — the run is then dispatched
   *     with `model: undefined` and `allowModelOverride: false`, i.e. under the
   *     selected agent's own configured model and fallback order.
   *   docs/gateway/openai-http-api.md:97 — "If you omit `x-openclaw-model`, the
   *     selected agent runs with its normal configured model."
   *
   * There is deliberately no `listModels()` call here: no backend model is being
   * requested, so catalog membership would be a check of something this probe
   * never selects. `response.model` echoes the request TARGET and is ignored for
   * the same reason it is ignored in `probeModel`.
   */
  async probeDefaultAnswer(prompt: string): Promise<{ text: string }> {
    let response: OpenClawResponse;
    try {
      response = await this.post(
        OPENCLAW_RESPONSES,
        { model: OPENCLAW_AGENT_TARGET_MODEL, input: prompt, stream: false },
        // No `model` key at all: `post` only sets the override header when one
        // is present, so the header is absent rather than blank.
        { kind: 'operator' },
      );
    } catch {
      throw openClawSafeError('openclaw_model_probe_failed');
    }
    if (response.status !== 200) throw openClawSafeError('openclaw_model_probe_failed');
    const text = extractResponseText(response.body);
    if (text === undefined) throw openClawSafeError('openclaw_model_probe_failed');
    return { text };
  }
}

// --- pure projections --------------------------------------------------------

/**
 * Admin RPC success is `200 { id, ok: true, payload }`. Note the key: it is
 * `payload`, NOT `result`. Handled failures answer `{ id, ok: false, error: {
 * code, message } }` with UPPERCASE codes (`INVALID_REQUEST`, `UNAVAILABLE`,
 * `AGENT_TIMEOUT`, `NOT_LINKED`, `NOT_PAIRED`, `APPROVAL_NOT_FOUND`) mapped to
 * 400/503/504/409/404; route-level failures (405, 413, unparseable body) answer
 * `{ ok: false, error: { type, message } }` with no `code` at all.
 */
function isAdminRpcSuccess(response: OpenClawResponse): boolean {
  return response.status === 200
    && isRecord(response.body)
    && response.body.ok === true
    && Object.hasOwn(response.body, 'payload');
}

function unwrapAdminRpc(response: OpenClawResponse, failure: OpenClawControlErrorCode): unknown {
  if (!isAdminRpcSuccess(response)) throw openClawSafeError(failure);
  return (response.body as Record<string, unknown>).payload;
}

/**
 * `/tools/invoke` is a DIFFERENT surface with a different envelope:
 * `200 { ok: true, result }`. It is unwrapped separately on purpose — sharing
 * one unwrapper with the admin RPC above is exactly how the two got conflated.
 */
function unwrapToolsInvoke(response: OpenClawResponse, failure: OpenClawControlErrorCode): unknown {
  if (
    response.status !== 200
    || !isRecord(response.body)
    || response.body.ok !== true
    || !Object.hasOwn(response.body, 'result')
  ) {
    throw openClawSafeError(failure);
  }
  return response.body.result;
}

/**
 * The one retry-eligible `config.patch` outcome. The gateway reports a stale
 * `baseHash` as a plain `INVALID_REQUEST` (HTTP 400) — the same code it uses for
 * every other rejected patch — so the ONLY distinguishing signal is the exact
 * message string.
 *
 * Matching on a human-readable message is fragile, so the comparison is exact
 * equality against the single pinned string, never a substring or fuzzy match.
 * If that message ever changes, this returns false and the caller throws
 * `openclaw_config_failed` — failing closed rather than retrying a write blindly.
 * The two sibling messages ("base hash unavailable" / "base hash required") are
 * deliberately excluded: we always send a `baseHash`, so they signal a defect
 * that retrying cannot fix. The message is only compared here and is never
 * stored, thrown, or logged.
 */
const CONFIG_BASE_HASH_CONFLICT_MESSAGE =
  'config changed since last load; re-run config.get and retry';

function isConfigBaseHashConflict(response: OpenClawResponse): boolean {
  if (response.status !== 400 || !isRecord(response.body) || response.body.ok !== false) return false;
  const error = response.body.error;
  return isRecord(error)
    && error.code === 'INVALID_REQUEST'
    && error.message === CONFIG_BASE_HASH_CONFLICT_MESSAGE;
}

/**
 * The pinned `HealthSummary` payload. It is `{ ok: true, ts, durationMs, ... }`;
 * there is NO `status` field. Requiring positive structural evidence (not just
 * HTTP 200, and not just a truthy object) is what keeps the password probe and
 * the health check fail-closed.
 */
function isHealthSummary(payload: unknown): boolean {
  return isRecord(payload)
    && payload.ok === true
    && typeof payload.ts === 'number'
    && typeof payload.durationMs === 'number';
}

function projectAgentIdentity(result: unknown): OpenClawGBrainIdentity {
  if (!isRecord(result)) throw openClawSafeError('openclaw_mcp_probe_failed');
  // Only the Agent transport is mappable. OAuth, legacy, local, and anything
  // unrecognized mean the MCP entry is not bound to the durable Agent.
  if (result.transport !== 'agent') throw openClawSafeError('openclaw_mcp_probe_failed');
  const mode = result.source_access_mode;
  if (
    !nonEmptyString(result.agent_id)
    || !nonEmptyString(result.workspace_id)
    || !Array.isArray(result.scopes)
    || result.scopes.some(scope => typeof scope !== 'string')
    || (mode !== 'none' && mode !== 'specific' && mode !== 'all')
  ) {
    throw openClawSafeError('openclaw_mcp_probe_failed');
  }
  return {
    workspaceId: result.workspace_id,
    agentId: result.agent_id,
    scopes: result.scopes as string[],
    sourceAccessMode: mode,
  };
}

/**
 * `payload.providers` is an ARRAY of provider snapshots keyed by a `provider`
 * FIELD — it is not a map. Indexing it like a map (`providers[provider]`) yields
 * `undefined` for every provider forever, silently, because an array also passes
 * a naive object check; `isRecord` therefore excludes arrays and the array shape
 * is required positively here.
 *
 * Absence fails closed. `resolveConfiguredProviders` deliberately omits
 * env/apiKey-backed providers from its "missing" synthesis, so a provider may be
 * absent whether or not a credential exists — absence proves nothing.
 */
function authProviderEntry(payload: unknown, provider: string): Record<string, unknown> | undefined {
  const providers = isRecord(payload) ? payload.providers : undefined;
  if (!Array.isArray(providers)) return undefined;
  const entry = providers.find(item => isRecord(item) && item.provider === provider);
  return isRecord(entry) ? entry : undefined;
}

const AUTH_STATUSES: ReadonlySet<string> = new Set<OpenClawAuthStatus>([
  'ok', 'expiring', 'expired', 'missing', 'static',
]);

function projectAuthStatus(entry: Record<string, unknown> | undefined): OpenClawAuthStatus {
  const status = entry?.status;
  // An unrecognized status string is not assumed benign.
  return typeof status === 'string' && AUTH_STATUSES.has(status)
    ? (status as OpenClawAuthStatus)
    : 'unknown';
}

const UNKNOWN_QUOTA: OpenClawQuota = { state: 'unknown', remainingPercent: null, resetsAt: null };

/**
 * Fail-closed quota projection over an embedded usage snapshot.
 *
 * `error` is checked FIRST and before `windows`, because a failed poll arrives
 * as `{ windows: [], error: 'Timeout' }` inside an `ok: true` envelope — a check
 * that only inspects `windows` reads a timeout as a healthy, unlimited provider.
 *
 * `billing` is read for nothing. `limit` exists only on `type: 'budget'`;
 * `balance` and `spend` carry `amount` and no limit, so any `used / limit`
 * arithmetic yields NaN or Infinity there. Quota comes from named windows only.
 */
function projectQuota(usage: unknown): OpenClawQuota {
  if (!isRecord(usage)) return UNKNOWN_QUOTA;
  if (usage.error !== undefined) return UNKNOWN_QUOTA;
  const windows = usage.windows;
  // The `length === 0` arm is defence in depth: the terminal `maxUsedPercent < 0`
  // guard below already rejects a snapshot from which no window was accepted.
  if (!Array.isArray(windows) || windows.length === 0) return UNKNOWN_QUOTA;

  let maxUsedPercent = -1;
  let resetsAt: number | null = null;
  for (const window of windows) {
    if (!isRecord(window)) return UNKNOWN_QUOTA;
    const used = window.usedPercent;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) {
      return UNKNOWN_QUOTA;
    }
    if (used > maxUsedPercent) {
      maxUsedPercent = used;
      // `resetAt` is epoch milliseconds and is OPTIONAL; it is never a string.
      resetsAt = typeof window.resetAt === 'number' && Number.isFinite(window.resetAt)
        ? window.resetAt
        : null;
    }
  }
  if (maxUsedPercent < 0) return UNKNOWN_QUOTA;
  return { state: 'known', remainingPercent: 100 - maxUsedPercent, resetsAt };
}

/**
 * `ResponseResourceSchema` has NO top-level `output_text`; `output_text` is a
 * content-PART type inside `output[].content[]`. That walk is the only live
 * path.
 */
function extractResponseText(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  // Allowlist, not denylist. `probeModel` feeds the `*_verified` readiness
  // blockers, so partial text from an `in_progress`, `incomplete`, or `queued`
  // run must not count as proof that the model answered — and a run with no
  // terminal status at all proves even less. Only `completed` is evidence.
  if (body.status !== 'completed') return undefined;
  if (!Array.isArray(body.output)) return undefined;
  for (const item of body.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && nonEmptyString(part.text)) {
        return part.text.trim();
      }
    }
  }
  return undefined;
}

/** Read at most 1 MiB, aborting the stream instead of buffering a hostile body. */
async function readCappedText(response: Response): Promise<string> {
  const stream = response.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw openClawSafeError('openclaw_invalid_response');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OpenClawControlError) throw error;
    throw openClawSafeError('openclaw_unavailable');
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

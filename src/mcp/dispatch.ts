/**
 * Shared MCP tool-call dispatch — single source of truth for stdio + HTTP transports.
 *
 * Both transports validate the same params, build the same OperationContext shape,
 * and serialize errors identically. Drift between transports caused PR #483's reversed-args
 * + missing-context bugs; this module exists to prevent that recurring.
 */

import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError, sourceAccessRequiredError } from '../core/operations.ts';
import type { Operation, OperationContext, AuthInfo } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { hasScope } from '../core/scope.ts';
import { resolveOperationSourceAccess } from '../workspace/source-access.ts';
import type { SourceAccessPrincipal } from '../workspace/source-access.ts';
import type { RemoteAuthorizationContext } from '../workspace/authorization-context.ts';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /**
   * v0.31 (eD3): MCP spec-blessed metadata slot for server-supplied data.
   * The dispatcher injects `_meta.brain_hot_memory` here when an op succeeds
   * and the configured `metaHook` returns a payload.
   *
   * Existing clients ignore unknown `_meta` fields; capable clients (Claude
   * Code, Claude Desktop) read it. NOT a wrapper around the result body —
   * `content` stays the same shape it always had. Best-effort: any error in
   * the meta hook is absorbed and the tool call still succeeds.
   */
  _meta?: Record<string, unknown>;
}

export interface DispatchOpts {
  /** Canonical authorization contract for every remote/untrusted caller. */
  authorization?: RemoteAuthorizationContext;
  /** @deprecated Remote production callers must use `authorization`. Trusted local callers pass false. */
  remote?: boolean;
  /** Override the default stderr logger (e.g. CLI uses console.* directly). */
  logger?: OperationContext['logger'];
  /**
   * v0.28: per-token allow-list for the takes.holder field. Threaded by
   * the HTTP/stdio transport from `access_tokens.permissions.takes_holders`.
   * When set, takes_list / takes_search / query (when it returns takes)
   * MUST filter `WHERE holder = ANY($takesHoldersAllowList)`. Local CLI
   * callers leave this unset (no filter — they own the brain).
   */
  takesHoldersAllowList?: string[];
  /**
   * v0.31 (eD4): tenancy axis for facts hot memory ops (extract_facts,
   * recall, forget_fact). When set, the OperationContext receives a
   * matching `sourceId`. CLI dispatch resolves this from --source flag /
   * GBRAIN_SOURCE / .gbrain-source / 'default'; HTTP MCP transport
   * resolves it from the per-token allow-list (eE3).
   */
  /** @deprecated Remote production callers carry their write Source in `authorization`. */
  sourceId?: string;
  /**
   * v0.31 (eD3): hook called by the dispatcher AFTER op.handler succeeds
   * to compute `_meta.brain_hot_memory` for the response. Wrapped in its
   * own try/catch (eE4) so a DB blip in the helper degrades to no _meta
   * rather than flipping the whole tool call to error.
   *
   * Returning undefined means "no _meta to inject"; the dispatcher
   * preserves the existing response shape.
   */
  metaHook?: (
    name: string,
    ctx: OperationContext,
  ) => Promise<Record<string, unknown> | undefined>;
  /**
   * OAuth auth info threaded through from the HTTP MCP transport. Set so
   * the whoami op (and any future scope-aware op handlers) can introspect
   * the calling identity. Without this, every whoami call from HTTP
   * transports throws unknown_transport — the v0.31 D12 / eE1 refactor
   * silently dropped this field when the inlined OperationContext literal
   * was replaced by dispatchToolCall.
   */
  /** @deprecated Remote production callers carry AuthInfo in `authorization`. */
  auth?: AuthInfo;
  /** @deprecated Remote production callers carry their principal in `authorization`. */
  sourceAccessPrincipal?: SourceAccessPrincipal;
}

/**
 * Build a privacy-safe summary of MCP request params for logging + the admin
 * SSE feed.
 *
 * The previous default of `JSON.stringify(params)` wrote raw payloads —
 * page bodies, search queries, file paths — into `mcp_request_log` and
 * broadcast them to every connected admin browser. For a personal-knowledge
 * brain those payloads include private notes about real people / deals /
 * companies, retained indefinitely.
 *
 * The redactor returns the SHAPE of the request (what op was called, which
 * declared params were passed, approximate size) without any of the values.
 *
 * Hardening note (codex C8): a naive "dump all submitted keys" summary still
 * leaks via attacker-controlled key names — a caller can submit
 * `put_page {"wiki/people/sensitive_name": "..."}` and the key becomes a
 * persistent log entry. To prevent this, we intersect submitted keys
 * against the operation's declared `params` allow-list (the same definition
 * `validateParams` reads). Anything outside the allow-list is counted but
 * not named.
 *
 * Operators who want full payloads for debugging set `--log-full-params` on
 * `gbrain serve --http`; that path bypasses this helper and writes the raw
 * JSON, with a loud startup warning.
 */
export interface ParamSummary {
  redacted: true;
  kind: 'array' | 'object' | string;
  declared_keys?: string[];
  unknown_key_count?: number;
  length?: number;
  approx_bytes?: number;
}

/**
 * Round a byte count UP to the nearest 1KB so the redacted summary keeps a
 * coarse size signal without enabling a size-based side channel.
 *
 * Why bucketing matters: the previous shape published `approx_bytes` as the
 * exact JSON.stringify(params).length. An attacker who can submit
 * `put_page` with a known prefix and observe the resulting log entry
 * could binary-search the byte length of secret content (the body the
 * legitimate user just wrote) via repeated probes. Bucketing to 1KB
 * resolution destroys that channel while preserving the operator-useful
 * "roughly how large was the request" signal.
 */
function bucketBytes(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  if (n <= 0) return 0;
  const KB = 1024;
  return Math.ceil(n / KB) * KB;
}

export function summarizeMcpParams(opName: string, params: unknown): ParamSummary | null {
  if (params == null) return null;

  let approxBytes: number | undefined;
  try { approxBytes = bucketBytes(JSON.stringify(params).length); } catch { approxBytes = undefined; }

  if (Array.isArray(params)) {
    return {
      redacted: true,
      kind: 'array',
      length: params.length,
      ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
    };
  }

  if (typeof params === 'object') {
    const submittedKeys = Object.keys(params as Record<string, unknown>);
    const op = operations.find(o => o.name === opName);
    const allowList = op ? new Set(Object.keys(op.params)) : new Set<string>();
    const declared: string[] = [];
    let unknown = 0;
    for (const k of submittedKeys) {
      if (allowList.has(k)) declared.push(k);
      else unknown += 1;
    }
    declared.sort();
    return {
      redacted: true,
      kind: 'object',
      declared_keys: declared,
      unknown_key_count: unknown,
      ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
    };
  }

  return {
    redacted: true,
    kind: typeof params,
    ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
  };
}

/** Validate required params exist and have the expected type. Returns null on success, error message on failure. */
export function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
    }
  }
  return null;
}

const stderrLogger: OperationContext['logger'] = {
  info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
};

function isRemoteDispatch(opts: DispatchOpts): boolean {
  return opts.authorization !== undefined || opts.remote !== false;
}

export function buildOperationContext(
  engine: BrainEngine,
  params: Record<string, unknown>,
  opts: DispatchOpts = {},
): OperationContext {
  const remote = isRemoteDispatch(opts);
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: opts.logger || stderrLogger,
    dryRun: !!params.dry_run,
    remote,
    takesHoldersAllowList: opts.takesHoldersAllowList,
    // sourceId remains required at the type level. Only trusted local callers
    // receive the compatibility default; remote write targets must be explicit.
    sourceId: opts.authorization?.writeSourceId ?? opts.sourceId ?? (remote === false ? 'default' : ''),
    auth: opts.authorization?.auth ?? opts.auth,
  };
}

/**
 * Resolve operation, validate params, build context, invoke handler, format result.
 *
 * Returns a `ToolResult` with the same shape both MCP transports need:
 * `{ content: [{ type: 'text', text }], isError?: boolean }`.
 */
export async function dispatchToolCall(
  engine: BrainEngine,
  name: string,
  params: Record<string, unknown> | undefined,
  opts: DispatchOpts = {},
): Promise<ToolResult> {
  const op = operations.find(o => o.name === name);
  if (!op) {
    // Always return JSON-shaped error content. v0.31 e2e tests
    // (sources-remote-mcp.test.ts) parse content via JSON.parse so a
    // plain `Error: ...` string here breaks the contract on every
    // unknown-op path and the resulting test failure looked like a
    // transport bug.
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool', message: `Unknown tool: ${name}` }, null, 2) }],
      isError: true,
    };
  }

  if (op.localOnly && isRemoteDispatch(opts)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'permission_denied',
          message: 'This operation is available only to trusted local callers.',
        }, null, 2),
      }],
      isError: true,
    };
  }

  const safeParams = params || {};
  const validationError = validateParams(op, safeParams);
  if (validationError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }],
      isError: true,
    };
  }

  if (opts.authorization) {
    const requiredCapability = op.scope || 'read';
    if (!hasScope(opts.authorization.capabilities, requiredCapability)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'insufficient_scope',
            message: `Operation ${name} requires '${requiredCapability}' scope`,
          }, null, 2),
        }],
        isError: true,
      };
    }
  }

  const ctx = buildOperationContext(engine, safeParams, opts);

  // #50: member-bound consent tokens (#47) carry no credential write target,
  // so remote write dispatch resolves ctx.sourceId to ''. Honor an explicit
  // per-call source_id instead; the write gate below still requires the
  // target to be inside the caller's resolved Source Access, so this stays
  // fail-closed (ADR-0013) — an out-of-grant or missing target is refused,
  // never defaulted.
  if (op.scope === 'write' && !ctx.sourceId && typeof safeParams.source_id === 'string') {
    ctx.sourceId = safeParams.source_id;
  }

  try {
    ctx.sourceAccess = opts.authorization?.resolvePrincipalPolicy === false
      ? opts.authorization.sourceAccess
      : await resolveOperationSourceAccess(engine, {
          remote: ctx.remote,
          principal: opts.authorization?.principal ?? opts.sourceAccessPrincipal,
          credentialSourceIds: opts.authorization?.sourceAccess.sourceIds,
        });
    // KNOWN GAP: this gate only fires for `write`. `sources_admin` operations
    // (sources_add / sources_remove) never reach it, so an admin-capable
    // credential with No Source Access can still remove a Source. Accepted
    // ceiling of the #58 D8 scope mapping; see
    // docs/issues/source-access-fail-opens.md.
    if (
      op.scope === 'write'
      && ctx.sourceAccess?.kind === 'sources'
    ) {
      if (ctx.sourceAccess.sourceIds.length === 0) {
        throw sourceAccessRequiredError();
      }
      if (!ctx.sourceAccess.sourceIds.includes(ctx.sourceId)) {
        throw new OperationError(
          'permission_denied',
          'Source Access to the write target is required.',
          'Ask a Workspace Administrator to grant access to the target Source.',
        );
      }
    }
    const result = await op.handler(ctx, safeParams);
    const out: ToolResult = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    // v0.31 (eD3 + eE4): best-effort _meta.brain_hot_memory injection.
    // The hook is wrapped in its own try/catch — any DB blip / cache miss /
    // helper crash degrades to no `_meta` rather than flipping the whole
    // tool call to error.
    if (opts.metaHook) {
      try {
        const meta = await opts.metaHook(name, ctx);
        if (meta && Object.keys(meta).length > 0) out._meta = meta;
      } catch (metaErr) {
        const msg = metaErr instanceof Error ? metaErr.message : String(metaErr);
        ctx.logger.warn(`[mcp] _meta hook failed for ${name}: ${msg}; degrading to no-_meta`);
      }
    }
    return out;
  } catch (e: unknown) {
    if (e instanceof OperationError) {
      return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
    }
    // Non-OperationError (uncaught throws) — wrap in the same shape so
    // every error response is JSON-parseable. The pre-v0.31 path emitted
    // plain `Error: ${msg}` strings here, which broke any caller that
    // tried JSON.parse(content).
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'internal_error', message: msg }, null, 2) }],
      isError: true,
    };
  }
}

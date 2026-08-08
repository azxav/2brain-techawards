/**
 * Workspace adapter — the control plane's seam onto a provisioned Workspace.
 *
 * This is the HTTPS management lane: the control plane holds a per-workspace
 * bootstrap credential and talks to the Workspace's own public HTTP boundary.
 * It never reaches into the VM. Same shape as adapters/github.ts.
 *
 * Every call dials the workspace by its **IP address**, not by its hostname, and
 * presents the hostname only as the TLS SNI, the Host header, and the name the
 * certificate is checked against — `curl --resolve`, in Node. The control plane
 * creates the workspace's DNS record moments before it first talks to it, and a
 * lookup of a name that new can be answered NXDOMAIN and negative-cached by the
 * local resolver for the zone's SOA minimum (30 minutes here) — far longer than
 * the provision's whole health window. Dialing the IP the launch already handed
 * us removes DNS from the management lane entirely, so no early call can poison a
 * name the customer's browser will later resolve for itself.
 */
import { request as nodeHttpsRequest } from 'node:https';
import { AGENT_RUNTIME_HEALTH_PATH } from '../agent-ingress-contract.ts';

/**
 * Does this status PROVE the colocated agent runtime is alive? (#68)
 *
 * Exactly one status does: the bodiless `204` GBrain's runtime-health gate emits
 * after its loopback control adapter proved the OpenClaw Gateway answered. Every
 * other status is "not yet", including the whole 2xx family — the gate has no
 * other success answer, so a 200 means something else is serving that path.
 *
 * This replaces #57's `agentGatewayAnswered`, which asked the far weaker question
 * "did anything answer under /agent". That predicate accepted 200, 302 and 401,
 * and on the first real agent VM a workspace reached `running` on GBrain's own
 * 404 before the agent existed at all. The lesson is the recurring one in this
 * codebase: a presence check is not a fail-closed check. Do not widen this back
 * to a range, a `< 400`, or a `2xx`.
 *
 * Shared with FakeWorkspace so the fake cannot answer by a different rule.
 */
export function agentRuntimeHealthProven(status: number): boolean {
  return status === 204;
}

export class WorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'WorkspaceApiError';
  }
}

export interface IssueSetupLinkInput {
  baseUrl: string;
  /** The workspace's public address. The call dials this and validates the cert
   *  against the baseUrl hostname; DNS resolution of that hostname is bypassed. */
  ip: string;
  bootstrapCredential: string;
  /**
   * Stable across retries. The Workspace derives the token from this, so a
   * retried provision surfaces the same link instead of minting a second one.
   */
  idempotencyKey: string;
}

export interface WorkspaceAdapter {
  /**
   * False (never throws) while TLS or the service is still coming up. Dials `ip`
   * and validates the certificate against the `baseUrl` hostname.
   */
  probeHealth(baseUrl: string, ip: string): Promise<boolean>;
  /**
   * Agent-tier readiness (#68): true only when GBrain's own runtime-health gate
   * answers an exact 204, which it does only after proving the loopback OpenClaw
   * Gateway is alive. Every other status — and every transport fault — is "not
   * yet", so it returns false and lets the caller retry rather than throwing.
   */
  probeAgent(baseUrl: string, ip: string): Promise<boolean>;
  /** Returns the absolute single-use first-Administrator setup link. */
  issueSetupLink(input: IssueSetupLinkInput): Promise<string>;
}

// ---------------------------------------------------------------------------
// The direct-IP HTTPS port. The real adapter binds node:https; tests bind a
// recording fake. This is the seam fetch used to be, moved down one level so the
// connect address (an IP) and the certificate name (the hostname) can differ.
// ---------------------------------------------------------------------------

export interface DirectHttpsRequest {
  /** The address actually dialed. */
  host: string;
  /** The TLS SNI and the name the certificate is validated against. */
  servername: string;
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /**
   * Optional trust anchor replacing the system roots for this call — the seam
   * that lets the real-socket suite exercise the full success path against a
   * local TLS server with a fixture certificate. Verification stays strict
   * either way; production never sets it.
   */
  ca?: string;
}

export interface DirectHttpsResponse {
  status: number;
  body: string;
}

export type DirectHttpsFn = (request: DirectHttpsRequest, body: string | null) => Promise<DirectHttpsResponse>;

/**
 * node:https, not fetch: undici offers no per-request way to dial one address
 * while presenting another name for SNI and certificate validation, which is the
 * whole point here. `rejectUnauthorized` is left at its secure default, so a
 * self-signed or wrong-host certificate fails the call rather than passing it —
 * "healthy" has to mean a browser would trust this workspace, not merely that
 * something answered on 443.
 */
const nodeDirectHttps: DirectHttpsFn = (request, body) =>
  new Promise<DirectHttpsResponse>((outerResolve, outerReject) => {
    // Settling must not depend on any one event firing: under Bun's node:https
    // shim, `destroy(err)` emits no 'error', so a timeout that only destroys
    // leaves the promise pending forever — and with it the reconciler tick that
    // awaited it (#48). Every path below settles through here, exactly once.
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: { ok: DirectHttpsResponse } | { err: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if ('ok' in outcome) outerResolve(outcome.ok);
      else outerReject(outcome.err);
    };
    let responseStarted = false;
    const clientRequest = nodeHttpsRequest(
      {
        host: request.host,
        servername: request.servername,
        port: request.port,
        method: request.method,
        path: request.path,
        headers: request.headers,
        timeout: request.timeoutMs,
        ca: request.ca,
      },
      response => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk as Buffer));
        response.on('end', () => settle({ ok: { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') } }));
      },
    );
    clientRequest.on('error', error => settle({ err: error }));
    clientRequest.on('timeout', () => {
      // Reject first: destroy() may or may not emit anything afterwards.
      settle({ err: new Error(`workspace request timed out after ${request.timeoutMs}ms`) });
      clientRequest.destroy();
    });
    // A connection torn down before a response — reset, handshake abandoned —
    // must reject, not leave the promise waiting on a response that cannot come.
    // Only before a response, though: under Bun the request's 'close' fires
    // BEFORE the response's 'end', so rejecting unconditionally here discards
    // every successful response (found live, #48). Once a response has started,
    // 'end' resolves it, and a response truncated by a dying socket is caught by
    // the wall-clock deadline below.
    clientRequest.on('close', () => {
      if (!responseStarted) settle({ err: new Error('connection closed before a response') });
    });
    // Belt and braces: a hard wall-clock bound that owes nothing to the request's
    // own event semantics, so the guarantee holds on any runtime.
    deadline = setTimeout(() => {
      settle({ err: new Error(`workspace request timed out after ${request.timeoutMs}ms`) });
      clientRequest.destroy();
    }, request.timeoutMs + 1_000);
    if (body !== null) clientRequest.write(body);
    clientRequest.end();
  });

// ---------------------------------------------------------------------------
// Real implementation (the Workspace HTTP boundary), fetch injected for tests.
// ---------------------------------------------------------------------------

export interface HttpWorkspaceOptions {
  httpsImpl?: DirectHttpsFn;
  /** A management-lane call must not hang the reconciler tick. */
  timeoutMs?: number;
  /** See DirectHttpsRequest.ca — a test seam; production leaves it unset. */
  caCertPem?: string;
}

export class HttpWorkspace implements WorkspaceAdapter {
  private readonly httpsImpl: DirectHttpsFn;
  private readonly timeoutMs: number;
  private readonly caCertPem?: string;

  constructor(options: HttpWorkspaceOptions = {}) {
    this.httpsImpl = options.httpsImpl ?? nodeDirectHttps;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.caCertPem = options.caCertPem;
  }

  private port(url: URL): number {
    return url.port ? Number(url.port) : 443;
  }

  async probeHealth(baseUrl: string, ip: string): Promise<boolean> {
    const url = new URL(baseUrl);
    try {
      const response = await this.httpsImpl(
        {
          host: ip,
          servername: url.hostname,
          port: this.port(url),
          method: 'GET',
          path: '/health',
          headers: { host: url.hostname },
          timeoutMs: this.timeoutMs,
          ca: this.caCertPem,
        },
        null,
      );
      return response.status >= 200 && response.status < 300;
    } catch {
      // TLS still issuing, service still booting, a wrong-host cert mid-ACME: all
      // of these are "not yet", not "broken". The caller counts attempts.
      return false;
    }
  }

  async probeAgent(baseUrl: string, ip: string): Promise<boolean> {
    const url = new URL(baseUrl);
    try {
      const response = await this.httpsImpl(
        {
          host: ip,
          servername: url.hostname,
          port: this.port(url),
          method: 'GET',
          path: AGENT_RUNTIME_HEALTH_PATH,
          headers: { host: url.hostname },
          timeoutMs: this.timeoutMs,
          ca: this.caCertPem,
        },
        null,
      );
      return agentRuntimeHealthProven(response.status);
    } catch {
      // Nothing answering yet is "not yet", same as probeHealth. The caller counts attempts.
      return false;
    }
  }

  async issueSetupLink(input: IssueSetupLinkInput): Promise<string> {
    const url = new URL(input.baseUrl);
    // No email: ADR-0037 forbids the platform guessing an administrator
    // identity. The human enters it on the setup page itself.
    const payload = JSON.stringify({ purpose: 'setup', idempotency_key: input.idempotencyKey });
    let response: DirectHttpsResponse;
    try {
      response = await this.httpsImpl(
        {
          host: input.ip,
          servername: url.hostname,
          port: this.port(url),
          method: 'POST',
          path: '/api/workspace/v1/operator/links',
          headers: {
            host: url.hostname,
            authorization: `Bootstrap ${input.bootstrapCredential}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          },
          timeoutMs: this.timeoutMs,
          ca: this.caCertPem,
        },
        payload,
      );
    } catch (error) {
      throw new WorkspaceApiError(`setup link request failed to send: ${(error as Error).message}`, true);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new WorkspaceApiError(`setup link request returned ${response.status}`, response.status >= 500 || response.status === 429);
    }
    let token: string | undefined;
    try {
      token = (JSON.parse(response.body) as { data?: { token?: string } }).data?.token;
    } catch {
      throw new WorkspaceApiError('setup link response was not valid JSON', true);
    }
    if (!token) throw new WorkspaceApiError('setup link response carried no token', true);
    // The link the human clicks: hostname, not IP — their browser resolves it
    // normally, long after any propagation delay the control plane dodged.
    return `${input.baseUrl}/setup/${token}`;
  }
}

// ---------------------------------------------------------------------------
// In-memory fake for tests.
// ---------------------------------------------------------------------------

type WorkspaceOperation = 'probeHealth' | 'probeAgent' | 'issueSetupLink';

export class FakeWorkspace implements WorkspaceAdapter {
  /** Each probe records the baseUrl and the IP it was told to dial. */
  readonly healthProbes: Array<{ baseUrl: string; ip: string }> = [];
  /** Each agent probe records the baseUrl and the IP it was told to dial. */
  readonly agentProbes: Array<{ baseUrl: string; ip: string }> = [];
  readonly setupLinkRequests: IssueSetupLinkInput[] = [];
  private failures = new Map<WorkspaceOperation, WorkspaceApiError>();

  /** Set false to make the workspace stay unhealthy, as a slow boot would. */
  healthy = true;
  /**
   * What GBrain's runtime-health gate answers: a status, or null for nothing
   * answering. A status rather than a flag because the interesting failures are
   * not silence — they are GBrain's own 404 before the route exists, and any
   * other 2xx from something that is not the gate. It is mapped through the real
   * rule so the fake cannot be kinder than production.
   */
  agentStatus: number | null = 204;

  failNext(operation: WorkspaceOperation, message = `fake workspace ${operation} failure`, retryable = false): void {
    this.failures.set(operation, new WorkspaceApiError(message, retryable));
  }

  private guard(operation: WorkspaceOperation): void {
    const failure = this.failures.get(operation);
    if (!failure) return;
    this.failures.delete(operation);
    throw failure;
  }

  async probeHealth(baseUrl: string, ip: string): Promise<boolean> {
    this.guard('probeHealth');
    this.healthProbes.push({ baseUrl, ip });
    return this.healthy;
  }

  async probeAgent(baseUrl: string, ip: string): Promise<boolean> {
    this.guard('probeAgent');
    this.agentProbes.push({ baseUrl, ip });
    return this.agentStatus !== null && agentRuntimeHealthProven(this.agentStatus);
  }

  async issueSetupLink(input: IssueSetupLinkInput): Promise<string> {
    this.guard('issueSetupLink');
    this.setupLinkRequests.push({ ...input });
    // Mirror the real endpoint's idempotency: same key, same link.
    return `${input.baseUrl}/setup/fake-token-${input.idempotencyKey}`;
  }

  reset(): void {
    this.healthProbes.length = 0;
    this.agentProbes.length = 0;
    this.setupLinkRequests.length = 0;
    this.failures.clear();
    this.healthy = true;
    this.agentStatus = 204;
  }
}

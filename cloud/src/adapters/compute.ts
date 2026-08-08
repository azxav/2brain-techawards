/**
 * Compute adapter — the control plane's VM seam (Oracle Cloud Infrastructure).
 *
 * Same shape as adapters/github.ts: the provisioning state machine depends only
 * on the interface, production binds the real signed-REST implementation, tests
 * bind the in-memory fake.
 *
 * `displayName` is the dedupe key. It is derived from the workspace id, and the
 * state machine looks an instance up by name before launching, so a launch whose
 * acknowledgement was lost costs one wasted lookup rather than a second VM.
 */
import { createHash, createSign } from 'node:crypto';

export type ComputeInstanceState = 'provisioning' | 'running' | 'stopped' | 'terminated';

export interface ComputeInstance {
  ocid: string;
  displayName: string;
  state: ComputeInstanceState;
  /** Null until the VNIC is attached and a public address is assigned. */
  publicIp: string | null;
}

export interface LaunchInstanceInput {
  /** Stable, derived from the workspace id — the dedupe key described above. */
  displayName: string;
  /** Rendered cloud-init user-data. Carries per-workspace secrets: never log it. */
  cloudInit: string;
}

export class ComputeError extends Error {
  constructor(
    message: string,
    /** Transport and 5xx faults are worth another tick; a 4xx is not. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ComputeError';
  }
}

export interface ComputeAdapter {
  launchInstance(input: LaunchInstanceInput): Promise<ComputeInstance>;
  findInstanceByName(displayName: string): Promise<ComputeInstance | null>;
  getInstance(ocid: string): Promise<ComputeInstance | null>;
  /** Idempotent: terminating an unknown or already-terminated instance succeeds. */
  terminateInstance(ocid: string): Promise<void>;
  /**
   * Suspend: stop the VM, keeping its boot volume and its address. A graceful
   * shutdown, not a power cut — the workspace is a Postgres host and suspension
   * is an enforcement lever, not a way to corrupt someone's data.
   */
  stopInstance(ocid: string): Promise<void>;
  /** Resume. Idempotent: starting an already-running instance succeeds. */
  startInstance(ocid: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Real implementation (OCI Core Services), fetch injected for unit testing.
// ---------------------------------------------------------------------------

export interface OciCredentials {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  /** PEM-encoded RSA private key matching the fingerprint above. */
  privateKeyPem: string;
}

export interface OciComputeOptions {
  credentials: OciCredentials;
  region: string;
  compartmentOcid: string;
  availabilityDomain: string;
  subnetOcid: string;
  /**
   * The workspace network security group every launch attaches. OCI evaluates
   * the subnet security list and the NSG as a union, so the workspace's real
   * ingress policy — 80/443 open, SSH only from the control plane — has to ride
   * on an NSG the VM actually carries; without it the shared subnet list is the
   * only thing in force, and tightening that list cuts ingress for the whole
   * fleet. Required, not optional: a workspace launched with no NSG is a silent
   * hole, so index.ts refuses to boot without it rather than default it away.
   */
  nsgOcid: string;
  imageOcid: string;
  /**
   * Must be a Flex shape this image can boot AND this tenancy is offered — the
   * launch sends a shapeConfig, which fixed shapes reject, and a shape the
   * tenancy does not have earns a bare 404 (NotAuthorizedOrNotFound) rather than
   * anything that names the problem. `smoke-preflight.ts --discover` reads the
   * compatible list rather than guessing.
   */
  shape?: string;
  ocpus?: number;
  memoryInGbs?: number;
  bootVolumeSizeInGbs?: number;
  /**
   * A reconciler tick must not be able to block forever. Without this an OCI
   * connection that is accepted and then never answered hangs the tick — and
   * with it the whole provision — with no output and no way back to the
   * teardown path. The workspace adapter has carried this bound since it was
   * written; compute is the same lane and needs the same one.
   */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injected only by tests that assert the signing string. */
  now?: () => Date;
}

export const DEFAULT_OCI_INSTANCE_SHAPE = 'VM.Standard.A2.Flex';
export const DEFAULT_OCI_INSTANCE_OCPUS = 1;
export const DEFAULT_OCI_INSTANCE_MEMORY_GB = 4;
export const DEFAULT_OCI_INSTANCE_BOOT_VOLUME_GB = 50;

export function parseOciCapacityOverride(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a positive whole number when set`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number when set`);
  }
  return value;
}

export function parseOciShapeOverride(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
    throw new Error('OCI_INSTANCE_SHAPE must be a non-empty shape name when set');
  }
  return raw;
}

/**
 * OCI authenticates with draft-cavage HTTP signatures rather than a bearer
 * token. The signing string is one `name: value` line per signed header, joined
 * by newlines, with the request target line first. Bodies additionally sign
 * their sha256 so a tampered body invalidates the signature.
 *
 * Exported for unit testing: this is the one part of the adapter no fake can
 * exercise, so it is asserted directly rather than only through the smoke run.
 *
 * `contentType` defaults to `application/json` so existing (non-Object-Storage)
 * callers keep signing exactly what they signed before. Object Storage persists
 * the content type as object metadata, so a PUT must sign the type it actually
 * sends rather than inherit this default.
 */
/**
 * Marker for a POST whose body must be the empty string: signed (length,
 * type, digest) but absent, the only form OCI's InstanceAction accepts.
 */
const EMPTY_BODY = Symbol('oci-empty-body');

export function ociSigningHeaders(
  credentials: OciCredentials,
  method: string,
  url: URL,
  body: string | null,
  now: Date,
  contentType = 'application/json',
): Record<string, string> {
  const target = `${method.toLowerCase()} ${url.pathname}${url.search}`;
  const date = now.toUTCString();
  const signed: Array<[string, string]> = [
    ['(request-target)', target],
    ['host', url.host],
    ['date', date],
  ];
  const headers: Record<string, string> = { date, host: url.host };

  if (body !== null) {
    const contentSha = createHash('sha256').update(body).digest('base64');
    const length = String(Buffer.byteLength(body));
    signed.push(['content-length', length], ['content-type', contentType], ['x-content-sha256', contentSha]);
    headers['content-length'] = length;
    headers['content-type'] = contentType;
    headers['x-content-sha256'] = contentSha;
  }

  const signingString = signed.map(([name, value]) => `${name}: ${value}`).join('\n');
  const signature = createSign('RSA-SHA256').update(signingString).sign(credentials.privateKeyPem, 'base64');
  const keyId = `${credentials.tenancyOcid}/${credentials.userOcid}/${credentials.fingerprint}`;
  const headerNames = signed.map(([name]) => name).join(' ');
  headers.authorization =
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${headerNames}",signature="${signature}"`;
  return headers;
}

/** OCI's lifecycle vocabulary is wider than ours; collapse it to what we act on. */
function toInstanceState(lifecycleState: string): ComputeInstanceState {
  switch (lifecycleState) {
    case 'RUNNING':
      return 'running';
    case 'STOPPING':
    case 'STOPPED':
      return 'stopped';
    case 'TERMINATING':
    case 'TERMINATED':
      return 'terminated';
    default:
      return 'provisioning';
  }
}

interface OciInstanceBody {
  id: string;
  displayName: string;
  lifecycleState: string;
}

export class OciCompute implements ComputeAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OciComputeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.base = `https://iaas.${options.region}.oraclecloud.com`;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Bounds every OCI call, headers and body alike.
   *
   * An explicit controller rather than `AbortSignal.timeout`: under Bun that
   * signal's timer does not hold the event loop, so a call with nothing else
   * pending ends up waiting on an abort that never arrives — the very hang this
   * exists to prevent.
   */
  private async call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T | null> {
    const controller = new AbortController();
    const expiry = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), this.timeoutMs);
    try {
      return await this.send<T>(method, path, controller.signal, body, extraHeaders);
    } finally {
      clearTimeout(expiry);
    }
  }

  private async send<T>(
    method: string,
    path: string,
    signal: AbortSignal,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T | null> {
    const url = new URL(`${this.base}${path}`);
    const payload = body === undefined ? null : body === EMPTY_BODY ? '' : JSON.stringify(body);
    const headers = {
      ...ociSigningHeaders(this.options.credentials, method, url, payload, this.now()),
      accept: 'application/json',
      ...extraHeaders,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { method, headers, body: payload ?? undefined, signal });
    } catch (error) {
      // A transport fault says nothing about whether OCI acted: retryable. A
      // timeout is named as one rather than folded into the generic message,
      // because "the tick stopped here" is the single most useful thing an
      // operator can be told about a provision that stopped making progress.
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
        throw new ComputeError(`OCI ${method} ${path} timed out after ${this.timeoutMs}ms`, true);
      }
      throw new ComputeError(`OCI ${method} ${path} failed to send: ${(error as Error).message}`, true);
    }
    // 404 means "absent" only for a read. On a write it is OCI's
    // NotAuthorizedOrNotFound — a referenced image, subnet or compartment does
    // not exist or is invisible to this user — which is a hard rejection, not an
    // empty result. Mapping it to null on a launch reported "OCI accepted the
    // launch" for a request OCI had refused, and discarded the reason with it.
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) {
      // OCI's error body carries a machine-readable `code` alongside a `message`.
      // The message can echo request detail; the code is a bare classification
      // (NotAuthorizedOrNotFound, LimitExceeded, InvalidParameter), which is
      // exactly what an operator needs and safe to surface.
      let code = '';
      try {
        code = ((await response.json()) as { code?: string }).code ?? '';
      } catch {
        // Not every OCI error body is JSON; the status still tells the story.
      }
      throw new ComputeError(
        `OCI ${method} ${path} returned ${response.status}${code ? ` (${code})` : ''}`,
        response.status >= 500 || response.status === 429,
      );
    }
    if (response.status === 204) return null;
    return (await response.json()) as T;
  }

  async launchInstance(input: LaunchInstanceInput): Promise<ComputeInstance> {
    const body = {
      availabilityDomain: this.options.availabilityDomain,
      compartmentId: this.options.compartmentOcid,
      displayName: input.displayName,
      shape: this.options.shape ?? DEFAULT_OCI_INSTANCE_SHAPE,
      shapeConfig: {
        ocpus: this.options.ocpus ?? DEFAULT_OCI_INSTANCE_OCPUS,
        memoryInGBs: this.options.memoryInGbs ?? DEFAULT_OCI_INSTANCE_MEMORY_GB,
      },
      sourceDetails: {
        sourceType: 'image',
        imageId: this.options.imageOcid,
        bootVolumeSizeInGBs: this.options.bootVolumeSizeInGbs ?? DEFAULT_OCI_INSTANCE_BOOT_VOLUME_GB,
      },
      createVnicDetails: { subnetId: this.options.subnetOcid, assignPublicIp: true, nsgIds: [this.options.nsgOcid] },
      metadata: { user_data: Buffer.from(input.cloudInit, 'utf8').toString('base64') },
    };
    // Belt and braces with find-by-name: OCI dedupes on the retry token itself,
    // which covers the common case of a retry inside the token's lifetime.
    const created = await this.call<OciInstanceBody>('POST', '/20160918/instances', body, {
      'opc-retry-token': input.displayName,
    });
    if (!created) throw new ComputeError('OCI accepted the launch but returned no instance', true);
    return { ocid: created.id, displayName: created.displayName, state: toInstanceState(created.lifecycleState), publicIp: null };
  }

  async findInstanceByName(displayName: string): Promise<ComputeInstance | null> {
    const query = new URLSearchParams({ compartmentId: this.options.compartmentOcid, displayName });
    const found = await this.call<OciInstanceBody[]>('GET', `/20160918/instances?${query}`);
    // A terminated namesake must not be mistaken for a live instance, or a
    // retried provision would adopt a corpse instead of launching.
    const live = (found ?? []).find(instance => toInstanceState(instance.lifecycleState) !== 'terminated');
    return live ? this.hydrate(live) : null;
  }

  async getInstance(ocid: string): Promise<ComputeInstance | null> {
    const instance = await this.call<OciInstanceBody>('GET', `/20160918/instances/${encodeURIComponent(ocid)}`);
    return instance ? this.hydrate(instance) : null;
  }

  async terminateInstance(ocid: string): Promise<void> {
    try {
      await this.call('DELETE', `/20160918/instances/${encodeURIComponent(ocid)}`);
    } catch (error) {
      // Already gone is the outcome cleanup wanted. Only a read treats 404 as
      // absence, so this is the one write that has to say so for itself.
      if (error instanceof ComputeError && /returned 404/.test(error.message)) return;
      throw error;
    }
  }

  async stopInstance(ocid: string): Promise<void> {
    // SOFTSTOP asks the guest OS to shut down; STOP cuts the power. The
    // workspace runs Postgres, so the graceful form is the only correct one.
    await this.instanceAction(ocid, 'SOFTSTOP');
  }

  async startInstance(ocid: string): Promise<void> {
    await this.instanceAction(ocid, 'START');
  }

  /**
   * OCI models power operations as a POST to the instance with an `action`
   * query parameter. A 409 means the instance is already in (or heading to) the
   * requested state, which is the outcome the caller wanted; anything else is a
   * real failure and is left to the reconciler's retry counter.
   */
  private async instanceAction(ocid: string, action: 'SOFTSTOP' | 'START'): Promise<void> {
    const path = `/20160918/instances/${encodeURIComponent(ocid)}?action=${action}`;
    try {
      // The body must be EMPTY, not `{}`: InstanceAction parses any body it is
      // given as InstancePowerActionDetails, and these actions have no details
      // shape, so `{}` is a 400 InvalidParameter (proven against real OCI). The
      // signature still covers content-length, content-type and the digest —
      // of the empty string.
      await this.call('POST', path, EMPTY_BODY);
    } catch (error) {
      if (error instanceof ComputeError && /returned 409/.test(error.message)) return;
      throw error;
    }
  }

  /** The public address lives on the VNIC, two hops from the instance itself. */
  private async hydrate(instance: OciInstanceBody): Promise<ComputeInstance> {
    const base: ComputeInstance = {
      ocid: instance.id,
      displayName: instance.displayName,
      state: toInstanceState(instance.lifecycleState),
      publicIp: null,
    };
    if (base.state === 'terminated') return base;
    const query = new URLSearchParams({ compartmentId: this.options.compartmentOcid, instanceId: instance.id });
    const attachments = await this.call<Array<{ vnicId: string; lifecycleState: string }>>('GET', `/20160918/vnicAttachments?${query}`);
    const attached = (attachments ?? []).find(attachment => attachment.lifecycleState === 'ATTACHED');
    if (!attached) return base;
    const vnic = await this.call<{ publicIp: string | null }>('GET', `/20160918/vnics/${encodeURIComponent(attached.vnicId)}`);
    return { ...base, publicIp: vnic?.publicIp ?? null };
  }
}

// ---------------------------------------------------------------------------
// In-memory fake for tests.
// ---------------------------------------------------------------------------

type ComputeOperation =
  | 'launchInstance'
  | 'findInstanceByName'
  | 'getInstance'
  | 'terminateInstance'
  | 'stopInstance'
  | 'startInstance';

export class FakeCompute implements ComputeAdapter {
  /** Every launch ever attempted — the duplicate-launch assertion reads this. */
  readonly launches: LaunchInstanceInput[] = [];
  readonly terminated: string[] = [];
  readonly stopped: string[] = [];
  readonly started: string[] = [];
  private instances = new Map<string, ComputeInstance>();
  private counter = 0;
  private failures = new Map<ComputeOperation, ComputeError>();

  /** Set false to make a launched instance withhold its address, as OCI does. */
  assignPublicIpImmediately = true;

  /** Make the next call to `operation` throw, once. */
  failNext(operation: ComputeOperation, message = `fake compute ${operation} failure`, retryable = false): void {
    this.failures.set(operation, new ComputeError(message, retryable));
  }

  private guard(operation: ComputeOperation): void {
    const failure = this.failures.get(operation);
    if (!failure) return;
    this.failures.delete(operation);
    throw failure;
  }

  async launchInstance(input: LaunchInstanceInput): Promise<ComputeInstance> {
    this.guard('launchInstance');
    this.launches.push({ ...input });
    // OCI dedupes on opc-retry-token, which the real adapter sets to the display
    // name. Model that here: a fake that minted a fresh instance per call would
    // let a double launch pass a test that the real API would have refused, and
    // the retry token is what the "never two VMs" invariant actually rests on.
    const existing = [...this.instances.values()].find(
      candidate => candidate.displayName === input.displayName && candidate.state !== 'terminated',
    );
    if (existing) return { ...existing };
    const instance: ComputeInstance = {
      ocid: `ocid1.instance.fake.${++this.counter}`,
      displayName: input.displayName,
      state: 'running',
      publicIp: this.assignPublicIpImmediately ? `203.0.113.${this.counter}` : null,
    };
    this.instances.set(instance.ocid, instance);
    return { ...instance };
  }

  async findInstanceByName(displayName: string): Promise<ComputeInstance | null> {
    this.guard('findInstanceByName');
    for (const instance of this.instances.values()) {
      if (instance.displayName === displayName && instance.state !== 'terminated') return { ...instance };
    }
    return null;
  }

  async getInstance(ocid: string): Promise<ComputeInstance | null> {
    this.guard('getInstance');
    const instance = this.instances.get(ocid);
    return instance ? { ...instance } : null;
  }

  async terminateInstance(ocid: string): Promise<void> {
    this.guard('terminateInstance');
    this.terminated.push(ocid);
    const instance = this.instances.get(ocid);
    if (instance) this.instances.set(ocid, { ...instance, state: 'terminated', publicIp: null });
  }

  async stopInstance(ocid: string): Promise<void> {
    this.guard('stopInstance');
    this.stopped.push(ocid);
    const instance = this.instances.get(ocid);
    // A stopped instance keeps its ephemeral address, as OCI's does: that is why
    // suspend leaves the DNS record in place and resume does not need a new one.
    if (instance && instance.state !== 'terminated') this.instances.set(ocid, { ...instance, state: 'stopped' });
  }

  async startInstance(ocid: string): Promise<void> {
    this.guard('startInstance');
    this.started.push(ocid);
    const instance = this.instances.get(ocid);
    if (instance && instance.state !== 'terminated') this.instances.set(ocid, { ...instance, state: 'running' });
  }

  /** Give a withheld address to an instance, simulating OCI catching up. */
  attachPublicIp(ocid: string, publicIp = '203.0.113.200'): void {
    const instance = this.instances.get(ocid);
    if (instance) this.instances.set(ocid, { ...instance, state: 'running', publicIp });
  }

  /** Live (non-terminated) instances — the "no orphaned VM" assertion. */
  liveInstances(): ComputeInstance[] {
    return [...this.instances.values()].filter(instance => instance.state !== 'terminated');
  }

  reset(): void {
    this.launches.length = 0;
    this.terminated.length = 0;
    this.stopped.length = 0;
    this.started.length = 0;
    this.instances.clear();
    this.failures.clear();
    this.counter = 0;
    this.assignPublicIpImmediately = true;
  }
}

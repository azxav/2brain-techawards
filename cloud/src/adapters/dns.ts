/**
 * DNS adapter — the control plane's record seam (Cloudflare REST API).
 *
 * Cloudflare stays authoritative for the workspace zone (design decision for
 * #40); the control plane holds a token scoped to Zone:DNS:Edit on that zone
 * alone. Same shape as adapters/github.ts: interface, real implementation with
 * an injected fetch, in-memory fake beside it.
 */

export interface DnsRecord {
  id: string;
  name: string;
  ipv4: string;
}

export class DnsError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'DnsError';
  }
}

export interface DnsAdapter {
  findRecord(name: string): Promise<DnsRecord | null>;
  /** Idempotent by contract: creates, or returns/repoints an existing record. */
  upsertRecord(name: string, ipv4: string): Promise<DnsRecord>;
  /** Idempotent: deleting an unknown record succeeds. */
  deleteRecord(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Real implementation (Cloudflare), fetch injected for unit testing.
// ---------------------------------------------------------------------------

export interface CloudflareDnsOptions {
  apiToken: string;
  zoneId: string;
  /** Short by default: a provision waits on propagation before probing health. */
  ttlSeconds?: number;
  /** Same reason as the compute adapter's: a tick must not block forever. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

interface CloudflareRecord {
  id: string;
  name: string;
  content: string;
}

export class CloudflareDns implements DnsAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly ttl: number;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: CloudflareDnsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttl = options.ttlSeconds ?? 60;
    this.base = `https://api.cloudflare.com/client/v4/zones/${options.zoneId}/dns_records`;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Bounded for the same reason, and the same way, as the compute adapter's. */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const expiry = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), this.timeoutMs);
    try {
      return await this.send<T>(method, path, controller.signal, body);
    } finally {
      clearTimeout(expiry);
    }
  }

  private async send<T>(method: string, path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // Transport fault: Cloudflare may or may not have acted, so retry. A
      // timeout says so by name — see the compute adapter for why.
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
        throw new DnsError(`Cloudflare ${method} timed out after ${this.timeoutMs}ms`, true);
      }
      throw new DnsError(`Cloudflare ${method} failed to send: ${(error as Error).message}`, true);
    }
    if (!response.ok) {
      throw new DnsError(`Cloudflare ${method} returned ${response.status}`, response.status >= 500 || response.status === 429);
    }
    const envelope = (await response.json()) as CloudflareEnvelope<T>;
    if (!envelope.success) {
      // Cloudflare's error strings echo the record and zone; keep them out.
      throw new DnsError(`Cloudflare ${method} was refused`, false);
    }
    return envelope.result;
  }

  async findRecord(name: string): Promise<DnsRecord | null> {
    const query = new URLSearchParams({ type: 'A', name });
    const records = await this.call<CloudflareRecord[]>('GET', `?${query}`);
    const found = records[0];
    return found ? { id: found.id, name: found.name, ipv4: found.content } : null;
  }

  async upsertRecord(name: string, ipv4: string): Promise<DnsRecord> {
    // Look before creating: this is what makes a retried provision reuse the
    // record it already made instead of colliding with itself.
    const existing = await this.findRecord(name);
    if (existing?.ipv4 === ipv4) return existing;

    // proxied:false is load-bearing, not a default. The workspace VM terminates
    // its own TLS via ACME; proxying would intercept the challenge and the
    // certificate would never issue.
    const body = { type: 'A', name, content: ipv4, ttl: this.ttl, proxied: false };
    const record = existing
      ? await this.call<CloudflareRecord>('PATCH', `/${existing.id}`, body)
      : await this.call<CloudflareRecord>('POST', '', body);
    return { id: record.id, name: record.name, ipv4: record.content };
  }

  async deleteRecord(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/${id}`);
    } catch (error) {
      // Already gone is the outcome cleanup wanted.
      if (error instanceof DnsError && /returned 404/.test(error.message)) return;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory fake for tests.
// ---------------------------------------------------------------------------

type DnsOperation = 'findRecord' | 'upsertRecord' | 'deleteRecord';

export class FakeDns implements DnsAdapter {
  readonly upserts: Array<{ name: string; ipv4: string }> = [];
  readonly deletes: string[] = [];
  private records = new Map<string, DnsRecord>();
  private counter = 0;
  private failures = new Map<DnsOperation, DnsError>();

  failNext(operation: DnsOperation, message = `fake dns ${operation} failure`, retryable = false): void {
    this.failures.set(operation, new DnsError(message, retryable));
  }

  private guard(operation: DnsOperation): void {
    const failure = this.failures.get(operation);
    if (!failure) return;
    this.failures.delete(operation);
    throw failure;
  }

  async findRecord(name: string): Promise<DnsRecord | null> {
    this.guard('findRecord');
    const record = this.records.get(name);
    return record ? { ...record } : null;
  }

  async upsertRecord(name: string, ipv4: string): Promise<DnsRecord> {
    this.guard('upsertRecord');
    this.upserts.push({ name, ipv4 });
    const existing = this.records.get(name);
    const record: DnsRecord = { id: existing?.id ?? `fake-dns-${++this.counter}`, name, ipv4 };
    this.records.set(name, record);
    return { ...record };
  }

  async deleteRecord(id: string): Promise<void> {
    this.guard('deleteRecord');
    this.deletes.push(id);
    for (const [name, record] of this.records) if (record.id === id) this.records.delete(name);
  }

  /** Records still published — the "no orphaned DNS" assertion. */
  liveRecords(): DnsRecord[] {
    return [...this.records.values()].map(record => ({ ...record }));
  }

  reset(): void {
    this.upserts.length = 0;
    this.deletes.length = 0;
    this.records.clear();
    this.failures.clear();
    this.counter = 0;
  }
}

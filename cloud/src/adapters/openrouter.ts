/**
 * OpenRouter provisioned-key adapter — the platform embedding credential seam.
 *
 * Same shape as adapters/compute.ts: the provisioning state machine depends only
 * on the interface, production binds the real HTTPS implementation, tests bind
 * the in-memory fake.
 *
 * One key per workspace, minted from the platform's account with its own spend
 * limit, is the whole point: a fleet-wide key on a customer VM would be readable
 * by anyone who reaches that VM and would bill — and could exhaust — every other
 * workspace's embedding budget with it. A per-workspace key is capped,
 * individually revocable, and meters that workspace's usage on its own.
 *
 * The key name is the dedupe key, derived from the workspace id. OpenRouter
 * returns the key material exactly once, at creation, so a mint whose
 * acknowledgement was lost leaves a key nothing can ever use again: the mint
 * revokes a same-named predecessor rather than adopting it. That is safe only
 * because minting happens before the VM that consumes the key is launched.
 */

/** The one moment the key material exists outside OpenRouter. Never log it. */
export interface EmbeddingKey {
  /** OpenRouter's handle for the key — an identifier, not a credential. */
  hash: string;
  key: string;
}

export interface EmbeddingKeyStatus {
  hash: string;
  name: string;
  usageUsd: number;
  /** Null when the key carries no per-key cap. */
  limitUsd: number | null;
  disabled: boolean;
}

export class EmbeddingKeyError extends Error {
  constructor(
    message: string,
    /** Transport and 5xx faults are worth another tick; a 4xx is not. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'EmbeddingKeyError';
  }
}

export interface MintEmbeddingKeyInput {
  /** Stable, derived from the workspace id — the dedupe key described above. */
  name: string;
}

/** What a workspace may spend on embeddings before its own key stops working. */
export const DEFAULT_EMBEDDING_KEY_LIMIT_USD = 5;

/**
 * Every entrypoint that mints real keys parses the cap through here, so none of
 * them can reach OpenRouter with `NaN` — a limit the API reads as no limit at
 * all, which is the single property bounding what a key read off a VM can cost.
 * Whole dollars only, matching what the deploy's env validator accepts.
 */
export function parseEmbeddingKeyLimitUsd(value: string | undefined): number {
  if (value === undefined) return DEFAULT_EMBEDDING_KEY_LIMIT_USD;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new EmbeddingKeyError(`the embedding key spend limit must be a positive whole number of dollars, got '${value}'`);
  }
  return limit;
}

export interface EmbeddingKeyAdapter {
  /** Replaces any same-named key, so a repeated mint yields one live key. */
  mintKey(input: MintEmbeddingKeyInput): Promise<EmbeddingKey>;
  findKeyByName(name: string): Promise<EmbeddingKeyStatus | null>;
  readUsage(hash: string): Promise<EmbeddingKeyStatus | null>;
  /** Idempotent: revoking an unknown or already-revoked key succeeds. */
  revokeKey(hash: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Real implementation (OpenRouter provisioning API), fetch injected for testing.
// ---------------------------------------------------------------------------

export interface HttpOpenRouterKeysOptions {
  /**
   * A *provisioning* key, not an inference key: it can mint and revoke keys but
   * cannot itself be used to call a model. It never leaves the control plane.
   */
  provisioningKey: string;
  /** Default per-key spend cap, in US dollars. */
  limitUsd: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/** OpenRouter's own page size for the key listing. */
const KEY_PAGE_SIZE = 100;
/** A bound on the scan, not a fleet limit: ~10-20 live workspaces, plus history. */
const MAX_KEYS_SCANNED = 5000;

interface OpenRouterKeyBody {
  hash: string;
  name?: string;
  label?: string;
  limit?: number | null;
  usage?: number | null;
  disabled?: boolean;
}

function toStatus(body: OpenRouterKeyBody): EmbeddingKeyStatus {
  return {
    hash: body.hash,
    name: body.name ?? body.label ?? '',
    usageUsd: Number(body.usage ?? 0),
    limitUsd: body.limit === undefined || body.limit === null ? null : Number(body.limit),
    disabled: body.disabled === true,
  };
}

export class HttpOpenRouterKeys implements EmbeddingKeyAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(private readonly options: HttpOpenRouterKeysOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.base = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const url = `${this.base}${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.options.provisioningKey}`,
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: payload,
      });
    } catch (error) {
      // A transport fault says nothing about whether OpenRouter acted: retryable.
      throw new EmbeddingKeyError(`OpenRouter ${method} ${path} failed to send: ${(error as Error).message}`, true);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      // The status is the whole message on purpose: an OpenRouter error body can
      // echo the request, and this request carries the provisioning key.
      throw new EmbeddingKeyError(
        `OpenRouter ${method} ${path} returned ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }
    if (response.status === 204) return null;
    return (await response.json()) as T;
  }

  async mintKey(input: MintEmbeddingKeyInput): Promise<EmbeddingKey> {
    const existing = await this.findKeyByName(input.name);
    if (existing) await this.revokeKey(existing.hash);
    const created = await this.call<{ key?: string; data?: OpenRouterKeyBody }>('POST', '/keys', {
      name: input.name,
      limit: this.options.limitUsd,
    });
    if (!created?.key || !created.data?.hash) {
      // Retryable: the key may exist without us having learned it, and the next
      // mint replaces the same-named orphan rather than piling a second one up.
      throw new EmbeddingKeyError('OpenRouter accepted the key creation but returned no key', true);
    }
    return { hash: created.data.hash, key: created.key };
  }

  /**
   * Paged, and deliberately so. The listing includes disabled keys, so the
   * platform's account accumulates them for the fleet's whole life; reading only
   * the first page would let the orphan this lookup exists to find fall off the
   * end and be reported absent — a live, billable key nobody revokes.
   */
  async findKeyByName(name: string): Promise<EmbeddingKeyStatus | null> {
    for (let offset = 0; offset < MAX_KEYS_SCANNED; offset += KEY_PAGE_SIZE) {
      const listed = await this.call<{ data?: OpenRouterKeyBody[] }>(
        'GET',
        `/keys?include_disabled=true&offset=${offset}`,
      );
      const page = listed?.data ?? [];
      const match = page.find(key => (key.name ?? key.label) === name);
      if (match) return toStatus(match);
      if (page.length < KEY_PAGE_SIZE) return null;
    }
    // Not "absent": the scan ran out of pages to read. Saying null here would
    // report a clean account to a caller about to mint a duplicate or skip a
    // revocation.
    throw new EmbeddingKeyError(`scanned ${MAX_KEYS_SCANNED} OpenRouter keys without reaching the end of the list`, true);
  }

  async readUsage(hash: string): Promise<EmbeddingKeyStatus | null> {
    const found = await this.call<{ data?: OpenRouterKeyBody }>('GET', `/keys/${encodeURIComponent(hash)}`);
    return found?.data ? toStatus(found.data) : null;
  }

  async revokeKey(hash: string): Promise<void> {
    // `call` maps 404 to null, which is exactly what cleanup wanted: already gone.
    await this.call('DELETE', `/keys/${encodeURIComponent(hash)}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory fake for tests.
// ---------------------------------------------------------------------------

type EmbeddingKeyOperation = 'mintKey' | 'findKeyByName' | 'readUsage' | 'revokeKey';

export class FakeOpenRouterKeys implements EmbeddingKeyAdapter {
  /** Every mint ever attempted — the "one key per workspace" assertion reads this. */
  readonly mints: MintEmbeddingKeyInput[] = [];
  readonly revoked: string[] = [];
  private keys = new Map<string, EmbeddingKeyStatus>();
  private counter = 0;
  private failures = new Map<EmbeddingKeyOperation, EmbeddingKeyError>();

  constructor(readonly limitUsd = DEFAULT_EMBEDDING_KEY_LIMIT_USD) {}

  failNext(operation: EmbeddingKeyOperation, message = `fake openrouter ${operation} failure`, retryable = false): void {
    this.failures.set(operation, new EmbeddingKeyError(message, retryable));
  }

  private guard(operation: EmbeddingKeyOperation): void {
    const failure = this.failures.get(operation);
    if (!failure) return;
    this.failures.delete(operation);
    throw failure;
  }

  async mintKey(input: MintEmbeddingKeyInput): Promise<EmbeddingKey> {
    this.guard('mintKey');
    this.mints.push({ ...input });
    // Model the real adapter's replace-by-name: a fake that let two same-named
    // keys live would pass a test the real API would have failed.
    const predecessor = [...this.keys.values()].find(key => key.name === input.name);
    if (predecessor) await this.revokeKey(predecessor.hash);
    const hash = `fake-key-hash-${++this.counter}`;
    this.keys.set(hash, { hash, name: input.name, usageUsd: 0, limitUsd: this.limitUsd, disabled: false });
    return { hash, key: `sk-or-v1-fake-${this.counter}` };
  }

  async findKeyByName(name: string): Promise<EmbeddingKeyStatus | null> {
    this.guard('findKeyByName');
    const found = [...this.keys.values()].find(key => key.name === name);
    return found ? { ...found } : null;
  }

  async readUsage(hash: string): Promise<EmbeddingKeyStatus | null> {
    this.guard('readUsage');
    const found = this.keys.get(hash);
    return found ? { ...found } : null;
  }

  async revokeKey(hash: string): Promise<void> {
    this.guard('revokeKey');
    this.revoked.push(hash);
    this.keys.delete(hash);
  }

  /** Spend recorded against a key, so a metering assertion has something to read. */
  recordUsage(hash: string, usageUsd: number): void {
    const found = this.keys.get(hash);
    if (found) this.keys.set(hash, { ...found, usageUsd });
  }

  /** Keys that still exist — the "no orphaned credential" assertion. */
  liveKeys(): EmbeddingKeyStatus[] {
    return [...this.keys.values()].map(key => ({ ...key }));
  }

  reset(): void {
    this.mints.length = 0;
    this.revoked.length = 0;
    this.keys.clear();
    this.failures.clear();
    this.counter = 0;
  }
}

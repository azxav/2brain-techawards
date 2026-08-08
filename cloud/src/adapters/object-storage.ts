/**
 * Object storage adapter — the control plane's backup seam (OCI Object Storage).
 *
 * The registry is the one dataset in the pilot with backups (#46): workspace
 * data has GitHub as its durable copy, the registry has none, and losing it
 * strands every VM, DNS record, and sealed credential in the fleet.
 *
 * One method, deliberately. Retention is a bucket lifecycle rule configured in
 * cloud/deploy/README.md, not code: pruning in-app would add List and Delete —
 * two more signed endpoints and two more failure modes on a nightly timer — to
 * reimplement what OCI already does. Same shape as adapters/dns.ts: interface,
 * real implementation with an injected fetch, fake beside it.
 */
import { ociSigningHeaders, type OciCredentials } from './compute.ts';

export class ObjectStorageError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ObjectStorageError';
  }
}

export interface ObjectStorage {
  /** Overwrites by contract: a retried backup replaces its own object. */
  put(objectName: string, body: string, contentType: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Real implementation (OCI Object Storage), fetch injected for unit testing.
// ---------------------------------------------------------------------------

export interface OciObjectStorageOptions {
  credentials: OciCredentials;
  region: string;
  /** Tenancy-specific; not derivable from the other OCI values. */
  namespace: string;
  bucket: string;
  fetchImpl?: typeof fetch;
  /** Injected only by tests that assert the signing string. */
  now?: () => Date;
}

export class OciObjectStorage implements ObjectStorage {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: OciObjectStorageOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async put(objectName: string, body: string, contentType: string): Promise<void> {
    // objectName's '/' stays literal: OCI treats it as the pseudo-directory
    // delimiter, and the bucket's lifecycle rule filters on the registry/
    // prefix — an encoded %2F would never match it. Encode each segment on
    // its own, the same default both official OCI SDKs use.
    const encodedObjectName = objectName.split('/').map(encodeURIComponent).join('/');
    const url = new URL(
      `https://objectstorage.${this.options.region}.oraclecloud.com` +
        `/n/${encodeURIComponent(this.options.namespace)}` +
        `/b/${encodeURIComponent(this.options.bucket)}` +
        `/o/${encodedObjectName}`,
    );
    const headers = ociSigningHeaders(this.options.credentials, 'PUT', url, body, this.now(), contentType);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'PUT', headers, body });
    } catch (error) {
      // Transport fault: the object may or may not have landed, so retry.
      throw new ObjectStorageError(`object storage PUT failed to send: ${(error as Error).message}`, true);
    }
    if (!response.ok) {
      // OCI's error bodies echo the bucket, namespace, and user OCID. Keep them out.
      throw new ObjectStorageError(
        `object storage PUT returned ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory fake for tests.
// ---------------------------------------------------------------------------

type ObjectStorageOperation = 'put';

export class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: string; contentType: string }>();
  private failures = new Map<ObjectStorageOperation, ObjectStorageError>();

  failNext(operation: ObjectStorageOperation, message = `fake object storage ${operation} failure`, retryable = false): void {
    this.failures.set(operation, new ObjectStorageError(message, retryable));
  }

  private guard(operation: ObjectStorageOperation): void {
    const failure = this.failures.get(operation);
    if (!failure) return;
    this.failures.delete(operation);
    throw failure;
  }

  async put(objectName: string, body: string, contentType: string): Promise<void> {
    this.guard('put');
    this.objects.set(objectName, { body, contentType });
  }

  reset(): void {
    this.objects.clear();
    this.failures.clear();
  }
}

import { describe, expect, test } from 'bun:test';
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { ociSigningHeaders, type OciCredentials } from '../src/adapters/compute.ts';
import {
  FakeObjectStorage,
  ObjectStorageError,
  OciObjectStorage,
} from '../src/adapters/object-storage.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const credentials: OciCredentials = {
  tenancyOcid: 'ocid1.tenancy.oc1..example',
  userOcid: 'ocid1.user.oc1..example',
  fingerprint: 'aa:bb:cc',
  privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
};

describe('OCI object storage content-type signing', () => {
  test('defaults a body to JSON so existing callers are unchanged', () => {
    const url = new URL('https://iaas.example.com/20160918/instances');
    const headers = ociSigningHeaders(credentials, 'POST', url, '{"a":1}', new Date(0));

    expect(headers['content-type']).toBe('application/json');
    // headers="" only lists signed header *names*, not their values — this
    // proves content-type was among the signed headers, not which value was
    // signed. See the round-trip below for a check on the actual value.
    expect(headers.authorization).toContain('content-type');
  });

  test('signs the exact content type it sent, not a hardcoded default', () => {
    const url = new URL('https://objectstorage.example.com/n/ns/b/bucket/o/thing');
    const at = new Date('2026-07-16T12:00:00Z');
    const body = 'sealed-body';
    const headers = ociSigningHeaders(credentials, 'PUT', url, body, at, 'application/octet-stream');

    expect(headers['content-type']).toBe('application/octet-stream');

    // Reconstruct the signing string OCI's own verifier would build, using the
    // content type this call actually sent. If the signer instead hardcoded
    // some other value into the signature (e.g. always 'application/json'),
    // this reconstruction — which uses 'application/octet-stream' — would not
    // match what was signed, and the verify below would fail.
    const contentSha = createHash('sha256').update(body).digest('base64');
    const signingString = [
      '(request-target): put /n/ns/b/bucket/o/thing',
      'host: objectstorage.example.com',
      `date: ${at.toUTCString()}`,
      `content-length: ${Buffer.byteLength(body)}`,
      'content-type: application/octet-stream',
      `x-content-sha256: ${contentSha}`,
    ].join('\n');
    const signature = /signature="([^"]+)"/.exec(headers.authorization)![1];
    expect(
      createVerify('RSA-SHA256').update(signingString).verify(publicKey, Buffer.from(signature, 'base64')),
    ).toBe(true);
  });
});

describe('OciObjectStorage', () => {
  test('PUTs to the namespaced bucket path with a signed body', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const storage = new OciObjectStorage({
      credentials,
      region: 'eu-frankfurt-1',
      namespace: 'examplenamespace',
      bucket: 'registry-backups',
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init!.method!,
          headers: init!.headers as Record<string, string>,
          body: init!.body as string,
        });
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });

    await storage.put('registry/dump.sql.sealed', 'sealed-payload', 'application/octet-stream');

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(
      'https://objectstorage.eu-frankfurt-1.oraclecloud.com/n/examplenamespace/b/registry-backups/o/registry/dump.sql.sealed',
    );
    expect(calls[0].body).toBe('sealed-payload');
    expect(calls[0].headers.authorization).toContain('Signature version="1"');
    expect(calls[0].headers['x-content-sha256']).toBeDefined();
  });

  test('encodes within a path segment but leaves the delimiter slash literal', async () => {
    const calls: Array<{ url: string }> = [];
    const storage = new OciObjectStorage({
      credentials,
      region: 'eu-frankfurt-1',
      namespace: 'examplenamespace',
      bucket: 'registry-backups',
      fetchImpl: (async (input: string | URL | Request) => {
        calls.push({ url: String(input) });
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });

    await storage.put('registry/a b.sealed', 'x', 'application/octet-stream');

    // OCI treats '/' as the pseudo-directory delimiter, and the bucket's
    // lifecycle rule filters on the registry/ prefix: encoding the slash
    // (e.g. via a blanket encodeURIComponent(objectName)) would make the
    // rule silently never match.
    expect(calls[0].url).toBe(
      'https://objectstorage.eu-frankfurt-1.oraclecloud.com/n/examplenamespace/b/registry-backups/o/registry/a%20b.sealed',
    );
  });

  test('a transport fault is retryable', async () => {
    const storage = new OciObjectStorage({
      credentials,
      region: 'eu-frankfurt-1',
      namespace: 'ns',
      bucket: 'b',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    const error = await storage.put('o', 'x', 'text/plain').catch(e => e);

    expect(error).toBeInstanceOf(ObjectStorageError);
    expect(error.retryable).toBe(true);
  });

  test('a refused PUT raises without echoing the response body', async () => {
    const storage = new OciObjectStorage({
      credentials,
      region: 'eu-frankfurt-1',
      namespace: 'examplenamespace',
      bucket: 'registry-backups',
      fetchImpl: (async () =>
        new Response('bucket registry-backups is not authorized for user ocid1.user..', { status: 403 })) as unknown as typeof fetch,
    });

    const error = await storage.put('registry/dump.sql.sealed', 'x', 'application/octet-stream').catch(e => e);

    expect(error).toBeInstanceOf(ObjectStorageError);
    expect(error.message).toContain('403');
    expect(error.message).not.toContain('ocid1.user');
    expect(error.retryable).toBe(false);
  });

  test('a 5xx is retryable, a 4xx is not', async () => {
    const make = (status: number) =>
      new OciObjectStorage({
        credentials,
        region: 'eu-frankfurt-1',
        namespace: 'ns',
        bucket: 'b',
        fetchImpl: (async () => new Response(null, { status })) as unknown as typeof fetch,
      });

    const server = await make(503).put('o', 'x', 'text/plain').catch(e => e);
    const client = await make(404).put('o', 'x', 'text/plain').catch(e => e);

    expect(server.retryable).toBe(true);
    expect(client.retryable).toBe(false);
  });

  test('a 429 is retryable — OCI rate-limiting, not a permanent client error', async () => {
    const make = (status: number) =>
      new OciObjectStorage({
        credentials,
        region: 'eu-frankfurt-1',
        namespace: 'ns',
        bucket: 'b',
        fetchImpl: (async () => new Response(null, { status })) as unknown as typeof fetch,
      });

    const rateLimited = await make(429).put('o', 'x', 'text/plain').catch(e => e);

    expect(rateLimited.retryable).toBe(true);
  });
});

describe('FakeObjectStorage', () => {
  test('records what it stored', async () => {
    const storage = new FakeObjectStorage();

    await storage.put('registry/a.sealed', 'body-a', 'application/octet-stream');

    expect(storage.objects.get('registry/a.sealed')).toEqual({
      body: 'body-a',
      contentType: 'application/octet-stream',
    });
  });

  test('failNext raises once, then recovers', async () => {
    const storage = new FakeObjectStorage();
    storage.failNext('put');

    await expect(storage.put('o', 'x', 'text/plain')).rejects.toThrow(ObjectStorageError);
    await storage.put('o', 'x', 'text/plain');

    expect(storage.objects.size).toBe(1);
  });
});

import { describe, expect, test } from 'bun:test';
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { CloudflareDns, DnsError } from '../src/adapters/dns.ts';
import { FakeWorkspace, HttpWorkspace, type DirectHttpsFn, type DirectHttpsRequest, type DirectHttpsResponse } from '../src/adapters/workspace.ts';
import { ComputeError, OciCompute, ociSigningHeaders, parseOciCapacityOverride, parseOciShapeOverride, type OciCredentials } from '../src/adapters/compute.ts';
import {
  DEFAULT_EMBEDDING_KEY_LIMIT_USD,
  EmbeddingKeyError,
  HttpOpenRouterKeys,
  parseEmbeddingKeyLimitUsd,
} from '../src/adapters/openrouter.ts';
import { AGENT_RUNTIME_HEALTH_PATH, renderCloudInit, sanitizeWorkspaceName } from '../src/cloud-init.ts';
import { REQUIRED_CLOUD_INIT_KEYS } from '../image/verify-contract.ts';
import { openSecret, parseSealingKey, randomSealingKey, sealSecret, SecretSealError } from '../src/secrets.ts';

// ---------------------------------------------------------------------------
// The real adapters, driven with an injected fetch. Nothing here reaches a real
// API; the point is to pin the request shape the fakes cannot check.
// ---------------------------------------------------------------------------

function recordingFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return responder(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A peer that accepts the connection and then says nothing — the shape a status
 * code can never describe. Honours the abort signal the way a real fetch does,
 * so a caller that passes no deadline hangs here exactly as it would in the wild.
 */
function hangingFetch(): typeof fetch {
  return (async (_input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
    })) as unknown as typeof fetch;
}

describe('OCI request signing', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentials: OciCredentials = {
    tenancyOcid: 'ocid1.tenancy.oc1..example',
    userOcid: 'ocid1.user.oc1..example',
    fingerprint: 'aa:bb:cc',
    privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
  const at = new Date('2026-07-16T12:00:00Z');

  test('a GET signs the request target, host, and date, and verifies against the public key', () => {
    const url = new URL('https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/instances?compartmentId=x');
    const headers = ociSigningHeaders(credentials, 'GET', url, null, at);

    expect(headers.date).toBe(at.toUTCString());
    expect(headers.authorization).toContain('keyId="ocid1.tenancy.oc1..example/ocid1.user.oc1..example/aa:bb:cc"');
    expect(headers.authorization).toContain('algorithm="rsa-sha256"');
    expect(headers.authorization).toContain('headers="(request-target) host date"');
    // A GET has no body, so it must not claim to sign one.
    expect(headers.authorization).not.toContain('x-content-sha256');

    const signature = /signature="([^"]+)"/.exec(headers.authorization)![1];
    const signingString = [
      '(request-target): get /20160918/instances?compartmentId=x',
      'host: iaas.eu-frankfurt-1.oraclecloud.com',
      `date: ${at.toUTCString()}`,
    ].join('\n');
    expect(createVerify('RSA-SHA256').update(signingString).verify(publicKey, Buffer.from(signature, 'base64'))).toBe(true);
  });

  test('a body is covered by the signature, so tampering with it invalidates the request', () => {
    const url = new URL('https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/instances');
    const headers = ociSigningHeaders(credentials, 'POST', url, '{"displayName":"a"}', at);

    expect(headers.authorization).toContain('headers="(request-target) host date content-length content-type x-content-sha256"');
    expect(headers['content-length']).toBe('19');

    const tampered = ociSigningHeaders(credentials, 'POST', url, '{"displayName":"b"}', at);
    expect(tampered['x-content-sha256']).not.toBe(headers['x-content-sha256']);
    expect(tampered.authorization).not.toBe(headers.authorization);
  });
});

describe('OciCompute', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const base = {
    credentials: {
      tenancyOcid: 'ocid1.tenancy.oc1..example',
      userOcid: 'ocid1.user.oc1..example',
      fingerprint: 'aa:bb:cc',
      privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    },
    region: 'eu-frankfurt-1',
    compartmentOcid: 'ocid1.compartment.oc1..example',
    availabilityDomain: 'AD-1',
    subnetOcid: 'ocid1.subnet.oc1..example',
    nsgOcid: 'ocid1.networksecuritygroup.oc1..example',
    imageOcid: 'ocid1.image.oc1..example',
  };

  test('a launch carries base64 user-data, a retry token, and the image', async () => {
    const { impl, calls } = recordingFetch(() => json({ id: 'ocid1.instance.1', displayName: '2brain-ws-abc', lifecycleState: 'PROVISIONING' }));
    const compute = new OciCompute({ ...base, fetchImpl: impl });

    const instance = await compute.launchInstance({ displayName: '2brain-ws-abc', cloudInit: '#cloud-config\n' });

    expect(instance).toEqual({ ocid: 'ocid1.instance.1', displayName: '2brain-ws-abc', state: 'provisioning', publicIp: null });
    const body = JSON.parse(calls[0].init.body as string);
    expect(Buffer.from(body.metadata.user_data, 'base64').toString()).toBe('#cloud-config\n');
    expect(body.sourceDetails).toEqual({
      sourceType: 'image',
      imageId: 'ocid1.image.oc1..example',
      bootVolumeSizeInGBs: 50,
    });
    expect(body.shape).toBe('VM.Standard.A2.Flex');
    expect(body.shapeConfig).toEqual({ ocpus: 1, memoryInGBs: 4 });
    // The NSG is what actually enforces the workspace's ingress policy; a launch
    // that dropped it would ride on the shared subnet security list alone.
    expect(body.createVnicDetails).toEqual({
      subnetId: 'ocid1.subnet.oc1..example',
      assignPublicIp: true,
      nsgIds: ['ocid1.networksecuritygroup.oc1..example'],
    });
    // The retry token is what makes a resent launch idempotent at OCI itself.
    expect((calls[0].init.headers as Record<string, string>)['opc-retry-token']).toBe('2brain-ws-abc');
  });

  test('workspace sizing defaults can be explicitly overridden', async () => {
    const { impl, calls } = recordingFetch(() => json({ id: 'ocid1.instance.2', displayName: '2brain-ws-custom', lifecycleState: 'PROVISIONING' }));
    const compute = new OciCompute({
      ...base,
      shape: 'VM.Standard.A2.Flex',
      ocpus: 2,
      memoryInGbs: 8,
      bootVolumeSizeInGbs: 75,
      fetchImpl: impl,
    });

    await compute.launchInstance({ displayName: '2brain-ws-custom', cloudInit: '' });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.shapeConfig).toEqual({ ocpus: 2, memoryInGBs: 8 });
    expect(body.sourceDetails.bootVolumeSizeInGBs).toBe(75);
  });

  test('a power action sends a signed empty body, because InstanceAction refuses any details payload', async () => {
    // Proven on real OCI: POST ...?action=SOFTSTOP with `{}` as the body is a
    // 400 InvalidParameter — SOFTSTOP has no InstancePowerActionDetails shape,
    // so any body at all is a malformed request. The signature still has to
    // cover content-length, content-type and the digest, of the empty string.
    const { impl, calls } = recordingFetch(() => json({ id: 'ocid1.instance.1', lifecycleState: 'STOPPING' }));
    const compute = new OciCompute({ ...base, fetchImpl: impl });

    await compute.stopInstance('ocid1.instance.1');
    await compute.startInstance('ocid1.instance.1');

    expect(calls[0].url).toContain('?action=SOFTSTOP');
    expect(calls[1].url).toContain('?action=START');
    for (const { init } of calls) {
      expect(init.body ?? '').toBe('');
      const headers = init.headers as Record<string, string>;
      expect(headers['content-length']).toBe('0');
      expect(headers['x-content-sha256']).toBe(createHash('sha256').update('').digest('base64'));
    }
  });

  test('find-by-name ignores a terminated namesake so a retry does not adopt a corpse', async () => {
    const { impl } = recordingFetch(() => json([
      { id: 'ocid1.instance.dead', displayName: '2brain-ws-abc', lifecycleState: 'TERMINATED' },
    ]));
    const compute = new OciCompute({ ...base, fetchImpl: impl });
    expect(await compute.findInstanceByName('2brain-ws-abc')).toBeNull();
  });

  test('a live instance is hydrated with the public address from its VNIC', async () => {
    const { impl } = recordingFetch(url => {
      if (url.includes('/vnicAttachments')) return json([{ vnicId: 'ocid1.vnic.1', lifecycleState: 'ATTACHED' }]);
      if (url.includes('/vnics/')) return json({ publicIp: '203.0.113.9' });
      return json({ id: 'ocid1.instance.1', displayName: '2brain-ws-abc', lifecycleState: 'RUNNING' });
    });
    const compute = new OciCompute({ ...base, fetchImpl: impl });
    expect(await compute.getInstance('ocid1.instance.1')).toEqual({
      ocid: 'ocid1.instance.1',
      displayName: '2brain-ws-abc',
      state: 'running',
      publicIp: '203.0.113.9',
    });
  });

  test('a 5xx is retryable and a 4xx is not, and neither echoes the response body', async () => {
    const server = new OciCompute({ ...base, fetchImpl: recordingFetch(() => json({ message: 'tenancy ocid1.secret leaked here' }, 500)).impl });
    await expect(server.getInstance('x')).rejects.toMatchObject({ retryable: true });
    await expect(server.getInstance('x')).rejects.toThrow(/returned 500/);
    await expect(server.getInstance('x')).rejects.not.toThrow(/leaked/);

    const client = new OciCompute({ ...base, fetchImpl: recordingFetch(() => json({}, 400)).impl });
    await expect(client.getInstance('x')).rejects.toMatchObject({ retryable: false });
  });

  test('a transport fault is retryable', async () => {
    // A fetch that never got an answer says nothing about whether OCI acted, so
    // the reconciler must get another tick rather than fail the workspace.
    const compute = new OciCompute({
      ...base,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    const error = await compute.getInstance('ocid1.instance.1').catch(e => e);

    expect(error).toBeInstanceOf(ComputeError);
    expect(error.retryable).toBe(true);
  });

  test('a 404 is absence on a read, but a hard failure on a write', async () => {
    // A read that 404s means the instance is not there.
    const read = new OciCompute({ ...base, fetchImpl: recordingFetch(() => new Response('', { status: 404 })).impl });
    expect(await read.getInstance('ocid1.instance.gone')).toBeNull();

    // A launch that 404s is OCI's NotAuthorizedOrNotFound: an image, subnet or
    // compartment it cannot see. Treating that as an empty result reported that
    // OCI had accepted a launch it actually refused.
    const write = new OciCompute({
      ...base,
      fetchImpl: recordingFetch(() => json({ code: 'NotAuthorizedOrNotFound', message: 'subnet ocid1.subnet.secret not found' }, 404)).impl,
    });
    await expect(write.launchInstance({ displayName: '2brain-ws-abc', cloudInit: '' })).rejects.toThrow(/returned 404 \(NotAuthorizedOrNotFound\)/);
    // The code classifies the fault; the message, which echoes the resource, does not leak.
    await expect(write.launchInstance({ displayName: '2brain-ws-abc', cloudInit: '' })).rejects.not.toThrow(/secret/);

    // Terminate is the exception: cleanup wanted it gone, and it is gone.
    const terminate = new OciCompute({ ...base, fetchImpl: recordingFetch(() => new Response('', { status: 404 })).impl });
    await expect(terminate.terminateInstance('ocid1.instance.gone')).resolves.toBeUndefined();
  });

  test('a connection that is accepted and never answered ends the call rather than the run', async () => {
    // The failure this pins: a peer that takes the connection and goes quiet.
    // No status ever arrives, so every status-based guard above is unreachable
    // and only the deadline can end it. Without one the await never settles —
    // the reconciler tick never returns, the smoke run's teardown never runs,
    // and a billed VM outlives the run that created it.
    const compute = new OciCompute({ ...base, timeoutMs: 50, fetchImpl: hangingFetch() });

    await expect(compute.getInstance('ocid1.instance.1')).rejects.toThrow(/timed out after 50ms/);
    // Retryable: a timeout says nothing about whether OCI acted on the request.
    await expect(compute.getInstance('ocid1.instance.1')).rejects.toMatchObject({ name: 'ComputeError', retryable: true });
  });
});

describe('OCI instance overrides', () => {
  test('accepts positive decimal capacities and rejects alternate numeric spellings', () => {
    expect(parseOciCapacityOverride('OCI_INSTANCE_MEMORY_GB', undefined)).toBeUndefined();
    expect(parseOciCapacityOverride('OCI_INSTANCE_MEMORY_GB', '4')).toBe(4);
    expect(parseOciCapacityOverride('OCI_INSTANCE_MEMORY_GB', '04')).toBe(4);
    for (const raw of ['', '0', '1e2', '0x10', ' 4 ']) {
      expect(() => parseOciCapacityOverride('OCI_INSTANCE_MEMORY_GB', raw)).toThrow(/positive whole number/);
    }
  });

  test('accepts a non-empty explicit shape and rejects an empty one', () => {
    expect(parseOciShapeOverride(undefined)).toBeUndefined();
    expect(parseOciShapeOverride('VM.Standard.A2.Flex')).toBe('VM.Standard.A2.Flex');
    expect(() => parseOciShapeOverride('')).toThrow(/OCI_INSTANCE_SHAPE/);
    expect(() => parseOciShapeOverride(' VM.Standard.A2.Flex ')).toThrow(/OCI_INSTANCE_SHAPE/);
  });
});

describe('CloudflareDns', () => {
  const options = { apiToken: 'cf-test-token', zoneId: 'zone-1' };

  test('creating a record is unproxied, so the VM can complete its own ACME challenge', async () => {
    const { impl, calls } = recordingFetch(url =>
      url.includes('?') ? json({ success: true, result: [] }) : json({ success: true, result: { id: 'rec-1', name: 'a.example.com', content: '203.0.113.5' } }));
    const dns = new CloudflareDns({ ...options, fetchImpl: impl });

    expect(await dns.upsertRecord('a.example.com', '203.0.113.5')).toEqual({ id: 'rec-1', name: 'a.example.com', ipv4: '203.0.113.5' });
    expect(calls[1].init.method).toBe('POST');
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ type: 'A', name: 'a.example.com', content: '203.0.113.5', ttl: 60, proxied: false });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer cf-test-token');
  });

  test('an upsert that matches what is already published makes no write at all', async () => {
    const { impl, calls } = recordingFetch(() => json({ success: true, result: [{ id: 'rec-1', name: 'a.example.com', content: '203.0.113.5' }] }));
    const dns = new CloudflareDns({ ...options, fetchImpl: impl });

    expect(await dns.upsertRecord('a.example.com', '203.0.113.5')).toEqual({ id: 'rec-1', name: 'a.example.com', ipv4: '203.0.113.5' });
    expect(calls).toHaveLength(1);
  });

  test('a connection that is accepted and never answered ends the call rather than the run', async () => {
    const dns = new CloudflareDns({ ...options, timeoutMs: 50, fetchImpl: hangingFetch() });

    await expect(dns.findRecord('a.example.com')).rejects.toThrow(/timed out after 50ms/);
    await expect(dns.findRecord('a.example.com')).rejects.toMatchObject({ name: 'DnsError', retryable: true });
  });

  test('an existing record pointing elsewhere is repointed, not duplicated', async () => {
    const { impl, calls } = recordingFetch(url =>
      url.includes('?') ? json({ success: true, result: [{ id: 'rec-1', name: 'a.example.com', content: '198.51.100.1' }] })
        : json({ success: true, result: { id: 'rec-1', name: 'a.example.com', content: '203.0.113.5' } }));
    const dns = new CloudflareDns({ ...options, fetchImpl: impl });

    await dns.upsertRecord('a.example.com', '203.0.113.5');
    expect(calls[1].init.method).toBe('PATCH');
    expect(calls[1].url).toContain('/rec-1');
  });

  test('deleting a record that is already gone is a success, because cleanup wanted it gone', async () => {
    const { impl } = recordingFetch(() => new Response(JSON.stringify({ success: false }), { status: 404 }));
    const dns = new CloudflareDns({ ...options, fetchImpl: impl });
    await expect(dns.deleteRecord('rec-1')).resolves.toBeUndefined();
  });

  test('a transport fault is retryable', async () => {
    // Cloudflare may or may not have acted, so the reconciler must retry rather
    // than abandon a half-provisioned workspace on a network blip.
    const dns = new CloudflareDns({
      ...options,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    const error = await dns.findRecord('a.example.com').catch(e => e);

    expect(error).toBeInstanceOf(DnsError);
    expect(error.retryable).toBe(true);
  });

  test("a refusal does not echo Cloudflare's message, which names the zone and record", async () => {
    const { impl } = recordingFetch(() => json({ success: false, errors: [{ code: 1004, message: 'zone secret-zone.example record leaked' }], result: null }));
    const dns = new CloudflareDns({ ...options, fetchImpl: impl });
    await expect(dns.findRecord('a.example.com')).rejects.not.toThrow(/leaked/);
  });
});

describe('HttpWorkspace', () => {
  // The direct-IP HTTPS port the adapter dials through, recorded so a test can
  // assert the connection dials the IP while the certificate name stays the
  // hostname — the curl --resolve behaviour DNS resolution is bypassed for.
  function recordingHttps(responder: (request: DirectHttpsRequest, body: string | null) => DirectHttpsResponse | Error) {
    const calls: Array<{ request: DirectHttpsRequest; body: string | null }> = [];
    const impl: DirectHttpsFn = async (request, body) => {
      calls.push({ request, body });
      const result = responder(request, body);
      if (result instanceof Error) throw result;
      return result;
    };
    return { impl, calls };
  }

  test('a health probe dials the IP, validates the cert against the hostname, and hits /health', async () => {
    const { impl, calls } = recordingHttps(() => ({ status: 200, body: 'ok' }));
    const workspace = new HttpWorkspace({ httpsImpl: impl });

    expect(await workspace.probeHealth('https://a.example.com', '203.0.113.5')).toBe(true);
    expect(calls[0].request).toMatchObject({
      host: '203.0.113.5', // dialed by address
      servername: 'a.example.com', // SNI + certificate name
      port: 443,
      method: 'GET',
      path: '/health',
      headers: { host: 'a.example.com' },
    });
  });

  test('a health probe is false, never a throw, while the workspace is still coming up', async () => {
    const refused = new HttpWorkspace({ httpsImpl: recordingHttps(() => new Error('ECONNREFUSED')).impl });
    expect(await refused.probeHealth('https://a.example.com', '203.0.113.5')).toBe(false);

    // A wrong-host or self-signed cert mid-ACME rejects the connection: still "not
    // yet", not a hard failure. And a 502 from a booting service is not healthy.
    const badCert = new HttpWorkspace({ httpsImpl: recordingHttps(() => new Error('ERR_TLS_CERT_ALTNAME_INVALID')).impl });
    expect(await badCert.probeHealth('https://a.example.com', '203.0.113.5')).toBe(false);

    const notReady = new HttpWorkspace({ httpsImpl: recordingHttps(() => ({ status: 502, body: '' })).impl });
    expect(await notReady.probeHealth('https://a.example.com', '203.0.113.5')).toBe(false);
  });

  test('probeAgent requires GBrain to prove the loopback runtime is alive', async () => {
    // #68: readiness is no longer "something answered under /agent". It is
    // GBrain's own gate endpoint answering an exact, bodiless 204, which it emits
    // only after `control.runtimeHealth()` proved the loopback Gateway. The old
    // rule declared a workspace ready on a 401 the Gateway had not issued, and on
    // the first real agent VM it passed on GBrain's own 404 before the agent
    // existed at all.
    const { impl, calls } = recordingHttps(() => ({ status: 204, body: '' }));
    const adapter = new HttpWorkspace({ httpsImpl: impl });

    expect(await adapter.probeAgent('https://a.example.test', '203.0.113.5')).toBe(true);
    expect(calls[0].request.path).toBe(AGENT_RUNTIME_HEALTH_PATH);
    expect(calls[0].request.path).toBe('/api/workspace/v1/agent/runtime-health');
    // The direct-IP dial, the TLS server name, and the Host header all survive
    // the path change: DNS stays out of the management lane.
    expect(calls[0].request).toMatchObject({
      host: '203.0.113.5',
      servername: 'a.example.test',
      port: 443,
      method: 'GET',
      headers: { host: 'a.example.test' },
    });
  });

  // Exhaustive over the classes that used to pass. 200 is the whole 2xx family
  // that a "success" check would wave through; 302 is a redirect to a login page;
  // 401 is the pre-#68 "the gateway answered" reading; 404 is GBrain before the
  // route exists; 500/503 is Caddy up with everything behind it down.
  for (const status of [200, 201, 302, 401, 403, 404, 500, 503] as const) {
    test(`probeAgent rejects status ${status}`, async () => {
      const adapter = new HttpWorkspace({ httpsImpl: recordingHttps(() => ({ status, body: '' })).impl });
      expect(await adapter.probeAgent('https://a.example.test', '203.0.113.5')).toBe(false);
    });
  }

  test('probeAgent is false, never a throw, on transport failure', async () => {
    const adapter = new HttpWorkspace({ httpsImpl: recordingHttps(() => new Error('ECONNREFUSED')).impl });
    expect(await adapter.probeAgent('https://a.example.com', '203.0.113.5')).toBe(false);
  });

  test('the fake cannot be kinder than the real adapter about what proves the runtime', async () => {
    // FakeWorkspace and HttpWorkspace must agree status-for-status, or every
    // provisioning test is proving a rule production does not have.
    const fake = new FakeWorkspace();
    for (const status of [200, 201, 302, 401, 403, 404, 500, 503, 204] as const) {
      fake.agentStatus = status;
      const real = new HttpWorkspace({ httpsImpl: recordingHttps(() => ({ status, body: '' })).impl });
      expect(await fake.probeAgent('https://a.example.test', '203.0.113.5'))
        .toBe(await real.probeAgent('https://a.example.test', '203.0.113.5'));
    }
    fake.agentStatus = null;
    expect(await fake.probeAgent('https://a.example.test', '203.0.113.5')).toBe(false);
  });

  test('the setup link dials the IP, carries the credential and idempotency key, and no email', async () => {
    const { impl, calls } = recordingHttps(() => ({ status: 201, body: JSON.stringify({ data: { purpose: 'setup', token: 'tok-123' } }) }));
    const workspace = new HttpWorkspace({ httpsImpl: impl });

    const link = await workspace.issueSetupLink({
      baseUrl: 'https://a.example.com',
      ip: '203.0.113.5',
      bootstrapCredential: 'bootstrap-secret',
      idempotencyKey: 'workspace-uuid',
    });

    // The link the human clicks is by hostname; only the control plane's own
    // connection went by IP.
    expect(link).toBe('https://a.example.com/setup/tok-123');
    expect(calls[0].request).toMatchObject({
      host: '203.0.113.5',
      servername: 'a.example.com',
      method: 'POST',
      path: '/api/workspace/v1/operator/links',
    });
    expect(calls[0].request.headers.authorization).toBe('Bootstrap bootstrap-secret');
    const body = JSON.parse(calls[0].body as string);
    expect(body).toEqual({ purpose: 'setup', idempotency_key: 'workspace-uuid' });
    // ADR-0037: the platform never guesses an administrator identity.
    expect(body).not.toHaveProperty('email');
  });
});

describe('OpenRouter provisioned keys', () => {
  const base = { provisioningKey: 'sk-or-provisioning', limitUsd: 5 };

  test('minting sends the workspace name and the per-key spend limit, and returns the key once', async () => {
    const { impl, calls } = recordingFetch((url, init) => {
      if (init.method === 'POST') return json({ key: 'sk-or-v1-minted', data: { hash: 'hash-1', name: '2brain-ws-abc', limit: 5, usage: 0 } });
      return json({ data: [] });
    });
    const keys = new HttpOpenRouterKeys({ ...base, fetchImpl: impl });

    expect(await keys.mintKey({ name: '2brain-ws-abc' })).toEqual({ hash: 'hash-1', key: 'sk-or-v1-minted' });
    const create = calls.find(call => call.init.method === 'POST')!;
    expect(create.url).toBe('https://openrouter.ai/api/v1/keys');
    expect((create.init.headers as Record<string, string>).authorization).toBe('Bearer sk-or-provisioning');
    // The spend limit is what bounds the blast radius of a key read off a VM.
    expect(JSON.parse(create.init.body as string)).toMatchObject({ name: '2brain-ws-abc', limit: 5 });
  });

  test('a same-named key left by a lost acknowledgement is revoked before a fresh one is minted', async () => {
    // OpenRouter returns the key material exactly once, so an orphan from a
    // crashed provision can never be adopted — it can only be replaced.
    const { impl, calls } = recordingFetch((url, init) => {
      if (init.method === 'POST') return json({ key: 'sk-or-v1-fresh', data: { hash: 'hash-2' } });
      if (init.method === 'DELETE') return json({ data: { success: true } });
      return json({ data: [{ hash: 'hash-orphan', name: '2brain-ws-abc', limit: 5, usage: 0.2, disabled: false }] });
    });
    const keys = new HttpOpenRouterKeys({ ...base, fetchImpl: impl });

    expect(await keys.mintKey({ name: '2brain-ws-abc' })).toEqual({ hash: 'hash-2', key: 'sk-or-v1-fresh' });
    const deleted = calls.find(call => call.init.method === 'DELETE')!;
    expect(deleted.url).toBe('https://openrouter.ai/api/v1/keys/hash-orphan');
  });

  test('usage and the spend limit are readable per key, which is what the operator meters on', async () => {
    const { impl } = recordingFetch(() => json({ data: { hash: 'hash-1', name: '2brain-ws-abc', limit: 5, usage: 1.25, disabled: false } }));
    const keys = new HttpOpenRouterKeys({ ...base, fetchImpl: impl });

    expect(await keys.readUsage('hash-1')).toEqual({
      hash: 'hash-1',
      name: '2brain-ws-abc',
      usageUsd: 1.25,
      limitUsd: 5,
      disabled: false,
    });
  });

  test('revoking a key that is already gone succeeds, so cleanup can run twice', async () => {
    const keys = new HttpOpenRouterKeys({ ...base, fetchImpl: recordingFetch(() => json({ error: { message: 'not found' } }, 404)).impl });
    await keys.revokeKey('hash-gone');
  });

  test('a 5xx is retryable and a 4xx is not, and neither echoes the response body', async () => {
    const server = new HttpOpenRouterKeys({ ...base, fetchImpl: recordingFetch(() => json({ error: { message: 'sk-or-provisioning leaked here' } }, 500)).impl });
    await expect(server.readUsage('hash-1')).rejects.toMatchObject({ retryable: true });
    await expect(server.readUsage('hash-1')).rejects.toThrow(/returned 500/);
    await expect(server.readUsage('hash-1')).rejects.not.toThrow(/leaked/);

    const client = new HttpOpenRouterKeys({ ...base, fetchImpl: recordingFetch(() => json({}, 401)).impl });
    await expect(client.readUsage('hash-1')).rejects.toMatchObject({ retryable: false });
  });

  test('the name lookup pages, so an orphan past the first page is still found', async () => {
    // The listing includes disabled keys, so the platform's account accumulates
    // them for the fleet's whole life. Reading page one only would report the
    // orphan this lookup exists to find as absent — and leave it billable.
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ hash: `h${index}`, name: `other-${index}`, limit: 5, usage: 0 }));
    const { impl, calls } = recordingFetch(url =>
      url.includes('offset=100')
        ? json({ data: [{ hash: 'hash-orphan', name: '2brain-embedding-abc', limit: 5, usage: 0.4, disabled: false }] })
        : json({ data: firstPage }));
    const keys = new HttpOpenRouterKeys({ ...base, fetchImpl: impl });

    expect((await keys.findKeyByName('2brain-embedding-abc'))?.hash).toBe('hash-orphan');
    expect(calls).toHaveLength(2);
  });

  test('a listing that never ends is an error, not a clean account', async () => {
    // Reporting "absent" after giving up would tell a caller about to mint a
    // duplicate, or skip a revocation, that there was nothing there.
    const page = Array.from({ length: 100 }, (_, index) => ({ hash: `h${index}`, name: `other-${index}` }));
    const keys = new HttpOpenRouterKeys({ ...base, fetchImpl: recordingFetch(() => json({ data: page })).impl });

    await expect(keys.findKeyByName('2brain-embedding-abc')).rejects.toMatchObject({ retryable: true });
  });

  test('the spend cap is parsed rather than coerced, so no entrypoint can mint an uncapped key', () => {
    expect(parseEmbeddingKeyLimitUsd(undefined)).toBe(DEFAULT_EMBEDDING_KEY_LIMIT_USD);
    expect(parseEmbeddingKeyLimitUsd('12')).toBe(12);
    // Number('') is 0 and Number('x') is NaN; OpenRouter reads either as no cap.
    for (const hostile of ['', '0', '-1', '2.5', 'five']) {
      expect(() => parseEmbeddingKeyLimitUsd(hostile)).toThrow(EmbeddingKeyError);
    }
  });

  test('a transport fault is retryable', async () => {
    const keys = new HttpOpenRouterKeys({
      ...base,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    const error = await keys.readUsage('hash-1').catch(e => e);

    expect(error).toBeInstanceOf(EmbeddingKeyError);
    expect(error.retryable).toBe(true);
  });
});

function baseCloudInitInput() {
  return {
    name: 'Acme Example',
    subdomain: 'acme.workspaces.example.com',
    secrets: { tokenSecret: 'token-secret', bootstrapCredential: 'bootstrap-cred', postgresPassword: 'pg-pass' },
    resendApiKey: 'resend-key',
    emailFrom: '2Brain <no-reply@workspaces.example.com>',
    openrouterKey: 'sk-or-v1-workspace-key',
  };
}

describe('cloud-init rendering', () => {
  const input = baseCloudInitInput();

  test('every key the image contract requires is declared', () => {
    const rendered = renderCloudInit(input);
    for (const key of REQUIRED_CLOUD_INIT_KEYS) {
      expect(rendered).toMatch(new RegExp(`^\\s*${key}=.+$`, 'm'));
    }
    expect(rendered).toContain('/usr/local/sbin/gbrain-cloud-init-finalize');
    expect(rendered).toContain("permissions: '0640'");
  });

  test('both database URLs carry the same password, as the contract requires', () => {
    const rendered = renderCloudInit(input);
    const urls = [...rendered.matchAll(/^\s*(?:GBRAIN|TWO_BRAIN)_DATABASE_URL=(.+)$/gm)].map(match => match[1]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    expect(urls[0]).toContain('pg-pass');
  });

  test('the VM carries its own provisioned embedding key, never a fleet-wide one', () => {
    const rendered = renderCloudInit(input);
    expect(rendered).toMatch(/^\s*OPENROUTER_API_KEY=sk-or-v1-workspace-key$/m);
    // The model and dimensions are part of the contract too: search has to work
    // with nothing the user ever typed.
    expect(rendered).toMatch(/^\s*GBRAIN_EMBEDDING_MODEL=openrouter:openai\/text-embedding-3-small$/m);
    expect(rendered).toMatch(/^\s*GBRAIN_EMBEDDING_DIMENSIONS=1536$/m);
  });

  test('a missing or env-file-hostile embedding key is refused rather than rendered', () => {
    expect(() => renderCloudInit({ ...input, openrouterKey: '' })).toThrow(/openrouterKey/);
    // The value lands in a systemd EnvironmentFile a root shell also reads.
    expect(() => renderCloudInit({ ...input, openrouterKey: 'sk "or"\nGBRAIN_BOOTSTRAP_CREDENTIAL=attacker' })).toThrow(/openrouterKey/);
  });

  test('a hostile workspace name cannot break out of the env file', () => {
    const rendered = renderCloudInit({
      ...input,
      name: 'Evil"\nGBRAIN_BOOTSTRAP_CREDENTIAL=attacker\n#',
    });
    // The payload survives as text inside the quoted name — that is fine and
    // expected. What matters is that it never becomes an assignment: the quote
    // and the newlines it needed to escape with are gone.
    expect(rendered).toContain('GBRAIN_WORKSPACE_NAME="Evil GBRAIN_BOOTSTRAP_CREDENTIAL attacker"');
    expect(rendered).not.toContain('=attacker');
    // One credential line, and it is ours.
    expect([...rendered.matchAll(/^\s*GBRAIN_BOOTSTRAP_CREDENTIAL=/gm)]).toHaveLength(1);
    expect(rendered).toContain('GBRAIN_BOOTSTRAP_CREDENTIAL=bootstrap-cred');
  });

  test('brain-tier cloud-init never names the agent finalizer', () => {
    const rendered = renderCloudInit(baseCloudInitInput());
    expect(rendered).toContain('- [/usr/local/sbin/gbrain-cloud-init-finalize]');
    expect(rendered).not.toContain('gbrain-agent-finalize');
  });

  test('agent-tier cloud-init runs the agent finalizer after the brain finalizer', () => {
    const rendered = renderCloudInit({ ...baseCloudInitInput(), tier: 'agent' });
    const brainAt = rendered.indexOf('- [/usr/local/sbin/gbrain-cloud-init-finalize]');
    const agentAt = rendered.indexOf('- [/usr/local/sbin/gbrain-agent-finalize]');
    expect(brainAt).toBeGreaterThan(-1);
    expect(agentAt).toBeGreaterThan(brainAt);
    // The env file differs by exactly the tier marker (#58 D3): the agent
    // tier adds a flag, never a secret.
    const envBlock = (doc: string) => doc.split('\nruncmd:')[0];
    expect(envBlock(rendered).replace(/^\s*GBRAIN_AGENT_TIER=true\n/m, '')).toBe(envBlock(renderCloudInit(baseCloudInitInput())));
  });

  test('agent-tier cloud-init marks the VM with GBRAIN_AGENT_TIER and brain tier never does', () => {
    expect(renderCloudInit({ ...baseCloudInitInput(), tier: 'agent' })).toMatch(/^\s*GBRAIN_AGENT_TIER=true$/m);
    expect(renderCloudInit(baseCloudInitInput())).not.toContain('GBRAIN_AGENT_TIER');
    expect(renderCloudInit({ ...baseCloudInitInput(), tier: 'brain' })).not.toContain('GBRAIN_AGENT_TIER');
  });

  test('names are stripped to a charset that cannot open a shell substitution', () => {
    expect(sanitizeWorkspaceName('$(whoami)')).toBe('whoami');
    expect(sanitizeWorkspaceName('`id`')).toBe('id');
    expect(sanitizeWorkspaceName('a"b\\c')).toBe('a b c');
    expect(sanitizeWorkspaceName('   ')).toBe('Workspace');
    expect(sanitizeWorkspaceName('x'.repeat(500))).toHaveLength(120);
  });
});

describe('secret sealing', () => {
  const key = parseSealingKey(randomSealingKey());

  test('a sealed secret round-trips and never contains its plaintext', () => {
    const sealed = sealSecret('bootstrap-credential-value', key);
    expect(sealed).not.toContain('bootstrap-credential-value');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(openSecret(sealed, key)).toBe('bootstrap-credential-value');
  });

  test('the same plaintext seals differently every time, so ciphertexts are not comparable', () => {
    expect(sealSecret('same', key)).not.toBe(sealSecret('same', key));
  });

  test('a tampered ciphertext or a wrong key is refused rather than returning garbage', () => {
    const sealed = sealSecret('secret', key);
    expect(() => openSecret(sealed, parseSealingKey(randomSealingKey()))).toThrow(SecretSealError);
    const [version, iv, tag, body] = sealed.split('.');
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] ^= 0xff;
    expect(() => openSecret([version, iv, tag, flipped.toString('base64url')].join('.'), key)).toThrow(SecretSealError);
  });

  test('an undersized key is refused rather than silently weakening the seal', () => {
    expect(() => parseSealingKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

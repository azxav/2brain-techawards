import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { parseLegacyTokenScope } from '../src/core/legacy-token-scope.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { hashToken } from '../src/core/utils.ts';
import { runServeHttp } from '../src/commands/serve-http.ts';
import {
  authorizationFromAuthInfo,
  ungrantedMcpAuthorization,
  workspaceMemberAuthorization,
} from '../src/workspace/authorization-context.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { setPrincipalSourceAccess } from '../src/workspace/source-access.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

function agentAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: 'credential-that-must-not-leak',
    clientId: 'agent-oauth',
    clientName: 'OAuth Agent',
    scopes: ['read'],
    sourceId: 'source-a',
    allowedSources: ['source-a'],
    ...overrides,
  };
}

async function call(authorization: ReturnType<typeof authorizationFromAuthInfo> | ReturnType<typeof workspaceMemberAuthorization>) {
  return dispatchToolCall(engine, 'list_pages', {}, { authorization });
}

async function callHttpMcp(
  baseUrl: string,
  token: string,
  name = 'list_pages',
  args: Record<string, unknown> = {},
) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  const dataLine = text.split('\n').find(line => line.startsWith('data: '));
  const payload = JSON.parse(dataLine ? dataLine.slice(6) : text) as any;
  return { response, payload };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await initializeWorkspaceFoundation(engine);
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES
      ('source-a', 'Source A', '{}'::jsonb),
      ('source-b', 'Restricted Source', '{}'::jsonb)`,
  );
  await engine.putPage('notes/allowed', {
    type: 'note', title: 'Allowed title', compiled_truth: 'allowed', frontmatter: {},
  }, { sourceId: 'source-a' });
  await engine.putPage('notes/restricted', {
    type: 'note', title: 'Restricted title', compiled_truth: 'restricted', frontmatter: {},
  }, { sourceId: 'source-b' });
});

describe('canonical remote authorization dispatch', () => {
  test('legacy credential grants normalize strictly without inventing default', () => {
    for (const malformed of [undefined, '', [], ['source-a', null], ['source-a', '../source-b']]) {
      expect(parseLegacyTokenScope(malformed)).toEqual({ allowedSources: [] });
    }
    expect(parseLegacyTokenScope('source-a')).toEqual({
      sourceId: 'source-a',
      allowedSources: ['source-a'],
    });
    expect(parseLegacyTokenScope(['source-b', 'source-a', 'source-b'])).toEqual({
      sourceId: 'source-b',
      allowedSources: ['source-b', 'source-a'],
    });

    const conflicting = authorizationFromAuthInfo(agentAuth({
      sourceId: 'source-a',
      allowedSources: [],
    }));
    expect(conflicting.sourceAccess).toEqual({ kind: 'sources', sourceIds: [] });
    expect(conflicting.writeSourceId).toBeUndefined();
  });

  test('legacy API-key HTTP dispatch consumes the canonical authorization contract', async () => {
    const token = 'legacy-http-explicit-grant';
    await engine.executeRaw(
      `INSERT INTO access_tokens (id, name, token_hash, permissions)
       VALUES ($1, $2, $3, $4::jsonb)`,
      ['00000000-0000-4000-8000-000000000010', 'Legacy HTTP', hashToken(token), JSON.stringify({ source_id: ['source-a'] })],
    );
    const server = await startHttpTransport({ port: 0, engine });
    try {
      const response = await fetch(`http://localhost:${(server as any).port}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_pages', arguments: {} },
        }),
      });
      const payload = await response.json() as any;
      const body = JSON.parse(payload.result.content[0].text);
      expect(body.map((page: { slug: string }) => page.slug)).toEqual(['notes/allowed']);
      expect(JSON.stringify(payload)).not.toContain(token);
      expect(JSON.stringify(payload)).not.toContain('notes/restricted');

      const broadenedResponse = await fetch(`http://localhost:${(server as any).port}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 4, method: 'tools/call',
          params: { name: 'sources_status', arguments: { id: 'source-b' } },
        }),
      });
      const broadenedPayload = await broadenedResponse.json() as any;
      const broadenedText = JSON.stringify(broadenedPayload);
      expect(broadenedPayload.result.isError).toBe(true);
      expect(broadenedText).not.toContain('source-b');
      expect(broadenedText).not.toContain('Restricted Source');
      expect(broadenedText).not.toContain('count');
      expect(broadenedText).not.toContain('latency');
      expect(broadenedText).not.toContain('provenance');

      const localOnlyResponse = await fetch(`http://localhost:${(server as any).port}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'file_list', arguments: {} },
        }),
      });
      const localOnlyPayload = await localOnlyResponse.json() as any;
      expect(localOnlyPayload.result.isError).toBe(true);
      expect(JSON.parse(localOnlyPayload.result.content[0].text)).toEqual({
        error: 'permission_denied',
        message: 'This operation is available only to trusted local callers.',
      });

      await engine.executeRaw('DELETE FROM access_tokens WHERE token_hash = $1', [hashToken(token)]);
      const revoked = await fetch(`http://localhost:${(server as any).port}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 3, method: 'tools/call',
          params: { name: 'list_pages', arguments: {} },
        }),
      });
      expect(revoked.status).toBe(401);
      expect(await revoked.text()).not.toContain(token);
    } finally {
      (server as any).stop(true);
    }
  });

  test('OAuth HTTP and MCP adapters share allowed, denied, and revoked behavior', async () => {
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.reduce(
        (text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''),
        '',
      );
      return engine.executeRaw(query, values);
    };
    const provider = new GBrainOAuthProvider({ sql: sql as any, tokenTtl: 60, refreshTtl: 300 });
    const { clientId, clientSecret } = await provider.registerClientManual(
      'parity-oauth-agent',
      ['client_credentials'],
      'read',
    );
    const principal = { kind: 'agent' as const, id: clientId };
    await setPrincipalSourceAccess(engine, principal, { mode: 'specific', sourceIds: ['source-a'] });
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read');

    const server = await runServeHttp(engine, {
      port: 0,
      tokenTtl: 60,
      enableDcr: false,
      bind: '127.0.0.1',
      suppressBootstrapToken: true,
    });
    try {
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const allowed = await callHttpMcp(baseUrl, tokens.access_token);
      expect(allowed.response.status).toBe(200);
      expect(JSON.parse(allowed.payload.result.content[0].text).map((page: { slug: string }) => page.slug))
        .toEqual(['notes/allowed']);

      const broadened = await callHttpMcp(baseUrl, tokens.access_token, 'sources_status', { id: 'source-b' });
      const broadenedText = JSON.stringify(broadened.payload);
      expect(broadened.payload.result.isError).toBe(true);
      expect(broadenedText).not.toContain('source-b');
      expect(broadenedText).not.toContain('Restricted Source');
      expect(broadenedText).not.toContain('count');
      expect(broadenedText).not.toContain('latency');
      expect(broadenedText).not.toContain('provenance');

      await setPrincipalSourceAccess(engine, principal, { mode: 'none' });
      const denied = await callHttpMcp(baseUrl, tokens.access_token);
      const deniedBody = JSON.parse(denied.payload.result.content[0].text);
      const mcpDenied = await call(ungrantedMcpAuthorization());
      expect(deniedBody).toEqual(JSON.parse(mcpDenied.content[0]!.text));

      await engine.executeRaw('DELETE FROM oauth_tokens WHERE token_hash = $1', [hashToken(tokens.access_token)]);
      const revoked = await callHttpMcp(baseUrl, tokens.access_token);
      expect(revoked.response.status).toBe(401);
      expect(JSON.stringify(revoked.payload)).not.toContain(tokens.access_token);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  test('OAuth, legacy API-key, and Workspace HTTP callers return the same allowed shape', async () => {
    const member = { kind: 'member' as const, id: 'membership-http' };
    await setPrincipalSourceAccess(engine, member, { mode: 'specific', sourceIds: ['source-a'] });

    const oauth = authorizationFromAuthInfo(agentAuth());
    const legacyApiKey = authorizationFromAuthInfo(agentAuth({
      token: 'different-legacy-secret',
      clientId: 'agent-legacy',
      clientName: 'Legacy API Key',
      scopes: ['read', 'write', 'admin'],
    }));
    const workspaceHttp = workspaceMemberAuthorization({
      membership_id: member.id,
      role: 'member',
    });

    const results = await Promise.all([call(oauth), call(legacyApiKey), call(workspaceHttp)]);
    const bodies = results.map(result => JSON.parse(result.content[0]!.text));

    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[0].map((page: { slug: string }) => page.slug)).toEqual(['notes/allowed']);
    expect(JSON.stringify(results)).not.toContain('credential-that-must-not-leak');
    expect(JSON.stringify(results)).not.toContain('different-legacy-secret');
    expect(JSON.stringify(results)).not.toContain('notes/restricted');
    expect(JSON.stringify(results)).not.toContain('Restricted title');
  });

  test('missing, empty, malformed, and ungranted remote Source access returns one safe denial shape', async () => {
    await setPrincipalSourceAccess(
      engine,
      { kind: 'agent', id: 'stdio-mcp' },
      { mode: 'all' },
    );
    const missingGrant = authorizationFromAuthInfo(agentAuth({
      token: 'missing-grant-secret',
      sourceId: undefined,
      allowedSources: undefined,
    }));
    const emptyGrant = authorizationFromAuthInfo(agentAuth({
      token: 'empty-grant-secret',
      sourceId: undefined,
      allowedSources: [],
    }));
    const malformedGrant = authorizationFromAuthInfo(agentAuth({
      token: 'malformed-grant-secret',
      allowedSources: ['source-a', '../source-b'],
    }));
    const policylessMember = workspaceMemberAuthorization({
      membership_id: 'membership-without-policy',
      role: 'member',
    });
    const ungrantedMcp = ungrantedMcpAuthorization();

    const results = await Promise.all([
      call(missingGrant),
      call(emptyGrant),
      call(malformedGrant),
      call(policylessMember),
      call(ungrantedMcp),
    ]);
    const bodies = results.map(result => JSON.parse(result.content[0]!.text));

    for (const result of results) expect(result.isError).toBe(true);
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0]).toEqual({
      error: 'permission_denied',
      message: 'Source access is required for this operation.',
      suggestion: 'Ask a Workspace Administrator to grant Source Access.',
    });

    const identity = await dispatchToolCall(engine, 'whoami', {}, { authorization: emptyGrant });
    expect(identity.isError).not.toBe(true);
    expect(JSON.parse(identity.content[0]!.text)).toMatchObject({
      transport: 'legacy',
      token_name: 'OAuth Agent',
      scopes: ['read'],
    });

    const serialized = JSON.stringify(results);
    for (const forbidden of [
      'missing-grant-secret',
      'empty-grant-secret',
      'malformed-grant-secret',
      'source-b',
      'notes/restricted',
      'Restricted title',
      'count',
      'latency',
      'revision',
      'config',
      'health',
      'provenance',
    ]) expect(serialized).not.toContain(forbidden);
  });

  test('capability scope and Source Access deny independently before operation dispatch', async () => {
    const readOnlyWithAccess = authorizationFromAuthInfo(agentAuth({ scopes: ['read'] }));
    const writeWithoutAccess = authorizationFromAuthInfo(agentAuth({
      scopes: ['write'],
      sourceId: undefined,
      allowedSources: [],
    }));

    const capabilityDenied = await dispatchToolCall(engine, 'put_page', {
      slug: 'notes/not-written',
      content: '---\ntype: note\ntitle: Not written\n---\nbody',
      dry_run: true,
    }, { authorization: readOnlyWithAccess });
    expect(JSON.parse(capabilityDenied.content[0]!.text)).toEqual({
      error: 'insufficient_scope',
      message: "Operation put_page requires 'write' scope",
    });

    const sourceDenied = await dispatchToolCall(engine, 'put_page', {
      slug: 'notes/not-written',
      content: '---\ntype: note\ntitle: Not written\n---\nbody',
      dry_run: true,
    }, { authorization: writeWithoutAccess });
    expect(JSON.parse(sourceDenied.content[0]!.text).error).toBe('permission_denied');

    const broadened = await dispatchToolCall(engine, 'sources_status', {
      id: 'source-b',
    }, { authorization: readOnlyWithAccess });
    const serialized = JSON.stringify(broadened);
    expect(broadened.isError).toBe(true);
    expect(serialized).not.toContain('source-b');
    expect(serialized).not.toContain('Restricted Source');
    expect(serialized).not.toContain('count');
    expect(serialized).not.toContain('latency');
    expect(serialized).not.toContain('provenance');
  });
});

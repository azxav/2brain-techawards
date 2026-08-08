import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  resolveOperationSourceAccess,
  resolvePrincipalSourceAccess,
  setPrincipalSourceAccess,
} from '../src/workspace/source-access.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let testEngine: PGLiteEngine;

beforeAll(async () => {
  testEngine = new PGLiteEngine();
  await testEngine.connect({});
});

afterAll(async () => {
  await testEngine.disconnect();
});

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(testEngine);
  await initializeWorkspaceFoundation(testEngine);
});

describe('principal Source Access', () => {
  test('trusted-local access is explicitly unrestricted', async () => {
    const value = testEngine;
    expect(await resolvePrincipalSourceAccess(value, { remote: false }, ['source-a']))
      .toEqual({ kind: 'unrestricted_trusted_local' });
  });

  test('missing or malformed remote principals fail closed without a default Source', async () => {
    const value = testEngine;
    expect(await resolvePrincipalSourceAccess(value, { remote: true }, ['default', 'source-a']))
      .toEqual({ kind: 'sources', sourceIds: [] });
    expect(await resolvePrincipalSourceAccess(value, { remote: true, principal: { kind: 'member', id: '' } }, ['default']))
      .toEqual({ kind: 'sources', sourceIds: [] });
  });

  test('legacy brains without policy tables use only an explicit validated credential grant', async () => {
    const legacyEngine = {
      executeRaw: async () => {
        const error = new Error('relation workspace_principal_source_policies does not exist') as Error & { code: string };
        error.code = '42P01';
        throw error;
      },
    };
    const principal = { kind: 'agent' as const, id: 'legacy-agent-id' };

    expect(await resolveOperationSourceAccess(legacyEngine as never, {
      remote: true,
      principal,
      credentialSourceIds: ['source-a'],
    })).toEqual({ kind: 'sources', sourceIds: ['source-a'] });
    expect(await resolveOperationSourceAccess(legacyEngine as never, {
      remote: true,
      principal,
    })).toEqual({ kind: 'sources', sourceIds: [] });
  });

  test('All Sources includes every current and future Source', async () => {
    const value = testEngine;
    const principal = { kind: 'member' as const, id: 'membership-1' };
    await setPrincipalSourceAccess(value, principal, { mode: 'all' });

    expect(await resolvePrincipalSourceAccess(value, { remote: true, principal }, ['source-a']))
      .toEqual({ kind: 'sources', sourceIds: ['source-a'] });
    expect(await resolvePrincipalSourceAccess(value, { remote: true, principal }, ['source-a', 'source-new']))
      .toEqual({ kind: 'sources', sourceIds: ['source-a', 'source-new'] });
  });

  test('Specific Sources contains only immutable explicit identifiers', async () => {
    const value = testEngine;
    const principal = { kind: 'agent' as const, id: 'agent-1' };
    await setPrincipalSourceAccess(value, principal, { mode: 'specific', sourceIds: ['source-b', 'source-a', 'source-a'] });

    expect(await resolvePrincipalSourceAccess(value, { remote: true, principal }, ['source-a', 'source-b', 'source-new']))
      .toEqual({ kind: 'sources', sourceIds: ['source-a', 'source-b'] });
    await expect(setPrincipalSourceAccess(value, principal, { mode: 'specific', sourceIds: ['../source-a'] }))
      .rejects.toThrow('invalid_source_access_grant');
  });

  test('No Source Access replaces stale grants and remains independent of role or Agent Scope', async () => {
    const value = testEngine;
    const member = { kind: 'member' as const, id: 'shared-id' };
    const agent = { kind: 'agent' as const, id: 'shared-id' };
    await setPrincipalSourceAccess(value, member, { mode: 'specific', sourceIds: ['source-a'] });
    await setPrincipalSourceAccess(value, agent, { mode: 'all' });
    await setPrincipalSourceAccess(value, member, { mode: 'none' });

    expect(await resolvePrincipalSourceAccess(value, { remote: true, principal: member }, ['source-a']))
      .toEqual({ kind: 'sources', sourceIds: [] });
    expect(await resolvePrincipalSourceAccess(value, { remote: true, principal: agent }, ['source-a']))
      .toEqual({ kind: 'sources', sourceIds: ['source-a'] });
  });

  test('resolver ignores Workspace role and Agent Scope dimensions', async () => {
    const principal = { kind: 'member' as const, id: 'membership-independent' };
    await setPrincipalSourceAccess(testEngine, principal, { mode: 'specific', sourceIds: ['source-a'] });
    const administrator = { remote: true, principal, workspaceRole: 'administrator' };
    const readAgentContext = { remote: true, principal, agentScope: 'read' };

    expect(await resolvePrincipalSourceAccess(testEngine, administrator, ['source-a', 'source-b']))
      .toEqual({ kind: 'sources', sourceIds: ['source-a'] });
    expect(await resolvePrincipalSourceAccess(testEngine, readAgentContext, ['source-a', 'source-b']))
      .toEqual({ kind: 'sources', sourceIds: ['source-a'] });
  });

  test('malformed persisted grants fail the entire remote resolution closed', async () => {
    const fakeEngine = {
      executeRaw: async (sql: string) => sql.includes('workspace_principal_source_policies')
        ? [{ access_mode: 'specific' }]
        : [{ source_id: 'source-a' }, { source_id: '../source-b' }],
    };
    expect(await resolvePrincipalSourceAccess(
      fakeEngine as never,
      { remote: true, principal: { kind: 'member', id: 'membership-malformed' } },
      ['source-a'],
    )).toEqual({ kind: 'sources', sourceIds: [] });
  });
});

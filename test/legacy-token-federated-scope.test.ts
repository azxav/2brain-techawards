/**
 * #1336 — legacy bearer tokens honor their stored federated_read grant.
 *
 * Pre-fix the legacy access_tokens path hardcoded `sourceId: 'default'` and never
 * populated `allowedSources`, so a token whose `permissions.source_id` granted
 * multiple sources could not read across them (and MCP reads silently returned
 * empty in non-default brains). The grant is now parsed and threaded.
 *
 * Bounded by design: never widened to "all" — an empty/garbage value resolves
 * to an explicit empty Source set.
 */
import { describe, test, expect } from 'bun:test';
import { parseLegacyTokenScope } from '../src/mcp/http-transport.ts';

describe('parseLegacyTokenScope', () => {
  test('array grant → allowedSources (federated read) with first as scalar floor', () => {
    expect(parseLegacyTokenScope(['dept-x', 'shared'])).toEqual({ sourceId: 'dept-x', allowedSources: ['dept-x', 'shared'] });
  });

  test('single-element array → that source as both floor and grant', () => {
    expect(parseLegacyTokenScope(['only'])).toEqual({ sourceId: 'only', allowedSources: ['only'] });
  });

  test('string grant → scalar source and explicit one-source grant', () => {
    expect(parseLegacyTokenScope('team-a')).toEqual({ sourceId: 'team-a', allowedSources: ['team-a'] });
  });

  test('absent grant → explicit empty Source set', () => {
    expect(parseLegacyTokenScope(undefined)).toEqual({ allowedSources: [] });
    expect(parseLegacyTokenScope(null)).toEqual({ allowedSources: [] });
  });

  test('empty array → explicit empty Source set (NOT "all")', () => {
    expect(parseLegacyTokenScope([])).toEqual({ allowedSources: [] });
  });

  test('garbage (number / empty string) → explicit empty Source set', () => {
    expect(parseLegacyTokenScope(123)).toEqual({ allowedSources: [] });
    expect(parseLegacyTokenScope('')).toEqual({ allowedSources: [] });
  });

  test('a mixed-malformed array fails the entire grant closed', () => {
    expect(parseLegacyTokenScope(['a', 5, '', 'b'])).toEqual({ allowedSources: [] });
  });
});

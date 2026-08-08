/**
 * Tests for resolveWorkspaceProductionFlag() in src/commands/serve-http.ts.
 *
 * The flag decides whether Workspace session cookies are marked Secure, so
 * parsing must be deterministic: recognized truthy/falsy values win, and any
 * unrecognized value falls back to the NODE_ENV inference instead of silently
 * forcing one behavior.
 */
import { describe, expect, test } from 'bun:test';
import { resolveWorkspaceProductionFlag } from '../src/commands/serve-http.ts';

describe('resolveWorkspaceProductionFlag', () => {
  test('recognized truthy values force production cookies', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(resolveWorkspaceProductionFlag({ GBRAIN_WORKSPACE_PRODUCTION: value })).toBe(true);
    }
  });

  test('recognized falsy values force non-production cookies even under NODE_ENV=production', () => {
    for (const value of ['0', 'false', 'FALSE', 'no', 'off']) {
      expect(resolveWorkspaceProductionFlag({ GBRAIN_WORKSPACE_PRODUCTION: value, NODE_ENV: 'production' })).toBe(false);
    }
  });

  test('unset falls back to the NODE_ENV inference', () => {
    expect(resolveWorkspaceProductionFlag({ NODE_ENV: 'production' })).toBe(true);
    expect(resolveWorkspaceProductionFlag({ NODE_ENV: 'development' })).toBe(false);
    expect(resolveWorkspaceProductionFlag({})).toBe(false);
  });

  test('unrecognized values fall back to NODE_ENV rather than forcing either behavior', () => {
    expect(resolveWorkspaceProductionFlag({ GBRAIN_WORKSPACE_PRODUCTION: 'flase', NODE_ENV: 'production' })).toBe(true);
    expect(resolveWorkspaceProductionFlag({ GBRAIN_WORKSPACE_PRODUCTION: 'flase' })).toBe(false);
    expect(resolveWorkspaceProductionFlag({ GBRAIN_WORKSPACE_PRODUCTION: '  ' })).toBe(false);
  });
});

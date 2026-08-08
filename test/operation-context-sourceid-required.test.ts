/**
 * v0.34 STEP 0 / D4 — OperationContext.sourceId REQUIRED contract.
 *
 * The compiler is the first defense. Mirrors v0.26.9 `remote` REQUIRED
 * pattern that closed the HTTP RCE class. Every transport that builds an
 * OperationContext literal MUST populate sourceId; this test pins the
 * contract so a future regression that quietly demotes the field back to
 * optional fails loud at compile time.
 *
 * Why these tests use @ts-expect-error rather than runtime asserts:
 * the contract IS the type signature. Runtime behavior is uninteresting
 * (the field gets read by op handlers as a normal string). What we
 * defend against is the type being weakened — that's a compile-time
 * concern, not a runtime concern.
 */
import { describe, test, expect } from 'bun:test';
import { buildOperationContext } from '../src/mcp/dispatch.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('OperationContext.sourceId — REQUIRED contract', () => {
  test('omitting sourceId from an OperationContext literal is a type error', () => {
    // @ts-expect-error — sourceId is required; this literal is missing it
    const badCtx: OperationContext = {
      engine: {} as BrainEngine,
      config: { engine: 'pglite' } as any,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      // sourceId intentionally omitted — must be a compile error
    };
    // Reference badCtx so it isn't dead code; the @ts-expect-error is the
    // assertion. Use a type-only access so runtime behavior doesn't matter.
    void badCtx;
    expect(true).toBe(true);
  });

  test('passing sourceId satisfies the contract', () => {
    const ctx: OperationContext = {
      engine: {} as BrainEngine,
      config: { engine: 'pglite' } as any,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    };
    expect(ctx.sourceId).toBe('default');
  });

  test('passing undefined for sourceId is a type error', () => {
    const ctx: OperationContext = {
      engine: {} as BrainEngine,
      config: { engine: 'pglite' } as any,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      // @ts-expect-error — undefined is not assignable to string
      sourceId: undefined,
    };
    void ctx;
    expect(true).toBe(true);
  });
});

describe('buildOperationContext — auto-fill safety net', () => {
  // The compatibility default is scoped to explicitly trusted local callers.
  // A DispatchOpts that does not say `remote: false` is treated as remote, so
  // it gets '' — an unusable write target — rather than silently inheriting
  // the default Source. See the unify-remote-authorization-dispatch change in
  // src/mcp/dispatch.ts.
  test('omitting sourceId from a trusted-local dispatch falls back to "default"', () => {
    const engine = {} as BrainEngine;
    const ctx = buildOperationContext(engine, {}, { remote: false });
    expect(ctx.sourceId).toBe('default');
    expect(typeof ctx.sourceId).toBe('string');
  });

  test('omitting sourceId from an untrusted dispatch does NOT fall back to "default"', () => {
    const engine = {} as BrainEngine;
    const ctx = buildOperationContext(engine, {}, {});
    expect(ctx.remote).toBe(true);
    expect(ctx.sourceId).toBe('');
  });

  test('explicit sourceId in DispatchOpts is preserved', () => {
    const engine = {} as BrainEngine;
    const ctx = buildOperationContext(engine, {}, { sourceId: 'my-source' });
    expect(ctx.sourceId).toBe('my-source');
  });

  test('explicit empty-string sourceId is preserved (not coerced to default)', () => {
    // Empty string is a valid string. The auto-fill only fires on undefined.
    const engine = {} as BrainEngine;
    const ctx = buildOperationContext(engine, {}, { sourceId: '' });
    // The ?? operator returns 'default' for null/undefined only; '' passes through.
    expect(ctx.sourceId).toBe('');
  });
});

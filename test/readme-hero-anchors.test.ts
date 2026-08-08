import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('public README contract', () => {
  const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');

  test('uses the public product identity', () => {
    expect(readme.startsWith('# 2Brain\n')).toBe(true);
    expect(readme).toContain('public incubation edition');
  });

  test('explains value and architecture', () => {
    expect(readme).toContain('## Problem');
    expect(readme).toContain('## Solution');
    expect(readme).toContain('## Architecture');
    expect(readme).toContain('## Security and privacy');
  });

  test('documents compatibility and verification', () => {
    expect(readme).toContain('remain named `gbrain` for compatibility');
    expect(readme).toContain('bun run verify');
    expect(readme).toContain('bun run test:full');
  });
});

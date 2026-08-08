import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('postinstall exits successfully without requiring a POSIX shell or configured brain', () => {
  const result = spawnSync(process.execPath, ['run', resolve('scripts/postinstall.ts')], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toContain('Run `gbrain doctor` after setup');
});

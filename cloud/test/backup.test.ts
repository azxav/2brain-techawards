import { describe, expect, test } from 'bun:test';
import { runBackup } from '../src/backup.ts';
import { FakeObjectStorage } from '../src/adapters/object-storage.ts';
import { openSecret, parseSealingKey, randomSealingKey, SecretSealError } from '../src/secrets.ts';

const key = parseSealingKey(randomSealingKey());
const at = (iso: string) => () => new Date(iso);

describe('runBackup', () => {
  test('stores the dump sealed, under a timestamped object name', async () => {
    const storage = new FakeObjectStorage();

    const objectName = await runBackup({
      dump: async () => 'CREATE TABLE cp_workspaces (id text);',
      storage,
      sealingKey: key,
      now: at('2026-07-17T03:00:00.000Z'),
    });

    expect(objectName).toBe('registry/2026-07-17T03-00-00-000Z.sql.sealed');
    const stored = storage.objects.get(objectName)!;
    expect(stored.contentType).toBe('application/octet-stream');
    // The whole artifact is ciphertext, not just the columns that already were.
    expect(stored.body).not.toContain('cp_workspaces');
    expect(openSecret(stored.body, key)).toBe('CREATE TABLE cp_workspaces (id text);');
  });

  test('a dump sealed under one key cannot be opened by another', async () => {
    const storage = new FakeObjectStorage();
    const otherKey = parseSealingKey(randomSealingKey());

    const objectName = await runBackup({
      dump: async () => 'CREATE TABLE cp_workspaces (id text); -- secret-registry-contents',
      storage,
      sealingKey: key,
      now: at('2026-07-17T03:00:00.000Z'),
    });

    // This is the escrow claim: without CP_SECRET_KEY the backup is unreadable.
    expect(() => openSecret(storage.objects.get(objectName)!.body, otherKey)).toThrow(SecretSealError);
  });

  test('refuses to store an empty dump', async () => {
    const storage = new FakeObjectStorage();

    await expect(
      runBackup({ dump: async () => '   \n', storage, sealingKey: key, now: at('2026-07-17T03:00:00.000Z') }),
    ).rejects.toThrow(/empty/i);

    // A silent zero-byte backup is worse than a loud failure: the timer would
    // report success nightly while the registry had no durable copy at all.
    expect(storage.objects.size).toBe(0);
  });

  test('refuses to store a dump that has no registry table in it', async () => {
    const storage = new FakeObjectStorage();
    // Shaped like real pg_dump output against a database where migrations
    // never ran (or the wrong database entirely): a non-empty header with no
    // CREATE TABLE/COPY rows for cp_workspaces. This is the realistic case
    // the whitespace-only check above cannot catch.
    const headerOnly = [
      '--',
      '-- PostgreSQL database dump',
      '--',
      '',
      'SET statement_timeout = 0;',
      "SET client_encoding = 'UTF8';",
    ].join('\n');

    await expect(
      runBackup({ dump: async () => headerOnly, storage, sealingKey: key, now: at('2026-07-17T03:00:00.000Z') }),
    ).rejects.toThrow(/cp_workspaces/i);

    // Partial "success" here is worse than the empty-dump case: sealed
    // ciphertext in the bucket looks like a normal backup in a listing.
    expect(storage.objects.size).toBe(0);
  });

  test('a failed upload surfaces rather than being swallowed', async () => {
    const storage = new FakeObjectStorage();
    storage.failNext('put');

    await expect(
      runBackup({
        dump: async () => 'CREATE TABLE cp_workspaces (id text);',
        storage,
        sealingKey: key,
        now: at('2026-07-17T03:00:00.000Z'),
      }),
    ).rejects.toThrow();
  });
});

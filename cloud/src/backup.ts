/**
 * Nightly registry backup: pg_dump -> seal -> OCI Object Storage.
 *
 * The registry is the one dataset in the pilot that gets backups (#46). #35's
 * "no backups" clause covers workspace data, which has GitHub-synced Sources as
 * its durable copy; the registry has none, and losing it strands the fleet.
 *
 * The whole dump is sealed, not just the columns that were already ciphertext:
 * a plain dump still carries operator emails, GitHub ids, workspace names,
 * subdomains, and invite codes, so "a database dump alone does not hand over the
 * fleet" is only true of the artifact if the artifact is sealed whole.
 *
 * Scale bound: the dump is held in memory and base64url inflates it ~33%. That
 * is fine at a fleet cap of 20 workspaces, where the registry is kilobytes. This
 * is not a general backup tool and should not be pointed at workspace data.
 */
import { readFileSync } from 'node:fs';
import { OciObjectStorage, type ObjectStorage } from './adapters/object-storage.ts';
import { parseSealingKey, sealSecret } from './secrets.ts';

export interface BackupDeps {
  dump: () => Promise<string>;
  storage: ObjectStorage;
  sealingKey: Buffer;
  now: () => Date;
}

/** Returns the object name written. */
export async function runBackup(deps: BackupDeps): Promise<string> {
  const plaintext = await deps.dump();
  if (plaintext.trim() === '') {
    // Truly empty output (pg_dump never ran, or ran against nothing at all)
    // is the cheap, honest floor for this check. Fail loudly instead of
    // letting the timer report success over a zero-byte object.
    throw new Error('pg_dump produced an empty dump; refusing to store it');
  }
  if (!plaintext.includes('cp_workspaces')) {
    // pg_dump emits several hundred bytes of header (comments, SET
    // statements) even against an empty or unmigrated database, so the
    // check above passes long before the dump has any real content. What
    // must never happen is the unattended nightly timer reporting success
    // over a dump with no durable copy of the registry in it — so require
    // the table whose loss strands the fleet (OCID, subdomain, sealed
    // bootstrap credential, lifecycle state) to actually be in the dump.
    // Its absence means this ran against the wrong database, or the right
    // one before migrations ran — not that the registry happens to be empty
    // (an empty table still gets a CREATE TABLE statement).
    throw new Error('pg_dump produced a dump with no cp_workspaces table in it; refusing to store it');
  }
  const sealed = sealSecret(plaintext, deps.sealingKey);
  const stamp = deps.now().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const objectName = `registry/${stamp}.sql.sealed`;
  await deps.storage.put(objectName, sealed, 'application/octet-stream');
  return objectName;
}

// ---------------------------------------------------------------------------
// Entrypoint: env, real Postgres, real bucket. Kept out of runBackup so tests
// never need a live database.
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[backup] missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

/**
 * Credentials go via PGPASSWORD, never argv: a URL passed as an argument is
 * visible in `ps` to every account on the box.
 */
async function pgDump(databaseUrl: string): Promise<string> {
  const url = new URL(databaseUrl);
  const child = Bun.spawn(
    [
      'pg_dump',
      '--format=plain',
      '--no-owner',
      '--no-privileges',
      '--host', url.hostname,
      '--port', url.port || '5432',
      '--username', decodeURIComponent(url.username),
      '--dbname', url.pathname.replace(/^\//, ''),
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`pg_dump exited ${exitCode}: ${stderr.trim()}`);
  return stdout;
}

if (import.meta.main) {
  const databaseUrl = requireEnv('CP_DATABASE_URL');

  let sealingKey: Buffer;
  try {
    sealingKey = parseSealingKey(requireEnv('CP_SECRET_KEY'));
  } catch (error) {
    console.error(`[backup] CP_SECRET_KEY is unusable: ${(error as Error).message}`);
    process.exit(1);
  }

  const storage = new OciObjectStorage({
    credentials: {
      tenancyOcid: requireEnv('OCI_TENANCY_OCID'),
      userOcid: requireEnv('OCI_USER_OCID'),
      fingerprint: requireEnv('OCI_KEY_FINGERPRINT'),
      privateKeyPem: readFileSync(requireEnv('OCI_PRIVATE_KEY_PATH'), 'utf8'),
    },
    region: requireEnv('OCI_REGION'),
    namespace: requireEnv('CP_BACKUP_NAMESPACE'),
    bucket: requireEnv('CP_BACKUP_BUCKET'),
  });

  try {
    const objectName = await runBackup({
      dump: () => pgDump(databaseUrl),
      storage,
      sealingKey,
      now: () => new Date(),
    });
    console.log(`[backup] wrote ${objectName}`);
  } catch (error) {
    // Non-zero so the timer's unit fails and the operator's journal shows it.
    console.error(`[backup] failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

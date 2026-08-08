/**
 * Envelope encryption for the few secrets the registry must be able to replay.
 *
 * Most credentials the control plane holds are verifiers: sessions and invite
 * codes are stored as sha256 digests and never need to come back (see tokens.ts).
 * The per-workspace bootstrap credential is different — the control plane has to
 * present it to the Workspace HTTP boundary, so a digest cannot work. It is
 * sealed here instead, under a key that lives in the environment rather than in
 * the database, so a database dump alone does not hand over the fleet.
 *
 * This is not a substitute for a real secret store; it is the pilot's floor.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretSealError';
  }
}

/**
 * Decode and validate the fleet key. Throws rather than silently weakening:
 * Buffer.from ignores anything it cannot decode instead of raising, so the
 * length check is the only real gate and has to be the one that fails.
 */
export function parseSealingKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) throw new SecretSealError(`sealing key must be ${KEY_BYTES} bytes, got ${key.length}`);
  return key;
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url — safe to store in a text column. */
export function sealSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function openSecret(sealed: string, key: Buffer): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretSealError('sealed secret is malformed or of an unknown version');
  const [, iv, tag, ciphertext] = parts;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or tampered ciphertext. Never echo either back.
    throw new SecretSealError('sealed secret could not be opened');
  }
}

export function randomSealingKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

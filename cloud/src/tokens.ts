import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Hex sha256 of a secret — the only form any secret takes in the database. */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Invite codes are shorter than session tokens but still unguessable. */
export function randomInviteCode(): string {
  return `2b-${randomBytes(12).toString('base64url')}`;
}

export function digestMatches(provided: string, expectedDigest: string): boolean {
  const a = Buffer.from(digest(provided));
  const b = Buffer.from(expectedDigest);
  return a.length === b.length && timingSafeEqual(a, b);
}

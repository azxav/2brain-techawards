/**
 * Small request-level helpers shared by the Workspace router and the OAuth
 * consent router. Express 5 has no built-in cookie parsing; `cookie` reads
 * the parsed jar when the cookie-parser middleware ran and falls back to the
 * raw header otherwise, so routers work identically in serve-http (which
 * mounts cookie-parser) and in tests that don't.
 */

import type express from 'express';

/** Parse a positive integer env var, falling back to default. */
export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function cookie(req: express.Request, name: string): string | undefined {
  const parsed = (req as express.Request & { cookies?: Record<string, string> }).cookies?.[name];
  if (parsed) return parsed;
  const match = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

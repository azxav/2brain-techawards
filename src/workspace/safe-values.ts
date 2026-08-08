import { redactConnectionInfo } from '../core/audit/redact-connection-info.ts';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|private[_-]?key|secret|session|token|api[_-]?key)/i;
const SAFE_AUDIT_KEYS = new Set([
  'active',
  'archived',
  'assignee_id',
  'cadence',
  'client_id',
  'configured_access_level',
  'deleted',
  'enabled',
  'effective_access_level',
  'expected_cadence',
  'id',
  'included_in_workspace_search',
  'kind',
  'lifecycle_state',
  'membership_id',
  'name',
  'owner_id',
  'policy',
  'revoked',
  'role',
  'scope',
  'source_access',
  'source_ids',
  'access_level',
  'state',
  'status',
  'type',
]);

const UNSAFE_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(password|pwd|secret|token|credential|api[_-]?key|authorization|cookie)\s*[:=]/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
  /\b[A-Za-z]:\\/,
  /(^|\s)\/[^\s]/,
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  /(^|\r?\n)\s*at\s+[^\r\n]+/i,
  /\bSELECT\s+.+\s+FROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\S+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\b(?:ALTER|CREATE|DROP)\s+TABLE\b/i,
];

/** Fail-closed scrubber for browser-visible and member-visible text. */
export function sanitizeWorkspaceText(text: string): string {
  if (redactConnectionInfo(text) !== text || UNSAFE_TEXT_PATTERNS.some(pattern => pattern.test(text))) {
    return REDACTED;
  }
  return text.slice(0, 2_000);
}

/**
 * Audit snapshots support a deliberately small state vocabulary. Unknown or
 * secret-shaped fields are redacted instead of silently expanding the
 * durable audit surface whenever a caller passes a richer domain object.
 */
export function sanitizeWorkspaceSnapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizeWorkspaceText(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) return value.map(item => sanitizeWorkspaceSnapshot(item, seen));

  const safe: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    safe[key] = SENSITIVE_KEY.test(key) || !SAFE_AUDIT_KEYS.has(normalizedKey)
      ? REDACTED
      : sanitizeWorkspaceSnapshot(nested, seen);
  }
  return safe;
}

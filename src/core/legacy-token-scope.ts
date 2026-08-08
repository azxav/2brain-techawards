import { isValidSourceId } from './source-id.ts';

/**
 * Derive a legacy bearer token's source scope from its stored
 * `access_tokens.permissions.source_id` grant.
 *
 * ARRAY = federated read grant, exposed through `allowedSources` with the
 * first granted source as the scalar write floor. STRING = scalar source.
 * Missing, empty, mixed-malformed, or garbage values fail closed to an
 * explicit empty Source set and NEVER widen to all sources.
 */
export function parseLegacyTokenScope(rawSource: unknown): { sourceId?: string; allowedSources: string[] } {
  if (Array.isArray(rawSource)) {
    if (rawSource.length === 0 || rawSource.some(sourceId => !isValidSourceId(sourceId))) {
      return { allowedSources: [] };
    }
    const allowedSources = [...new Set(rawSource as string[])];
    return { sourceId: allowedSources[0], allowedSources };
  }
  if (isValidSourceId(rawSource)) {
    return { sourceId: rawSource, allowedSources: [rawSource] };
  }
  return { allowedSources: [] };
}

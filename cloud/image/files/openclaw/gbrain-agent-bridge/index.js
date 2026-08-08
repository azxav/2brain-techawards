// The ONLY GBrain-owned surface inside the pinned OpenClaw runtime (#68).
//
// GBrain's control adapter reaches the Gateway over loopback and needs exactly
// one thing the bundled admin RPC cannot do safely: hand OpenClaw a provider
// credential the Workspace Administrator supplied, without that credential ever
// travelling through a config-mutation surface that also writes everything else.
//
// This plugin is therefore deliberately one write-only route with a closed
// two-value provider set. It exposes no read, list, delete, shell, file, or
// arbitrary-provider operation, and it never logs: a credential that reaches a
// journal is a credential the whole VM's operators can read.
//
// The route runs at `auth: 'gateway'`, so the Gateway's own auth decides who may
// call it. On this image that is trusted-proxy auth with `allowLoopback`, whose
// boundary is the loopback bind plus Caddy stripping client-supplied identity
// headers at the edge — NOT the header values themselves, which OpenClaw only
// checks for presence.
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import {
  resolveOpenClawAgentDir,
  upsertAuthProfileWithLock,
  validateAnthropicSetupToken,
} from 'openclaw/plugin-sdk/provider-auth';

/** A provider credential is a few hundred bytes; 32 KiB is already generous. */
const MAX_BODY_BYTES = 32 * 1024;

/**
 * The closed provider set. A Map rather than a list so the profile id and
 * credential shape for each provider are declared once, together: an added
 * entry cannot accidentally inherit another provider's storage shape.
 */
const SUPPORTED_PROVIDERS = new Map([
  ['anthropic', {
    profileId: 'anthropic:gbrain',
    buildCredential: token => ({ type: 'token', provider: 'anthropic', token }),
  }],
  ['openrouter', {
    profileId: 'openrouter:gbrain',
    buildCredential: key => ({ type: 'api_key', provider: 'openrouter', key }),
  }],
]);

/** Only `{ ok: true, provider }` or `{ ok: false, code }` ever leaves this route. */
function reply(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
  return true;
}

/**
 * Reads at most MAX_BODY_BYTES and returns `null` past that bound.
 *
 * The declared `content-length` is checked first so an oversized body is
 * refused before a byte of it is buffered, but the streaming bound is what
 * actually enforces the limit: a chunked request declares no length at all.
 */
async function readBoundedBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleProviderImport(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'method_not_allowed' });
  const contentType = String(req.headers['content-type'] ?? '').trim();
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return reply(res, 415, { ok: false, code: 'unsupported_media_type' });
  }

  let body = null;
  let credential = null;
  try {
    const raw = await readBoundedBody(req);
    if (raw === null) return reply(res, 413, { ok: false, code: 'payload_too_large' });
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(res, 400, { ok: false, code: 'invalid_body' });
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return reply(res, 400, { ok: false, code: 'invalid_body' });
    }
    const provider = body.provider;
    if (typeof provider !== 'string' || !SUPPORTED_PROVIDERS.has(provider)) {
      return reply(res, 400, { ok: false, code: 'unsupported_provider' });
    }
    credential = body.credential;
    if (typeof credential !== 'string' || credential.trim() === '') {
      return reply(res, 400, { ok: false, code: 'invalid_credential' });
    }
    // Anthropic setup tokens have a checkable shape, so a paste error is
    // refused here rather than surfacing later as an opaque provider 401.
    if (provider === 'anthropic') {
      const problem = validateAnthropicSetupToken(credential);
      if (problem) return reply(res, 400, { ok: false, code: 'invalid_credential' });
    }
    const { profileId, buildCredential } = SUPPORTED_PROVIDERS.get(provider);
    // `null` means the store was not written. Treating it as success would
    // report an import that never happened.
    const store = await upsertAuthProfileWithLock({
      profileId,
      credential: buildCredential(credential),
      agentDir: resolveOpenClawAgentDir(process.env),
    });
    if (store === null) return reply(res, 500, { ok: false, code: 'import_failed' });
    return reply(res, 200, { ok: true, provider });
  } catch {
    // The thrown value is deliberately not inspected or reported: it can carry
    // the credential in a message or stack frame.
    return reply(res, 500, { ok: false, code: 'import_failed' });
  } finally {
    // Best-effort lifetime minimization: it drops THIS scope's references so
    // the parsed body and credential become collectable as soon as the request
    // ends. It does not and cannot zeroize the JavaScript strings themselves.
    body = null;
    credential = null;
  }
}

export default definePluginEntry({
  id: 'gbrain-agent-bridge',
  name: '2Brain Agent provider bridge',
  description: 'Imports supported pilot provider credentials from GBrain loopback control.',
  register(api) {
    api.registerHttpRoute({
      path: '/api/v1/gbrain/provider',
      auth: 'gateway',
      match: 'exact',
      gatewayRuntimeScopeSurface: 'trusted-operator',
      handler: handleProviderImport,
    });
  },
});

// Exported for the image contract test, which drives the real handler rather
// than reading its source. Not part of the OpenClaw plugin contract.
export { MAX_BODY_BYTES, handleProviderImport };

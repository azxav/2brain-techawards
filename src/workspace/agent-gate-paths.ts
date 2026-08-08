/**
 * The three GBrain agent-gate paths, named once (#68).
 *
 * These strings are a cross-runtime contract, not route decoration. Four things
 * have to agree on them and only two are TypeScript:
 *   - this router, which serves them;
 *   - the control plane's readiness probe (`cloud/src/agent-ingress-contract.ts`
 *     re-exports AGENT_RUNTIME_HEALTH_PATH from here);
 *   - the Caddyfile rendered by `cloud/image/files/bin/gbrain-agent-finalize`,
 *     whose two `forward_auth` blocks rewrite onto AGENT_AUTHORIZE_PATH and
 *     AGENT_NATIVE_READY_PATH; and
 *   - the finalizer's own readiness curl.
 *
 * Before this module the router held its own copies, so renaming a route left
 * every GBrain test green while the probe and both gates 404'd in production.
 * This file imports nothing so the control plane, which runs a production-only
 * install, can import it without dragging GBrain's dependency tree behind it.
 */
export const AGENT_RUNTIME_HEALTH_PATH = '/api/workspace/v1/agent/runtime-health';
export const AGENT_AUTHORIZE_PATH = '/api/workspace/v1/agent/authorize';
export const AGENT_NATIVE_READY_PATH = '/api/workspace/v1/agent/native-ready';

/**
 * The two PUBLIC ingress prefixes on the Workspace origin, as opposed to the
 * three gate paths above. They live here for the same reason: the Caddyfile in
 * `cloud/image/files/bin/gbrain-agent-finalize` hardcodes them, the control
 * plane's `cloud/src/agent-ingress-contract.ts` re-exports them, and #68's
 * `GET /agent/native-access` builds the native client's `wss://` URL from
 * AGENT_CLIENT_BASE_PATH. Before this, GBrain had no copy at all and the
 * customer-facing URL would have been a fourth hand-written literal.
 */
export const AGENT_BASE_PATH = '/agent';
export const AGENT_CLIENT_BASE_PATH = '/agent-client';

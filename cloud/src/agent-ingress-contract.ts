/**
 * The agent ingress literals, named so a test can pin them (#57, #68).
 *
 * These constants are implemented in `cloud/image/files/bin/gbrain-agent-finalize`,
 * not here. That script is standalone bash and imports nothing, so nothing but a
 * test can hold it to the same bytes the control plane and GBrain use — which is
 * exactly what `cloud/test/image-contract.test.ts` does with these values.
 *
 * They live in their own module rather than in `cloud-init.ts` because most of
 * them have no production consumer at all: a production module whose exports
 * exist only for a test invites someone to "clean up" the pin. The one exception
 * is AGENT_RUNTIME_HEALTH_PATH, which `adapters/workspace.ts` really does dial —
 * and which is re-exported from GBrain's own `src/workspace/agent-gate-paths.ts`
 * so the path the control plane probes is the path the router actually mounts.
 */
export { AGENT_RUNTIME_HEALTH_PATH } from '../../src/workspace/agent-gate-paths.ts';

/**
 * The agent gateway's two public paths on the Workspace origin (#57, #68).
 *
 * AGENT_BASE_PATH: the gateway's own `gateway.controlUi.basePath`, the Caddy
 * matcher that routes to it, and the finalizer's loopback readiness curl must
 * all agree. AGENT_CLIENT_BASE_PATH is the second public prefix for the SAME
 * gateway, used by native apps and CLIs; Caddy rewrites it back onto
 * AGENT_BASE_PATH before the upstream, so the gateway still sees the one
 * basePath it is configured with. The two ingresses authenticate differently
 * and cannot share a route: the browser prefix carries a Caddy-created
 * trusted-proxy identity, while this one deliberately carries none so the
 * gateway's direct-loopback password fallback authenticates the client.
 *
 * Both are re-exported from GBrain rather than re-declared, because #68's
 * `GET /api/workspace/v1/agent/native-access` builds the customer's `wss://`
 * URL from AGENT_CLIENT_BASE_PATH and a second copy could drift from the
 * Caddyfile silently.
 */
export {
  AGENT_BASE_PATH,
  AGENT_CLIENT_BASE_PATH,
} from '../../src/workspace/agent-gate-paths.ts';

/** The gateway's loopback port inside the VM; never publicly reachable. */
export const AGENT_GATEWAY_PORT = 3334;

/**
 * GBrain's own loopback port inside the VM — the `forward_auth` upstream and the
 * root route's upstream.
 */
export const GBRAIN_WEB_PORT = 3131;

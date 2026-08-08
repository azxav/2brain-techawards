import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { appDocument, invitationDocument, workspacePanelForPath } from '../src/web/workspace-shell.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';
import { withEnv } from './helpers/with-env.ts';

const agentsPage = (agentTier: boolean, role: 'administrator' | 'member' = 'administrator') =>
  appDocument('Trust Workspace', role, 'all', '/app/agents', {}, 'latest', agentTier);

/** Every text node under one selector, in document order. */
async function textUnder(html: string, selector: string): Promise<string[]> {
  const chunks: string[] = [];
  let current = '';
  const rewriter = new HTMLRewriter().on(selector, {
    element(element) {
      if (current) { chunks.push(current); current = ''; }
      element.onEndTag(() => { chunks.push(current); current = ''; });
    },
    text(chunk) { current += chunk.text; },
  });
  await rewriter.transform(new Response(html)).text();
  if (current) chunks.push(current);
  return chunks.map(value => value.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// #68 Task 11 — the singular Agent destination.
//
// Agent tier replaces the plural Agents surface entirely; Brain tier keeps it
// byte-for-byte. The #58 D4 manual MCP snippet is gone: Task 8/10 configure the
// GBrain MCP server from the reconciler, so pasting a hand-written server block
// is no longer a step anyone should be told to take.
// ---------------------------------------------------------------------------

describe('#68 Task 11 — the singular Agent destination', () => {
  test('Agent tier gives every role a singular Agent destination', () => {
    for (const role of ['administrator', 'member'] as const) {
      const html = appDocument(
        'Trust Workspace', role, 'all', '/app/agent', {}, 'latest', true,
      );
      expect(html).toContain('href="/app/agent"');
      expect(html).toContain('>Agent<');
    }
  });

  test('Brain tier keeps its existing Agents page and has no customer Agent route', () => {
    const html = appDocument(
      'Trust Workspace', 'administrator', 'all', '/app/agents', {}, 'latest', false,
    );
    expect(html).toContain('href="/app/agents"');
    expect(html).not.toContain('href="/app/agent"');
    expect(workspacePanelForPath('/app/agent', false)).toBeNull();
    expect(workspacePanelForPath('/app/agent', true)).toBe('agent');
  });

  test('an Agent-tier invitation names every shared category before acceptance', () => {
    const html = invitationDocument('token', 'request-1', true);
    for (const category of [
      'conversations', 'memory', 'files', 'schedules', 'model subscriptions',
      'browser sessions', 'credentials', 'channels', 'GBrain Sources',
    ]) {
      expect(html).toContain(category);
    }
    expect(html).toContain('I understand this OpenClaw is shared');
  });

  test('a Brain-tier invitation is byte-for-byte what it was, with no Agent copy', () => {
    expect(invitationDocument('token', 'request-1', false)).toBe(invitationDocument('token', 'request-1'));
    expect(invitationDocument('token', 'request-1')).not.toContain('OpenClaw');
    expect(invitationDocument('token', 'request-1')).not.toContain('agent_warning_ack');
  });

  test('the Agent-tier invitation sends the checkbox value itself, never a baked-in true', () => {
    const html = invitationDocument('token', 'request-1', true);
    expect(html).toContain("agent_warning_ack:document.querySelector('#agent-warning-checkbox').checked");
    // A literal would make the server's `=== true` gate compare against a
    // constant that can never be false.
    expect(html).not.toContain('agent_warning_ack:true');
  });

  test('provider connection and limit status is outside the hidden ready section for every role', () => {
    for (const role of ['administrator', 'member'] as const) {
      const html = appDocument('Trust Workspace', role, 'all', '/app/agent', {}, 'latest', true);
      const models = html.indexOf('id="agent-models"');
      const ready = html.indexOf('<section id="agent-ready"');
      expect(models, `${role} must be served the model status`).toBeGreaterThan(-1);
      expect(ready).toBeGreaterThan(-1);
      // Inside `#agent-ready` it would be invisible for the whole of setup —
      // exactly the state a Member is most likely to open the page in.
      expect(models, `${role} must see model status before readiness`).toBeLessThan(ready);
      expect(html).toContain('Connected models');
    }
  });

  test('every Administrator action announces its outcome in a polite status region', () => {
    const admin = appDocument('Trust Workspace', 'administrator', 'all', '/app/agent', {}, 'latest', true);
    const member = appDocument('Trust Workspace', 'member', 'all', '/app/agent', {}, 'latest', true);
    for (const html of [admin, member]) {
      expect(html).toContain('<p id="agent-action-status" class="hint" role="status" aria-live="polite"></p>');
    }
    // The region is only useful if the action helper actually writes to it.
    expect(admin).toContain('agentActionStatus.textContent=success');
    for (const sentence of [
      'The shared Agent was created at Read scope with No Source Access.',
      'Scope and Source Access were saved. Confirm the grant to apply it.',
      'The current grant was confirmed.',
      'The Claude setup token was sent to the runtime and cleared from this page.',
      'Check Codex passed against the running runtime.',
      'Check Claude passed against the running runtime.',
      'The default answer and its automatic fallback were proved.',
      // Rotation is destructive and irreversible and changes no other text.
      'The shared native password was rotated. Every native app and CLI must be given the new password.',
    ]) {
      expect(admin, `an Administrator action must announce "${sentence}"`).toContain(sentence);
    }
  });

  test('the Scope step is never ticked Done for a default nobody chose', () => {
    const html = appDocument('Trust Workspace', 'administrator', 'all', '/app/agent', {}, 'latest', true);
    // `grant` is non-null with the safe default from the instant the Agent is
    // created; ticking step 2 on that would certify an explicit choice.
    expect(html).toContain('agentSetStep(2,false,');
    expect(html).toContain('Safe default in place \\u2014 review and set');
    expect(html).not.toContain('agentSetStep(2,started&&data.grant!==null)');
  });

  test('the Agent page states the shared-state warning verbatim and offers the acknowledgment', () => {
    const html = appDocument('Trust Workspace', 'member', 'all', '/app/agent', {}, 'latest', true);
    expect(html).toContain('This Workspace uses one shared OpenClaw Agent. Every active Member can use it and may see or affect its conversations, memory, files, schedules, model subscriptions and usage, browser sessions, credentials, channels, and the GBrain Sources and authority granted to the Agent. Only connect channels whose external senders are allowed to use that shared authority.');
    expect(html).toContain('I understand this OpenClaw is shared with every active Workspace Member.');
  });

  test('the Administrator checklist renders the nine steps in the decided order', async () => {
    const html = appDocument('Trust Workspace', 'administrator', 'all', '/app/agent', {}, 'latest', true);
    expect(await textUnder(html, '#agent-checklist .step strong')).toEqual([
      'Create the shared Agent.',
      'Choose Scope and Source Access.',
      'Confirm the current grant.',
      'Wait for the live GBrain MCP check.',
      'Open Agent and send /login codex; complete browser/device-code login.',
      'On a trusted local computer, run claude setup-token and paste it once.',
      'Run Check Codex.',
      'Run Check Claude.',
      'Run Prove default answer.',
    ]);
  });

  test('a Member sees the same nine steps but no mutation control is rendered', async () => {
    const member = appDocument('Trust Workspace', 'member', 'all', '/app/agent', {}, 'latest', true);
    const admin = appDocument('Trust Workspace', 'administrator', 'all', '/app/agent', {}, 'latest', true);
    expect(await textUnder(member, '#agent-checklist .step strong')).toEqual(
      await textUnder(admin, '#agent-checklist .step strong'),
    );
    for (const control of [
      'id="agent-initialize"', 'id="agent-grant-form"', 'id="agent-grant-confirm"',
      'id="agent-claude-form"', 'id="agent-check-codex"', 'id="agent-check-claude"',
      'id="agent-answer-proof"', 'id="agent-rotate"',
    ]) {
      expect(admin, `an Administrator must have ${control}`).toContain(control);
      expect(member, `a Member must not have ${control}`).not.toContain(control);
    }
  });

  test('the ready surface names both required models, the fallback rule, and the safe CLI commands', () => {
    const html = appDocument('Trust Workspace', 'member', 'all', '/app/agent', {}, 'latest', true);
    expect(html).toContain('href="/agent/"');
    expect(html).toContain('Switch models in OpenClaw. An explicit model choice is strict for that session; reset to Default to restore automatic Codex &rarr; Claude fallback');
    expect(html).toContain('Show native app &amp; CLI details');
    expect(html).toContain('openclaw config set gateway.mode remote');
    expect(html).toContain('openclaw config set gateway.remote.url ');
    expect(html).toContain('openclaw tui');
    expect(html).toContain('OPENCLAW_GATEWAY_PASSWORD');
    expect(html).toContain('openclaw mcp serve --url ');
    expect(html).toContain('--password-file');
    // --url on the pinned CLI requires an explicit credential flag too, or the
    // TUI refuses to connect before anything happens — it never silently
    // drops auth and falls back to a stored credential. See
    // .superpowers/sdd/2026-07-29-openclaw-customer-access/task-16-contract-resolution.md Q6.
    expect(html).toContain('you must also pass an explicit credential flag');
    expect(html).toContain('refuses to connect at all');
    expect(html).not.toContain('silently drop your authentication');
    // The channels instruction: Channels is a sibling top-level Control UI
    // destination, not a child of Config, and no deep-link route is documented
    // as stable, so only `/agent/` is ever linked.
    expect(html).toContain('Agent &rarr; Channels');
    expect(html).not.toContain('Config &rarr; Channels');
    expect(html).not.toContain('/agent/settings/channels');
  });

  // -------------------------------------------------------------------------
  // #68 Task 12 — the rejected per-Member RBAC, stated honestly.
  //
  // Approvals, model switching, and Channels are OpenClaw operator features and
  // the pilot hands out ONE shared operator identity, so a Workspace role
  // cannot narrow them. Saying so on the page is the alternative to pretending
  // otherwise; the copy is asserted verbatim because a softened rewrite would
  // be exactly the failure.
  // -------------------------------------------------------------------------

  test('the ready Agent page states the shared-operator limitation verbatim, to every role', () => {
    for (const role of ['administrator', 'member'] as const) {
      const html = appDocument('Trust Workspace', role, 'all', '/app/agent', {}, 'latest', true);
      expect(html).toContain(
        "Pilot access is shared operator access. Workspace roles control the supported 2Brain setup buttons, "
        + "but everyone who receives the shared native password can use OpenClaw's operator features. "
        + 'Use this pilot only with a trusted team.',
      );
      // It belongs to the READY surface: it explains what the shared native
      // password grants, which only matters once there is one to hand out.
      const ready = html.indexOf('<section id="agent-ready"');
      const limitation = html.indexOf('id="agent-shared-operator-limitation"');
      expect(ready).toBeGreaterThan(-1);
      expect(limitation).toBeGreaterThan(ready);
      // …and it is NOT a replacement for the shared-state acknowledgment, which
      // still has to be confirmed before anyone reaches the runtime at all.
      expect(html).toContain('I understand this OpenClaw is shared with every active Workspace Member.');
    }
    // Brain tier gains no such copy, because it has no shared operator.
    expect(appDocument('Trust Workspace', 'administrator', 'all', '/app/agents', {}, 'latest', false))
      .not.toContain('Pilot access is shared operator access');
  });

  test('the Agent page carries the channel-sender, backup, and deletion warnings', () => {
    const html = appDocument('Trust Workspace', 'member', 'all', '/app/agent', {}, 'latest', true);
    expect(html).toContain('Messages from connected channels may come from people who are not Workspace Members. The shared Agent can act with its configured model subscriptions and GBrain authority. Only connect channels whose senders you trust.');
    expect(html).toContain('OpenClaw conversations, memory, files, schedules, browser sessions, channels, and credentials are not included in Workspace Export and have no 2Brain backup. Deleting this Workspace permanently deletes that OpenClaw state.');
  });

  test('the Agent page server-renders no secret and no client-side secret storage', () => {
    for (const role of ['administrator', 'member'] as const) {
      const html = appDocument('Trust Workspace', role, 'all', '/app/agent', {}, 'latest', true);
      expect(html).not.toContain('localStorage');
      // The one session value the shell legitimately keeps is the CSRF token.
      expect(html).not.toContain("sessionStorage.setItem('workspace_native");
      expect(html).not.toContain('data-password');
      // The password input starts hidden and is never a server-rendered value.
      expect(html).not.toContain('value="wss://');
    }
  });

  test('the manual MCP snippet is gone from the Agents panel on both tiers', () => {
    for (const html of [agentsPage(true), agentsPage(false), agentsPage(true, 'member')]) {
      expect(html).not.toContain('Connect OpenClaw');
      expect(html).not.toContain('127.0.0.1:3131');
    }
    expect(agentsPage(false)).toContain('Register an Agent');
  });

  test('omitting the flag defaults to brain-tier rendering', () => {
    const html = appDocument('Trust Workspace', 'administrator', 'all', '/app/agents', {});
    expect(html).toContain('Register an Agent');
    expect(html).toContain('href="/app/agents"');
  });
});

// The pure-function tests above cannot see the router's env read, so the
// GBRAIN_AGENT_TIER gate gets its own end-to-end coverage.
describe('the served shell routes Agent tier to /app/agent and Brain tier to /app/agents', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' }); });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetWorkspaceFoundationForTest(engine); await initializeWorkspaceFoundation(engine); });

  type Served = { status: number; location: string | null; html: string };

  /** One Workspace setup, then every requested path over the same session. */
  async function servedShell(...paths: string[]): Promise<Served[]> {
    const app = express();
    let confirmationToken = '';
    app.use(createWorkspaceRouter(engine, {
      bootstrapCredential: 'bootstrap-test',
      tokenSecret: 'workspace-token-secret-for-tests',
      allowedOrigin: 'https://workspace.example.test',
      requestId: () => 'req-agents-shell',
      deliverConfirmation: async message => { confirmationToken = message.token; },
    }));
    const listener = await new Promise<Server>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const base = `http://127.0.0.1:${address.port}`;
    const json = { origin: 'https://workspace.example.test', 'content-type': 'application/json' };
    try {
      const issue = await fetch(`${base}/api/workspace/v1/operator/links`, { method: 'POST', headers: { authorization: 'Bootstrap bootstrap-test', 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'setup' }) });
      const setupToken = (await issue.json() as any).data.token;
      await fetch(`${base}/api/workspace/v1/setup`, { method: 'POST', headers: json, body: JSON.stringify({ token: setupToken, workspace_name: 'Acme Example', administrator_email: 'admin@example.test' }) });
      const confirmed = await fetch(`${base}/api/workspace/v1/setup/confirm`, { method: 'POST', headers: json, body: JSON.stringify({ token: confirmationToken }) });
      const cookie = confirmed.headers.get('set-cookie')!.split(';')[0];
      const results: Served[] = [];
      for (const path of paths) {
        const response = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
        results.push({ status: response.status, location: response.headers.get('location'), html: await response.text() });
      }
      return results;
    } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
  }

  // process.env is process-global and a shard loads many files into one
  // process, so these go through withEnv; a thrown assertion must not leak
  // GBRAIN_AGENT_TIER into whatever runs next.
  test('GBRAIN_AGENT_TIER=true redirects /app/agents to the singular Agent page', async () => {
    await withEnv({ GBRAIN_AGENT_TIER: 'true' }, async () => {
      const [redirect, agent] = await servedShell('/app/agents', '/app/agent');
      expect(redirect!.status).toBe(303);
      expect(redirect!.location).toBe('/app/agent');
      expect(agent!.status).toBe(200);
      expect(agent!.html).toContain('I understand this OpenClaw is shared with every active Workspace Member.');
      expect(agent!.html).toContain('href="/app/agent"');
      expect(agent!.html).not.toContain('127.0.0.1:3131');
    });
  });

  test('an unset GBRAIN_AGENT_TIER serves the plural Agents page and no Agent route', async () => {
    await withEnv({ GBRAIN_AGENT_TIER: undefined }, async () => {
      const [agents, agent] = await servedShell('/app/agents', '/app/agent');
      expect(agents!.status).toBe(200);
      expect(agents!.html).toContain('Register an Agent');
      // `/app/agent` is not a Brain-tier panel: it falls through to Home.
      expect(agent!.status).toBe(200);
      expect(agent!.html).not.toContain('I understand this OpenClaw is shared');
      expect(agent!.html).toContain('href="/app/agents"');
    });
  });

  test('GBRAIN_AGENT_TIER=false never serves the shared Agent surface', async () => {
    await withEnv({ GBRAIN_AGENT_TIER: 'false' }, async () => {
      const [agents, agent] = await servedShell('/app/agents', '/app/agent');
      expect(agents!.status).toBe(200);
      expect(agent!.html).not.toContain('I understand this OpenClaw is shared');
    });
  });
});

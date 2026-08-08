#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, relative } from 'node:path';
import { chromium } from 'playwright-core';

/**
 * Two journeys share this client: the Brain-tier release journey that has always
 * run here, and the #68 Task 14 Agent-tier customer-access journey. They never
 * run against the same Workspace database — the harness gives each its own — and
 * the Brain-tier body below is unchanged, so an Agent-tier regression cannot be
 * mistaken for Brain-tier drift or the other way round.
 */
const journey = (process.env.WORKSPACE_RELEASE_JOURNEY ?? 'brain').trim();
if (journey !== 'brain' && journey !== 'agent') {
  throw new Error(`Unknown release journey ${journey}.`);
}

const baseUrl = process.env.WORKSPACE_RELEASE_BASE_URL;
const setupToken = process.env.WORKSPACE_RELEASE_SETUP_TOKEN;
const evidenceDir = process.env.WORKSPACE_RELEASE_EVIDENCE_DIR;
if (!baseUrl || !setupToken || !evidenceDir) {
  throw new Error('Workspace browser client environment is incomplete.');
}

const omittedScopeClientId = process.env.WORKSPACE_RELEASE_OMITTED_SCOPE_CLIENT_ID;
const readClientId = process.env.WORKSPACE_RELEASE_READ_CLIENT_ID;
const oauthRedirectUri = process.env.WORKSPACE_RELEASE_OAUTH_REDIRECT_URI;
if (journey === 'brain' && (!omittedScopeClientId || !readClientId || !oauthRedirectUri)) {
  throw new Error('Workspace browser client environment is incomplete.');
}

/**
 * The three Agent-tier values that must NOT arrive from the harness.
 *
 * Each one is a pinned product fact: the two entitled model identifiers and the
 * shape of the Workspace agent-client URL. Receiving them from the process that
 * also configures the server would make every assertion about them move with
 * the thing it verifies, which is exactly the vacuous-verifier failure this
 * branch has shipped before. They are written out here instead.
 */
const agentCodexModel = 'openai/gpt-5.6-sol';
const agentClaudeModel = 'anthropic/claude-sonnet-5';
const agentNativeUrl = 'wss://agent-workspace.example.test/agent-client/';

// The shipped Agent-tier copy, duplicated here on purpose. A release verifier
// that imported the constants it is verifying would pass for any wording,
// including an empty one; these are the exact sentences a customer must read.
const AGENT_SHARED_WARNING = 'This Workspace uses one shared OpenClaw Agent. Every active Member can use it and may see or affect its conversations, memory, files, schedules, model subscriptions and usage, browser sessions, credentials, channels, and the GBrain Sources and authority granted to the Agent. Only connect channels whose external senders are allowed to use that shared authority.';
const AGENT_ACK_LABEL = 'I understand this OpenClaw is shared with every active Workspace Member.';
const AGENT_CHANNEL_WARNING = 'Messages from connected channels may come from people who are not Workspace Members. The shared Agent can act with its configured model subscriptions and GBrain authority. Only connect channels whose senders you trust.';
const AGENT_BACKUP_WARNING = 'OpenClaw conversations, memory, files, schedules, browser sessions, channels, and credentials are not included in Workspace Export and have no 2Brain backup. Deleting this Workspace permanently deletes that OpenClaw state.';
const AGENT_SHARED_OPERATOR_LIMITATION = "Pilot access is shared operator access. Workspace roles control the supported 2Brain setup buttons, but everyone who receives the shared native password can use OpenClaw's operator features. Use this pilot only with a trusted team.";
const AGENT_MODEL_SWITCH_COPY = 'Switch models in OpenClaw. An explicit model choice is strict for that session; reset to Default to restore automatic Codex \u2192 Claude fallback.';
const AGENT_CHANNELS_LOCATION = 'In OpenClaw, go to Agent \u2192 Channels.';
const AGENT_SHARED_CATEGORIES = [
  'conversations',
  'memory',
  'files',
  'schedules',
  'model subscriptions and usage',
  'browser sessions',
  'credentials',
  'channels',
  'GBrain Sources and Agent authority',
];
/** Every Administrator-only control on the Agent page, by id. */
const AGENT_ADMINISTRATOR_CONTROLS = [
  '#agent-initialize',
  '#agent-grant-form',
  '#agent-grant-confirm',
  '#agent-claude-form',
  '#agent-check-codex',
  '#agent-check-claude',
  '#agent-answer-proof',
  '#agent-rotate',
];

const oauthVerifier = 'release-browser-verifier-0123456789-0123456789-0123456789';
const oauthChallenge = createHash('sha256').update(oauthVerifier).digest('base64url');

function oauthAuthorizeUrl(clientId) {
  const url = new URL('/authorize', baseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', oauthRedirectUri);
  url.searchParams.set('code_challenge', oauthChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', 'release-browser-state');
  return url.toString();
}

const browserCandidates = [
  process.env.BROWSER_EXECUTABLE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browserExecutable = browserCandidates.find(existsSync);
if (!browserExecutable) throw new Error('Set BROWSER_EXECUTABLE to a Chromium-compatible browser.');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function percentile(samples, percentileValue) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

async function waitFor(check, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // A callable message can report the state actually observed, which is what
  // makes an Agent-tier timeout diagnosable instead of merely red.
  throw new Error(typeof message === 'function' ? message() : message);
}

async function releaseToken(purpose, email) {
  const url = `${baseUrl}/__release/token?purpose=${encodeURIComponent(purpose)}&email=${encodeURIComponent(email)}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    if (response.ok) return (await response.json()).token;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${purpose} token was not delivered for ${email}.`);
}

async function waitForStatus(kind, expected, message) {
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/__release/status/${kind}`);
    return response.ok && (await response.json()).value === expected;
  }, message);
}

// --- shared instrumentation --------------------------------------------------

let browser;
let adminContext;
let memberContext;
let adminPage;
let memberPage;

const consoleErrors = [];
// The journey deliberately provokes authorization refusals, and a browser
// reports each refused response as a console error. Only the requests made
// while a probe is in flight are exempt; anything else counts.
let expectRefusedRequest = false;
// The Agent journey additionally drives the shared-state acknowledgment refusal
// (409) and the rotation-pending refusal (503). The Brain journey keeps its
// original, narrower exemption, so widening it here cannot silence anything the
// Brain journey used to catch.
const refusalNoise = journey === 'agent' ? /\b(401|403|409|503)\b/ : /\b(401|403)\b/;

const screenshots = [];
// Recorded relative to the repository so the committed report stays portable.
const recordScreenshot = path => screenshots.push(relative(process.cwd(), path).split('\\').join('/'));
const checks = {};
const timings = {};
const accessibility = [];
const axeSource = readFileSync(join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const auditOnce = async page => {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    const result = await globalThis.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    });
    return result.violations.map(violation => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map(node => ({
        target: node.target,
        html: node.html,
        summary: node.failureSummary,
      })),
    }));
  });
};

const runAxe = async (page, route) => {
  // A live update can reload the document between injecting axe and running
  // it, which discards the injected script. Re-inject and retry rather than
  // reporting the lost run as an audit result.
  let violations;
  for (let attempt = 1; ; attempt += 1) {
    try {
      violations = await auditOnce(page);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await page.waitForLoadState('load');
    }
  }
  accessibility.push({ route, violations });
  assert(violations.length === 0, `${route} has WCAG violations: ${JSON.stringify(violations)}.`);
};

const openLifecycleDialog = async (page, row) => {
  await row.getByRole('button', { name: 'Archive Source' }).click();
  try {
    await page.locator('#source-lifecycle-dialog').waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    const state = await page.evaluate(() => ({
      dialogOpen: document.querySelector('#source-lifecycle-dialog')?.open ?? null,
      rowButtons: [...document.querySelectorAll('.resource-row button')].map(button => button.textContent),
      feedback: document.querySelector('#settings-feedback')?.textContent ?? '',
      success: document.querySelector('#source-success')?.textContent ?? '',
      width: document.documentElement.clientWidth,
    }));
    throw new Error(`Archive Source did not open the lifecycle dialog: ${JSON.stringify(state)}`);
  }
};

const submitDialog = async (page, dialogId, errorId, confirmName) => {
  await page.locator(dialogId).getByRole('button', { name: confirmName }).click();
  try {
    await page.locator(dialogId).waitFor({ state: 'hidden', timeout: 15_000 });
  } catch {
    const failure = await page.locator(errorId).textContent();
    throw new Error(`${confirmName} left ${dialogId} open. Dialog error: ${failure?.trim() || 'none shown'}.`);
  }
};

// --- Agent-tier helpers ------------------------------------------------------

async function releaseCall(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) throw new Error(`${path} answered ${response.status}.`);
  if (response.status === 204) return null;
  return response.json();
}

const releasePost = path => releaseCall(path, { method: 'POST' });

/**
 * Ask the harness whether the derived shared password occurs in a sample.
 *
 * The client never receives the password from the server side, so the journey
 * cannot leak it into evidence by accident: it can only learn WHICH sample
 * matched and at which generation.
 */
async function scanSamples(samples) {
  // The server always derives at least two candidate generations
  // (Math.max(1, generation) + 1), so a bare "generations >= 2" check can
  // never fail and proves nothing. Compare against the binding's own current
  // generation, read independently right before the scan, so a broken
  // derivation loop (wrong count, off-by-one) is something this assertion can
  // actually catch.
  const binding = await readBinding();
  const body = await releaseCall('/__release/agent/secret-scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ samples }),
  });
  const expectedGenerations = Math.max(1, Number(binding.native_password_generation)) + 1;
  assert(
    body.generations === expectedGenerations,
    `The secret scanner derived ${body.generations} candidate passwords; the current native-password `
    + `generation ${binding.native_password_generation} implies ${expectedGenerations}.`,
  );
  return body.hits;
}

/** Serialized markup plus both web storages, for both browser contexts. */
async function secretSurfaces(label) {
  const samples = [];
  for (const [name, page] of [['administrator', adminPage], ['member', memberPage]]) {
    samples.push({ name: `${label}:${name}:document`, text: await page.content() });
    samples.push({
      name: `${label}:${name}:storage`,
      text: await page.evaluate(() => JSON.stringify({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      })),
    });
  }
  return samples;
}

async function assertNoSecretInSurfaces(label) {
  const hits = await scanSamples(await secretSurfaces(label));
  assert(hits.length === 0, `The shared native password appeared in ${JSON.stringify(hits)} at ${label}.`);
}

/**
 * Open the native app/CLI details and report the page's own refusal when they
 * do not open. Without this, every disclosure refusal reads as an anonymous
 * locator timeout instead of naming the state that closed the door.
 */
async function openNativeDetails(page, who) {
  // The toggle is a toggle: clicking it while the panel is already open closes
  // it. Requiring the closed precondition turns a journey ordering slip into a
  // named failure instead of an anonymous visibility timeout.
  assert(
    await page.locator('#agent-native-details').isHidden(),
    `${who} asked to open native details that were already open.`,
  );
  await page.locator('#agent-native-toggle').click();
  try {
    await page.locator('#agent-native-details').waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    const feedback = (await page.locator('#agent-feedback').textContent().catch(() => null)) ?? '';
    const status = (await page.locator('#agent-status').textContent().catch(() => null)) ?? '';
    // Ask the disclosure endpoint directly for its own refusal code, so a
    // closed door reports WHY it is closed rather than only that it is.
    const probe = await page.evaluate(async () => {
      const response = await fetch('/api/workspace/v1/agent/native-access', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, code: body?.error?.code ?? null };
    }).catch(error => ({ status: 'unreachable', code: String(error).slice(0, 200) }));
    throw new Error(
      `${who} could not open the native details. Feedback: ${feedback.trim() || 'none shown'}. `
      + `Status: ${status.trim()}. Disclosure probe: ${JSON.stringify(probe)}.`,
    );
  }
}

async function readBinding() {
  return (await releaseCall('/__release/agent/binding')).value;
}

async function waitForBinding(predicate, message, timeoutMs = 60_000) {
  let last = null;
  await waitFor(async () => {
    last = await readBinding();
    return last !== null && predicate(last);
  }, () => `${message} Last binding: ${JSON.stringify(last)}`, timeoutMs);
}

async function waitForText(page, selector, expected, timeoutMs = 20_000) {
  let seen = '';
  await waitFor(async () => {
    seen = (await page.locator(selector).textContent().catch(() => null)) ?? '';
    return seen.trim() === expected;
  }, () => `${selector} read "${seen.trim()}" instead of "${expected}".`, timeoutMs);
}

async function waitForTextContaining(page, selector, expected, timeoutMs = 20_000) {
  let seen = '';
  await waitFor(async () => {
    seen = (await page.locator(selector).textContent().catch(() => null)) ?? '';
    return seen.includes(expected);
  }, () => `${selector} read "${seen.trim()}" which does not contain "${expected}".`, timeoutMs);
}

// --- Journey 1: Brain tier ---------------------------------------------------

async function runBrainJourney() {
  await adminPage.goto(`${baseUrl}/setup/${encodeURIComponent(setupToken)}`);
  assert((await adminPage.title()).includes('Set up'), 'Setup page identity did not render.');
  await adminPage.getByLabel('Workspace name').fill('Release Workspace');
  await adminPage.getByLabel('Administrator email').fill('admin@example.test');
  await adminPage.getByRole('button', { name: 'Continue' }).click();
  await adminPage.getByRole('heading', { name: 'Check your email' }).waitFor();
  const confirmation = await releaseToken('confirmation', 'admin@example.test');
  const shellStart = performance.now();
  await adminPage.goto(`${baseUrl}/confirm/${encodeURIComponent(confirmation)}`);
  await adminPage.waitForURL(`${baseUrl}/app`);
  await adminPage.getByText('Release Workspace', { exact: true }).waitFor();
  timings.authenticated_shell = Math.round(performance.now() - shellStart);
  assert(timings.authenticated_shell < 2_500, 'Authenticated shell exceeded the 2.5 second release budget.');
  checks.first_administrator_setup = 'pass';

  // The authentication boundary is server-side, so prove it from outside the
  // authenticated context rather than asserting it because the shell rendered.
  expectRefusedRequest = true;
  const anonymous = await browser.newContext();
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(`${baseUrl}/app`);
  await anonymousPage.waitForURL(`${baseUrl}/login`);
  const unauthenticated = await anonymousPage.evaluate(async base => {
    const read = await fetch(`${base}/api/workspace/v1/memberships`);
    const mutate = await fetch(`${base}/api/workspace/v1/sources/release-source/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'unauthenticated probe' }),
    });
    return { read: read.status, mutate: mutate.status };
  }, baseUrl);
  assert(
    unauthenticated.read === 401 && unauthenticated.mutate === 401,
    `Unauthenticated requests were not refused: ${JSON.stringify(unauthenticated)}`,
  );
  // A session cookie without the CSRF header must not be able to mutate.
  const forged = await adminPage.evaluate(async base => {
    const response = await fetch(`${base}/api/workspace/v1/sources/release-source/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'missing csrf header' }),
    });
    return response.status;
  }, baseUrl);
  assert(forged === 403, `A mutation without the CSRF header was not refused: ${forged}`);
  const sessionCookie = (await adminContext.cookies()).find(cookie => cookie.name === 'workspace_session');
  assert(sessionCookie?.httpOnly === true, 'The session cookie is not httpOnly.');
  assert(sessionCookie?.secure === true, 'The session cookie is not marked secure.');
  assert(sessionCookie?.sameSite === 'Lax', `The session cookie SameSite is ${sessionCookie?.sameSite}.`);
  await anonymous.close();
  expectRefusedRequest = false;
  checks.production_http_auth_boundary = 'pass';

  await runAxe(adminPage, '/app desktop');
  const adminHome = join(evidenceDir, 'admin-home-1440x900.png');
  await adminPage.screenshot({ path: adminHome });
  recordScreenshot(adminHome);

  await adminPage.goto(`${baseUrl}/app/settings/members`);
  assert(
    await adminPage.getByLabel('Close Settings').evaluate(element => element === document.activeElement),
    'Settings initial focus did not land on Close Settings.',
  );
  await adminPage.locator('#invite-email').fill('member@example.test');
  await adminPage.locator('#invite-role').selectOption('member');
  await adminPage.locator('#invite-access').selectOption('none');
  await adminPage.getByRole('button', { name: 'Send invitation' }).click();
  const invitation = await releaseToken('invitation', 'member@example.test');

  await memberPage.goto(`${baseUrl}/login`);
  const redeemed = await memberPage.evaluate(async ({ token, email }) => {
    const response = await fetch('/api/workspace/v1/invitations/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, email }),
    });
    return { status: response.status, body: await response.json() };
  }, { token: invitation, email: 'member@example.test' });
  assert(redeemed.status === 200, 'Member invitation redemption failed.');
  await memberPage.evaluate(csrf => sessionStorage.setItem('workspace_csrf', csrf), redeemed.body.data.csrf_token);
  await memberPage.goto(`${baseUrl}/app`);
  await memberPage.getByRole('heading', { name: 'Workspace is being set up' }).waitFor();
  checks.member_invitation = 'pass';

  await memberPage.goto(`${baseUrl}/app/settings/account`);
  await memberPage.getByRole('button', { name: 'Log out' }).click();
  await memberPage.waitForURL(`${baseUrl}/login`);
  await memberPage.getByLabel('Email').fill('member@example.test');
  await memberPage.getByRole('button', { name: 'Continue' }).click();
  await memberPage.getByRole('heading', { name: 'Check your email' }).waitFor();
  const loginToken = await releaseToken('login', 'member@example.test');
  await memberPage.goto(`${baseUrl}/login/redeem/${encodeURIComponent(loginToken)}`);
  await memberPage.waitForURL(`${baseUrl}/app`);
  checks.member_login = 'pass';

  await adminPage.goto(`${baseUrl}/app/settings/sources`);
  await adminPage.getByLabel('Source ID', { exact: true }).fill('release-source');
  await adminPage.getByLabel('Name', { exact: true }).fill('Release handbook');
  await adminPage.getByLabel('HTTPS Git URL', { exact: true }).fill('https://example.test/release-handbook.git');
  await adminPage.getByLabel('Expected cadence', { exact: true }).selectOption('daily');
  await adminPage.getByRole('button', { name: 'Connect Source' }).click();
  await adminPage.getByText(/Source queued/).waitFor();
  // The Source is queued by the request and only ever moves to completed by the
  // separate always-on worker process, so reaching completed is what proves the
  // worker is running — nothing in the request path can produce this state.
  await waitForStatus('source', 'completed', 'Always-on worker did not complete Source provisioning.');
  checks.source_onboarding_worker = 'pass';
  checks.always_on_worker = 'pass';

  const seed = await fetch(`${baseUrl}/__release/seed`, { method: 'POST' });
  assert(seed.ok, 'Release Knowledge fixture could not be seeded.');
  await memberPage.goto(`${baseUrl}/app`);
  await memberPage.getByRole('heading', { name: 'Access required' }).waitFor();
  await runAxe(memberPage, '/app member access-required');
  checks.zero_source_access_explanation = 'pass';
  await adminPage.goto(`${baseUrl}/app/settings/members`);
  const memberRow = adminPage.locator('.member-row').filter({ hasText: 'member@example.test' });
  await memberRow.locator('.member-access').selectOption('all');
  await memberRow.locator('.member-reason').fill('Release journey Source access');
  await memberRow.getByRole('button', { name: 'Save role & access' }).click();
  await waitForStatus('access', 'all', 'Member Source Access change was not persisted.');
  checks.current_and_future_source_access = 'pass';

  await adminPage.goto(oauthAuthorizeUrl(omittedScopeClientId));
  const adminConsentAccess = adminPage.getByLabel('Access level');
  assert(await adminConsentAccess.inputValue() === 'read', 'Administrator consent did not default to Read.');
  assert(
    !(await adminConsentAccess.locator('option[value="write"]').isDisabled()),
    'Administrator Write choice is disabled for omitted-scope DCR.',
  );
  assert(
    !(await adminConsentAccess.locator('option[value="admin"]').isDisabled()),
    'Administrator Admin choice is disabled for omitted-scope DCR.',
  );
  await runAxe(adminPage, '/authorize administrator omitted-scope');
  await adminConsentAccess.selectOption('admin');
  await adminPage.getByRole('button', { name: 'Approve' }).click();
  await adminPage.getByRole('heading', { name: 'Connected' }).waitFor();

  await adminPage.goto(`${baseUrl}/app/settings/connected-apps`);
  const adminConnectedRow = adminPage.locator('.resource-row').filter({ hasText: 'Release Admin-capable Connector' });
  await adminConnectedRow.waitFor();
  assert(
    (await adminConnectedRow.textContent()).includes('Configured Admin'),
    'Administrator Connected App does not show Configured Admin.',
  );
  const adminConnectedAccess = adminConnectedRow.getByLabel('Access level for Release Admin-capable Connector');
  for (const level of ['read', 'write', 'admin']) {
    assert(
      !(await adminConnectedAccess.locator(`option[value="${level}"]`).isDisabled()),
      `Administrator Connected Apps ${level} choice is disabled.`,
    );
  }
  await runAxe(adminPage, '/app/settings/connected-apps administrator');

  await adminPage.goto(oauthAuthorizeUrl(readClientId));
  const readOnlyAccess = adminPage.getByLabel('Access level');
  for (const level of ['write', 'admin']) {
    const option = readOnlyAccess.locator(`option[value="${level}"]`);
    assert(await option.isDisabled(), `Explicit Read client ${level} choice is enabled.`);
    const copy = await option.textContent();
    assert(copy.includes('unavailable because of this client registration'), `Explicit Read ${level} copy misses the client limiter.`);
    assert(!copy.includes('Member role'), `Explicit Read ${level} copy incorrectly blames the Membership role.`);
  }

  await memberPage.goto(oauthAuthorizeUrl(readClientId));
  const combinedLimiterAccess = memberPage.getByLabel('Access level');
  const combinedAdminOption = combinedLimiterAccess.locator('option[value="admin"]');
  assert(await combinedAdminOption.isDisabled(), 'Member explicit-Read Admin choice is enabled.');
  assert(
    (await combinedAdminOption.textContent()).includes('unavailable for the Member role and this client registration'),
    'Member explicit-Read Admin choice does not name both limiters.',
  );
  await runAxe(memberPage, '/authorize member explicit-read combined-limiter');

  await memberPage.goto(oauthAuthorizeUrl(omittedScopeClientId));
  const memberConsentAccess = memberPage.getByLabel('Access level');
  assert(await memberConsentAccess.inputValue() === 'read', 'Member consent did not default to Read.');
  assert(
    !(await memberConsentAccess.locator('option[value="write"]').isDisabled()),
    'Member Write choice is disabled for omitted-scope DCR.',
  );
  const memberAdminOption = memberConsentAccess.locator('option[value="admin"]');
  assert(await memberAdminOption.isDisabled(), 'Member Admin choice is enabled.');
  assert(
    (await memberAdminOption.textContent()).includes('unavailable for the Member role'),
    'Member Admin choice does not explain the Membership-role ceiling.',
  );
  await runAxe(memberPage, '/authorize member omitted-scope');
  await memberConsentAccess.selectOption('write');
  await memberPage.getByRole('button', { name: 'Approve' }).click();
  await memberPage.getByRole('heading', { name: 'Connected' }).waitFor();

  await memberPage.goto(`${baseUrl}/app/settings/connected-apps`);
  const memberConnectedRow = memberPage.locator('.resource-row').filter({ hasText: 'Release Admin-capable Connector' });
  await memberConnectedRow.waitFor();
  assert(
    (await memberConnectedRow.textContent()).includes('Configured Write'),
    'Member Connected App does not show Configured Write.',
  );
  const memberConnectedAccess = memberConnectedRow.getByLabel('Access level for Release Admin-capable Connector');
  const memberSettingsAdmin = memberConnectedAccess.locator('option[value="admin"]');
  assert(await memberSettingsAdmin.isDisabled(), 'Member Connected Apps Admin choice is enabled.');
  assert(
    (await memberSettingsAdmin.textContent()).includes('unavailable for the Member role'),
    'Member Connected Apps Admin choice does not name the Membership-role limiter.',
  );
  await runAxe(memberPage, '/app/settings/connected-apps member');
  const memberConnectedApps = join(evidenceDir, 'member-connected-apps-role-limited-1440x900.png');
  await memberPage.screenshot({ path: memberConnectedApps });
  recordScreenshot(memberConnectedApps);
  checks.connected_app_access_ceilings = 'pass';

  await memberPage.goto(`${baseUrl}/app/knowledge`);
  await memberPage.getByRole('link', { name: 'Release handbook', exact: true }).waitFor();
  await memberPage.getByLabel('Evidence', { exact: true }).selectOption('source_backed');
  await memberPage.getByRole('button', { name: 'Apply', exact: true }).click();
  await memberPage.getByRole('link', { name: 'Release handbook', exact: true }).waitFor();
  await memberPage.getByRole('link', { name: 'Unverified draft', exact: true }).waitFor({ state: 'detached' });
  const knowledgeSamples = [];
  for (let sample = 0; sample < 20; sample += 1) {
    const evidenceStatus = sample % 2 === 0 ? 'missing_evidence' : 'source_backed';
    const expectedTitle = sample % 2 === 0 ? 'Unverified draft' : 'Release handbook';
    await memberPage.getByLabel('Evidence', { exact: true }).selectOption(evidenceStatus);
    const knowledgeStart = performance.now();
    await memberPage.getByRole('button', { name: 'Apply', exact: true }).click();
    await memberPage.getByRole('link', { name: expectedTitle, exact: true }).waitFor();
    knowledgeSamples.push(Math.round(performance.now() - knowledgeStart));
  }
  timings.knowledge_list_p95 = percentile(knowledgeSamples, 95);
  timings.knowledge_list_samples = knowledgeSamples;
  assert(
    timings.knowledge_list_p95 < 1_000,
    `Knowledge list p95 was ${timings.knowledge_list_p95}ms and exceeded the one-second release budget.`,
  );
  await memberPage.getByRole('link', { name: 'Release handbook', exact: true }).click();
  await memberPage.getByLabel('Page trust header').waitFor();
  await runAxe(memberPage, '/app/knowledge page detail');
  checks.knowledge_and_page_inspection = 'pass';

  const searchSamples = [];
  const searchNetworkSamples = [];
  await memberPage.goto(`${baseUrl}/app/search`);
  await memberPage.getByLabel('Search Knowledge').fill('evidence-backed');
  await memberPage.getByRole('button', { name: 'Search', exact: true }).click();
  await memberPage.getByRole('link', { name: 'Release handbook', exact: true }).waitFor();
  for (let sample = 0; sample < 20; sample += 1) {
    const query = sample % 2 === 0 ? 'supporting evidence' : 'evidence-backed';
    const expectedTitle = sample % 2 === 0 ? 'Unverified draft' : 'Release handbook';
    await memberPage.getByLabel('Search Knowledge').fill(query);
    const responsePromise = memberPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/workspace/v1/search' && url.searchParams.get('q') === query;
    });
    const searchStart = performance.now();
    await memberPage.getByRole('button', { name: 'Search', exact: true }).click();
    await responsePromise;
    searchNetworkSamples.push(Math.round(performance.now() - searchStart));
    await memberPage.getByRole('link', { name: expectedTitle, exact: true }).waitFor();
    searchSamples.push(Math.round(performance.now() - searchStart));
  }
  timings.search_p95 = percentile(searchSamples, 95);
  timings.search_samples = searchSamples;
  timings.search_network_p95 = percentile(searchNetworkSamples, 95);
  timings.search_network_samples = searchNetworkSamples;
  assert(
    timings.search_p95 < 1_000,
    `Search p95 was ${timings.search_p95}ms (HTTP p95 ${timings.search_network_p95}ms); total ${JSON.stringify(searchSamples)}; HTTP ${JSON.stringify(searchNetworkSamples)}.`,
  );
  await runAxe(memberPage, '/app/search results');
  checks.deterministic_search = 'pass';

  await memberPage.getByRole('button', { name: 'Ask 2Brain' }).click();
  await memberPage.getByLabel('Question').fill('evidence-backed verification');
  const askStart = performance.now();
  await memberPage.getByRole('button', { name: 'Ask', exact: true }).click();
  await memberPage.waitForURL(/\/app\/ask\//);
  timings.ask_acknowledgement = Math.round(performance.now() - askStart);
  assert(timings.ask_acknowledgement < 1_000, `Ask acknowledgement took ${timings.ask_acknowledgement}ms and exceeded the one-second release budget.`);
  await memberPage.getByText('Evidence-backed verification is required for release.').waitFor();
  await memberPage.getByRole('heading', { name: 'Cited Pages' }).waitFor();
  await runAxe(memberPage, '/app/ask answered');
  checks.ask_answer_and_citation = 'pass';
  const askScreenshot = join(evidenceDir, 'member-ask-answer-1440x900.png');
  await memberPage.screenshot({ path: askScreenshot });
  recordScreenshot(askScreenshot);

  // The synthesizer answers this question with a claim no retrieved Page
  // supports. The product must refuse it rather than deliver it, so the trust
  // boundary is driven in both directions through the browser.
  await memberPage.goto(`${baseUrl}/app/search`);
  await memberPage.getByRole('button', { name: 'Ask 2Brain' }).click();
  await memberPage.getByLabel('Question').fill('what uptime is guaranteed');
  await memberPage.getByRole('button', { name: 'Ask', exact: true }).click();
  await memberPage.waitForURL(/\/app\/ask\//);
  await memberPage.getByText(/not enough evidence|evidence gap/i).waitFor();
  const refusedBody = await memberPage.textContent('body');
  assert(
    !refusedBody.includes('99.99% uptime'),
    'An unsupported Ask claim was delivered instead of refused.',
  );
  await runAxe(memberPage, '/app/ask refused');
  const askRefusal = join(evidenceDir, 'member-ask-refusal-1440x900.png');
  await memberPage.screenshot({ path: askRefusal });
  recordScreenshot(askRefusal);
  checks.ask_refusal_on_unsupported_claim = 'pass';

  const detected = await fetch(`${baseUrl}/__release/detect`, { method: 'POST' });
  assert(detected.ok, 'Attention detectors did not complete.');
  const attentionResponse = await memberPage.evaluate(async () => {
    const response = await fetch('/api/workspace/v1/attention');
    return { ok: response.ok, body: await response.json() };
  });
  assert(attentionResponse.ok, `Member Attention API failed: ${JSON.stringify(attentionResponse.body)}`);
  const attentionItems = attentionResponse.body?.data?.items ?? [];
  assert(
    attentionItems.some(item => item.category === 'knowledge_quality'),
    `Member Attention API omitted Knowledge quality: ${JSON.stringify(attentionItems)}`,
  );
  await memberPage.goto(`${baseUrl}/app/attention`);
  await memberPage.getByText('Category: Knowledge quality', { exact: true }).waitFor();
  await memberPage.getByRole('button', { name: 'Take ownership' }).click();
  await memberPage.getByText('Assignee: member@example.test', { exact: true }).waitFor();
  await runAxe(memberPage, '/app/attention assigned');
  await memberPage.goto(`${baseUrl}/app/notifications`);
  await memberPage.getByText(/assigned/i).first().waitFor();
  checks.attention_and_notifications = 'pass';

  await adminPage.goto(`${baseUrl}/app/agents`);
  await adminPage.getByLabel('Name').fill('Release verifier');
  await adminPage.getByLabel('Purpose').fill('Verify the release journey');
  await adminPage.getByRole('button', { name: 'Register Agent' }).click();
  await adminPage.getByText('Credential created — copy it now').waitFor();
  await adminPage.getByText('Release verifier', { exact: true }).waitFor();
  await runAxe(adminPage, '/app/agents registered');
  checks.agent_registration_and_directory = 'pass';

  await adminPage.goto(`${baseUrl}/app/settings/export`);
  await adminPage.getByRole('button', { name: 'Start export' }).click();
  await adminPage.getByText(/Progress appears below/).waitFor();
  await waitForStatus('export', 'completed', 'Always-on worker did not complete the Workspace Export.');
  await adminPage.getByRole('button', { name: 'Refresh' }).last().click();
  await adminPage.getByRole('button', { name: 'Download archive' }).waitFor();
  await runAxe(adminPage, '/app/settings/export completed');
  checks.export_completion = 'pass';

  // Source Access is evaluated independently of the Workspace role: the first
  // Administrator holds No Source Access until it is granted, so the Source
  // lifecycle refuses the mutation before any grant exists.
  await adminPage.goto(`${baseUrl}/app/settings/sources`);
  const sourceRow = adminPage.locator('.resource-row').filter({ hasText: 'Release handbook' });
  await openLifecycleDialog(adminPage, sourceRow);
  await adminPage.locator('#source-lifecycle-reason').fill('Release archive refusal check');
  expectRefusedRequest = true;
  await adminPage.locator('#source-lifecycle-dialog').getByRole('button', { name: 'Archive Source' }).click();
  await adminPage.locator('#source-lifecycle-error').waitFor({ state: 'visible' });
  const lifecycleRefusal = await adminPage.locator('#source-lifecycle-error').textContent();
  expectRefusedRequest = false;
  assert(
    /Administrator Source Access is required/.test(lifecycleRefusal ?? ''),
    `Archive without Source Access was not refused: ${lifecycleRefusal}`,
  );
  await adminPage.locator('#source-lifecycle-dialog').getByRole('button', { name: 'Cancel' }).click();
  checks.role_alone_grants_no_source_access = 'pass';

  await adminPage.goto(`${baseUrl}/app/settings/members`);
  const adminRow = adminPage.locator('.member-row').filter({ hasText: 'admin@example.test' });
  await adminRow.locator('.member-access').selectOption('all');
  await adminRow.locator('.member-reason').fill('Release lifecycle administration');
  await adminPage.evaluate(() => { window.beforeAccessReload = true; });
  await adminRow.getByRole('button', { name: 'Save role & access' }).click();
  await waitFor(async () => {
    const grants = await adminPage.evaluate(async () => {
      const response = await fetch('/api/workspace/v1/memberships');
      const body = await response.json();
      return body.data.map(member => [member.email, member.sourceAccess.mode]);
    });
    return grants.some(([email, mode]) => email === 'admin@example.test' && mode === 'all');
  }, 'Administrator Source Access grant was not persisted.');
  // An access live update makes the shell re-authorize by reloading the
  // document. The Administrator just changed its own Source Access, so that
  // reload is still in flight; wait for it to land before driving a dialog that
  // it would otherwise tear down mid-interaction.
  await waitFor(
    async () => adminPage.evaluate(() => window.beforeAccessReload !== true).catch(() => false),
    'The Administrator shell never re-authorized after its own Source Access change.',
  );
  checks.administrator_source_access_grant = 'pass';

  await adminPage.goto(`${baseUrl}/app/settings/sources`);
  await openLifecycleDialog(adminPage, sourceRow);
  await adminPage.locator('#source-lifecycle-reason').fill('Release archive verification');
  await submitDialog(adminPage, '#source-lifecycle-dialog', '#source-lifecycle-error', 'Archive Source');
  await adminPage.getByRole('tab', { name: 'Archived' }).click();
  const archivedRow = adminPage.locator('.resource-row').filter({ hasText: 'Release handbook' });
  await archivedRow.getByRole('button', { name: 'Permanently delete…' }).click();
  await adminPage.getByLabel('Type the immutable Source ID to confirm').fill('release-source');
  await adminPage.locator('#source-delete-reason').fill('Release deletion verification');
  await submitDialog(adminPage, '#source-delete-dialog', '#source-delete-error', 'Permanently delete Source');
  await waitForStatus('deletion', 'deleted', 'Always-on worker did not complete permanent Source deletion.');
  checks.archive_and_deletion = 'pass';

  // Appearance defaults to System and offers Light and Dark, so audit all three
  // rather than only the browser's default scheme.
  for (const colorScheme of ['no-preference', 'light', 'dark']) {
    await memberPage.emulateMedia({ colorScheme });
    await memberPage.goto(`${baseUrl}/app`);
    await runAxe(memberPage, `/app desktop ${colorScheme === 'no-preference' ? 'system' : colorScheme}`);
  }
  checks.system_light_and_dark = 'pass';

  // Tablet: the layout must hold between the desktop and mobile breakpoints.
  await memberPage.setViewportSize({ width: 768, height: 1024 });
  await memberPage.emulateMedia({ colorScheme: 'light' });
  await memberPage.goto(`${baseUrl}/app/knowledge`);
  const tablet = await memberPage.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(tablet.clientWidth === tablet.scrollWidth, 'Tablet viewport has horizontal overflow.');
  await runAxe(memberPage, '/app/knowledge tablet 768x1024');
  const tabletScreenshot = join(evidenceDir, 'member-knowledge-tablet-768x1024.png');
  await memberPage.screenshot({ path: tabletScreenshot });
  recordScreenshot(tabletScreenshot);
  checks.tablet_layout = 'pass';

  await memberPage.setViewportSize({ width: 390, height: 844 });
  await memberPage.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await memberPage.goto(`${baseUrl}/app/notifications`);
  const viewport = await memberPage.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(viewport.clientWidth === viewport.scrollWidth, 'Mobile viewport has horizontal overflow.');
  await runAxe(memberPage, '/app/notifications mobile dark reduced-motion');
  const mobileScreenshot = join(evidenceDir, 'member-notifications-dark-mobile-390x844.png');
  await memberPage.screenshot({ path: mobileScreenshot });
  recordScreenshot(mobileScreenshot);
  checks.mobile_dark_reduced_motion = 'pass';

  await adminPage.goto(`${baseUrl}/app/settings/account`);
  await adminPage.keyboard.press('Escape');
  await adminPage.waitForURL(`${baseUrl}/app`);
  checks.keyboard_escape = 'pass';
}

// --- Journey 2: Agent tier ---------------------------------------------------

/**
 * The Agent-tier customer journey (#68 Task 14 Step 1).
 *
 * The whole point is that nothing is asserted from a constant this file also
 * supplies to the server. Readiness is reached only by driving the real page:
 * the exact pinned model IDs are proved because `Check Codex` genuinely refuses
 * before the subscription exists, the shared password is proved because the
 * disclosure endpoint's value is matched against the harness's own derivation,
 * and every "no secret here" claim is a scan for that derived value rather than
 * a scan for a placeholder.
 */
async function runAgentJourney() {
  // --- 1. First Administrator, and the singular Agent destination ------------
  await adminPage.goto(`${baseUrl}/setup/${encodeURIComponent(setupToken)}`);
  await adminPage.getByLabel('Workspace name').fill('Agent Release Workspace');
  await adminPage.getByLabel('Administrator email').fill('admin@example.test');
  await adminPage.getByRole('button', { name: 'Continue' }).click();
  await adminPage.getByRole('heading', { name: 'Check your email' }).waitFor();
  const confirmation = await releaseToken('confirmation', 'admin@example.test');
  await adminPage.goto(`${baseUrl}/confirm/${encodeURIComponent(confirmation)}`);
  await adminPage.waitForURL(`${baseUrl}/app`);
  checks.agent_first_administrator_setup = 'pass';

  // The plural Agents page does not exist on Agent tier; a stale link lands on
  // the destination that does.
  await adminPage.goto(`${baseUrl}/app/agents`);
  await adminPage.waitForURL(`${baseUrl}/app/agent`);
  checks.agent_tier_serves_the_singular_agent = 'pass';

  // --- 2. Invitation warning and per-Member acknowledgment ------------------
  await adminPage.goto(`${baseUrl}/app/settings/members`);
  await adminPage.locator('#invite-email').fill('member@example.test');
  await adminPage.locator('#invite-role').selectOption('member');
  await adminPage.locator('#invite-access').selectOption('none');
  await adminPage.getByRole('button', { name: 'Send invitation' }).click();
  const invitation = await releaseToken('invitation', 'member@example.test');

  await memberPage.goto(`${baseUrl}/invitations/${encodeURIComponent(invitation)}`);
  const invitationBody = await memberPage.textContent('body');
  assert(invitationBody.includes(AGENT_SHARED_WARNING), 'The invitation omits the shared-state warning.');
  assert(invitationBody.includes(AGENT_ACK_LABEL), 'The invitation omits the acknowledgment label.');
  await memberPage.getByLabel('Email').fill('member@example.test');
  // HTML `required` is a convenience, not the boundary. Remove it and prove the
  // SERVER refuses an unacknowledged acceptance and leaves the single-use
  // invitation unconsumed.
  await memberPage.evaluate(() => document.querySelector('#agent-warning-checkbox').removeAttribute('required'));
  expectRefusedRequest = true;
  await memberPage.getByRole('button', { name: 'Accept invitation' }).click();
  await memberPage.locator('#error').waitFor({ state: 'visible' });
  const acknowledgmentRefusal = await memberPage.locator('#error').textContent();
  expectRefusedRequest = false;
  assert(
    /shared-state warning has not been acknowledged/.test(acknowledgmentRefusal ?? ''),
    `An unacknowledged invitation was not refused: ${acknowledgmentRefusal}`,
  );
  assert(memberPage.url().includes('/invitations/'), 'A refused invitation still signed the Member in.');

  await memberPage.locator('#agent-warning-checkbox').check();
  await memberPage.getByRole('button', { name: 'Accept invitation' }).click();
  await memberPage.waitForURL(`${baseUrl}/app`);
  checks.agent_invitation_warning_and_acknowledgment = 'pass';

  // --- 3. Member sees "setup incomplete" ------------------------------------
  await memberPage.goto(`${baseUrl}/app/agent`);
  await waitForText(memberPage, '#agent-status', 'Setup is not finished: the shared Agent has not been created.');
  assert(await memberPage.locator('#agent-ready').isHidden(), 'A Member saw the ready section before setup finished.');
  for (const control of AGENT_ADMINISTRATOR_CONTROLS) {
    assert(
      await memberPage.locator(control).count() === 0,
      `A Member was served the Administrator control ${control}.`,
    );
  }
  // Redeeming with the acknowledgment recorded it, so this Member is not asked
  // for it a second time.
  await memberPage.locator('#agent-warning-confirmed').waitFor({ state: 'visible' });
  assert(await memberPage.locator('#agent-warning-form').isHidden(), 'A Member who acknowledged was asked again.');
  const sharedCategories = await memberPage.locator('#agent-shared-categories li').allTextContents();
  assert(
    sharedCategories.join('|') === AGENT_SHARED_CATEGORIES.join('|'),
    `The shared-state categories were ${JSON.stringify(sharedCategories)}.`,
  );
  assert(
    await memberPage.locator('#agent-provider-status').isVisible(),
    'Provider and limit status is hidden while setup is incomplete.',
  );
  await waitForTextContaining(memberPage, '#agent-models', `Codex (default) \u2014 Not connected \u00b7 ${agentCodexModel}`);
  const memberIncompleteBody = await memberPage.textContent('body');
  assert(memberIncompleteBody.includes(AGENT_SHARED_WARNING), 'The Agent page omits the shared-state warning.');
  assert(memberIncompleteBody.includes(AGENT_BACKUP_WARNING), 'The no-backup warning is absent while setup is incomplete.');
  await runAxe(memberPage, '/app/agent member setup-incomplete');
  const memberIncomplete = join(evidenceDir, 'agent-member-setup-incomplete-1440x900.png');
  await memberPage.screenshot({ path: memberIncomplete });
  recordScreenshot(memberIncomplete);
  checks.agent_member_setup_incomplete = 'pass';

  // --- 4a. The Administrator's own acknowledgment ---------------------------
  await adminPage.goto(`${baseUrl}/app/agent`);
  await waitForText(adminPage, '#agent-status', 'Setup is not finished: the shared Agent has not been created.');
  // The first Administrator never redeemed an invitation, so they acknowledge
  // here — the acknowledgment is per Member, not per Workspace.
  await adminPage.locator('#agent-warning-form').waitFor({ state: 'visible' });
  assert(
    await adminPage.locator('#agent-warning-submit').isDisabled(),
    'The acknowledgment could be submitted without checking the box.',
  );
  await runAxe(adminPage, '/app/agent administrator setup');
  const adminSetup = join(evidenceDir, 'agent-administrator-setup-1440x900.png');
  await adminPage.screenshot({ path: adminSetup });
  recordScreenshot(adminSetup);
  await adminPage.locator('#agent-warning-checkbox').check();
  assert(
    !(await adminPage.locator('#agent-warning-submit').isDisabled()),
    'Checking the acknowledgment did not enable the control.',
  );
  await adminPage.locator('#agent-warning-submit').click();
  await adminPage.locator('#agent-warning-confirmed').waitFor({ state: 'visible' });
  checks.agent_per_member_acknowledgment = 'pass';

  // --- 4b. Initialize at Read + No Source Access ----------------------------
  await adminPage.locator('#agent-initialize').click();
  await waitForText(
    adminPage, '#agent-action-status',
    'The shared Agent was created at Read scope with No Source Access.',
  );
  // agentAct writes #agent-action-status BEFORE awaiting agentLoad(), so the
  // grant-scope/grant-access inputs still hold their static HTML defaults at
  // this point. #agent-step-2's step-state text is set inside the SAME
  // synchronous agentRender() pass that assigns scope.value/access.value from
  // the fetched grant, so waiting for it first proves these reads are the
  // server's value, not the markup's hardcoded default.
  await waitForText(adminPage, '#agent-step-2 .agent-step-state', 'Safe default in place \u2014 review and set');
  assert(await adminPage.locator('#agent-grant-scope').inputValue() === 'read', 'The Agent was not created at Read scope.');
  assert(await adminPage.locator('#agent-grant-access').inputValue() === 'none', 'The Agent was not created with No Source Access.');
  await waitForTextContaining(adminPage, '#agent-status', 'the current grant is unconfirmed');
  checks.agent_read_and_no_source_default = 'pass';

  // --- 4c. Confirm the grant ------------------------------------------------
  await adminPage.locator('#agent-grant-confirm-reason').fill('Release journey grant confirmation');
  await adminPage.locator('#agent-grant-confirm').click();
  await waitForText(adminPage, '#agent-action-status', 'The current grant was confirmed.');
  checks.agent_explicit_grant_confirmation = 'pass';

  // --- 4d. The always-on worker proves the live MCP binding -----------------
  // Nothing in the request path can produce these two facts: the reconciler
  // issues the bound Agent's credential, hands it to the runtime, and only then
  // records the proof against the current generation.
  await waitForBinding(
    binding => binding.mcp_verified_generation === binding.mcp_generation
      && binding.native_password_applied_generation === binding.native_password_generation
      && binding.native_password_generation >= 1,
    'The always-on worker did not verify the GBrain MCP binding and apply the first shared password.',
  );
  checks.agent_live_mcp_and_first_password_generation = 'pass';

  // --- 4e. Check Codex refuses before the subscription exists ---------------
  await adminPage.reload();
  await waitForTextContaining(adminPage, '#agent-status', 'Codex has not been checked');
  expectRefusedRequest = true;
  await adminPage.locator('#agent-check-codex').click();
  await adminPage.locator('#agent-feedback').waitFor({ state: 'visible' });
  const codexRefusal = await adminPage.locator('#agent-feedback').textContent();
  expectRefusedRequest = false;
  assert(
    /required model is not available/i.test(codexRefusal ?? ''),
    `Check Codex passed without a connected subscription: ${codexRefusal}`,
  );
  checks.agent_model_check_fails_closed = 'pass';

  // The Codex device-code flow runs inside OpenClaw against the customer's own
  // account, so the harness stands in for it. Everything after this point is
  // the product's own work again.
  await releasePost('/__release/agent/codex-login');

  // --- 4f. Claude, then both exact-model checks, then the answer proof ------
  await adminPage.reload();
  await adminPage.locator('#agent-claude-token').fill('release-claude-setup-token');
  await adminPage.locator('#agent-claude-form').getByRole('button', { name: 'Connect Claude' }).click();
  await waitForText(
    adminPage, '#agent-action-status',
    'The Claude setup token was sent to the runtime and cleared from this page.',
  );
  assert(
    await adminPage.locator('#agent-claude-token').inputValue() === '',
    'The Claude setup token was left in the page after it was sent.',
  );

  await adminPage.locator('#agent-check-codex').click();
  await waitForText(adminPage, '#agent-action-status', 'Check Codex passed against the running runtime.');
  await adminPage.locator('#agent-check-claude').click();
  await waitForText(adminPage, '#agent-action-status', 'Check Claude passed against the running runtime.');
  await adminPage.locator('#agent-answer-proof').click();
  await waitForText(adminPage, '#agent-action-status', 'The default answer and its automatic fallback were proved.');

  const observed = (await releaseCall('/__release/agent/runtime-observations')).value;
  assert(
    observed.probed_models.includes(agentCodexModel) && observed.probed_models.includes(agentClaudeModel),
    `The pinned models were not both probed: ${JSON.stringify(observed.probed_models)}`,
  );
  assert(
    observed.probed_models.every(model => model === agentCodexModel || model === agentClaudeModel),
    `A model outside the pinned pair was probed: ${JSON.stringify(observed.probed_models)}`,
  );
  assert(observed.default_answer_probes >= 1, 'The default answer chain was never probed without an override.');
  assert(observed.mcp_configure_calls >= 1, 'The GBrain MCP server was never configured on the runtime.');
  assert(
    observed.imported_providers.includes('anthropic'),
    `The Claude credential never reached the runtime: ${JSON.stringify(observed.imported_providers)}`,
  );
  checks.agent_exact_pinned_models_and_answer_proof = 'pass';

  // --- 5. Ready state for both roles ---------------------------------------
  await waitForBinding(binding => binding.ready === true, 'Readiness never opened after every proof landed.');
  await adminPage.reload();
  await waitForText(adminPage, '#agent-status', 'The shared Agent is ready.');
  await adminPage.locator('#agent-ready').waitFor({ state: 'visible' });
  assert(await adminPage.locator('#agent-checklist').isHidden(), 'The setup checklist stayed visible after readiness.');
  await runAxe(adminPage, '/app/agent administrator ready');

  await memberPage.reload();
  await waitForText(memberPage, '#agent-status', 'The shared Agent is ready.');
  await memberPage.locator('#agent-ready').waitFor({ state: 'visible' });
  for (const control of AGENT_ADMINISTRATOR_CONTROLS) {
    assert(
      await memberPage.locator(control).count() === 0,
      `A ready Member was served the Administrator control ${control}.`,
    );
  }
  await runAxe(memberPage, '/app/agent member ready');
  checks.agent_ready_for_both_roles = 'pass';

  // --- 6. Native details reveal only after a click -------------------------
  assert(await adminPage.locator('#agent-native-details').isHidden(), 'Native details were open before any click.');
  assert(
    await adminPage.locator('#agent-native-password').inputValue() === '',
    'The shared password was present before it was requested.',
  );
  await assertNoSecretInSurfaces('pre-reveal');

  await openNativeDetails(adminPage, 'The Administrator');
  assert(
    await adminPage.locator('#agent-native-toggle').getAttribute('aria-expanded') === 'true',
    'The native details toggle did not announce its expanded state.',
  );
  assert(
    await adminPage.locator('#agent-native-url').inputValue() === agentNativeUrl,
    'The disclosed Gateway URL is not the configured Workspace agent-client URL.',
  );
  assert(
    await adminPage.locator('#agent-native-password').getAttribute('type') === 'password',
    'The shared password was rendered in the clear.',
  );
  const administratorSecret = await adminPage.locator('#agent-native-password').inputValue();
  assert(administratorSecret.length > 0, 'The disclosure returned no shared password.');
  const revealHits = await scanSamples([{ name: 'reveal', text: administratorSecret }]);
  assert(
    revealHits.length === 1 && revealHits[0].generation === 1,
    `The revealed value is not the generation-1 derived password: ${JSON.stringify(revealHits)}`,
  );
  assert(
    await adminPage.locator('#agent-native-tui-url').textContent() === agentNativeUrl,
    'The rendered TUI snippet does not carry the real Gateway URL.',
  );
  // Post-reveal the value lives only in the live input's value property. It must
  // not have reached serialized markup, localStorage, or sessionStorage.
  await assertNoSecretInSurfaces('post-reveal');
  const nativeDetails = join(evidenceDir, 'agent-native-details-masked-1440x900.png');
  await adminPage.screenshot({ path: nativeDetails });
  recordScreenshot(nativeDetails);

  // The same shared credential reaches a second Member — that is the whole
  // shared-agent exception, proved rather than described.
  await openNativeDetails(memberPage, 'The Member');
  const memberSecret = await memberPage.locator('#agent-native-password').inputValue();
  assert(memberSecret === administratorSecret, 'Two Members did not receive the same shared native password.');
  await memberPage.locator('#agent-native-close').click();
  await memberPage.locator('#agent-native-details').waitFor({ state: 'hidden' });
  assert(
    await memberPage.locator('#agent-native-password').inputValue() === '',
    'Hiding the details left the shared password in the field.',
  );
  await adminPage.locator('#agent-native-close').click();
  await adminPage.locator('#agent-native-details').waitFor({ state: 'hidden' });
  assert(
    await adminPage.locator('#agent-native-password').inputValue() === '',
    'Hiding the details left the shared password in the Administrator field.',
  );
  await assertNoSecretInSurfaces('after-hide');
  checks.agent_native_reveal_after_click_only = 'pass';
  checks.agent_shared_credential_for_every_member = 'pass';

  // --- 7/8/9. Channels, model limitation, and no-backup copy ---------------
  const readyBody = await adminPage.textContent('body');
  assert(readyBody.includes(AGENT_CHANNEL_WARNING), 'The Channels external-sender warning is absent.');
  assert(readyBody.includes(AGENT_CHANNELS_LOCATION), 'The corrected Channels location copy is absent.');
  assert(
    !readyBody.includes('Config \u2192 Channels'),
    'The Channels location regressed to the incorrect "Config → Channels".',
  );
  assert(
    await adminPage.locator('#agent-channels').getAttribute('href') === '/agent/',
    'The Channels action does not link to the Workspace agent path.',
  );
  checks.agent_channel_warning_and_link = 'pass';

  assert(readyBody.includes(AGENT_MODEL_SWITCH_COPY), 'The model switching and fallback copy is absent.');
  assert(readyBody.includes(AGENT_SHARED_OPERATOR_LIMITATION), 'The shared-operator limitation copy is absent.');
  await waitForTextContaining(adminPage, '#agent-models', `Codex (default) \u2014 Connected \u00b7 ${agentCodexModel}`);
  await waitForTextContaining(adminPage, '#agent-models', `Claude (automatic fallback) \u2014 Connected \u00b7 ${agentClaudeModel}`);
  checks.agent_model_and_fallback_limitation_copy = 'pass';

  assert(readyBody.includes(AGENT_BACKUP_WARNING), 'The no-backup and deletion warning is absent at readiness.');
  checks.agent_no_backup_and_deletion_warning = 'pass';

  // --- 10a. Password rotation shows a pending state ------------------------
  // Park the runtime inside its password apply so the pending state is observed
  // rather than raced against a fast worker.
  await releasePost('/__release/agent/hold-apply');
  await openNativeDetails(adminPage, 'The Administrator');
  await adminPage.locator('#agent-rotate-reason').fill('Release journey rotation');
  await adminPage.locator('#agent-rotate').click();
  await waitForText(
    adminPage, '#agent-action-status',
    'The shared native password was rotated. Every native app and CLI must be given the new password.',
  );
  await waitFor(
    async () => (await releaseCall('/__release/agent/hold-apply')).value.active === true,
    'The always-on worker never reached the runtime password apply.',
    60_000,
  );
  await adminPage.reload();
  await waitForText(adminPage, '#agent-status', 'Setup is not finished: the shared password is still being applied.');
  assert(await adminPage.locator('#agent-ready').isHidden(), 'The ready section survived a pending rotation.');
  assert(
    !(await adminPage.locator('#agent-checklist').isHidden()),
    'The setup checklist stayed hidden during a pending rotation.',
  );
  expectRefusedRequest = true;
  const pendingRefusal = await adminPage.evaluate(async () => {
    const response = await fetch('/api/workspace/v1/agent/native-access', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  expectRefusedRequest = false;
  assert(
    pendingRefusal.status === 503 && pendingRefusal.body?.error?.code === 'agent_native_rotation_pending',
    `Disclosure was not refused during rotation: ${JSON.stringify(pendingRefusal)}`,
  );
  checks.agent_password_rotation_pending_state = 'pass';

  await releasePost('/__release/agent/release-apply');
  await waitForBinding(
    binding => binding.ready === true
      && binding.native_password_generation === 2
      && binding.native_password_applied_generation === 2,
    'The rotation never reached the applied second generation.',
  );
  await adminPage.reload();
  await waitForText(adminPage, '#agent-status', 'The shared Agent is ready.');
  await openNativeDetails(adminPage, 'The Administrator');
  const rotatedSecret = await adminPage.locator('#agent-native-password').inputValue();
  assert(rotatedSecret !== administratorSecret, 'Rotation handed back the retired shared password.');
  const rotatedHits = await scanSamples([{ name: 'rotated', text: rotatedSecret }]);
  assert(
    rotatedHits.length === 1 && rotatedHits[0].generation === 2,
    `The rotated value is not the generation-2 derived password: ${JSON.stringify(rotatedHits)}`,
  );
  await adminPage.locator('#agent-native-close').click();
  await adminPage.locator('#agent-native-details').waitFor({ state: 'hidden' });
  checks.agent_rotation_applies_a_new_generation = 'pass';

  // --- 10b. Disabling a Member refuses them and rotates the shared password -
  // expectRefusedRequest is scoped tightly to the two probes below that
  // actually expect a 401. The Disable click, the 60 s rotation wait, and the
  // navigation to /login are unrelated to those probes; leaving the flag on
  // across them would silence any real 401/403/409/503 console error the
  // journey happens to trip during that window.
  await adminPage.goto(`${baseUrl}/app/settings/members`);
  const memberRow = adminPage.locator('.member-row').filter({ hasText: 'member@example.test' });
  await memberRow.locator('.member-reason').fill('Release journey membership disable');
  await memberRow.getByRole('button', { name: 'Disable' }).click();
  await waitForBinding(
    binding => binding.ready === true
      && binding.native_password_generation === 3
      && binding.native_password_applied_generation === 3,
    'Disabling a Member did not rotate and re-apply the shared native password.',
  );
  expectRefusedRequest = true;
  const disabledDisclosure = await memberPage.evaluate(async () => {
    const response = await fetch('/api/workspace/v1/agent/native-access', { cache: 'no-store' });
    return response.status;
  });
  expectRefusedRequest = false;
  assert(
    disabledDisclosure === 401,
    `A disabled Member was not refused the shared password: ${disabledDisclosure}`,
  );
  await memberPage.goto(`${baseUrl}/app/agent`);
  await memberPage.waitForURL(`${baseUrl}/login`);

  // Refusing a disabled membership and revoking its sessions are two different
  // facts, and only the second is visible here: re-enable the membership and
  // the old browser session must STILL be dead. Without this the membership
  // check alone answers every probe above, and dropping session revocation
  // outright would go unnoticed.
  await adminPage.goto(`${baseUrl}/app/settings/members`);
  const reEnableRow = adminPage.locator('.member-row').filter({ hasText: 'member@example.test' });
  await reEnableRow.locator('.member-reason').fill('Release journey membership re-enable');
  await reEnableRow.getByRole('button', { name: 'Re-enable' }).click();
  await reEnableRow.getByRole('button', { name: 'Disable' }).waitFor();
  expectRefusedRequest = true;
  const revivedSession = await memberPage.evaluate(async () => {
    const response = await fetch('/api/workspace/v1/agent', { cache: 'no-store' });
    return response.status;
  });
  expectRefusedRequest = false;
  assert(
    revivedSession === 401,
    `Re-enabling a membership revived the session disablement should have revoked: ${revivedSession}`,
  );
  checks.agent_disabled_member_refusal = 'pass';
  checks.agent_disable_revokes_sessions_durably = 'pass';

  // The remaining Member still gets a working, freshly rotated credential.
  await adminPage.goto(`${baseUrl}/app/agent`);
  await waitForText(adminPage, '#agent-status', 'The shared Agent is ready.');
  await openNativeDetails(adminPage, 'The Administrator');
  const postDisableSecret = await adminPage.locator('#agent-native-password').inputValue();
  const postDisableHits = await scanSamples([{ name: 'post-disable', text: postDisableSecret }]);
  assert(
    postDisableHits.length === 1 && postDisableHits[0].generation === 3,
    `The post-disable value is not the generation-3 derived password: ${JSON.stringify(postDisableHits)}`,
  );
  await adminPage.locator('#agent-native-close').click();
  await adminPage.locator('#agent-native-details').waitFor({ state: 'hidden' });
  await assertNoSecretInSurfaces('post-rotation');
  checks.agent_rotation_after_disable_disclosed_to_remaining_member = 'pass';

  const finalObservations = (await releaseCall('/__release/agent/runtime-observations')).value;
  assert(
    finalObservations.applied_password_count === 3,
    `The runtime applied ${finalObservations.applied_password_count} passwords instead of three generations.`,
  );
  timings.agent_native_password_generations = finalObservations.applied_password_count;
}

// --- driver ------------------------------------------------------------------

try {
  browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  adminPage = await adminContext.newPage();
  memberPage = await memberContext.newPage();
  for (const page of [adminPage, memberPage]) {
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (expectRefusedRequest && refusalNoise.test(text)) return;
      consoleErrors.push(`${text} (${message.location().url})`);
    });
    page.on('pageerror', error => consoleErrors.push(error.message));
  }

  if (journey === 'agent') await runAgentJourney();
  else await runBrainJourney();

  assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(' | ')}`);
  checks.console_health = 'pass';
  const evidence = {
    environment: journey === 'agent'
      ? {
        browser: basename(browserExecutable),
        database: 'postgres',
        http_boundary: baseUrl,
        worker: 'always-on',
        tier: 'agent',
        openclaw_runtime: 'local release fake (loopback gateway substitute)',
        desktop_viewport: '1440x900',
      }
      : {
        browser: basename(browserExecutable),
        database: 'postgres',
        http_boundary: baseUrl,
        worker: 'always-on',
        desktop_viewport: '1440x900',
        mobile_viewport: '390x844 dark reduced-motion',
      },
    checks,
    timings_ms: timings,
    accessibility,
    console_errors: consoleErrors,
    screenshots,
  };
  const reportPath = join(evidenceDir, journey === 'agent' ? 'agent-browser-evidence.json' : 'browser-evidence.json');
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (journey === 'agent') {
    // The report is subject to the same rule as every other surface: no
    // credential class may appear in it, and that is proved against the real
    // derived value rather than trusted.
    const evidenceHits = await scanSamples([{ name: 'evidence-report', text: serialized }]);
    assert(evidenceHits.length === 0, `The evidence report contains a shared password: ${JSON.stringify(evidenceHits)}`);
  }
  writeFileSync(reportPath, serialized);
  process.stdout.write(`2Brain ${journey} browser release journey PASS\nEvidence: ${reportPath}\n`);
} finally {
  await browser?.close();
}

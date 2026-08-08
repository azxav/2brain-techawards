import type { ControlPlaneUser, WorkspaceRecord } from './store.ts';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a2e; }
    a.button, button { display: inline-block; background: #1a1a2e; color: #fff; border: 0; border-radius: 6px; padding: 0.6rem 1.2rem; font-size: 1rem; text-decoration: none; cursor: pointer; }
    input[type="text"] { padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; width: 16rem; }
    .error { color: #b00020; }
    ul.workspaces { list-style: none; padding: 0; }
    ul.workspaces li { border: 1px solid #e0e0e0; border-radius: 8px; padding: 0.8rem 1rem; margin-bottom: 0.5rem; }
    .muted { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

export function landingPage(): string {
  return layout('2Brain Cloud', `
  <h1>2Brain Cloud</h1>
  <p>Your own hosted 2Brain: dashboard, synced GitHub Sources, and an always-on brain.</p>
  <p><a class="button" href="/auth/github">Sign in with GitHub</a></p>
  <p class="muted">Signup is invite-only during the pilot.</p>`);
}

export function signupPage(login: string, error?: string): string {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return layout('Join 2Brain Cloud', `
  <h1>Almost there, ${escapeHtml(login)}</h1>
  <p>2Brain Cloud is invite-only during the pilot. Enter your invite code to finish signing up.</p>
  ${errorHtml}
  <form method="post" action="/signup">
    <input type="text" name="invite_code" placeholder="Invite code" autofocus required>
    <button type="submit">Redeem invite</button>
  </form>`);
}

/** What a provisioning step means to someone watching the dashboard. */
const STEP_LABELS: Record<string, string> = {
  pending: 'Queued',
  credentials: 'Preparing credentials',
  instance: 'Starting the machine',
  dns: 'Publishing the address',
  health: 'Waiting for HTTPS',
  setup_link: 'Creating your setup link',
  running: 'Ready',
  failed: 'Failed',
};

/** What a lifecycle state means to the person whose workspace it is. */
const LIFECYCLE_DETAIL: Partial<Record<WorkspaceRecord['lifecycleState'], string>> = {
  suspending: 'Suspending&hellip; the machine is being stopped.',
  suspended: 'Suspended by the operator. The machine is stopped and the address is dark. Your data is untouched and comes back on resume.',
  resuming: 'Resuming&hellip; the machine is starting and will answer again shortly.',
  deleting: 'Deleting&hellip; the machine and the address are being released.',
};

function workspaceItem(w: WorkspaceRecord): string {
  const lifecycleNote = LIFECYCLE_DETAIL[w.lifecycleState];
  const detail = lifecycleNote
    ? `<p class="muted">${lifecycleNote}</p>`
    : w.lifecycleState === 'failed' && w.provisioningError
      ? `<p class="error">${escapeHtml(w.provisioningError)}</p>`
      : w.setupLink
        ? `<p><a class="button" href="${escapeHtml(w.setupLink)}">Open setup link</a></p>
         <p class="muted">Single use. It creates the first Administrator for this workspace.</p>
         <p class="muted">Search and embedding are not switched on yet during the pilot.</p>`
        : w.lifecycleState === 'provisioning'
          ? `<p class="muted">${escapeHtml(STEP_LABELS[w.provisioningStep] ?? w.provisioningStep)}&hellip;</p>`
          : '';
  // Nothing to offer once a delete is already under way.
  const deleteLink = w.lifecycleState === 'deleting'
    ? ''
    : `<p><a class="muted" href="/workspaces/${escapeHtml(w.workspaceId)}/delete">Delete this workspace</a></p>`;
  return `<li data-workspace-id="${escapeHtml(w.workspaceId)}" data-state="${escapeHtml(w.lifecycleState)}">
    <strong>${escapeHtml(w.name)}</strong><br>
    <span class="muted">${escapeHtml(w.subdomain)} &middot; ${escapeHtml(w.tier)} tier &middot; ${escapeHtml(w.lifecycleState)}</span>
    ${detail}
    ${deleteLink}
  </li>`;
}

/**
 * The delete confirmation.
 *
 * The pilot takes no backups, so this page is the only warning anyone gets. It
 * names both halves of the outcome — what the user still has afterwards, and
 * what nobody can give back — rather than asking "are you sure?" and leaving
 * them to guess which is which. Typing the name is the acknowledgement.
 */
export function deleteWorkspacePage(w: WorkspaceRecord, csrf: string, error?: string): string {
  return layout(`Delete ${w.name}`, `
  <h1>Delete ${escapeHtml(w.name)}</h1>
  <p>This shuts down <strong>${escapeHtml(w.subdomain)}</strong> for good. It cannot be undone, and 2Brain Cloud keeps no backups during the pilot.</p>
  <h2>What survives</h2>
  <ul>
    <li><strong>Sources synced from GitHub.</strong> Those live in your repositories, which this does not touch. A new workspace can sync them again.</li>
  </ul>
  <h2>What is gone for good</h2>
  <ul>
    <li><strong>Members and their Source grants.</strong> Everyone you invited, and everything you granted them.</li>
    <li><strong>Agent memory.</strong> Everything your agents have learned and recorded here.</li>
    <li><strong>Event history.</strong> Every record of what happened in this workspace.</li>
    <li><strong>Anything written only here</strong> and never synced to GitHub.</li>
  </ul>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/workspaces/${escapeHtml(w.workspaceId)}/delete">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <p><label>Type <strong>${escapeHtml(w.name)}</strong> to confirm:<br>
      <input type="text" name="confirm_name" autocomplete="off" autofocus required></label></p>
    <button type="submit">Delete this workspace permanently</button>
  </form>
  <p><a class="muted" href="/dashboard">Cancel and go back</a></p>`);
}

export function dashboardPage(
  user: ControlPlaneUser,
  workspaces: WorkspaceRecord[],
  csrf: string,
  error?: string,
  selectedTier: 'brain' | 'agent' = 'brain',
): string {
  const list = workspaces.length === 0
    ? '<p class="muted">No workspaces yet.</p>'
    : `<ul class="workspaces">${workspaces.map(workspaceItem).join('')}</ul>`;
  // Provisioning and the lifecycle actions all take minutes, so the page reloads
  // itself while any workspace is mid-action and stops as soon as none are.
  const inFlight = workspaces.some(w =>
    w.lifecycleState === 'provisioning' || w.lifecycleState === 'suspending'
    || w.lifecycleState === 'resuming' || w.lifecycleState === 'deleting');
  const poll = inFlight
    ? '<script>setTimeout(function () { window.location.reload(); }, 5000);</script>'
    : '';
  return layout('2Brain Cloud — Dashboard', `
  <h1>Workspaces</h1>
  <p class="muted">Signed in as ${escapeHtml(user.login)}${user.isOperator ? ' (operator)' : ''}</p>
  ${list}
  <h2>Create a workspace</h2>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/workspaces">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="text" name="name" placeholder="Workspace name" maxlength="120" required>
    <fieldset>
      <legend>Workspace type</legend>
      <label><input type="radio" name="tier" value="brain"${selectedTier === 'brain' ? ' checked' : ''}>
        <strong>Brain</strong> — the knowledge workspace: GBrain, Sources, and Members.</label>
      <label><input type="radio" name="tier" value="agent"${selectedTier === 'agent' ? ' checked' : ''}>
        <strong>Agent</strong> — everything in Brain, plus an OpenClaw agent with its own browser
        and public-internet access. Everyone you let in operates one shared agent: its files, saved
        logins, browser session, and memory are shared. That can let a Member reach things their
        own workspace permissions would not allow. You grant the agent its scope and Sources after
        setup.</label>
    </fieldset>
    <button type="submit">Create workspace</button>
  </form>
  <form method="post" action="/auth/logout">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <button type="submit">Sign out</button>
  </form>
  ${poll}`);
}

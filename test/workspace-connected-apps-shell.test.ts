import { describe, expect, test } from 'bun:test';
import { appDocument } from '../src/web/workspace-shell.ts';

const render = (role: 'administrator' | 'member') =>
  appDocument('Trust Workspace', role, 'all', '/app/settings/connected-apps', {});

describe('Connected Apps Settings surface', () => {
  test('emits parseable client scripts', () => {
    const scripts = [...render('administrator').matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map(match => match[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(() => new Function(script)).not.toThrow();
  });

  test('renders labelled access controls, effective-state explanation, and Administrator identity', () => {
    const html = render('administrator');
    expect(html).toContain('id="connected-apps"');
    expect(html).toContain('id="connected-apps-refresh-warning"');
    expect(html).toContain("select.setAttribute('aria-label','Access level for '+connectedApp.client_name)");
    expect(html).toContain('connectedApp.member_email');
    expect(html).toContain('configured_access_level');
    expect(html).toContain('effective_access_level');
    expect(html).toContain('Effective access is lower');
    expect(html).toContain('available_access_levels.includes(level)');
    expect(html).toContain('unavailable_access_level_reasons');
    expect(html).toContain('unavailable because of this client registration');
    expect(html).toContain('unavailable for the Member role');
    expect(html).toContain('unavailable for the Member role and this client registration');
    expect(html).not.toContain('unavailable for the Member role or client registration');
  });

  test('confirms Admin grants and pair-wide revocation in one accessible dialog', () => {
    const html = render('member');
    expect(html).toContain('<dialog id="connected-app-confirm-dialog"');
    expect(html).toContain('aria-labelledby="connected-app-confirm-title"');
    expect(html).toContain('aria-describedby="connected-app-confirm-detail"');
    expect(html).toContain('Every credential for this connection changes immediately.');
    expect(html).toContain("selectedLevel==='admin'");
    expect(html).toContain("connectedAppConfirm('revoke'");
    expect(html).toContain("'#connected-app-confirm-dialog'");
    expect(html).toContain("connectedAppReturnFocus?.focus()");
  });

  test('preserves Last Trustworthy State with timestamp, request ID, and Retry', () => {
    const html = render('member');
    expect(html).toContain('Last Trustworthy State');
    expect(html).toContain('potentially outdated');
    expect(html).toContain("error.requestId");
    expect(html).toContain("retry.textContent='Retry'");
    expect(html).toContain("retry.addEventListener('click',loadConnectedApps)");
    expect(html).toContain("box.dataset.hasTrustworthyState='true'");
  });

  test('applies live updates in place and restores focus after confirmed mutations', () => {
    const html = render('administrator');
    expect(html).toContain("document.querySelector('#members,#sources,#operations,#exports,#connected-apps')");
    expect(html).toContain('loadConnectedApps()]);');
    expect(html).toContain("row.dataset.connectedAppKey=connectedApp.membership_id+':'+connectedApp.client_id");
    expect(html).toContain("document.querySelector('[data-connected-app-key=\"'+key+'\"] select')");
    expect(html).toContain("document.querySelector('#settings-title')");
  });
});

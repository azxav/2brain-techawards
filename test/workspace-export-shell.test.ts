import { describe, expect, test } from 'bun:test';
import { appDocument } from '../src/web/workspace-shell.ts';
import {
  WORKSPACE_EXPORT_EXCLUDED_SECRET_CLASSES,
  WORKSPACE_EXPORT_RETAINED_DATA_CLASSES,
} from '../src/workspace/export.ts';

// Issue #32 AC #8 — the visible Data export Settings state. appDocument is pure,
// so the panel HTML, its impact explanation, and its progress/completion/
// failure/retry/cancellation/download wiring are asserted directly without a
// server. Permission-gating (Member never sees the surface) is verified through
// the same render, and enforced in the router (workspace-boundary tests).

const adminExport = () => appDocument('Trust Workspace', 'administrator', 'all', '/app/settings/export', {});

describe('Data export Settings surface (#32)', () => {
  test('exposes the export configuration, impact explanation, and list surface', () => {
    const html = adminExport();
    expect(html).toContain('<h1 id="settings-title" tabindex="-1">Data export</h1>');
    expect(html).toContain('id="start-export-button"');
    expect(html).toContain('id="exports"');
    expect(html).toContain('id="export-success"');
    expect(html).toContain('id="export-refresh-warning"');
    // The impact explanation is derived from the builder's declared data classes
    // so the visible copy cannot drift from what the archive actually reads.
    expect(html).toContain('What the archive includes');
    expect(html).toContain('Never included');
    expect(html).toContain('absent by construction');
    expect(html).toContain('<li>Pages Markdown</li>');
    expect(html).toContain('<li>Change Events</li>');
    for (const retained of WORKSPACE_EXPORT_RETAINED_DATA_CLASSES) {
      const label = retained.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
      expect(html).toContain(`<li>${label}</li>`);
    }
    // Every excluded secret class is named as absent (Credentials, Tokens,
    // Provider Secrets, Managed Clone Internals, Raw Prompts, …).
    for (const excluded of WORKSPACE_EXPORT_EXCLUDED_SECRET_CLASSES) {
      const label = excluded.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
      expect(html).toContain(`<li>${label}</li>`);
    }
  });

  test('wires the six export endpoints with durable progress, retry, cancel, and download', () => {
    const html = adminExport();
    expect(html).toContain("api('/api/workspace/v1/exports'");
    expect(html).toContain("'/api/workspace/v1/exports/'+encodeURIComponent(id)+'/artifact'");
    expect(html).toContain("'/api/workspace/v1/exports/'+encodeURIComponent(id)+'/'+action");
    expect(html).toContain('idempotency_key:globalThis.crypto?.randomUUID');
    // Progress uses the shared accessible progressbar grammar.
    expect(html).toContain("progress.setAttribute('aria-label','Export progress')");
    expect(html).toContain("progress.setAttribute('role','progressbar')");
    // Completion → download of the artifact as a client-side blob.
    expect(html).toContain('Download archive');
    expect(html).toContain("link.download='2brain-workspace-export-'+id+'.json'");
    // Cancellation copy distinguishes a queued cancel from a running request.
    expect(html).toContain("record.state==='running'?'Request cancellation':'Cancel'");
    expect(html).toContain('Cancellation requested. The archive is discarded');
    // Failure recovery preserves the Last Trustworthy State and request ID.
    expect(html).toContain('Last Trustworthy State — potentially outdated');
    expect(html).toContain('Export refresh failed');
  });

  test('offers the Data export navigation entry and marks the active section', () => {
    const active = adminExport();
    expect(active).toContain('href="/app/settings/export" aria-current="page">Data export</a>');
    // The entry is present from any Administrator Settings section.
    const fromSources = appDocument('Trust Workspace', 'administrator', 'all', '/app/settings/sources', {});
    expect(fromSources).toContain('href="/app/settings/export">Data export</a>');
    expect(fromSources).not.toContain('href="/app/settings/export" aria-current="page"');
  });

  test('never renders the export surface or navigation entry for a Member', () => {
    // The Member never receives the export panel or its Settings nav entry. The
    // shared inert settings script still contains admin API path literals for
    // all roles (as it already does for Sources and Memberships); the guarantee
    // is that no export control is rendered and the route itself is 403-gated
    // (workspace-boundary tests). Assert the rendered controls, not script text.
    const memberAccount = appDocument('Trust Workspace', 'member', 'all', '/app/settings/account', {});
    expect(memberAccount).not.toContain('>Data export</a>');
    expect(memberAccount).not.toContain('id="start-export-button"');
    expect(memberAccount).not.toContain('id="exports"');
    expect(memberAccount).toContain('id="logout"');
  });
});

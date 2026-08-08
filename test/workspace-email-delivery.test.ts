import { expect, test } from 'bun:test';
import { createResendDeliverer, missingEmailDeliveryVars, resolveEmailDeliveryConfig } from '../src/workspace/email-delivery.ts';

function recordingFetch(status = 200, body = '{"id":"email-1"}') {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('login message posts a sign-in magic link to the Resend API', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const deliver = createResendDeliverer({
    apiKey: 'resend-key-test',
    from: '2Brain <no-reply@workspace.example.test>',
    baseUrl: 'https://workspace.example.test',
    fetchImpl,
  });
  await deliver({ email: 'member@example.test', token: 'token-abc', purpose: 'login' });

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://api.resend.com/emails');
  expect(calls[0].init.method).toBe('POST');
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers.authorization).toBe('Bearer resend-key-test');
  expect(headers['content-type']).toBe('application/json');
  const payload = JSON.parse(String(calls[0].init.body));
  expect(payload.from).toBe('2Brain <no-reply@workspace.example.test>');
  expect(payload.to).toEqual(['member@example.test']);
  expect(payload.subject).toContain('sign-in');
  expect(payload.text).toContain('https://workspace.example.test/login/redeem/token-abc');
  expect(payload.html).toContain('https://workspace.example.test/login/redeem/token-abc');
});

test('confirmation and invitation messages link to their redemption pages and trim the base URL', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const deliver = createResendDeliverer({
    apiKey: 'resend-key-test',
    from: 'no-reply@workspace.example.test',
    baseUrl: 'https://workspace.example.test/',
    fetchImpl,
  });
  await deliver({ email: 'admin@example.test', token: 'token-confirm', purpose: 'confirmation' });
  await deliver({ email: 'invitee@example.test', token: 'token+invite', purpose: 'invitation' });

  const confirmation = JSON.parse(String(calls[0].init.body));
  expect(confirmation.to).toEqual(['admin@example.test']);
  expect(confirmation.text).toContain('https://workspace.example.test/confirm/token-confirm');
  const invitation = JSON.parse(String(calls[1].init.body));
  expect(invitation.to).toEqual(['invitee@example.test']);
  expect(invitation.text).toContain('https://workspace.example.test/invitations/token%2Binvite');
  expect(invitation.subject.toLowerCase()).toContain('invit');
});

test('a non-2xx Resend response throws so the outbox row is marked failed', async () => {
  const { fetchImpl } = recordingFetch(422, '{"message":"invalid from"}');
  const deliver = createResendDeliverer({
    apiKey: 'resend-key-test',
    from: 'broken',
    baseUrl: 'https://workspace.example.test',
    fetchImpl,
  });
  await expect(deliver({ email: 'admin@example.test', token: 'token-abc', purpose: 'confirmation' }))
    .rejects.toThrow('resend_delivery_failed');
});

test('a partial email configuration names the missing vars so the operator is warned', () => {
  expect(missingEmailDeliveryVars({})).toEqual([]);
  expect(missingEmailDeliveryVars({
    GBRAIN_EMAIL_RESEND_API_KEY: 'resend-key-test',
    GBRAIN_EMAIL_FROM: 'no-reply@workspace.example.test',
    GBRAIN_WORKSPACE_BASE_URL: 'https://workspace.example.test',
  })).toEqual([]);
  expect(missingEmailDeliveryVars({ GBRAIN_EMAIL_RESEND_API_KEY: 'resend-key-test' }))
    .toEqual(['GBRAIN_EMAIL_FROM', 'GBRAIN_WORKSPACE_BASE_URL']);
  expect(missingEmailDeliveryVars({ GBRAIN_EMAIL_FROM: 'no-reply@workspace.example.test', GBRAIN_WORKSPACE_BASE_URL: 'https://workspace.example.test' }))
    .toEqual(['GBRAIN_EMAIL_RESEND_API_KEY']);
});

test('email delivery config resolves only when every required env var is present', () => {
  const full = {
    GBRAIN_EMAIL_RESEND_API_KEY: 'resend-key-test',
    GBRAIN_EMAIL_FROM: '2Brain <no-reply@workspace.example.test>',
    GBRAIN_WORKSPACE_BASE_URL: 'https://workspace.example.test',
  };
  expect(resolveEmailDeliveryConfig(full)).toEqual({
    apiKey: 'resend-key-test',
    from: '2Brain <no-reply@workspace.example.test>',
    baseUrl: 'https://workspace.example.test',
  });
  expect(resolveEmailDeliveryConfig({})).toBeNull();
  expect(resolveEmailDeliveryConfig({ ...full, GBRAIN_EMAIL_RESEND_API_KEY: undefined })).toBeNull();
  expect(resolveEmailDeliveryConfig({ ...full, GBRAIN_EMAIL_FROM: '  ' })).toBeNull();
  expect(resolveEmailDeliveryConfig({ ...full, GBRAIN_WORKSPACE_BASE_URL: '' })).toBeNull();
});

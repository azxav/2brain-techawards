/**
 * Env-configured email delivery for Workspace magic links (issue #36).
 *
 * The Workspace router already exposes a `deliverConfirmation` injection seam;
 * this module supplies the production implementation backed by the Resend HTTP
 * API. The composition root (`serve --http`) enables it only when the operator
 * provides the full email environment; otherwise behavior is unchanged and the
 * operator outbox routes remain the delivery path.
 */

export interface WorkspaceEmailMessage {
  email: string;
  token: string;
  purpose: 'confirmation' | 'login' | 'invitation';
}

export interface ResendDelivererConfig {
  apiKey: string;
  /** RFC 5322 from-address, e.g. `2Brain <no-reply@workspace.example.test>`. */
  from: string;
  /** Public origin the magic links point at, e.g. `https://team.example.test`. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DELIVERY_TIMEOUT_MS = 10_000;

interface EmailContent {
  subject: string;
  heading: string;
  action: string;
  detail: string;
  path: (token: string) => string;
}

const CONTENT: Record<WorkspaceEmailMessage['purpose'], EmailContent> = {
  confirmation: {
    subject: 'Confirm your email · 2Brain',
    heading: 'Confirm your email',
    action: 'Confirm email',
    detail: 'Open this single-use link to confirm your email and enter your Workspace.',
    path: token => `/confirm/${token}`,
  },
  login: {
    subject: 'Your sign-in link · 2Brain',
    heading: 'Sign in to your Workspace',
    action: 'Sign in',
    detail: 'Open this single-use link to sign in. If you did not request it, you can ignore this email.',
    path: token => `/login/redeem/${token}`,
  },
  invitation: {
    subject: 'You are invited to a 2Brain Workspace',
    heading: 'Accept your invitation',
    action: 'Accept invitation',
    detail: 'Open this link and confirm the email this invitation was addressed to.',
    path: token => `/invitations/${token}`,
  },
};

/**
 * All three env vars are required together; a partial configuration resolves
 * to null so the composition root keeps the current (operator outbox) behavior
 * rather than sending half-configured email.
 */
export function resolveEmailDeliveryConfig(env: Record<string, string | undefined>): Omit<ResendDelivererConfig, 'fetchImpl'> | null {
  const apiKey = env.GBRAIN_EMAIL_RESEND_API_KEY?.trim();
  const from = env.GBRAIN_EMAIL_FROM?.trim();
  const baseUrl = env.GBRAIN_WORKSPACE_BASE_URL?.trim();
  if (!apiKey || !from || !baseUrl) return null;
  return { apiKey, from, baseUrl };
}

export function magicLinkPath(purpose: WorkspaceEmailMessage['purpose'], token: string): string {
  return CONTENT[purpose].path(encodeURIComponent(token));
}

const REQUIRED_EMAIL_VARS = ['GBRAIN_EMAIL_RESEND_API_KEY', 'GBRAIN_EMAIL_FROM', 'GBRAIN_WORKSPACE_BASE_URL'] as const;

/**
 * Names the vars still missing from a PARTIAL email configuration so the
 * composition root can warn the operator. Empty when nothing is configured
 * (delivery deliberately off) or when everything is (delivery on).
 */
export function missingEmailDeliveryVars(env: Record<string, string | undefined>): string[] {
  const missing = REQUIRED_EMAIL_VARS.filter(name => !env[name]?.trim());
  return missing.length === REQUIRED_EMAIL_VARS.length ? [] : missing;
}

export function createResendDeliverer(config: ResendDelivererConfig): (message: WorkspaceEmailMessage) => Promise<void> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  return async message => {
    const content = CONTENT[message.purpose];
    const link = `${base}${magicLinkPath(message.purpose, message.token)}`;
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: config.from,
        to: [message.email],
        subject: content.subject,
        text: `${content.heading}\n\n${content.detail}\n\n${link}\n`,
        html: `<p>${content.heading}</p><p>${content.detail}</p><p><a href="${link}">${content.action}</a></p><p>${link}</p>`,
      }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`resend_delivery_failed: status ${response.status}`);
    }
  };
}

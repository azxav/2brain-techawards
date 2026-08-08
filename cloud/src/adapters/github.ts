/**
 * GitHub OAuth adapter — the control plane's identity provider seam.
 *
 * This is the adapter-interface pattern every cloud effect follows (parent
 * spec): the HTTP app depends only on the interface; production binds the
 * real HTTPS implementation; tests bind the in-memory fake. Later tickets
 * add sibling adapters (OCI compute, DNS, Stripe, OpenRouter keys, SSH)
 * in this same directory with the same shape.
 */

export interface GitHubProfile {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export class GitHubOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubOAuthError';
  }
}

export interface GitHubOAuthAdapter {
  /** Where to send the browser to start the OAuth dance. */
  authorizeUrl(state: string): string;
  /** Exchange a callback code for the user's profile. Throws GitHubOAuthError when the provider refuses. */
  exchangeCode(code: string): Promise<GitHubProfile>;
}

// ---------------------------------------------------------------------------
// Real implementation (github.com), fetch injected for unit testing.
// ---------------------------------------------------------------------------

export interface HttpGitHubOAuthOptions {
  clientId: string;
  clientSecret: string;
  /** Absolute callback URL registered on the GitHub OAuth app. */
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export class HttpGitHubOAuth implements GitHubOAuthAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpGitHubOAuthOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  authorizeUrl(state: string): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'read:user');
    return url.toString();
  }

  async exchangeCode(code: string): Promise<GitHubProfile> {
    const tokenResponse = await this.fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        redirect_uri: this.options.redirectUri,
        code,
      }),
    });
    if (!tokenResponse.ok) throw new GitHubOAuthError(`token exchange failed with status ${tokenResponse.status}`);
    const tokenBody = (await tokenResponse.json()) as { access_token?: string; error?: string };
    if (!tokenBody.access_token) throw new GitHubOAuthError(tokenBody.error ?? 'no access token in response');

    const userResponse = await this.fetchImpl('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        accept: 'application/vnd.github+json',
        'user-agent': '2brain-cloud-control-plane',
      },
    });
    if (!userResponse.ok) throw new GitHubOAuthError(`user lookup failed with status ${userResponse.status}`);
    const user = (await userResponse.json()) as { id: number; login: string; name: string | null; avatar_url: string | null };
    return { githubId: user.id, login: user.login, name: user.name ?? null, avatarUrl: user.avatar_url ?? null };
  }
}

// ---------------------------------------------------------------------------
// In-memory fake for tests: issue single-use codes for arbitrary profiles.
// ---------------------------------------------------------------------------

export class FakeGitHubOAuth implements GitHubOAuthAdapter {
  private codes = new Map<string, GitHubProfile>();
  private counter = 0;

  authorizeUrl(state: string): string {
    return `https://github.example/oauth/authorize?state=${encodeURIComponent(state)}`;
  }

  issueCode(profile: GitHubProfile): string {
    const code = `fake-code-${++this.counter}`;
    this.codes.set(code, profile);
    return code;
  }

  async exchangeCode(code: string): Promise<GitHubProfile> {
    const profile = this.codes.get(code);
    if (!profile) throw new GitHubOAuthError('unknown or expired code');
    this.codes.delete(code);
    return profile;
  }

  reset(): void {
    this.codes.clear();
  }
}

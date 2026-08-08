import { describe, expect, test } from 'bun:test';
import { GitHubOAuthError, HttpGitHubOAuth } from '../src/adapters/github.ts';

function adapterWith(fetchImpl: typeof fetch): HttpGitHubOAuth {
  return new HttpGitHubOAuth({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://cloud.example/auth/github/callback',
    fetchImpl,
  });
}

describe('HttpGitHubOAuth', () => {
  test('authorizeUrl carries client id, redirect uri, state, and scope', () => {
    const adapter = adapterWith(fetch);
    const url = new URL(adapter.authorizeUrl('the-state'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cloud.example/auth/github/callback');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('scope')).toBe('read:user');
  });

  test('exchangeCode trades the code for a token, then fetches the profile', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('access_token')) {
        return new Response(JSON.stringify({ access_token: 'gho_token' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 42, login: 'alice-example', name: 'Alice', avatar_url: 'https://avatars.example/42' }), { status: 200 });
    }) as typeof fetch;

    const profile = await adapterWith(fetchImpl).exchangeCode('the-code');
    expect(profile).toEqual({ githubId: 42, login: 'alice-example', name: 'Alice', avatarUrl: 'https://avatars.example/42' });

    expect(calls.length).toBe(2);
    const tokenBody = JSON.parse(String(calls[0].init?.body)) as Record<string, string>;
    expect(tokenBody.code).toBe('the-code');
    expect(tokenBody.client_secret).toBe('client-secret');
    const authHeader = new Headers(calls[1].init?.headers).get('authorization');
    expect(authHeader).toBe('Bearer gho_token');
  });

  test('a refused token exchange raises GitHubOAuthError', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 })) as unknown as typeof fetch;
    await expect(adapterWith(fetchImpl).exchangeCode('bogus')).rejects.toThrow(GitHubOAuthError);
  });

  test('a non-2xx provider response raises GitHubOAuthError', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
    await expect(adapterWith(fetchImpl).exchangeCode('any')).rejects.toThrow(GitHubOAuthError);
  });
});

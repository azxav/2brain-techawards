# Connect GBrain to ChatGPT

**Status (v0.26.0):** Unblocked. GBrain's `gbrain serve --http` ships OAuth 2.1
with PKCE, which is the ChatGPT MCP connector's hard requirement. Before v1.0,
this was a P0 TODO — the only major AI client that could not connect.

ChatGPT does not support bearer-token MCP servers. You must use the OAuth 2.1
HTTP server.

## Hosted workspace (2Brain Cloud)

Hosted workspaces serve MCP with dynamic client registration (RFC 7591)
already enabled — there is no manual client registration step:

1. Open ChatGPT > Settings > Connectors.
2. Click **Add connector**.
3. MCP server URL: `https://<your-workspace-domain>/mcp`.
4. ChatGPT discovers OAuth support and registers itself automatically, then
   opens a browser window on your workspace's `/authorize` page. `/authorize`
   requires a signed-in Workspace Session — if you're signed out you're
   redirected to `/login`; sign in with the passwordless email flow, then
   restart the connection attempt from ChatGPT (there is no return-to deep
   link).
5. Approve the consent page naming the Connector Client and choose its Access
   level. Read is preselected. The connector is live.

Tokens minted through consent are bound to you, the consenting Member: every
MCP request resolves your CURRENT Source Access (grant removed → requests
refused; membership disabled or removed → token invalid). Members may consent
to Read or Write; Administrators may consent to Read, Write, or Admin, subject
to the Connector Client's registered ceiling. Manage or revoke the connection
any time under **Settings → Connected apps** in the Workspace.

## Self-hosted setup

### 1. Start the HTTP server with DCR

```bash
gbrain serve --http --port 3131 --enable-dcr
```

`--enable-dcr` turns on self-service client registration (RFC 7591), so
ChatGPT registers itself — no manual client registration. Without it, register
a client by hand with `gbrain auth register-client` (see
[DEPLOY.md](DEPLOY.md)); host-repo wrappers can register programmatically:

```ts
await oauthProvider.registerClientManual(
  'chatgpt',
  ['authorization_code'],
  'read write',
  ['https://chat.openai.com/connector_platform_oauth_redirect'],
);
```

### 2. Expose the server publicly

```bash
brew install ngrok
ngrok http 3131 --url your-brain.ngrok.app
```

Your OAuth issuer URL becomes `https://your-brain.ngrok.app`. ChatGPT's
connector auto-discovers the spec-compliant endpoint at
`/.well-known/oauth-authorization-server`.

### 3. Add the connector in ChatGPT

1. Open ChatGPT > Settings > Connectors.
2. Click **Add connector**.
3. MCP server URL: `https://your-brain.ngrok.app/mcp`.
4. Click **Connect**. ChatGPT opens your server's `/authorize` page in a
   browser. `/authorize` is session-gated everywhere it is served: sign in as
   a Workspace member at `/login` first if needed (then restart the connection
   from ChatGPT), and approve the consent page naming the Connector Client.

Start a new conversation and ask ChatGPT to search your brain.

## Scopes

Dynamic registration without `scope` advertises the full cumulative ceiling so
the consent page can offer every level permitted by the signed-in Member's
role. It does not grant Admin: Read remains preselected and is the default
credential grant. An explicit client scope remains a hard ceiling, so a client
that registers `scope=read` stays Read-only.

Each credential is also capped by the Access level granted when it was issued.
Choosing a higher level during re-consent creates newly elevated credentials;
existing access and refresh credentials do not widen. Four
operations are `localOnly` and rejected over HTTP regardless of scope:
`sync_brain`, `file_upload`, `file_list`, `file_url`. The HTTP server fails
closed for any attempt to reach local filesystem surface area.

Choose the lowest Access level ChatGPT needs. Admin remains available only to
Administrators when the client registration permits it.

## Troubleshooting

**Landed on `/login` instead of the consent page**
`/authorize` requires a signed-in Workspace Session. Sign in with the
passwordless email flow, then restart the connection attempt from ChatGPT —
there is no return-to deep link after login.

**"Invalid redirect_uri" during the ChatGPT connector OAuth handshake**
The registered `redirect-uri` must match ChatGPT's exactly. With DCR enabled
ChatGPT registers its own redirect URI, so this shouldn't occur; if you
registered the client manually, re-register with the exact URI the error page
shows.

**ChatGPT shows an MCP connection error after approval**
Check the server logs and try again. If no request arrives, the connector
isn't reaching your ngrok URL.

**An older dynamically registered connector only offers Read**
Older omitted-scope registrations are stored identically to clients that
explicitly requested `scope=read`, so they are never widened automatically.
Reconnect only the affected client:

```bash
# 1. Copy the client ID from Settings -> Connected apps or operator logs.
# 2. Revoke only that stored OAuth client and its credentials.
gbrain auth revoke-client <client-id>
# 3. Disconnect/reconnect the connector so it performs fresh DCR.
# 4. Approve the new consent; Read is selected unless you choose a higher level.
```

A client that freshly registers with `scope=read` remains Read-only.

**"Unsupported grant_type" on the token endpoint**
ChatGPT uses `authorization_code`, which the MCP SDK supports natively.
If you see this error, verify the client was registered with
`--grant-types authorization_code` and not `client_credentials`.

## See also

- [DEPLOY.md](DEPLOY.md) — full OAuth 2.1 setup reference
- [ALTERNATIVES.md](ALTERNATIVES.md) — tunnel options (ngrok, Tailscale, Fly)

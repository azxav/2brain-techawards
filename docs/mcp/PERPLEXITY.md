# Connect GBrain to Perplexity Computer

Perplexity Computer connects as a **remote** MCP client, so GBrain must be served
over HTTP and reachable at a public HTTPS URL. Perplexity does not run
`gbrain serve` (stdio) the way Claude Code does — it needs a reachable endpoint:

```
Perplexity Computer
  → ngrok tunnel (https://YOUR-DOMAIN.ngrok.app/mcp)
  → gbrain serve --http   (built-in OAuth 2.1 transport)
  → Postgres / PGLite
```

## Hosted workspace (2Brain Cloud)

Hosted workspaces serve OAuth with dynamic client registration enabled, and
there is no shell access to run `gbrain auth ...` — so the credential lanes in
step 3 below are self-hosted-only. If your Perplexity version supports
browser-based OAuth for MCP servers, add `https://<your-workspace-domain>/mcp`
as a remote connector with no credentials: the client registers itself and
opens your workspace's `/authorize` page — sign in at `/login` first if needed
(then restart the connection from Perplexity), and approve the consent page
naming the Connector Client. The connection acts with YOUR current Source
Access (role `member` is read-only); manage or revoke it under
**Settings → Connected apps** in the Workspace.

The rest of this page is the self-hosted path.

## 1. Serve GBrain over HTTP (host side)

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0 \
  --public-url https://YOUR-DOMAIN.ngrok.app
```

- **`--bind 0.0.0.0` is required.** Since v0.34, `--http` defaults to
  `127.0.0.1`, so without it the tunnel reaches the server but the connection is
  refused (`ECONNREFUSED`).
- **`--public-url` must match the tunnel.** The OAuth issuer in the discovery
  metadata has to line up with the URL Perplexity actually hits (RFC 8414 §3.3),
  or OAuth client-credentials auth fails.

## 2. Expose it with a tunnel

```bash
ngrok http 3131 --url YOUR-DOMAIN.ngrok.app
```

See the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for a persistent
tunnel.

## 3. Create credentials

Two supported auth paths.

**OAuth 2.1 client credentials (recommended, v0.26.0+).** Perplexity is a cloud
service, so it holds whatever credential you give it. OAuth is the correct choice:
least-privilege scopes + short-lived rotating access tokens instead of a
long-lived full-access secret. This is a machine-to-machine lane for
operator-registered confidential clients — the `client_credentials` grant at
`/token` is not session-gated, unlike the browser-based `/authorize` consent
flow. Mint a client and print the connector fields in
one step (on the brain host):

```bash
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --agent perplexity --oauth --register
```

Or register separately and pass the creds (works anywhere, no DB needed):

```bash
gbrain auth register-client perplexity --grant-types client_credentials --scopes "read write"
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --agent perplexity --oauth \
  --client-id gbrain_cl_xxx --client-secret gbrain_cs_xxx
```

`connect --oauth` prints the **Issuer URL + Client ID + Client Secret** to paste
in step 4.

**Legacy bearer token (simplest, best for local/personal):**

```bash
gbrain auth create "perplexity"
gbrain connect https://YOUR-DOMAIN.ngrok.app/mcp --token gbrain_xxx --agent perplexity
```

(Perplexity is a GUI connector, so there's no `--install` — `connect` prints the
exact values to paste in step 4.)

## 4. Add the connector in Perplexity

1. Open Perplexity (requires Pro subscription).
2. Go to **Settings → Connectors** (or **MCP Servers**).
3. Add a new remote connector:
   - **URL:** `https://YOUR-DOMAIN.ngrok.app/mcp`
   - **Authentication:** API Key / Bearer Token, or OAuth client credentials
   - Paste the token (bearer) or `client_id` + `client_secret` (OAuth).
4. Save.

## Verify

In a Perplexity conversation, ask it to use your brain:

```
Use my GBrain to search for [topic]
```

Have it call `get_brain_identity` (whose brain this is), then `list_skills`
(everything it can do).

## Notes

- Perplexity Computer is available to Pro subscribers; both the Mac app and web
  version support remote MCP connectors.
- The Mac app can also use a local MCP server (`gbrain serve` stdio) if you'd
  rather not expose an HTTP endpoint.
- A `gbrain auth create` token is a long-lived, full-access secret. Keep it
  private and prefer a scoped token where possible.

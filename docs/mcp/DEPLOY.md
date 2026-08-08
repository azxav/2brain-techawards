# Deploy GBrain Remote MCP Server

> **v0.26.0+:** `gbrain serve --http` ships full OAuth 2.1 (client credentials,
> auth code + PKCE, refresh rotation, optional DCR) and scoped operations.
> `/authorize` is session-gated: authorization codes are only minted through a
> consent page shown to a signed-in Workspace member (see
> [Session-gated authorization](#3-session-gated-authorization) below).
> Pre-v0.26 legacy bearer tokens still work — `verifyAccessToken` falls back
> to the `access_tokens` table and grandfathers tokens to `read+write+admin`.
> Postgres-only for the legacy fallback (the `access_tokens` table is Postgres-only);
> OAuth tables work on both PGLite and Postgres. See [SECURITY.md](../../SECURITY.md)
> for env vars and tunable defaults.

Access your brain from any device, any AI client. GBrain ships two transports:
`gbrain serve` (stdio) for local agents, and `gbrain serve --http` (v0.26.0+)
for remote clients over OAuth 2.1.

## Three Paths

### Local stdio (zero setup)

```bash
gbrain serve
```

Works with Claude Code, Cursor, Windsurf, and any MCP client that supports stdio.
No server, no tunnel, no token needed. Works on both PGLite and Postgres engines.

### Remote over OAuth 2.1 (recommended, v0.26.0+)

```bash
gbrain serve --http --port 3131
ngrok http 3131 --url your-brain.ngrok.app
gbrain serve --http --port 3131 --public-url https://your-brain.ngrok.app
```

Built-in HTTP transport with OAuth 2.1, scoped operations, and a
session-gated `/authorize` consent flow. Zero external dependencies. This is
the only path that works with ChatGPT (OAuth 2.1 + PKCE is required by the
ChatGPT MCP connector). Pass `--public-url` whenever the server is reachable
at anything other than `http://localhost:<port>` so the OAuth issuer in
discovery metadata matches what clients hit (RFC 8414 §3.3).

Supported clients:
- **ChatGPT** — requires OAuth 2.1 + PKCE. Works natively with `--http`.
- **Claude Desktop / Cowork** — OAuth 2.1 or legacy bearer tokens.
- **Perplexity** — OAuth 2.1 client credentials grant.
- **Claude Code, Cursor, Windsurf** — can use OAuth or legacy bearer.

See the [OAuth 2.1 setup](#oauth-21-setup-v100) section below.

### Remote with legacy bearer tokens (pre-v0.26 deployments) — Postgres only

```
Your AI client (Claude Desktop, Perplexity, etc.)
  → ngrok tunnel (https://YOUR-DOMAIN.ngrok.app)
  → gbrain serve --http  (built-in transport with bearer auth)
  → Postgres (pooler connection or self-hosted)
```

This requires:
1. A Postgres-backed brain (the `access_tokens` table only exists on Postgres;
   running `gbrain serve --http` against a PGLite install fails fast at startup)
2. A machine running `gbrain serve --http`
3. A public tunnel (ngrok, Tailscale, or cloud host)
4. A bearer token created via `gbrain auth create <name>`

Pre-v1.0 tokens are grandfathered as `read+write+admin` scopes when you upgrade
to the HTTP server, so no migration is required.

## OAuth 2.1 Setup (v0.26.0+)

### 1. Start the HTTP server

```bash
gbrain serve --http --port 3131
```

> **v0.26.9+:** `mcp_request_log.params` defaults
> to a redacted summary `{redacted, kind, declared_keys, unknown_key_count, approx_bytes}`.
> Declared param keys are kept (intersected against the operation's spec); unknown
> keys are counted but never named, and byte sizes round up to 1KB so size-probe
> attacks can't binary-search secret content. Operators on a personal laptop who
> want raw payloads back can pass `gbrain serve --http --log-full-params` (loud
> stderr warning fires at startup). Multi-tenant deployments should leave it on
> the redacted default.

### 2. Register OAuth clients

Register clients from the CLI:

```bash
gbrain auth register-client perplexity \
  --grant-types client_credentials \
  --scopes "read write"
```

Pick the grant type per client: `client_credentials` for machine-to-machine
(Perplexity, Claude Desktop bearer mode) or `authorization_code` for
browser-based clients with PKCE (ChatGPT, Claude Desktop/Code connectors).
Credentials are shown once at registration — secrets are hashed on storage
and never shown again.

**v0.34 — source-scoped clients.** Multi-source brains can scope a client's
write authority to one source and its read scope to a curated set with the
new `--source` and `--federated-read` flags:

```bash
gbrain auth register-client dept-x-agent \
  --grant-types client_credentials \
  --scopes "read write" \
  --source dept-x \
  --federated-read dept-x,shared,parent-canon
```

`--source` controls the write authority — `put_page` / `add_link` / etc only
land in `dept-x`. `--federated-read` controls the read axis independently;
queries return rows from any of the listed sources. Omit both flags for the
v0.33-compatible super-client shape. Pre-v0.34 clients are backfilled to
`source_id='default'` on `gbrain upgrade`.

Host-repo wrappers can register programmatically:

```ts
await oauthProvider.registerClientManual(
  'perplexity',
  ['client_credentials'],
  'read write',
  [],  // redirect_uris, empty for CC
);
```

For self-service client registration (Dynamic Client Registration, RFC 7591),
start the server with `--enable-dcr`: `POST /register` opens up and discovery
(`/.well-known/oauth-authorization-server`) advertises it, so browser-based
clients (ChatGPT, Claude Desktop, Claude Code) register themselves with no
manual step. DCR is off by default for self-hosted servers; hosted 2Brain
Cloud workspaces run with it enabled.

Dynamically registered clients are limited to `authorization_code` and
`refresh_token` grants — every credential they can obtain passes through the
Member consent gate below. `client_credentials` is reserved for
operator-registered clients (`gbrain auth register-client`), so an
unauthenticated caller cannot register their way to a member-less token.
When DCR omits `scope`, the stored registration receives the full cumulative
ceiling so consent can offer every role-permitted level. An explicit non-empty
scope remains the client's ceiling.

### 3. Session-gated authorization

`GET/POST /authorize` requires a signed-in Workspace Session (the `/login`
passwordless email flow) — unconditionally, wherever it is served, with or
without `--enable-dcr`. There is no ungated authorization-code issuance.
Signed-in members see a consent page naming the Connector Client and its
requested scopes and an Access level selector, with Approve/Deny; approval
mints the authorization code. Read is always preselected. Members may choose
at most Write and Administrators at most Admin, subject to the registered
client ceiling. A
signed-out user hitting `/authorize` is redirected to `/login` and must
restart the connection attempt from the client after signing in (no return-to
deep link).

Tokens minted through consent are bound to the consenting Member: every MCP
request resolves that Member's CURRENT Source Access (grant removed →
requests refused; membership disabled or removed → token invalid). Re-consent
may issue a credential at a newly higher level, but existing access and refresh
credentials remain capped by their original grant.

Members manage their consented Connector Clients under
**Settings → Connected apps** in the Workspace (name + connected date);
Revoke ends access immediately.

Registrations created under the older omitted-scope behavior remain Read-only:
the stored row cannot be distinguished from an explicitly Read-only client, so
there is no bulk backfill. Reconnect only the affected client:

```bash
# 1. Copy the affected client ID from Settings -> Connected apps or operator logs.
# 2. Revoke only that stored OAuth client and its credentials.
gbrain auth revoke-client <client-id>
# 3. Disconnect/reconnect the connector so it performs fresh DCR.
# 4. Approve the new consent; Read is selected unless you choose a higher level.
```

An explicitly Read-only client that re-registers with `scope=read` remains
Read-only.

The `client_credentials` grant at `/token` is NOT session-gated — it is the
machine-to-machine lane for operator-registered confidential clients only.

### 4. Expose the server

**v0.34 — bind explicitly.** `gbrain serve --http` defaults to `127.0.0.1`.
To accept connections from the ngrok tunnel (or any non-loopback source),
restart with `--bind`:

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0 --public-url https://your-brain.ngrok.app
```

When `--public-url` is set without `--bind`, a stderr WARN fires at
startup so the misconfiguration ("the tunnel is up but my agent gets
ECONNREFUSED") is loud.

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 3131 --url your-brain.ngrok.app
```

Your OAuth issuer URL becomes `https://your-brain.ngrok.app`. The MCP SDK's
router exposes the spec-compliant discovery endpoint at
`/.well-known/oauth-authorization-server`.

### 5. Scopes and localOnly

Every operation is tagged `read | write | admin`. Four operations are
`localOnly` and rejected over HTTP regardless of scope: `sync_brain`,
`file_upload`, `file_list`, `file_url`. Remote agents cannot reach local
filesystem surface area.

| Scope | What it allows |
|-------|---------------|
| `read` | `search`, `query`, `get_page`, `list_pages`, graph traversal |
| `write` | `put_page`, `delete_page`, `add_link`, `add_timeline_entry` |
| `admin` | Client management, token revocation, sweep, local-only ops |

## Legacy Bearer Token Setup

Keep using pre-v0.26 bearer tokens if you aren't ready to migrate. They
grandfather to `read+write+admin` scopes on the HTTP server.

### 1. Set up the tunnel

See the [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for full setup.
Quick version:

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 8787 --url your-brain.ngrok.app  # Hobby tier for fixed domain
```

### 2. Create access tokens

```bash
# Create a token for each client
gbrain auth create "claude-desktop"

# List all tokens
gbrain auth list

# Revoke a token
gbrain auth revoke "claude-desktop"
```

Tokens are per-client. Create one for each device/app. Revoke individually
if compromised. Tokens are stored SHA-256 hashed in your database.

### 3. Connect your AI client

- **ChatGPT:** [setup guide](CHATGPT.md) (OAuth 2.1 + PKCE, requires `gbrain serve --http`)
- **Claude Code:** [setup guide](CLAUDE_CODE.md)
- **Claude Desktop:** [setup guide](CLAUDE_DESKTOP.md) (must use GUI, not JSON config)
- **Claude Cowork:** [setup guide](CLAUDE_COWORK.md)
- **Perplexity:** [setup guide](PERPLEXITY.md)

### 4. Verify

```bash
gbrain auth test \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  --token YOUR_TOKEN
```

## Operations

All 30 GBrain operations are available remotely, including `sync_brain` and
`file_upload` (no timeout limits with self-hosted server).

**Security note on `file_upload`:** remote MCP callers are confined to the working
directory where `gbrain serve` was launched. Symlinks, `..` traversal, and absolute
paths outside cwd are rejected. Page slugs and filenames are allowlist-validated
(alphanumeric + hyphens; no control chars, RTL overrides, or backslashes). Local
CLI callers (`gbrain file upload ...`) keep unrestricted filesystem access since
the user owns the machine.

## Deployment Options

See [ALTERNATIVES.md](ALTERNATIVES.md) for a comparison of ngrok, Tailscale
Funnel, and cloud hosts (Fly.io, Railway).

## Troubleshooting

**"missing_auth" error**
Include the Authorization header: `Authorization: Bearer YOUR_TOKEN`

**"invalid_token" error**
Run `gbrain auth list` to see active tokens.

**"service_unavailable" error**
Database connection failed. Check your Supabase dashboard for outages.

**Claude Desktop doesn't connect**
Remote servers must be added via Settings > Integrations, NOT
`claude_desktop_config.json`. See [CLAUDE_DESKTOP.md](CLAUDE_DESKTOP.md).

## Expected Latencies

| Operation | Typical Latency | Notes |
|-----------|----------------|-------|
| get_page | < 100ms | Single DB query |
| list_pages | < 200ms | DB query with filters |
| search (keyword) | 100-300ms | Full-text search |
| query (hybrid) | 1-3s | Embedding + vector + keyword + RRF |
| put_page | 100-500ms | Write + trigger search_vector update |
| get_stats | < 100ms | Aggregate query |

**Note:** `gbrain serve --http` shipped in v0.26.0 with OAuth 2.1 baked into
the binary. The custom HTTP wrapper pattern (see
[voice recipe](../../recipes/twilio-voice-brain.md)) is still supported for
teams that need bespoke middleware, but for most remote deployments the
built-in server is the recommended path.

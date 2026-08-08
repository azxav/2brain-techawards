# Connect GBrain to Claude Desktop

**Important:** Claude Desktop does NOT connect to remote MCP servers via
`claude_desktop_config.json`. That file only works for local stdio servers.
Remote HTTP servers must be added through the GUI.

## Option 1: OAuth (hosted workspaces, recommended)

Claude Desktop custom connectors support OAuth, and hosted 2Brain Cloud
workspaces serve it with dynamic client registration enabled — no token to
create or paste:

1. Open Claude Desktop
2. Go to **Settings > Integrations**
3. Click **Add Integration** (or **Add Connector**)
4. Enter the MCP server URL:
   ```
   https://<your-workspace-domain>/mcp
   ```
5. Save. Claude Desktop discovers OAuth support and registers itself
   automatically, then opens a browser window on your workspace's `/authorize`
   page. Sign in at `/login` first if needed (then restart the connection from
   Claude Desktop — there is no return-to deep link), and approve the consent
   page naming the Connector Client.

The connection acts with YOUR current Source Access: a Member with role
`member` is read-only, an administrator keeps the client's registered scopes,
and removing a grant or membership cuts access immediately. Manage or revoke
the connection under **Settings → Connected apps** in the Workspace.

## Option 2: Bearer token (self-hosted operators)

If you run the server yourself and have shell access on the brain host:

1. Open Claude Desktop
2. Go to **Settings > Integrations**
3. Click **Add Integration** (or **Add Connector**)
4. Enter the MCP server URL:
   ```
   https://YOUR-DOMAIN.ngrok.app/mcp
   ```
   Replace `YOUR-DOMAIN` with your ngrok domain (see
   [ngrok-tunnel recipe](../../recipes/ngrok-tunnel.md) for setup).
5. Set authentication to **Bearer Token** and paste your token
   (create one with `gbrain auth create "claude-desktop"`)
6. Save

## Verify

Start a new conversation and try:

```
Search my brain for [any topic]
```

Claude Desktop will use your GBrain tools automatically.

## Common Mistakes

**Using claude_desktop_config.json for remote servers** — this silently fails
with no error message. The JSON config only works for local stdio MCP servers.
Remote HTTP servers must be added via Settings > Integrations in the GUI.

**Using the wrong URL** — make sure the URL ends with `/mcp` (not `/health`
or just the base domain).

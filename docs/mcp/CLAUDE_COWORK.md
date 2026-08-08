# Connect GBrain to Claude Cowork

Three ways to get GBrain into Cowork sessions:

## Option 1: Remote via OAuth (hosted workspaces, recommended)

Hosted 2Brain Cloud workspaces support OAuth with dynamic client registration
— no token to create or paste. For Team/Enterprise plans, an org Owner adds
the connector:

1. Go to **Organization Settings > Connectors**
2. Add a new connector with the MCP server URL:
   ```
   https://<your-workspace-domain>/mcp
   ```
3. Save. The client discovers OAuth support and registers itself
   automatically, then opens a browser window on your workspace's `/authorize`
   page. Sign in at `/login` first if needed (then restart the connection —
   there is no return-to deep link), and approve the consent page naming the
   Connector Client.

The connection acts with the consenting Member's current Source Access: role
`member` is read-only, an administrator keeps the client's registered scopes,
and removing a grant or membership cuts access immediately. Manage or revoke
it under **Settings → Connected apps** in the Workspace.

## Option 2: Remote via bearer token (self-hosted server + tunnel)

If you run the server yourself and have shell access on the brain host, an
org Owner adds the connector:

1. Go to **Organization Settings > Connectors**
2. Add a new connector with the MCP server URL:
   ```
   https://YOUR-DOMAIN.ngrok.app/mcp
   ```
3. Add Bearer token authentication in Advanced Settings
   (create one with `gbrain auth create "cowork"`)
4. Save

Note: Cowork connects from Anthropic's cloud, not your device. Your server
must be publicly reachable (ngrok, Tailscale Funnel, or cloud-hosted).

## Option 3: Local Bridge (via Claude Desktop)

If you already have GBrain configured in Claude Desktop (via `gbrain serve`
stdio or a remote integration), Cowork gets access automatically. Claude
Desktop bridges local MCP servers into Cowork via its SDK layer.

This means: if `gbrain serve` is running and configured in Claude Desktop,
you don't need a separate server for Cowork.

## Which to use?

- **Hosted workspace (OAuth):** no secrets to handle, per-Member access with revocation under Settings → Connected apps
- **Self-hosted remote server:** works even when your laptop is closed, available to all org members
- **Local Bridge:** zero extra setup if Claude Desktop already has GBrain, but requires your machine to be running

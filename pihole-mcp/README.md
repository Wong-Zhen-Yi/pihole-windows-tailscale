# Pi-hole MCP

Local Model Context Protocol server for this fork's **Pi-hole v6 Docker**
deployment. It gives Codex 13 tools for reading status and making requested
filtering changes. It does not build or replace the published Pi-hole image.

## Install in Codex

Requirements: Node.js 22+, npm, Docker Desktop's Linux engine, and the running
`pihole-windows` Compose project. The official Pi-hole container must have
`curl`, `jq`, and readable `/etc/pihole/cli_pw` (CLI authentication enabled).
No password is stored in this package or in Codex configuration.

From the repository root in PowerShell:

```powershell
npm --prefix .\pihole-mcp ci --ignore-scripts
$nodePath = (Get-Command node).Source
$serverPath = (Resolve-Path .\pihole-mcp\server.mjs).Path
codex mcp add pihole -- $nodePath $serverPath
codex mcp get pihole
npm --prefix .\pihole-mcp run smoke
```

Reload Codex or start a fresh chat if the new tools are not available in the
current chat. Ask for “Check Pi-hole status”, “Show recent blocked domains”,
“Allow example.com”, or “Pause Pi-hole for five minutes”. The agent should read
existing state and apply only the requested changes. A pause affects **all
clients** using this Pi-hole and automatically expires (1–3600 seconds).

`plugin.json` and `mcp.json` also describe the package for compatible local
plugin hosts. Run `npm ci --ignore-scripts` inside the package before using
that source package. The Codex command above registers the MCP directly and
does not upload it to an account or make it available on web/mobile.

## Tools

| Tool | Operation |
| --- | --- |
| `get_status` | Blocking state, aggregate statistics, installed versions |
| `get_queries` | Recent queries, optional exact domain filter, offset and limit |
| `get_top_domains` | Top queried or blocked domains |
| `list_domains` | Allow/deny rules, including regex rules; pagination |
| `add_domain`, `remove_domain` | Add/remove a single exact allow/deny rule |
| `list_subscriptions` | Blocklist/allowlist subscriptions; pagination |
| `add_subscription` | Add a trusted HTTP(S) list with comment and group IDs |
| `set_subscription_enabled` | Toggle a subscription, preserving comment/groups |
| `remove_subscription` | Remove a specified subscription |
| `list_groups` | Group IDs and enabled state; pagination |
| `set_blocking` | Enable blocking or pause it temporarily |
| `refresh_gravity` | Download lists and rebuild gravity; up to 120 seconds |

Domain and subscription additions default to group `0`. Read groups and the
existing entries before making changes. Exact domain edits apply immediately;
subscription changes should be followed by an explicitly requested gravity
refresh. Regex edits and arbitrary configuration changes are not exposed.

## Security and behavior

The server runs over **stdio**, opens no listening port, and uses argument-array
`docker exec` calls. It checks the container's Compose labels for project
`pihole-windows` and service `pihole` before each API request. The fixed bridge
script authenticates to `http://127.0.0.1:80/api` **inside the container**, using
its existing CLI credential. The credential and session stay inside that
container; each request attempts logout even after an HTTP error. Docker access
is privileged: give this MCP only to trusted local clients.

Write tools are annotated as mutations. These annotations describe scope; the
MCP does not enforce a separate human approval step. Installing it makes those
operations available to the connected agent. Query history is private and may
contain browsing domains and device details. `get_queries` omits client and
upstream identity unless `include_clients=true`; domain history remains visible.
Do not commit tool results, logs, credentials or backups.

No tool changes Windows/client DNS, firewall rules, Tailscale DNS, upstream
resolvers, port bindings, container lifecycle or persistent volumes. The MCP
does not invoke Compose, so it preserves a deployment started with `-Tailscale`.
It works through Docker even when the host dashboard binds only to a LAN IP.
It does not establish phone DNS connectivity.

Requests are serialized, have bounded output, and never automatically retry a
write. If a timeout occurs, a server operation may still finish. Read back the
item or check the dashboard before retrying. Gravity returns the last 12,000
characters of output and flags truncation; review the output for failed list
downloads. HTTP success alone does not prove every remote list downloaded.

Optional environment settings, supplied to the MCP process (not `windows/.env`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIHOLE_MCP_CONTAINER` | `pihole-windows-pihole-1` | Container name; matching Compose labels still required |
| `PIHOLE_MCP_API_PORT` | `80` | Internal container HTTP API port, not host dashboard port 8080 |

If those are customized, supply `--env NAME=VALUE` before `--` in `codex mcp add`.
Never put a password in those settings. The standard Windows deployment needs
no overrides.

## Verify, recover and remove

```powershell
npm --prefix .\pihole-mcp test
npm --prefix .\pihole-mcp run smoke
codex mcp remove pihole
```

Unit tests mock API mutations. The smoke check performs an MCP handshake, lists
tools, reads live status and rejects an invalid write before it reaches Pi-hole.
It makes no filtering changes and does not prove client or mobile DNS works.
Removing the MCP registration leaves Pi-hole running and preserves all data.

If a tool cannot connect, check Docker Desktop and run
`.\windows\pihole.ps1 Status -Tailscale` for a Tailscale deployment. If CLI
authentication is disabled, enable it deliberately in Pi-hole or use the
dashboard directly; the server will not reset passwords or disable API auth.
Reinstall dependencies with `npm ci --ignore-scripts` if imports fail. If this
checkout is moved, re-register the new absolute server path. Restore accidental
rule changes from the dashboard or your private Teleporter backup.

Protocol references: [Pi-hole API](https://docs.pi-hole.net/api/),
[API authentication](https://docs.pi-hole.net/api/auth/), and
[Codex MCP setup](https://developers.openai.com/codex/mcp).

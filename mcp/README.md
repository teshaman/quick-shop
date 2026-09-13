# Quick Shop ↔ Claude Code

This folder is a small MCP (Model Context Protocol) server. Claude Code launches it over stdio; it opens a
local WebSocket that the Quick Shop module's active GM client connects to. Every MCP tool is forwarded to
Foundry and executed there with GM permissions, so the module stays the single source of truth.

```
Claude Code ──stdio──▶ mcp/server.mjs ◀──ws://localhost:30310── Foundry (GM client, scripts/bridge.mjs)
```

## Setup (once)

1. Install dependencies:
   ```
   cd Data/modules/quick-shop/mcp
   npm install
   ```
2. Register the server with Claude Code (user scope, so it works from any folder):
   ```
   claude mcp add -s user quick-shop -- node "C:\Users\alexg\AppData\Local\FoundryVTT\Data\modules\quick-shop\mcp\server.mjs"
   ```
   To use a token or a different port, add `-e QUICK_SHOP_TOKEN=... -e QUICK_SHOP_PORT=...` before `--`.
3. In Foundry, as GM: **Configure Settings → Module Settings → Quick Shop → Claude Code bridge** on.
   Port and token must match the values above (defaults: port 30310, no token).

Check with `claude mcp list` in a terminal and `bridge_status` from inside Claude Code.

## How it connects

- Only the **active GM** client connects. If that GM logs out, the next active GM takes over.
- The module retries quietly (2 s → 30 s backoff) while no Claude Code session is running, and reconnects
  as soon as one starts. Nothing in Foundry breaks when Claude Code is closed.
- The server binds to 127.0.0.1 only. Set a token if other software on the machine should not be able to
  talk to Foundry through it.

## Hosted Foundry (The Forge, a VPS)

The MCP server always runs on the machine where Claude Code runs; Foundry's own server can be anywhere. The
bridge is opened by the GM's **browser**, so as long as the GM logs in from the Claude Code machine nothing
changes: the page at `https://<your-game>.forge-vtt.com` connects to `ws://localhost:30310` on that machine.

```
Claude Code ──stdio──▶ mcp/server.mjs ◀──ws://localhost:30310── GM's browser ◀──https──▶ The Forge
                (this machine)                                    (this machine)          (cloud)
```

1. Build the module zip and upload it to The Forge (**My Foundry → Import Wizard**, or the Bazaar's import),
   then enable the module in the world:
   ```
   cd Data/modules/quick-shop/mcp
   npm run zip
   ```
   The zip leaves out `mcp/node_modules`. The `mcp/` copy on The Forge is inert; the one on your disk runs.
2. Set up Claude Code locally exactly as in **Setup** above (`npm install` + `claude mcp add`).
3. Log in to the Forge world as GM from a browser on this machine and turn on **Claude Code bridge**. Leave
   **Bridge URL** empty. `bridge_status` reports `hosted: true` and the URL it connects to.

Browser notes:

- Chrome, Edge, and Firefox let an https page open `ws://localhost`. Recent Chrome asks once for permission to
  access your local network; allow it.
- Safari blocks it as mixed content. Use another browser, or a tunnel as below.

**GM on a different machine, or Safari.** Expose the local server through a TLS tunnel, for example
`cloudflared tunnel --url http://localhost:30310` or `ngrok http 30310`. Set a **Bridge token** on both sides
(`-e QUICK_SHOP_TOKEN=...` when registering the server), then put the tunnel's `wss://` address in
**Bridge URL (advanced)**. Anyone with that URL and token can drive your shops, so keep the token secret and stop
the tunnel after the session.

## Tools

| Tool | What it does |
| --- | --- |
| `bridge_status` | Connection state, world, system, players online |
| `list_shops` / `get_shop` | Shops, settings, stock with base and sale prices, haggle results |
| `create_shop` / `convert_actor_to_shop` / `remove_shop` | Manage which actors are shops |
| `update_shop` / `set_shop_open` | Name, markup, unlimited, haggle rules, generator defaults, open/closed |
| `show_shop_to_players` | Open the shop, push the window to players, post the chat card |
| `generate_stock` | Random stock from compendiums with category/price/rarity filters |
| `search_compendium_items` / `list_item_packs` | Find items and packs |
| `add_items` / `remove_items` / `clear_stock` | Edit stock by name, id, or UUID |
| `list_buyers` / `buy_item` | Characters with coin; GM-side purchase with gold deduction |
| `record_haggle` / `reset_haggles` | Apply a rolled haggle check; clear results between visits |
| `open_shop_window` | Open the browser or config window on the GM's screen |

Shops, buyers, and items can be referenced by id or by name (case-insensitive, partial match allowed).

## Development

`npm test` runs `test/smoke.mjs`: it starts the server on a spare port, connects a fake Foundry client, and
drives the MCP handshake and several tools over stdio. No Foundry needed.

Adding a tool: add an action to `ACTIONS` in `scripts/bridge.mjs`, then a matching `tool(...)` entry in
`server.mjs`. Logs go to stderr (stdout is the MCP channel).

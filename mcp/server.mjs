#!/usr/bin/env node
/**
 * Quick Shop MCP server.
 *
 * Claude Code launches this over stdio. It opens a local WebSocket server that the Quick Shop module's
 * active GM client connects to (scripts/bridge.mjs), then exposes shop management as MCP tools.
 *
 * Environment:
 *   QUICK_SHOP_PORT   port to listen on (default 30310; must match the module setting)
 *   QUICK_SHOP_TOKEN  optional shared secret (must match the module setting)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const PORT = Number(process.env.QUICK_SHOP_PORT) || 30310;
const TOKEN = process.env.QUICK_SHOP_TOKEN || "";
const REQUEST_TIMEOUT_MS = Number(process.env.QUICK_SHOP_TIMEOUT_MS) || 60000;

const log = (...args) => console.error("[quick-shop-mcp]", ...args);

/* -------------------------------------------- */
/*  Foundry bridge                              */
/* -------------------------------------------- */

class FoundryBridge {
  socket = null;
  info = null;
  pending = new Map();

  constructor(port) {
    this.wss = new WebSocketServer({ port, host: "127.0.0.1" });
    this.wss.on("connection", ws => this.#onConnection(ws));
    this.wss.on("error", err => log("websocket server error:", err.message));
    this.wss.on("listening", () => log(`listening for Foundry on ws://localhost:${port}`));
  }

  get connected() {
    return !!this.socket && (this.socket.readyState === this.socket.OPEN);
  }

  #onConnection(ws) {
    let authenticated = false;
    ws.on("message", raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if ( !authenticated ) {
        if ( msg?.type !== "hello" || msg.module !== "quick-shop" ) return ws.close(4000, "expected hello");
        if ( TOKEN && (msg.token !== TOKEN) ) {
          log("rejected a Foundry client: bad token");
          return ws.close(4001, "bad token");
        }
        authenticated = true;
        if ( this.socket && (this.socket !== ws) ) {
          log("replacing previous Foundry connection");
          this.socket.close(4002, "replaced");
        }
        this.socket = ws;
        this.info = { world: msg.worldTitle, user: msg.user, system: msg.system, core: msg.core, version: msg.version };
        log(`Foundry connected: world "${msg.worldTitle}" as ${msg.user}`);
        return;
      }
      if ( msg?.type === "response" ) {
        const entry = this.pending.get(msg.id);
        if ( !entry ) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if ( msg.ok ) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error || "Foundry reported an error."));
      }
    });
    ws.on("close", () => {
      if ( this.socket === ws ) {
        this.socket = null;
        this.info = null;
        log("Foundry disconnected");
        for ( const [id, entry] of this.pending ) {
          clearTimeout(entry.timer);
          entry.reject(new Error("Foundry disconnected before answering."));
          this.pending.delete(id);
        }
      }
    });
    ws.on("error", err => log("socket error:", err.message));
  }

  call(action, params = {}) {
    if ( !this.connected ) {
      throw new Error(
        "Foundry is not connected. In Foundry, log in as GM, open Configure Settings → Module Settings → Quick Shop, "
        + `enable "Claude Code bridge", and make sure the port is ${PORT}. The module reconnects on its own. `
        + "If Foundry is hosted (The Forge, a VPS), the GM must be logged in from a browser on this machine and that browser "
        + "must allow the page to reach ws://localhost; see mcp/README.md → Hosted Foundry."
      );
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Foundry did not answer "${action}" within ${REQUEST_TIMEOUT_MS / 1000}s.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "request", id, action, params }));
    });
  }
}

const bridge = new FoundryBridge(PORT);

/* -------------------------------------------- */
/*  MCP server                                  */
/* -------------------------------------------- */

const server = new McpServer({ name: "quick-shop", version: "0.2.0" });

function text(value) {
  return { content: [{ type: "text", text: (typeof value === "string") ? value : JSON.stringify(value, null, 2) }] };
}

/** Register a tool whose handler forwards to a Foundry bridge action. */
function tool(name, description, shape, action, transform = a => a) {
  server.registerTool(name, { description, inputSchema: shape }, async args => {
    try {
      const result = await bridge.call(action, transform(args ?? {}));
      return text(result);
    } catch ( err ) {
      return { isError: true, ...text(`Error: ${err.message}`) };
    }
  });
}

const shopRef = z.string().describe("Shop actor id, UUID, actor name, or display name (case-insensitive).");
const buyerRef = z.string().describe("Player character actor id or name.");
const haggleShape = z.object({
  enabled: z.boolean().optional(),
  skills: z.array(z.enum(["per", "dec", "itm"])).optional().describe("Allowed skills: per=Persuasion, dec=Deception, itm=Intimidation."),
  dc: z.number().optional(),
  discount: z.number().optional().describe("Percent off on success."),
  critBonus: z.number().optional().describe("Extra percent off on a natural 20."),
  failPenalty: z.number().optional().describe("Percent surcharge on a natural 1 or missing the DC by 5+."),
  oncePerVisit: z.boolean().optional()
}).optional();
const generatorShape = {
  category: z.enum(["any", "weapon", "armor", "gear", "consumable", "tool", "magic"]).optional(),
  count: z.number().int().min(1).max(200).optional().describe("How many distinct items to add."),
  minPrice: z.number().min(0).optional().describe("Minimum base price in gp."),
  maxPrice: z.number().min(0).optional().describe("Maximum base price in gp."),
  rarities: z.array(z.enum(["", "common", "uncommon", "rare", "veryRare", "legendary"])).optional()
    .describe('Allowed rarities; "" means mundane.'),
  minQty: z.number().int().min(1).optional(),
  maxQty: z.number().int().min(1).optional(),
  priceVariance: z.number().min(0).max(100).optional().describe("Randomly nudge base prices up/down by up to this percent."),
  packs: z.array(z.string()).optional().describe("Compendium collection ids from list_item_packs. Empty = every item pack.")
};

tool("bridge_status",
  "Check whether Foundry is connected to this server and summarize the world (system, core version, shop count, players online).",
  {}, "status");

tool("list_shops",
  "List every shop in the world with its open/closed state, markup, haggle rules, item count, and haggle results so far.",
  {}, "listShops");

tool("get_shop",
  "Get one shop in full, including its stock with base and sale prices. Pass a buyer to see that character's haggled prices.",
  { shop: shopRef, buyer: buyerRef.optional() }, "getShop");

tool("create_shop",
  "Create a new NPC actor and turn it into a shop. Returns the shop; add stock with generate_stock or add_items afterwards.",
  {
    name: z.string().describe("Actor name, e.g. \"The Rusty Anvil\"."),
    displayName: z.string().optional().describe("Name shown to players if different from the actor name."),
    img: z.string().optional().describe("Image path for the actor."),
    open: z.boolean().optional().describe("Open for business immediately (default false)."),
    markup: z.number().optional().describe("Price markup percent; 100 = book price."),
    unlimited: z.boolean().optional().describe("Purchases do not reduce stock."),
    haggle: haggleShape
  }, "createShop");

tool("convert_actor_to_shop",
  "Flag an existing NPC actor as a shop. Its current inventory becomes the stock.",
  { actor: z.string().describe("Actor id, UUID, or name.") }, "convertActor");

tool("remove_shop",
  "Stop an actor being a shop. The actor and its items stay; only the shop settings are removed.",
  { shop: shopRef }, "removeShop");

tool("update_shop",
  "Change shop settings: display name, open state, markup, unlimited stock, haggle rules, or generator defaults.",
  {
    shop: shopRef,
    changes: z.object({
      name: z.string().optional(),
      open: z.boolean().optional(),
      markup: z.number().optional(),
      unlimited: z.boolean().optional(),
      haggle: haggleShape,
      generator: z.object(generatorShape).optional()
    })
  }, "updateShop");

tool("set_shop_open",
  "Open or close a shop for business. Players can only buy while it is open.",
  { shop: shopRef, open: z.boolean().default(true) }, "setOpen");

tool("show_shop_to_players",
  "Open the shop (if closed), pop the shop window on players' screens, and post a chat card they can reopen it from.",
  { shop: shopRef, users: z.array(z.string()).optional().describe("User ids or names. Omit for everyone.") }, "showToPlayers");

tool("generate_stock",
  "Add random priced items from compendiums to a shop. Filters override the shop's saved generator settings for this call only.",
  { shop: shopRef, replace: z.boolean().optional().describe("Clear existing stock first."), ...generatorShape }, "generateStock");

tool("search_compendium_items",
  "Search item compendiums by name to find UUIDs and prices. Use before add_items when a name is ambiguous.",
  {
    query: z.string().min(2),
    packs: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(100).optional()
  }, "searchItems");

tool("add_items",
  "Add specific items to a shop's stock by name or compendium UUID. Names use the best compendium match. Existing stock of the same item has its quantity increased unless a custom price is given.",
  {
    shop: shopRef,
    items: z.array(z.union([
      z.string(),
      z.object({
        name: z.string().optional(),
        uuid: z.string().optional(),
        quantity: z.number().int().min(1).optional(),
        price: z.number().min(0).optional().describe("Override the base price."),
        denomination: z.enum(["pp", "gp", "ep", "sp", "cp"]).optional()
      })
    ])).min(1)
  }, "addItems");

tool("remove_items",
  "Remove items from a shop's stock by id or name. With quantity, reduce the count instead of deleting.",
  { shop: shopRef, items: z.array(z.string()).min(1), quantity: z.number().int().min(1).optional() }, "removeItems");

tool("clear_stock",
  "Delete every physical item from a shop's stock.",
  { shop: shopRef }, "clearStock");

tool("reset_haggles",
  "Forget all haggle results on a shop so characters can try again on their next visit.",
  { shop: shopRef }, "resetHaggles");

tool("list_buyers",
  "List player characters with their coin totals and owning players.",
  {}, "listBuyers");

tool("buy_item",
  "Buy from a shop on behalf of a character as the GM: deducts coin, moves the item, reduces stock, and posts the chat card. Works even while the shop is closed.",
  { shop: shopRef, buyer: buyerRef, item: z.string().describe("Stock item id or name."), quantity: z.number().int().min(1).default(1) },
  "buy");

tool("record_haggle",
  "Record a haggle check a character already rolled (e.g. via Familiar or in chat). Applies the shop's discount or surcharge rules and posts the result.",
  {
    shop: shopRef,
    buyer: buyerRef,
    skill: z.enum(["per", "dec", "itm"]),
    total: z.number().describe("The check total."),
    isCritical: z.boolean().optional().describe("Natural 20."),
    isFumble: z.boolean().optional().describe("Natural 1.")
  }, "recordHaggle");

tool("list_item_packs",
  "List item compendium packs available in the world, marking the ones the generator uses by default.",
  {}, "listPacks");

tool("open_shop_window",
  "Open the shop browser or the GM config window on the GM's screen.",
  { shop: shopRef, mode: z.enum(["browser", "config"]).default("browser") }, "openWindow");

/* -------------------------------------------- */
/*  Start                                       */
/* -------------------------------------------- */

const transport = new StdioServerTransport();
await server.connect(transport);
log("ready on stdio");

for ( const signal of ["SIGINT", "SIGTERM"] ) {
  process.on(signal, () => { bridge.wss.close(); process.exit(0); });
}
process.stdin.on("close", () => { bridge.wss.close(); process.exit(0); });

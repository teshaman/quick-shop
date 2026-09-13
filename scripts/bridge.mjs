/**
 * Claude Code bridge.
 *
 * The active GM client opens a WebSocket to the Quick Shop MCP server (mcp/server.mjs) that Claude Code
 * launches on demand. The server forwards tool calls as `{ type: "request", id, action, params }` and this
 * file answers with `{ type: "response", id, ok, result | error }`. Everything runs with GM permissions
 * on this client, so only the active GM ever connects.
 */
import { FLAG, MODULE_ID, PHYSICAL_TYPES } from "./constants.mjs";
import { allShops, defaultPackIds, getShopConfig, getVisit, isShop, makeShop, removeShop,
  replaceShopKey, shopItems, shopName, updateShop } from "./shop-data.mjs";
import { generateStock, itemPacks, searchIndex } from "./generator.mjs";
import { actorWealthCp, formatCp, itemBaseCp, unitPriceCp } from "./pricing.mjs";
import { requestGM } from "./socket.mjs";

const SETTINGS = { enabled: "bridgeEnabled", port: "bridgePort", token: "bridgeToken", url: "bridgeUrl" };
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;

let socket = null;
let retryTimer = null;
let retryDelay = RETRY_MIN_MS;
let announcedWaiting = false;

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

export function registerBridgeSettings() {
  game.settings.register(MODULE_ID, SETTINGS.enabled, {
    name: "QUICKSHOP.Settings.BridgeEnabled",
    hint: "QUICKSHOP.Settings.BridgeEnabledHint",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: () => refreshBridge()
  });
  game.settings.register(MODULE_ID, SETTINGS.port, {
    name: "QUICKSHOP.Settings.BridgePort",
    hint: "QUICKSHOP.Settings.BridgePortHint",
    scope: "world", config: true, type: Number, default: 30310,
    onChange: () => refreshBridge()
  });
  game.settings.register(MODULE_ID, SETTINGS.token, {
    name: "QUICKSHOP.Settings.BridgeToken",
    hint: "QUICKSHOP.Settings.BridgeTokenHint",
    scope: "world", config: true, type: String, default: "",
    onChange: () => refreshBridge()
  });
  game.settings.register(MODULE_ID, SETTINGS.url, {
    name: "QUICKSHOP.Settings.BridgeUrl",
    hint: "QUICKSHOP.Settings.BridgeUrlHint",
    scope: "world", config: true, type: String, default: "",
    onChange: () => refreshBridge()
  });
}

/**
 * Whether this client is served by a remote Foundry (The Forge, a VPS, ...) rather than the machine it runs on.
 * The bridge still works from such a page as long as Claude Code runs on the machine the browser is on.
 */
export function isHostedClient() {
  return !LOOPBACK_HOSTS.includes(window.location.hostname);
}

/** The WebSocket URL this client connects to: the Bridge URL setting if set, else localhost on the configured port. */
export function bridgeUrl() {
  const custom = String(game.settings.get(MODULE_ID, SETTINGS.url) ?? "").trim();
  if ( custom ) return /^wss?:\/\//i.test(custom) ? custom : `wss://${custom}`;
  const port = Number(game.settings.get(MODULE_ID, SETTINGS.port)) || 30310;
  return `ws://localhost:${port}`;
}

/** One-time console hint for hosted (https) clients, where the browser decides whether ws://localhost is reachable. */
function hostedHint(url) {
  if ( (window.location.protocol !== "https:") || !url.startsWith("ws://") ) return "";
  return `This Foundry client is served over https, so the browser must allow the page to reach ${url} on this machine. `
    + "Chrome, Edge, and Firefox allow it (Chrome may ask once for local network access); Safari blocks it. "
    + "If Claude Code runs on another machine, or you use Safari, set a wss:// Bridge URL through a tunnel. "
    + "See modules/quick-shop/mcp/README.md → Hosted Foundry.";
}

/* -------------------------------------------- */
/*  Connection                                  */
/* -------------------------------------------- */

/** (Re)evaluate whether this client should hold the bridge connection. */
export function refreshBridge() {
  const shouldConnect = game.settings.get(MODULE_ID, SETTINGS.enabled) && (game.user === game.users.activeGM);
  if ( shouldConnect ) connect();
  else disconnect();
}

function connect() {
  disconnect();
  const url = bridgeUrl();
  try {
    socket = new WebSocket(url);
  } catch ( err ) {
    scheduleRetry();
    return;
  }
  const ws = socket;
  ws.addEventListener("open", () => {
    retryDelay = RETRY_MIN_MS;
    announcedWaiting = false;
    ws.send(JSON.stringify({
      type: "hello",
      token: game.settings.get(MODULE_ID, SETTINGS.token) || "",
      module: MODULE_ID,
      version: game.modules.get(MODULE_ID).version,
      world: game.world.id,
      worldTitle: game.world.title,
      user: game.user.name,
      system: game.system.id,
      core: game.version
    }));
    console.log(`${MODULE_ID} | Claude Code bridge connected on ${url}`);
    ui.notifications.info(game.i18n.localize("QUICKSHOP.Bridge.Connected"), { console: false });
  });
  ws.addEventListener("message", event => onMessage(ws, event.data));
  ws.addEventListener("close", () => {
    if ( socket === ws ) {
      socket = null;
      scheduleRetry();
    }
  });
  ws.addEventListener("error", () => { /* a close event follows and handles the retry */ });
}

function disconnect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if ( socket ) {
    const ws = socket;
    socket = null;
    try { ws.close(); } catch ( err ) { /* ignore */ }
  }
}

function scheduleRetry() {
  if ( !game.settings.get(MODULE_ID, SETTINGS.enabled) ) return;
  if ( !announcedWaiting ) {
    announcedWaiting = true;
    const url = bridgeUrl();
    console.log(`${MODULE_ID} | Claude Code bridge waiting for the MCP server at ${url} (retrying quietly)`);
    const hint = hostedHint(url);
    if ( hint ) console.log(`${MODULE_ID} | ${hint}`);
  }
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => refreshBridge(), retryDelay);
  retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
}

export function bridgeStatus() {
  return {
    enabled: !!game.settings.get(MODULE_ID, SETTINGS.enabled),
    connected: socket?.readyState === WebSocket.OPEN,
    port: Number(game.settings.get(MODULE_ID, SETTINGS.port)) || 30310,
    url: bridgeUrl(),
    hosted: isHostedClient(),
    isActiveGM: game.user === game.users.activeGM
  };
}

async function onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch ( err ) { return; }
  if ( msg?.type !== "request" ) return;
  let reply;
  try {
    const handler = ACTIONS[msg.action];
    if ( !handler ) throw new Error(`Unknown action "${msg.action}"`);
    const result = await handler(msg.params ?? {});
    reply = { type: "response", id: msg.id, ok: true, result };
  } catch ( err ) {
    console.error(`${MODULE_ID} | bridge action ${msg.action} failed`, err);
    reply = { type: "response", id: msg.id, ok: false, error: err.message ?? String(err) };
  }
  if ( ws.readyState === WebSocket.OPEN ) ws.send(JSON.stringify(reply));
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function findShop(ref) {
  if ( !ref ) throw new Error("A shop id or name is required.");
  const byId = game.actors.get(ref) ?? foundry.utils.fromUuidSync?.(ref);
  const actor = (byId instanceof Actor) ? byId : findActorByName(ref, allShops());
  if ( !actor ) throw new Error(`No shop matches "${ref}".`);
  if ( !isShop(actor) ) throw new Error(`"${actor.name}" is not a shop. Convert it first.`);
  return actor;
}

function findActor(ref, pool = game.actors.contents) {
  if ( !ref ) throw new Error("An actor id or name is required.");
  const byId = game.actors.get(ref) ?? foundry.utils.fromUuidSync?.(ref);
  const actor = (byId instanceof Actor) ? byId : findActorByName(ref, pool);
  if ( !actor ) throw new Error(`No actor matches "${ref}".`);
  return actor;
}

function findActorByName(name, pool) {
  const q = String(name).trim().toLowerCase();
  return pool.find(a => (shopName(a).toLowerCase() === q) || (a.name.toLowerCase() === q))
    ?? pool.find(a => shopName(a).toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    ?? null;
}

function findStockItem(shop, ref) {
  const byId = shop.items.get(ref);
  if ( byId ) return byId;
  const q = String(ref).trim().toLowerCase();
  const stock = shopItems(shop);
  return stock.find(i => i.name.toLowerCase() === q) ?? stock.find(i => i.name.toLowerCase().includes(q)) ?? null;
}

function characters() {
  return game.actors.filter(a => a.type === "character");
}

function serializeShop(actor, { stock = false, buyerId = null } = {}) {
  const config = getShopConfig(actor);
  const visit = buyerId ? getVisit(config, buyerId) : null;
  const items = shopItems(actor);
  const out = {
    id: actor.id,
    uuid: actor.uuid,
    actorName: actor.name,
    name: shopName(actor),
    img: actor.img,
    open: !!config.open,
    markup: config.markup,
    unlimited: !!config.unlimited,
    haggle: config.haggle,
    generator: config.generator,
    itemCount: items.length,
    wealth: formatCp(actorWealthCp(actor)),
    haggleResults: Object.entries(config.visits ?? {}).map(([id, v]) => ({
      buyerId: id, buyer: game.actors.get(id)?.name ?? id, ...v
    }))
  };
  if ( stock ) out.stock = items.map(i => serializeItem(i, config, visit));
  return out;
}

function serializeItem(item, config, visit = null) {
  const saleCp = unitPriceCp(item, config, visit);
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    subtype: item.system?.type?.value ?? "",
    rarity: item.system?.rarity ?? "",
    quantity: item.system?.quantity ?? 1,
    basePrice: formatCp(itemBaseCp(item)),
    salePrice: formatCp(saleCp),
    salePriceCp: saleCp
  };
}

function serializeBuyer(actor) {
  return {
    id: actor.id,
    name: actor.name,
    wealth: formatCp(actorWealthCp(actor)),
    wealthCp: actorWealthCp(actor),
    owners: game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.name)
  };
}

async function itemDataFromUuid(uuid, quantity = 1) {
  const doc = await foundry.utils.fromUuid(uuid);
  if ( !doc ) throw new Error(`Nothing found at ${uuid}.`);
  const data = doc.toObject();
  delete data._id;
  delete data.folder;
  delete data.sort;
  data.system.quantity = quantity;
  data.system.container = null;
  return data;
}

/** Keys Claude may change on the shop flag. */
const EDITABLE = new Set([
  "name", "open", "markup", "unlimited",
  "haggle.enabled", "haggle.skills", "haggle.dc", "haggle.discount", "haggle.critBonus", "haggle.failPenalty",
  "haggle.oncePerVisit",
  "generator.packs", "generator.category", "generator.count", "generator.minPrice", "generator.maxPrice",
  "generator.rarities", "generator.minQty", "generator.maxQty", "generator.priceVariance"
]);
const ARRAY_KEYS = ["haggle.skills", "generator.packs", "generator.rarities"];

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

const ACTIONS = {
  async status() {
    return {
      ...bridgeStatus(),
      world: game.world.title,
      system: `${game.system.id} ${game.system.version}`,
      core: game.version,
      shops: allShops().length,
      playersOnline: game.users.filter(u => u.active && !u.isGM).map(u => u.name)
    };
  },

  async listShops() {
    return allShops().map(a => serializeShop(a));
  },

  async getShop({ shop, buyer }) {
    const actor = findShop(shop);
    const buyerId = buyer ? findActor(buyer, characters()).id : null;
    return serializeShop(actor, { stock: true, buyerId });
  },

  async createShop({ name, displayName, img, open = false, markup, unlimited, haggle }) {
    if ( !name?.trim() ) throw new Error("A shop name is required.");
    const data = { name: name.trim(), type: "npc" };
    if ( img ) data.img = img;
    const actor = await Actor.implementation.create(data);
    await makeShop(actor);
    const changes = { open: !!open };
    if ( displayName ) changes.name = displayName;
    if ( markup !== undefined ) changes.markup = Number(markup);
    if ( unlimited !== undefined ) changes.unlimited = !!unlimited;
    if ( haggle && (typeof haggle === "object") ) changes.haggle = haggle;
    await updateShop(actor, changes);
    return serializeShop(actor);
  },

  async convertActor({ actor: ref }) {
    const actor = findActor(ref);
    if ( actor.type === "character" ) throw new Error("Player characters cannot be shops.");
    await makeShop(actor);
    return serializeShop(actor);
  },

  async removeShop({ shop }) {
    const actor = findShop(shop);
    await removeShop(actor);
    return { id: actor.id, name: actor.name, removed: true };
  },

  async updateShop({ shop, changes }) {
    const actor = findShop(shop);
    if ( !changes || (typeof changes !== "object") ) throw new Error("changes must be an object.");
    const flat = foundry.utils.flattenObject(changes);
    const accepted = {};
    for ( const [key, value] of Object.entries(flat) ) {
      const root = key.split(".").slice(0, 2).join(".");
      if ( !EDITABLE.has(key) && !EDITABLE.has(root) ) throw new Error(`"${key}" is not an editable shop setting.`);
      accepted[key] = value;
    }
    // Arrays must replace the stored value rather than merge into it.
    const updates = {};
    for ( const [key, value] of Object.entries(accepted) ) {
      const arrayKey = ARRAY_KEYS.find(k => key === k || key.startsWith(`${k}.`));
      if ( arrayKey ) {
        const [a, b] = arrayKey.split(".");
        updates[arrayKey] = Array.isArray(changes[arrayKey]) ? changes[arrayKey] : changes[a]?.[b];
      } else {
        updates[key] = value;
      }
    }
    await updateShop(actor, updates);
    return serializeShop(actor);
  },

  async setOpen({ shop, open = true }) {
    const actor = findShop(shop);
    await updateShop(actor, { open: !!open });
    return serializeShop(actor);
  },

  async showToPlayers({ shop, users = [] }) {
    const actor = findShop(shop);
    const userIds = (users ?? []).map(ref => {
      const user = game.users.get(ref) ?? game.users.find(u => u.name.toLowerCase() === String(ref).toLowerCase());
      if ( !user ) throw new Error(`No user matches "${ref}".`);
      return user.id;
    });
    await game.modules.get(MODULE_ID).api.showToPlayers(actor, userIds);
    return { ...serializeShop(actor), shownTo: userIds.length ? userIds.map(id => game.users.get(id).name) : "everyone" };
  },

  async listPacks() {
    const defaults = defaultPackIds();
    return itemPacks().map(p => ({ id: p.collection, label: p.metadata.label, default: defaults.includes(p.collection) }));
  },

  async searchItems({ query, packs, limit = 25 }) {
    if ( !query || (String(query).trim().length < 2) ) throw new Error("query must be at least 2 characters.");
    const results = await searchIndex(packs?.length ? packs : defaultPackIds(), String(query), Number(limit) || 25);
    return results.map(r => ({ uuid: r.uuid, name: r.name, type: r.type, rarity: r.rarity, price: formatCp(r.priceCp), pack: r.pack }));
  },

  async generateStock({ shop, replace = false, ...overrides }) {
    const actor = findShop(shop);
    const config = getShopConfig(actor);
    const options = foundry.utils.mergeObject(config.generator, overrides, { inplace: false, insertKeys: false });
    if ( !options.packs?.length ) options.packs = defaultPackIds();
    const stock = await generateStock(options);
    if ( !stock.length ) throw new Error("No compendium items match those filters.");
    if ( replace ) {
      const old = actor.items.filter(i => PHYSICAL_TYPES.includes(i.type));
      if ( old.length ) await actor.deleteEmbeddedDocuments("Item", old.map(i => i.id));
    }
    const created = await actor.createEmbeddedDocuments("Item", stock);
    const fresh = getShopConfig(actor);
    return { added: created.map(i => serializeItem(i, fresh)), stockCount: shopItems(actor).length };
  },

  async addItems({ shop, items }) {
    const actor = findShop(shop);
    if ( !Array.isArray(items) || !items.length ) throw new Error("items must be a non-empty array.");
    const configured = getShopConfig(actor).generator.packs;
    const packs = configured?.length ? configured : defaultPackIds();
    const toCreate = [];
    const updated = [];
    const missing = [];
    for ( const entry of items ) {
      const spec = (typeof entry === "string") ? { name: entry } : entry;
      const quantity = Math.max(1, Math.floor(Number(spec.quantity) || 1));
      let uuid = spec.uuid;
      if ( !uuid && spec.name ) {
        const q = spec.name.trim().toLowerCase();
        const hits = await searchIndex(packs, spec.name, 50);
        const hit = hits.find(h => h.name.toLowerCase() === q) ?? hits[0];
        uuid = hit?.uuid;
      }
      if ( !uuid ) { missing.push(spec.name ?? "(no name)"); continue; }
      const data = await itemDataFromUuid(uuid, quantity);
      if ( spec.price !== undefined ) {
        data.system.price = { value: Number(spec.price), denomination: spec.denomination || "gp" };
      }
      const existing = actor.items.find(i => (i.name === data.name) && (i.type === data.type));
      if ( existing && (spec.price === undefined) ) {
        await existing.update({ "system.quantity": (existing.system.quantity ?? 0) + quantity });
        updated.push(existing);
      } else {
        toCreate.push(data);
      }
    }
    const created = toCreate.length ? await actor.createEmbeddedDocuments("Item", toCreate) : [];
    const config = getShopConfig(actor);
    return {
      added: [...created, ...updated].map(i => serializeItem(i, config)),
      notFound: missing,
      stockCount: shopItems(actor).length
    };
  },

  async removeItems({ shop, items, quantity }) {
    const actor = findShop(shop);
    if ( !Array.isArray(items) || !items.length ) throw new Error("items must be a non-empty array of ids or names.");
    const removed = [];
    const missing = [];
    for ( const ref of items ) {
      const item = findStockItem(actor, ref);
      if ( !item ) { missing.push(ref); continue; }
      const qty = Math.floor(Number(quantity) || 0);
      const have = item.system.quantity ?? 1;
      if ( (qty > 0) && (qty < have) ) {
        await item.update({ "system.quantity": have - qty });
        removed.push({ name: item.name, removed: qty, remaining: have - qty });
      } else {
        await item.delete();
        removed.push({ name: item.name, removed: have, remaining: 0 });
      }
    }
    return { removed, notFound: missing, stockCount: shopItems(actor).length };
  },

  async clearStock({ shop }) {
    const actor = findShop(shop);
    const items = actor.items.filter(i => PHYSICAL_TYPES.includes(i.type));
    if ( items.length ) await actor.deleteEmbeddedDocuments("Item", items.map(i => i.id));
    return { removed: items.length };
  },

  async resetHaggles({ shop }) {
    const actor = findShop(shop);
    const visits = actor.getFlag(MODULE_ID, FLAG)?.visits ?? {};
    const deletions = {};
    for ( const id of Object.keys(visits) ) deletions[`flags.${MODULE_ID}.${FLAG}.visits.-=${id}`] = null;
    if ( Object.keys(deletions).length ) await actor.update(deletions);
    else await replaceShopKey(actor, "visits", {});
    return { reset: Object.keys(visits).length };
  },

  async listBuyers() {
    return characters().map(serializeBuyer);
  },

  async buy({ shop, buyer, item, quantity = 1 }) {
    const actor = findShop(shop);
    const buyerActor = findActor(buyer, characters());
    const stockItem = findStockItem(actor, item);
    if ( !stockItem ) throw new Error(`"${item}" is not for sale at ${shopName(actor)}.`);
    const result = await requestGM("buy", { shopId: actor.id, buyerId: buyerActor.id, itemId: stockItem.id, quantity });
    if ( !result.ok ) throw new Error(result.error ?? "Purchase failed.");
    return {
      ...result,
      price: formatCp(result.totalCp),
      buyerWealth: formatCp(actorWealthCp(buyerActor)),
      stockCount: shopItems(actor).length
    };
  },

  async recordHaggle({ shop, buyer, skill, total, isCritical = false, isFumble = false }) {
    const actor = findShop(shop);
    const buyerActor = findActor(buyer, characters());
    const result = await requestGM("haggle", { shopId: actor.id, buyerId: buyerActor.id, skill, total, isCritical, isFumble });
    if ( !result.ok ) throw new Error(result.error ?? "Haggle failed.");
    return result;
  },

  async openWindow({ shop, mode = "browser" }) {
    const actor = findShop(shop);
    const api = game.modules.get(MODULE_ID).api;
    if ( mode === "config" ) await api.configureShop(actor);
    else api.openShop(actor);
    return { opened: mode, shop: shopName(actor) };
  }
};

export const BRIDGE_ACTIONS = Object.keys(ACTIONS);

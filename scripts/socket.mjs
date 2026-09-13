import { MODULE_ID, SOCKET } from "./constants.mjs";
import { getShopConfig, getVisit, isShop, replaceShopKey, shopName } from "./shop-data.mjs";
import { actorWealthCp, addCp, deductCp, formatCp, unitPriceCp } from "./pricing.mjs";

const pending = new Map();
const TIMEOUT_MS = 20000;

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */

export function registerSocket() {
  game.socket.on(SOCKET, onSocketMessage);
}

async function onSocketMessage(msg) {
  switch ( msg?.type ) {
    case "request": {
      if ( game.user !== game.users.activeGM ) return;
      const result = await execute(msg.action, msg.data, msg.userId);
      game.socket.emit(SOCKET, { type: "response", id: msg.id, userId: msg.userId, result });
      break;
    }
    case "response": {
      if ( msg.userId !== game.user.id ) return;
      const entry = pending.get(msg.id);
      if ( !entry ) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg.result);
      break;
    }
    case "showShop": {
      if ( msg.userIds?.length && !msg.userIds.includes(game.user.id) ) return;
      if ( game.user.isGM ) return;
      const actor = game.actors.get(msg.actorId);
      if ( actor ) game.modules.get(MODULE_ID).api.openShop(actor);
      break;
    }
  }
}

/** Ask the active GM to run an action. GMs run it locally. Resolves to `{ ok, error?, ...data }`. */
export async function requestGM(action, data) {
  if ( game.user.isGM ) return execute(action, data, game.user.id);
  if ( !game.users.activeGM ) return { ok: false, error: game.i18n.localize("QUICKSHOP.Error.NoGM") };
  const id = foundry.utils.randomID();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: game.i18n.localize("QUICKSHOP.Error.Timeout") });
    }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    game.socket.emit(SOCKET, { type: "request", id, action, data, userId: game.user.id });
  });
}

/** Push the shop window to players. Empty `userIds` means everyone. */
export function showShopToPlayers(actor, userIds = []) {
  game.socket.emit(SOCKET, { type: "showShop", actorId: actor.id, userIds });
}

/* -------------------------------------------- */
/*  GM-side handlers                            */
/* -------------------------------------------- */

async function execute(action, data, userId) {
  try {
    switch ( action ) {
      case "buy": return await handleBuy(data, userId);
      case "haggle": return await handleHaggle(data, userId);
      default: return { ok: false, error: `Unknown action ${action}` };
    }
  } catch ( err ) {
    console.error(`${MODULE_ID} | ${action} failed`, err);
    return { ok: false, error: err.message };
  }
}

function resolveParties(data, userId) {
  const shop = game.actors.get(data.shopId);
  const buyer = game.actors.get(data.buyerId);
  const user = game.users.get(userId);
  if ( !shop || !isShop(shop) ) throw new Error(game.i18n.localize("QUICKSHOP.Error.NoShop"));
  if ( !buyer ) throw new Error(game.i18n.localize("QUICKSHOP.Error.NoBuyer"));
  if ( !user?.isGM && !buyer.testUserPermission(user, "OWNER") ) {
    throw new Error(game.i18n.localize("QUICKSHOP.Error.NotOwner"));
  }
  const config = getShopConfig(shop);
  if ( !config.open && !user?.isGM ) throw new Error(game.i18n.localize("QUICKSHOP.Error.Closed"));
  return { shop, buyer, user, config };
}

async function handleBuy(data, userId) {
  const { shop, buyer, config } = resolveParties(data, userId);
  const item = shop.items.get(data.itemId);
  if ( !item ) throw new Error(game.i18n.localize("QUICKSHOP.Error.NoItem"));

  const quantity = Math.max(1, Math.floor(Number(data.quantity) || 1));
  const available = item.system.quantity ?? 1;
  if ( !config.unlimited && (quantity > available) ) {
    throw new Error(game.i18n.format("QUICKSHOP.Error.NotEnoughStock", { name: item.name, available }));
  }

  const visit = getVisit(config, buyer.id);
  const unit = unitPriceCp(item, config, visit);
  const total = unit * quantity;
  if ( actorWealthCp(buyer) < total ) {
    throw new Error(game.i18n.format("QUICKSHOP.Error.InsufficientFunds", { name: buyer.name }));
  }

  // Take the money first, then hand over the goods.
  await deductCp(buyer, total);
  await addCp(shop, total);

  const existing = (item.type !== "container") ? buyer.items.find(i =>
    (i.type === item.type) && (i.name === item.name) && !i.system.container
    && (i.system.price?.value === item.system.price?.value)
  ) : null;
  if ( existing ) {
    await existing.update({ "system.quantity": (existing.system.quantity ?? 0) + quantity });
  } else {
    const itemData = item.toObject();
    delete itemData._id;
    delete itemData.folder;
    delete itemData.sort;
    foundry.utils.setProperty(itemData, "system.quantity", quantity);
    foundry.utils.setProperty(itemData, "system.container", null);
    if ( "equipped" in (itemData.system ?? {}) ) itemData.system.equipped = false;
    if ( "attuned" in (itemData.system ?? {}) ) itemData.system.attuned = false;
    await Item.implementation.create(itemData, { parent: buyer });
  }

  if ( !config.unlimited ) {
    const remaining = available - quantity;
    if ( remaining <= 0 ) await item.delete();
    else await item.update({ "system.quantity": remaining });
  }

  await ChatMessage.implementation.create({
    speaker: ChatMessage.implementation.getSpeaker({ actor: buyer }),
    content: `<div class="quick-shop-chat">
      <img src="${item.img}" alt="${foundry.utils.escapeHTML(item.name)}">
      <p>${game.i18n.format("QUICKSHOP.Chat.Bought", {
        buyer: foundry.utils.escapeHTML(buyer.name),
        quantity,
        item: foundry.utils.escapeHTML(item.name),
        shop: foundry.utils.escapeHTML(shopName(shop)),
        price: formatCp(total)
      })}</p>
    </div>`
  });

  return { ok: true, totalCp: total, item: item.name, quantity };
}

async function handleHaggle(data, userId) {
  const { shop, buyer, config } = resolveParties(data, userId);
  const haggle = config.haggle;
  if ( !haggle.enabled ) throw new Error(game.i18n.localize("QUICKSHOP.Error.HaggleDisabled"));
  const prior = getVisit(config, buyer.id);
  if ( prior?.rolled && haggle.oncePerVisit ) throw new Error(game.i18n.localize("QUICKSHOP.Error.AlreadyHaggled"));
  if ( !haggle.skills.includes(data.skill) ) throw new Error(game.i18n.localize("QUICKSHOP.Error.SkillNotAllowed"));

  const total = Number(data.total) || 0;
  const dc = Number(haggle.dc) || 10;
  let modifier = 0;
  let outcome;
  if ( data.isCritical ) {
    modifier = Number(haggle.discount) + Number(haggle.critBonus);
    outcome = "Critical";
  } else if ( total >= dc ) {
    modifier = Number(haggle.discount);
    outcome = "Success";
  } else if ( data.isFumble || (total <= dc - 5) ) {
    modifier = -Number(haggle.failPenalty);
    outcome = "BadFailure";
  } else {
    modifier = 0;
    outcome = "Failure";
  }
  modifier = Math.clamp ? Math.clamp(modifier, -100, 90) : Math.min(90, Math.max(-100, modifier));

  const visits = foundry.utils.deepClone(config.visits ?? {});
  visits[buyer.id] = { rolled: true, modifier, total, skill: data.skill, outcome, at: Date.now() };
  await replaceShopKey(shop, "visits", visits);

  const skillLabel = CONFIG.DND5E.skills[data.skill]?.label ?? data.skill;
  await ChatMessage.implementation.create({
    speaker: ChatMessage.implementation.getSpeaker({ actor: buyer }),
    content: `<div class="quick-shop-chat"><p>${game.i18n.format(`QUICKSHOP.Chat.Haggle${outcome}`, {
      buyer: foundry.utils.escapeHTML(buyer.name),
      shop: foundry.utils.escapeHTML(shopName(shop)),
      skill: skillLabel,
      total,
      dc,
      percent: Math.abs(modifier)
    })}</p></div>`
  });

  return { ok: true, modifier, outcome };
}

import { DEFAULT_SHOP, FLAG, MODULE_ID, PHYSICAL_TYPES } from "./constants.mjs";

/** Full, defaulted shop configuration for an actor. */
export function getShopConfig(actor) {
  const stored = actor?.getFlag(MODULE_ID, FLAG) ?? {};
  return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_SHOP), stored, { inplace: false });
}

export function isShop(actor) {
  return !!actor?.getFlag(MODULE_ID, FLAG)?.isShop;
}

export function shopName(actor) {
  const custom = actor?.getFlag(MODULE_ID, FLAG)?.name?.trim();
  return custom || actor?.name || "";
}

/** Merge partial changes into the shop flag. Keys may use dot notation, e.g. "haggle.dc". */
export async function updateShop(actor, changes) {
  const updates = {};
  for ( const [key, value] of Object.entries(foundry.utils.flattenObject(changes)) ) {
    updates[`flags.${MODULE_ID}.${FLAG}.${key}`] = value;
  }
  return actor.update(updates);
}

/** Replace a whole sub-object of the shop flag (arrays and maps do not merge well). */
export async function replaceShopKey(actor, key, value) {
  return actor.update({ [`flags.${MODULE_ID}.${FLAG}.${key}`]: value });
}

export async function makeShop(actor) {
  if ( isShop(actor) ) return actor;
  const data = foundry.utils.deepClone(DEFAULT_SHOP);
  data.generator.packs = defaultPackIds();
  await actor.update({ [`flags.${MODULE_ID}.${FLAG}`]: data });
  return actor;
}

export async function removeShop(actor) {
  return actor.update({ [`flags.${MODULE_ID}.-=${FLAG}`]: null });
}

/** All actors flagged as shops in the world. */
export function allShops() {
  return game.actors.filter(a => isShop(a));
}

/** Items currently for sale in a shop. */
export function shopItems(actor) {
  const unlimited = !!actor.getFlag(MODULE_ID, FLAG)?.unlimited;
  return actor.items.filter(i => {
    if ( !PHYSICAL_TYPES.includes(i.type) ) return false;
    if ( i.system.container ) return false;
    const qty = i.system.quantity ?? 1;
    return unlimited || qty > 0;
  }).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

export function getVisit(config, buyerId) {
  return config.visits?.[buyerId] ?? null;
}

/** Item compendium packs that look like equipment sources. */
export function defaultPackIds() {
  const packs = game.packs.filter(p => p.documentName === "Item");
  const preferred = packs.filter(p => /item|equipment|tradegood|gear|magic/i.test(p.metadata.name)
    && !/feature|class|spell|race|origin|background|feat/i.test(p.metadata.name));
  return (preferred.length ? preferred : packs).map(p => p.collection);
}

/** Character actors the given user owns and may shop with. */
export function eligibleBuyers(user = game.user) {
  const actors = game.actors.filter(a => (a.type === "character") && a.testUserPermission(user, "OWNER"));
  return actors.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

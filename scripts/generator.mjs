import { PHYSICAL_TYPES } from "./constants.mjs";
import { gpToCp, toCp } from "./pricing.mjs";

const INDEX_FIELDS = ["type", "img", "system.price", "system.rarity", "system.type", "system.quantity"];
const cache = new Map();

/** Item compendium packs available in this world. */
export function itemPacks() {
  return game.packs.filter(p => p.documentName === "Item")
    .sort((a, b) => a.metadata.label.localeCompare(b.metadata.label, game.i18n.lang));
}

/**
 * Build a searchable index of physical items across the given packs.
 * @param {string[]} packIds  Collection ids such as "dnd5e.items".
 * @returns {Promise<object[]>}
 */
export async function buildIndex(packIds) {
  const entries = [];
  for ( const id of packIds ) {
    const pack = game.packs.get(id);
    if ( !pack || (pack.documentName !== "Item") ) continue;
    let index = cache.get(id);
    if ( !index ) {
      index = await pack.getIndex({ fields: INDEX_FIELDS });
      cache.set(id, index);
    }
    for ( const entry of index ) {
      if ( !PHYSICAL_TYPES.includes(entry.type) ) continue;
      const price = entry.system?.price ?? {};
      entries.push({
        uuid: entry.uuid,
        name: entry.name,
        img: entry.img,
        type: entry.type,
        subtype: entry.system?.type?.value ?? "",
        rarity: entry.system?.rarity ?? "",
        priceCp: toCp(price.value ?? 0, price.denomination || "gp"),
        pack: pack.metadata.label
      });
    }
  }
  return entries;
}

/** Whether an index entry belongs to a generator category. */
export function matchesCategory(entry, category) {
  const armorTypes = new Set(Object.keys(CONFIG.DND5E.armorTypes ?? {}));
  switch ( category ) {
    case "weapon": return entry.type === "weapon";
    case "armor": return (entry.type === "equipment") && armorTypes.has(entry.subtype);
    case "gear": return ((entry.type === "equipment") && !armorTypes.has(entry.subtype))
      || (entry.type === "loot") || (entry.type === "container");
    case "consumable": return entry.type === "consumable";
    case "tool": return entry.type === "tool";
    case "magic": return !!entry.rarity && (entry.rarity !== "common");
    default: return true;
  }
}

/**
 * Pick random stock for a shop.
 * @param {object} options  Generator options stored on the shop (see DEFAULT_SHOP.generator).
 * @returns {Promise<object[]>}  Item data ready for createEmbeddedDocuments.
 */
export async function generateStock(options) {
  const packIds = options.packs?.length ? options.packs : itemPacks().map(p => p.collection);
  const index = await buildIndex(packIds);
  const minCp = gpToCp(options.minPrice ?? 0);
  const maxCp = gpToCp(options.maxPrice ?? Infinity);
  const rarities = new Set(options.rarities ?? []);
  const useRarity = (options.category !== "magic") && rarities.size;

  const seen = new Set();
  const candidates = index.filter(e => {
    if ( seen.has(e.name) ) return false;
    if ( !matchesCategory(e, options.category) ) return false;
    if ( (e.priceCp < minCp) || (e.priceCp > maxCp) ) return false;
    if ( useRarity && !rarities.has(e.rarity) ) return false;
    if ( (options.category === "magic") && rarities.size && !rarities.has(e.rarity) ) return false;
    seen.add(e.name);
    return true;
  });

  shuffle(candidates);
  const picks = candidates.slice(0, Math.max(0, Math.floor(Number(options.count) || 0)));
  const minQty = Math.max(1, Math.floor(Number(options.minQty) || 1));
  const maxQty = Math.max(minQty, Math.floor(Number(options.maxQty) || minQty));
  const variance = Math.max(0, Number(options.priceVariance) || 0) / 100;

  const results = [];
  for ( const pick of picks ) {
    const doc = await foundry.utils.fromUuid(pick.uuid);
    if ( !doc ) continue;
    const data = doc.toObject();
    delete data._id;
    delete data.folder;
    delete data.sort;
    data.system.quantity = randomInt(minQty, maxQty);
    data.system.container = null;
    if ( variance && data.system.price?.value ) {
      const factor = 1 + ((Math.random() * 2 - 1) * variance);
      data.system.price.value = roundPrice(data.system.price.value * factor);
    }
    results.push(data);
  }
  return results;
}

/** Search the index by name for the quick-add box. */
export async function searchIndex(packIds, query, limit = 25) {
  const q = query.trim().toLowerCase();
  if ( q.length < 2 ) return [];
  const index = await buildIndex(packIds?.length ? packIds : itemPacks().map(p => p.collection));
  const seen = new Set();
  return index.filter(e => {
    if ( !e.name.toLowerCase().includes(q) ) return false;
    const key = `${e.name}|${e.priceCp}`;
    if ( seen.has(key) ) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang)).slice(0, limit);
}

export function clearIndexCache() {
  cache.clear();
}

function shuffle(array) {
  for ( let i = array.length - 1; i > 0; i-- ) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function roundPrice(value) {
  if ( value >= 100 ) return Math.round(value);
  if ( value >= 10 ) return Math.round(value * 2) / 2;
  return Math.round(value * 10) / 10;
}

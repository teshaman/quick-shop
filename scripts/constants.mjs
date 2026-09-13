export const MODULE_ID = "quick-shop";
export const FLAG = "shop";
export const SOCKET = `module.${MODULE_ID}`;
export const TEMPLATES = `modules/${MODULE_ID}/templates`;

/** Item types that can sit in a shop's stock. */
export const PHYSICAL_TYPES = ["weapon", "equipment", "consumable", "tool", "loot", "container"];

/** Skills a shop may allow for haggling. */
export const HAGGLE_SKILLS = ["per", "dec", "itm"];

/** Stock generator categories. */
export const CATEGORIES = {
  any: "QUICKSHOP.Category.Any",
  weapon: "QUICKSHOP.Category.Weapon",
  armor: "QUICKSHOP.Category.Armor",
  gear: "QUICKSHOP.Category.Gear",
  consumable: "QUICKSHOP.Category.Consumable",
  tool: "QUICKSHOP.Category.Tool",
  magic: "QUICKSHOP.Category.Magic"
};

/** Rarity keys offered by the generator. "" means mundane (no rarity). */
export const RARITIES = ["", "common", "uncommon", "rare", "veryRare", "legendary"];

/** Default shop flag data. */
export const DEFAULT_SHOP = {
  isShop: true,
  name: "",
  open: false,
  markup: 100,
  unlimited: false,
  haggle: {
    enabled: true,
    skills: ["per", "dec", "itm"],
    dc: 15,
    discount: 10,
    critBonus: 10,
    failPenalty: 5,
    oncePerVisit: true
  },
  visits: {},
  generator: {
    packs: [],
    category: "any",
    count: 10,
    minPrice: 0,
    maxPrice: 100,
    rarities: ["", "common"],
    minQty: 1,
    maxQty: 1,
    priceVariance: 0
  }
};

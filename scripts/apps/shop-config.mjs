import { CATEGORIES, HAGGLE_SKILLS, MODULE_ID, PHYSICAL_TYPES, RARITIES, TEMPLATES } from "../constants.mjs";
import { getShopConfig, removeShop, replaceShopKey, shopItems, shopName, updateShop } from "../shop-data.mjs";
import { formatCp, itemBaseCp, unitPriceCp } from "../pricing.mjs";
import { generateStock, itemPacks, searchIndex } from "../generator.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const OPEN = new Map();

export class ShopConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.searchResults = [];
    this.searchQuery = "";
    this.generating = false;
  }

  static DEFAULT_OPTIONS = {
    id: "quick-shop-config-{id}",
    classes: ["quick-shop", "shop-config"],
    tag: "form",
    window: { icon: "fa-solid fa-shop", resizable: true },
    position: { width: 720, height: 760 },
    form: { handler: ShopConfig.#onSubmit, submitOnChange: true, closeOnSubmit: false },
    actions: {
      preview: ShopConfig.#onPreview,
      showPlayers: ShopConfig.#onShowPlayers,
      openSheet: ShopConfig.#onOpenSheet,
      generate: ShopConfig.#onGenerate,
      clearStock: ShopConfig.#onClearStock,
      removeItem: ShopConfig.#onRemoveItem,
      addResult: ShopConfig.#onAddResult,
      resetHaggles: ShopConfig.#onResetHaggles,
      unmark: ShopConfig.#onUnmark
    }
  };

  static PARTS = {
    main: { template: `${TEMPLATES}/shop-config.hbs`, scrollable: [".config-body"] }
  };

  /* -------------------------------------------- */

  static open(actor) {
    let app = OPEN.get(actor.id);
    if ( !app ) {
      app = new ShopConfig(actor);
      OPEN.set(actor.id, app);
    }
    return app.render({ force: true });
  }

  static refresh(actorId = null) {
    for ( const app of OPEN.values() ) {
      if ( app.rendered && (!actorId || (app.actor.id === actorId)) ) app.render();
    }
  }

  get title() {
    return game.i18n.format("QUICKSHOP.Config.Title", { name: shopName(this.actor) });
  }

  /* -------------------------------------------- */

  async _prepareContext(options) {
    const config = getShopConfig(this.actor);
    const items = shopItems(this.actor).map(item => ({
      id: item.id,
      name: item.name,
      img: item.img,
      quantity: item.system.quantity ?? 1,
      basePrice: formatCp(itemBaseCp(item)),
      salePrice: formatCp(unitPriceCp(item, config)),
      rarity: item.system.rarity ? (CONFIG.DND5E.itemRarity[item.system.rarity] ?? item.system.rarity) : ""
    }));

    const selectedPacks = config.generator.packs ?? [];
    const packs = itemPacks().map(p => ({
      id: p.collection,
      label: `${p.metadata.label} (${p.metadata.packageName})`,
      selected: selectedPacks.includes(p.collection)
    }));
    const visits = Object.entries(config.visits ?? {}).map(([id, v]) => ({
      name: game.actors.get(id)?.name ?? id,
      modifier: v.modifier,
      outcome: game.i18n.localize(`QUICKSHOP.Outcome.${v.outcome ?? "Failure"}`)
    }));

    return {
      actor: this.actor,
      name: config.name,
      actorName: this.actor.name,
      img: this.actor.img,
      open: config.open,
      unlimited: config.unlimited,
      markup: config.markup,
      haggle: {
        ...config.haggle,
        skillOptions: HAGGLE_SKILLS.map(key => ({
          key, label: CONFIG.DND5E.skills[key]?.label ?? key, checked: config.haggle.skills.includes(key)
        }))
      },
      visits,
      items,
      itemCount: items.length,
      generator: {
        ...config.generator,
        categories: Object.entries(CATEGORIES).map(([key, label]) => ({ key, label, selected: key === config.generator.category })),
        rarityOptions: RARITIES.map(key => ({
          key: key || "mundane",
          label: key ? (CONFIG.DND5E.itemRarity[key] ?? key) : game.i18n.localize("QUICKSHOP.Rarity.Mundane"),
          checked: config.generator.rarities.includes(key)
        })),
        packs,
        selectedPacks: config.generator.packs ?? []
      },
      searchQuery: this.searchQuery,
      searchResults: this.searchResults.map(r => ({ ...r, price: formatCp(r.priceCp) })),
      generating: this.generating
    };
  }

  /* -------------------------------------------- */

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;

    const search = root.querySelector('[name="search"]');
    search?.addEventListener("input", ev => {
      this.searchQuery = ev.currentTarget.value;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this.#runSearch(), 250);
    });
    search?.addEventListener("keydown", ev => {
      if ( ev.key === "Enter" ) ev.preventDefault();
    });

    for ( const input of root.querySelectorAll("input[data-stock-qty]") ) {
      input.addEventListener("change", async ev => {
        ev.stopPropagation();
        const item = this.actor.items.get(ev.currentTarget.dataset.stockQty);
        const qty = Math.max(0, Math.floor(Number(ev.currentTarget.value) || 0));
        if ( item ) await item.update({ "system.quantity": qty });
      });
    }
  }

  async _onClose(options) {
    super._onClose?.(options);
    OPEN.delete(this.actor.id);
  }

  async #runSearch() {
    const config = getShopConfig(this.actor);
    this.searchResults = await searchIndex(config.generator.packs, this.searchQuery);
    const list = this.element.querySelector(".search-results");
    if ( !list ) return;
    list.innerHTML = this.searchResults.map(r => `
      <li>
        <img src="${r.img}" alt="">
        <span class="name">${foundry.utils.escapeHTML(r.name)}</span>
        <span class="meta">${formatCp(r.priceCp)} · ${foundry.utils.escapeHTML(r.pack)}</span>
        <button type="button" data-action="addResult" data-uuid="${r.uuid}" title="${game.i18n.localize("QUICKSHOP.Config.AddItem")}">
          <i class="fa-solid fa-plus"></i>
        </button>
      </li>`).join("");
    list.hidden = this.searchResults.length === 0;
  }

  /* -------------------------------------------- */
  /*  Form                                        */
  /* -------------------------------------------- */

  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    const skills = HAGGLE_SKILLS.filter(key => data[`haggle.skills.${key}`]);
    const rarities = RARITIES.filter(key => data[`generator.rarities.${key || "mundane"}`]);
    let packs = data["generator.packs"] ?? [];
    if ( !Array.isArray(packs) ) packs = packs ? [packs] : [];

    const changes = {
      name: data.name ?? "",
      open: !!data.open,
      unlimited: !!data.unlimited,
      markup: Math.max(0, Number(data.markup) || 100),
      haggle: {
        enabled: !!data["haggle.enabled"],
        dc: Math.max(1, Number(data["haggle.dc"]) || 15),
        discount: Math.max(0, Number(data["haggle.discount"]) || 0),
        critBonus: Math.max(0, Number(data["haggle.critBonus"]) || 0),
        failPenalty: Math.max(0, Number(data["haggle.failPenalty"]) || 0),
        oncePerVisit: !!data["haggle.oncePerVisit"]
      },
      generator: {
        category: data["generator.category"] ?? "any",
        count: Math.max(1, Number(data["generator.count"]) || 10),
        minPrice: Math.max(0, Number(data["generator.minPrice"]) || 0),
        maxPrice: Math.max(0, Number(data["generator.maxPrice"]) || 0),
        minQty: Math.max(1, Number(data["generator.minQty"]) || 1),
        maxQty: Math.max(1, Number(data["generator.maxQty"]) || 1),
        priceVariance: Math.max(0, Number(data["generator.priceVariance"]) || 0)
      }
    };
    // Arrays are written by full path so they replace rather than merge.
    changes.haggle.skills = skills;
    changes.generator.rarities = rarities;
    changes.generator.packs = packs;
    await updateShop(this.actor, changes);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #onPreview() {
    game.modules.get(MODULE_ID).api.openShop(this.actor);
  }

  static async #onShowPlayers() {
    await game.modules.get(MODULE_ID).api.showToPlayers(this.actor);
  }

  static #onOpenSheet() {
    this.actor.sheet.render(true);
  }

  static async #onGenerate(event, target) {
    if ( this.generating ) return;
    this.generating = true;
    target.disabled = true;
    try {
      const config = getShopConfig(this.actor);
      const stock = await generateStock(config.generator);
      if ( !stock.length ) {
        ui.notifications.warn(game.i18n.localize("QUICKSHOP.Config.NothingGenerated"));
        return;
      }
      await this.actor.createEmbeddedDocuments("Item", stock);
      ui.notifications.info(game.i18n.format("QUICKSHOP.Config.Generated", { count: stock.length }));
    } catch ( err ) {
      console.error(`${MODULE_ID} | stock generation failed`, err);
      ui.notifications.error(err.message);
    } finally {
      this.generating = false;
      target.disabled = false;
      this.render();
    }
  }

  static async #onClearStock() {
    const items = this.actor.items.filter(i => PHYSICAL_TYPES.includes(i.type));
    if ( !items.length ) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("QUICKSHOP.Config.ClearStock") },
      content: `<p>${game.i18n.format("QUICKSHOP.Config.ClearStockConfirm", { count: items.length })}</p>`,
      rejectClose: false,
      modal: true
    });
    if ( !confirmed ) return;
    await this.actor.deleteEmbeddedDocuments("Item", items.map(i => i.id));
  }

  static async #onRemoveItem(event, target) {
    const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    if ( item ) await item.delete();
  }

  static async #onAddResult(event, target) {
    const doc = await foundry.utils.fromUuid(target.dataset.uuid);
    if ( !doc ) return;
    const existing = this.actor.items.find(i => (i.name === doc.name) && (i.type === doc.type));
    if ( existing ) {
      await existing.update({ "system.quantity": (existing.system.quantity ?? 0) + 1 });
    } else {
      const data = doc.toObject();
      delete data._id;
      delete data.folder;
      delete data.sort;
      data.system.quantity = 1;
      data.system.container = null;
      await this.actor.createEmbeddedDocuments("Item", [data]);
    }
    ui.notifications.info(game.i18n.format("QUICKSHOP.Config.Added", { name: doc.name }));
  }

  static async #onResetHaggles() {
    await replaceShopKey(this.actor, "visits", {});
    // Flags keep deleted keys unless removed explicitly, so wipe with a deletion key as well.
    const visits = this.actor.getFlag(MODULE_ID, "shop")?.visits ?? {};
    const deletions = {};
    for ( const id of Object.keys(visits) ) deletions[`flags.${MODULE_ID}.shop.visits.-=${id}`] = null;
    if ( Object.keys(deletions).length ) await this.actor.update(deletions);
  }

  static async #onUnmark() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("QUICKSHOP.Config.Unmark") },
      content: `<p>${game.i18n.localize("QUICKSHOP.Config.UnmarkConfirm")}</p>`,
      rejectClose: false,
      modal: true
    });
    if ( !confirmed ) return;
    await removeShop(this.actor);
    this.close();
  }
}

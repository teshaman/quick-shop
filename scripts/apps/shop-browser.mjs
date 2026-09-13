import { HAGGLE_SKILLS, MODULE_ID, TEMPLATES } from "../constants.mjs";
import { eligibleBuyers, getShopConfig, getVisit, shopItems, shopName, updateShop } from "../shop-data.mjs";
import { actorWealthCp, formatCp, itemBaseCp, unitPriceCp } from "../pricing.mjs";
import { requestGM } from "../socket.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Registry of open browsers keyed by actor id so each shop has at most one window per client. */
const OPEN = new Map();

export class ShopBrowser extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.buyerId = ShopBrowser.#defaultBuyerId();
    this.skill = null;
    this.search = "";
    this.expanded = new Set();
  }

  static DEFAULT_OPTIONS = {
    id: "quick-shop-browser-{id}",
    classes: ["quick-shop", "shop-browser"],
    tag: "div",
    window: { icon: "fa-solid fa-store", resizable: true },
    position: { width: 680, height: 620 },
    actions: {
      buy: ShopBrowser.#onBuy,
      haggle: ShopBrowser.#onHaggle,
      toggleDetails: ShopBrowser.#onToggleDetails,
      toggleOpen: ShopBrowser.#onToggleOpen,
      showPlayers: ShopBrowser.#onShowPlayers,
      configure: ShopBrowser.#onConfigure,
      openSheet: ShopBrowser.#onOpenSheet
    }
  };

  static PARTS = {
    main: { template: `${TEMPLATES}/shop-browser.hbs`, scrollable: [".stock-list"] }
  };

  /* -------------------------------------------- */

  /** Open (or focus) the browser for a shop actor. */
  static open(actor) {
    let app = OPEN.get(actor.id);
    if ( !app ) {
      app = new ShopBrowser(actor);
      OPEN.set(actor.id, app);
    }
    return app.render({ force: true });
  }

  /** Re-render every open browser, or only those touching the given actor. */
  static refresh(actorId = null) {
    for ( const app of OPEN.values() ) {
      if ( !app.rendered ) continue;
      if ( !actorId || (app.actor.id === actorId) || (app.buyerId === actorId) ) app.render();
    }
  }

  static #defaultBuyerId() {
    const buyers = eligibleBuyers();
    const own = game.user.character;
    if ( own && buyers.some(b => b.id === own.id) ) return own.id;
    return buyers[0]?.id ?? null;
  }

  /* -------------------------------------------- */

  get title() {
    return shopName(this.actor);
  }

  get buyer() {
    return this.buyerId ? game.actors.get(this.buyerId) : null;
  }

  /* -------------------------------------------- */

  async _prepareContext(options) {
    const config = getShopConfig(this.actor);
    const isGM = game.user.isGM;
    const buyers = eligibleBuyers();
    if ( this.buyerId && !buyers.some(b => b.id === this.buyerId) ) this.buyerId = buyers[0]?.id ?? null;
    const buyer = this.buyer;
    const visit = buyer ? getVisit(config, buyer.id) : null;
    const wealth = buyer ? actorWealthCp(buyer) : 0;

    const skills = config.haggle.skills.filter(s => HAGGLE_SKILLS.includes(s)).map(key => ({
      key, label: CONFIG.DND5E.skills[key]?.label ?? key
    }));
    if ( !this.skill || !skills.some(s => s.key === this.skill) ) this.skill = skills[0]?.key ?? null;

    const canBuy = !!buyer && (config.open || isGM);
    const query = this.search.trim().toLowerCase();
    const items = [];
    for ( const item of shopItems(this.actor) ) {
      if ( query && !item.name.toLowerCase().includes(query) ) continue;
      const unit = unitPriceCp(item, config, visit);
      const base = itemBaseCp(item);
      const qty = item.system.quantity ?? 1;
      const expanded = this.expanded.has(item.id);
      items.push({
        id: item.id,
        name: item.name,
        img: item.img,
        typeLabel: CONFIG.Item.typeLabels?.[item.type] ? game.i18n.localize(CONFIG.Item.typeLabels[item.type]) : item.type,
        rarity: item.system.rarity ? (CONFIG.DND5E.itemRarity[item.system.rarity] ?? item.system.rarity) : "",
        quantity: config.unlimited ? "∞" : qty,
        maxQty: config.unlimited ? 999 : qty,
        price: formatCp(unit),
        basePrice: formatCp(base),
        discounted: unit !== base,
        cheaper: unit < base,
        canAfford: canBuy && (wealth >= unit),
        canBuy,
        expanded,
        description: expanded ? await this.#enrich(item) : ""
      });
    }

    return {
      actor: this.actor,
      name: shopName(this.actor),
      img: this.actor.img,
      isGM,
      open: config.open,
      unlimited: config.unlimited,
      markup: config.markup,
      buyers: buyers.map(b => ({ id: b.id, name: b.name, selected: b.id === this.buyerId })),
      hasBuyers: buyers.length > 0,
      buyer,
      wealth: formatCp(wealth),
      haggle: {
        enabled: config.haggle.enabled,
        skills,
        skill: this.skill,
        canRoll: !!buyer && config.haggle.enabled && (config.open || isGM) && !(visit?.rolled && config.haggle.oncePerVisit),
        visit,
        modifierLabel: this.#modifierLabel(visit),
        dc: config.haggle.dc
      },
      search: this.search,
      items,
      empty: items.length === 0,
      totalStock: shopItems(this.actor).length
    };
  }

  #modifierLabel(visit) {
    if ( !visit?.rolled ) return "";
    const m = Number(visit.modifier) || 0;
    if ( m > 0 ) return game.i18n.format("QUICKSHOP.Browser.Discount", { percent: m });
    if ( m < 0 ) return game.i18n.format("QUICKSHOP.Browser.Surcharge", { percent: Math.abs(m) });
    return game.i18n.localize("QUICKSHOP.Browser.NoDiscount");
  }

  async #enrich(item) {
    const raw = item.system.description?.value ?? "";
    const Editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    try {
      return await Editor.enrichHTML(raw, { relativeTo: item, secrets: false, rollData: item.getRollData?.() ?? {} });
    } catch {
      return raw;
    }
  }

  /* -------------------------------------------- */

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    root.querySelector('[name="buyer"]')?.addEventListener("change", ev => {
      this.buyerId = ev.currentTarget.value || null;
      this.render();
    });
    root.querySelector('[name="skill"]')?.addEventListener("change", ev => {
      this.skill = ev.currentTarget.value;
    });
    const search = root.querySelector('[name="search"]');
    search?.addEventListener("input", ev => {
      this.search = ev.currentTarget.value;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this.render(), 200);
    });
  }

  async _onClose(options) {
    super._onClose?.(options);
    OPEN.delete(this.actor.id);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onBuy(event, target) {
    const itemId = target.dataset.itemId;
    const item = this.actor.items.get(itemId);
    const buyer = this.buyer;
    if ( !item || !buyer ) return;
    const input = this.element.querySelector(`input[data-qty-for="${itemId}"]`);
    const quantity = Math.max(1, Math.floor(Number(input?.value) || 1));
    const config = getShopConfig(this.actor);
    const total = unitPriceCp(item, config, getVisit(config, buyer.id)) * quantity;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("QUICKSHOP.Browser.ConfirmTitle") },
      content: `<p>${game.i18n.format("QUICKSHOP.Browser.ConfirmBody", {
        quantity, item: foundry.utils.escapeHTML(item.name), price: formatCp(total), buyer: foundry.utils.escapeHTML(buyer.name)
      })}</p>`,
      rejectClose: false,
      modal: true
    });
    if ( !confirmed ) return;

    target.disabled = true;
    const result = await requestGM("buy", { shopId: this.actor.id, buyerId: buyer.id, itemId, quantity });
    target.disabled = false;
    if ( result?.ok ) {
      ui.notifications.info(game.i18n.format("QUICKSHOP.Browser.Purchased", {
        quantity: result.quantity, item: result.item, price: formatCp(result.totalCp)
      }));
    } else {
      ui.notifications.warn(result?.error ?? game.i18n.localize("QUICKSHOP.Error.Unknown"));
    }
    this.render();
  }

  static async #onHaggle(event, target) {
    const buyer = this.buyer;
    if ( !buyer ) return;
    const config = getShopConfig(this.actor);
    const skill = this.skill ?? config.haggle.skills[0];
    if ( !skill ) return;

    const rolls = await buyer.rollSkill({ skill }, {}, {
      data: { flags: { [MODULE_ID]: { haggle: { shopId: this.actor.id } } } }
    });
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if ( !roll ) return;
    const d20 = roll.dice?.find(d => d.faces === 20);
    const natural = d20?.total ?? d20?.results?.find(r => r.active)?.result;
    const isCritical = roll.isCriticalSuccess ?? (natural === 20);
    const isFumble = roll.isCriticalFailure ?? (natural === 1);

    const result = await requestGM("haggle", {
      shopId: this.actor.id, buyerId: buyer.id, skill, total: roll.total, isCritical: !!isCritical, isFumble: !!isFumble
    });
    if ( !result?.ok ) ui.notifications.warn(result?.error ?? game.i18n.localize("QUICKSHOP.Error.Unknown"));
    this.render();
  }

  static #onToggleDetails(event, target) {
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    if ( !id ) return;
    if ( this.expanded.has(id) ) this.expanded.delete(id);
    else this.expanded.add(id);
    this.render();
  }

  static async #onToggleOpen() {
    if ( !game.user.isGM ) return;
    const config = getShopConfig(this.actor);
    await updateShop(this.actor, { open: !config.open });
  }

  static async #onShowPlayers() {
    if ( !game.user.isGM ) return;
    await game.modules.get(MODULE_ID).api.showToPlayers(this.actor);
  }

  static #onConfigure() {
    if ( !game.user.isGM ) return;
    game.modules.get(MODULE_ID).api.configureShop(this.actor);
  }

  static #onOpenSheet() {
    if ( !this.actor.testUserPermission(game.user, "LIMITED") ) return;
    this.actor.sheet.render(true);
  }
}

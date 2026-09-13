import { MODULE_ID, TEMPLATES } from "../constants.mjs";
import { allShops, getShopConfig, isShop, makeShop, shopItems, shopName, updateShop } from "../shop-data.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

let instance = null;

export class ShopManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "quick-shop-manager",
    classes: ["quick-shop", "shop-manager"],
    tag: "div",
    window: { icon: "fa-solid fa-store", title: "QUICKSHOP.Manager.Title", resizable: true },
    position: { width: 560, height: 480 },
    actions: {
      create: ShopManager.#onCreate,
      convert: ShopManager.#onConvert,
      configure: ShopManager.#onConfigure,
      browse: ShopManager.#onBrowse,
      showPlayers: ShopManager.#onShowPlayers,
      toggleOpen: ShopManager.#onToggleOpen,
      openSheet: ShopManager.#onOpenSheet
    }
  };

  static PARTS = {
    main: { template: `${TEMPLATES}/shop-manager.hbs`, scrollable: [".shop-list"] }
  };

  static open() {
    instance ??= new ShopManager();
    return instance.render({ force: true });
  }

  static refresh() {
    if ( instance?.rendered ) instance.render();
  }

  async _prepareContext() {
    const shops = allShops().map(actor => {
      const config = getShopConfig(actor);
      return {
        id: actor.id,
        name: shopName(actor),
        actorName: actor.name,
        img: actor.img,
        open: config.open,
        count: shopItems(actor).length
      };
    }).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    return { shops, empty: shops.length === 0 };
  }

  #shop(target) {
    return game.actors.get(target.closest("[data-actor-id]")?.dataset.actorId);
  }

  /* -------------------------------------------- */

  static async #onCreate() {
    const name = await DialogV2.prompt({
      window: { title: game.i18n.localize("QUICKSHOP.Manager.Create") },
      content: `<div class="form-group"><label>${game.i18n.localize("QUICKSHOP.Manager.ShopName")}</label>
        <input type="text" name="name" autofocus placeholder="${game.i18n.localize("QUICKSHOP.Manager.ShopNamePlaceholder")}"></div>`,
      ok: {
        label: game.i18n.localize("QUICKSHOP.Manager.Create"),
        callback: (event, button) => button.form.elements.name.value.trim()
      },
      rejectClose: false,
      modal: true
    });
    if ( !name ) return;
    const actor = await Actor.implementation.create({ name, type: "npc", img: "icons/svg/chest.svg" });
    await makeShop(actor);
    game.modules.get(MODULE_ID).api.configureShop(actor);
  }

  static async #onConvert() {
    const candidates = game.actors.filter(a => (a.type !== "character") && !isShop(a))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    if ( !candidates.length ) {
      ui.notifications.warn(game.i18n.localize("QUICKSHOP.Manager.NoCandidates"));
      return;
    }
    const options = candidates.map(a => `<option value="${a.id}">${foundry.utils.escapeHTML(a.name)}</option>`).join("");
    const actorId = await DialogV2.prompt({
      window: { title: game.i18n.localize("QUICKSHOP.Manager.Convert") },
      content: `<div class="form-group"><label>${game.i18n.localize("QUICKSHOP.Manager.PickActor")}</label>
        <select name="actorId">${options}</select></div>`,
      ok: {
        label: game.i18n.localize("QUICKSHOP.Manager.Convert"),
        callback: (event, button) => button.form.elements.actorId.value
      },
      rejectClose: false,
      modal: true
    });
    const actor = game.actors.get(actorId);
    if ( !actor ) return;
    await makeShop(actor);
    game.modules.get(MODULE_ID).api.configureShop(actor);
  }

  static #onConfigure(event, target) {
    const actor = this.#shop(target);
    if ( actor ) game.modules.get(MODULE_ID).api.configureShop(actor);
  }

  static #onBrowse(event, target) {
    const actor = this.#shop(target);
    if ( actor ) game.modules.get(MODULE_ID).api.openShop(actor);
  }

  static async #onShowPlayers(event, target) {
    const actor = this.#shop(target);
    if ( actor ) await game.modules.get(MODULE_ID).api.showToPlayers(actor);
  }

  static async #onToggleOpen(event, target) {
    const actor = this.#shop(target);
    if ( !actor ) return;
    await updateShop(actor, { open: !getShopConfig(actor).open });
  }

  static #onOpenSheet(event, target) {
    this.#shop(target)?.sheet.render(true);
  }
}

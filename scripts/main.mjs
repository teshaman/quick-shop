import { MODULE_ID } from "./constants.mjs";
import { getShopConfig, isShop, makeShop, shopName, updateShop } from "./shop-data.mjs";
import { registerSocket, showShopToPlayers } from "./socket.mjs";
import { ShopBrowser } from "./apps/shop-browser.mjs";
import { ShopConfig } from "./apps/shop-config.mjs";
import { ShopManager } from "./apps/shop-manager.mjs";
import { bridgeStatus, refreshBridge, registerBridgeSettings } from "./bridge.mjs";

const HEADER_ACTION = "quickShop";

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

const api = {
  /** Open the shop browser for an actor (any user). */
  openShop(actor) {
    actor = resolveActor(actor);
    if ( !actor || !isShop(actor) ) return ui.notifications.warn(game.i18n.localize("QUICKSHOP.Error.NoShop"));
    return ShopBrowser.open(actor);
  },

  /** Open the GM configuration window for a shop. Non-shop actors are converted first. */
  async configureShop(actor) {
    if ( !game.user.isGM ) return;
    actor = resolveActor(actor);
    if ( !actor ) return;
    if ( !isShop(actor) ) await makeShop(actor);
    return ShopConfig.open(actor);
  },

  /** Open the list of all shops (GM). */
  manageShops() {
    if ( game.user.isGM ) return ShopManager.open();
  },

  /** Flag an actor as a shop. */
  makeShop(actor) {
    return makeShop(resolveActor(actor));
  },

  /** Open or close a shop for business. */
  setOpen(actor, open = true) {
    return updateShop(resolveActor(actor), { open: !!open });
  },

  /** Push the shop window to players and post a chat card they can reopen it from. */
  async showToPlayers(actor, userIds = []) {
    if ( !game.user.isGM ) return;
    actor = resolveActor(actor);
    if ( !actor || !isShop(actor) ) return;
    const config = getShopConfig(actor);
    if ( !config.open ) await updateShop(actor, { open: true });
    showShopToPlayers(actor, userIds);
    await ChatMessage.implementation.create({
      speaker: { alias: shopName(actor) },
      content: `<div class="quick-shop-chat quick-shop-card" data-actor-id="${actor.id}">
        <img src="${actor.img}" alt="">
        <div>
          <p><strong>${foundry.utils.escapeHTML(shopName(actor))}</strong></p>
          <p>${game.i18n.localize("QUICKSHOP.Chat.ShopOpen")}</p>
          <button type="button" class="quick-shop-open" data-actor-id="${actor.id}">
            <i class="fa-solid fa-store"></i> ${game.i18n.localize("QUICKSHOP.Chat.Browse")}
          </button>
        </div>
      </div>`
    });
  },

  /** Connection state of the Claude Code bridge (see mcp/README.md). */
  bridgeStatus,

  ShopBrowser, ShopConfig, ShopManager
};

function resolveActor(actor) {
  if ( typeof actor === "string" ) {
    const fromUuidSync = foundry.utils.fromUuidSync ?? globalThis.fromUuidSync;
    return game.actors.get(actor) ?? fromUuidSync?.(actor) ?? null;
  }
  if ( actor?.actor instanceof Actor ) return actor.actor;   // token
  return actor instanceof Actor ? actor : null;
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = api;
  registerBridgeSettings();
});

Hooks.once("ready", () => {
  registerSocket();
  refreshBridge();
  console.log(`${MODULE_ID} | ready`);
});

// The bridge follows the active GM, so re-check when users come and go.
Hooks.on("userConnected", () => refreshBridge());

// "Shops" button in the Actors sidebar header (GM only).
Hooks.on("renderActorDirectory", (app, html) => {
  if ( !game.user.isGM ) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if ( root.querySelector(".quick-shop-directory-button") ) return;
  let header = root.querySelector(".header-actions");
  if ( !header ) {
    header = document.createElement("div");
    header.className = "header-actions action-buttons flexrow";
    root.querySelector(":scope > header")?.insertAdjacentElement("afterbegin", header);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quick-shop-directory-button";
  button.innerHTML = `<i class="fa-solid fa-store" inert></i> ${game.i18n.localize("QUICKSHOP.Manager.Button")}`;
  button.addEventListener("click", () => ShopManager.open());
  header.append(button);
});

// Header control on every actor sheet (GM only).
Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  if ( !game.user.isGM || !Array.isArray(controls) ) return;
  const actor = app.document ?? app.actor;
  if ( !(actor instanceof Actor) ) return;
  if ( controls.some(c => c?.action === HEADER_ACTION) ) return;
  controls.push({
    action: HEADER_ACTION,
    icon: "fa-solid fa-store",
    label: "QUICKSHOP.Sheet.Control",
    visible: () => game.user.isGM,
    onClick: () => api.configureShop(actor)
  });
});

// Fallback for cores that ignore `onClick` on header controls.
Hooks.on("renderApplicationV2", app => {
  if ( !game.user.isGM ) return;
  const actor = app.document ?? app.actor;
  if ( !(actor instanceof Actor) || !app.element || app.element.dataset.quickShopBound ) return;
  app.element.dataset.quickShopBound = "1";
  app.element.addEventListener("click", event => {
    const target = event.target.closest(`[data-action="${HEADER_ACTION}"]`);
    if ( !target ) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    app.toggleControls?.(false);
    api.configureShop(actor);
  }, { capture: true });
});

// Right-click options in the Actors sidebar.
for ( const hook of ["getActorContextOptions", "getActorDirectoryEntryContext"] ) {
  Hooks.on(hook, (app, options) => {
    if ( !game.user.isGM ) return;
    const entryActor = li => game.actors.get((li instanceof HTMLElement ? li : li[0])?.dataset.entryId);
    options.push({
      name: "QUICKSHOP.Sheet.Configure",
      icon: '<i class="fa-solid fa-store"></i>',
      condition: li => isShop(entryActor(li)),
      callback: li => api.configureShop(entryActor(li))
    }, {
      name: "QUICKSHOP.Sheet.MakeShop",
      icon: '<i class="fa-solid fa-store"></i>',
      condition: li => {
        const actor = entryActor(li);
        return actor && !isShop(actor) && (actor.type !== "character");
      },
      callback: li => api.configureShop(entryActor(li))
    });
  });
}

// Chat card button that reopens the shop window.
Hooks.on("renderChatMessageHTML", (message, html) => {
  html.querySelectorAll("button.quick-shop-open").forEach(button => {
    button.addEventListener("click", () => {
      const actor = game.actors.get(button.dataset.actorId);
      if ( actor ) api.openShop(actor);
    });
  });
});

// Keep open windows in sync with document changes.
Hooks.on("updateActor", actor => refresh(actor.id));
for ( const hook of ["createItem", "updateItem", "deleteItem"] ) {
  Hooks.on(hook, item => { if ( item.parent instanceof Actor ) refresh(item.parent.id); });
}

function refresh(actorId) {
  ShopBrowser.refresh(actorId);
  ShopConfig.refresh(actorId);
  ShopManager.refresh();
}

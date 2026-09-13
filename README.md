# Quick Shop

GM-run shops for Foundry VTT (v13/v14) and the dnd5e system (4.x / 5.x).

A shop is any NPC actor flagged as a shop. Its inventory is the stock, so you can fill it by generating items
from compendiums, typing item names, dragging items onto the actor sheet, or letting Familiar add items to it.

## Workflow

1. **Actors sidebar → Shops** opens the shop manager. Create a new shop, or convert an existing NPC.
   You can also right-click an NPC in the sidebar, or use the store button in any actor sheet's header menu.
2. **Configure** the shop: display name, price markup, unlimited stock, haggling rules, and stock.
   The **Generate Stock** section picks random priced items by category, count, price range, and rarity.
3. **Preview** the shop window as the GM to check it.
4. **Show to Players** opens the shop for business, pops the window on every player's screen, and posts a chat
   card they can reopen it from.
5. Players pick the character they are shopping as, see their coin, and **Buy**. Coins are deducted
   automatically (making change across denominations) and the item lands in their inventory.
6. **Haggle** rolls Persuasion, Deception, or Intimidation once per character per visit.
   Success gives a discount, a natural 20 gives more, a bad failure adds a surcharge.
7. Close the shop from the manager, the browser, or the config window. Players cannot buy while it is closed.

## Macro API

```js
const api = game.modules.get("quick-shop").api;
api.openShop(actor);            // browser window (any user)
api.configureShop(actor);       // GM config window; converts the actor if needed
api.manageShops();              // GM list of shops
api.setOpen(actor, true);       // open or close
api.showToPlayers(actor);       // push the window to players + chat card
```

## Claude Code

The module ships an MCP server in `mcp/` so Claude Code can manage shops directly: create shops, generate or
edit stock, open them to players, and run purchases. Turn on **Claude Code bridge** in the module settings
and see `mcp/README.md` for the one-time registration. This also works when Foundry is hosted on The Forge or
a VPS: the bridge is opened by the GM's browser, so Claude Code only has to run on the machine the GM plays from
(see **Hosted Foundry** in `mcp/README.md`).

## Notes

- Purchases are executed by the active GM client, so a GM must be logged in for players to buy.
- Haggle results are stored per character on the shop. Reset them from the config window between visits.
- Sale prices are computed as base price × markup × haggle modifier, rounded to the nearest copper.

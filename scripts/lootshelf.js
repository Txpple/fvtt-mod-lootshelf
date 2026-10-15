/**
 * Loot Shelf — lean 5e-only loot containers and merchant shelf.
 *
 * Two features, nothing else (design.md is binding):
 *
 *   1. PLACEABLE LOOT CONTAINERS (container.js) — a chest is an actor with module flags.
 *      Players double-click and loot through a dnd5e-native sheet (container-sheet.js)
 *      and the system's own drop pipeline; the module defaults container drags to MOVE
 *      instead of copy, clears attuned/equipped on the way in, and adds Take buttons that
 *      route through the kernel so an unowned chest can be looted without ownership.
 *      A GM can also drag an item from a compendium or the sidebar onto the scene to leave
 *      it lying there as a container (canvas-drop.js).
 *
 *   2. MERCHANT SHELF (merchant.js) — the merchant's own dnd5e sheet (merchant-sheet.js),
 *      wearing prices: stock, buy and sell-back flows, per-item hide-from-shelf flag. All
 *      mutations go through the transfer kernel (transfer.js): a GM-elect proxy on plain
 *      `game.socket` that re-validates ownership, stock, and price GM-side.
 *
 * Every buy, sale and take posts one receipt line to chat, and a GM can revert the line with
 * one click (the item back, the coin back). The elect, the receipt and the logger are the
 * Open Roll 5e kit's, in scripts/kit/ (byte-identical across the family; family.js holds
 * this module's instances of them).
 *
 * No dependencies, no bundled UI runtime, no Item Piles compat. Item copies carry system
 * data verbatim except attuned/equipped/container, and `system.attunement` is never
 * touched — see design.md ("Lineage") for why that sentence is the whole reason this
 * module exists.
 *
 * Public API, for macros and other modules (By the Books' companions use
 * `createLootContainer`):
 *
 *   const api = game.modules.get("fvtt-mod-lootshelf").api;
 *   await api.createMerchant({ name, img, items: [uuid|itemData, ...], priceModifier,
 *                              sellModifier, infiniteStock, folder });
 *   await api.createLootContainer({ name, img, items, defaultOwnership, folder, ephemeral });
 *   await api.setMerchant(actor, { enabled, priceModifier, sellModifier, infiniteStock });
 *   await api.setContainer(actor, { enabled, ephemeral });
 *   api.isMerchant(actor);       api.isContainer(actor);
 *   api.openShelf(actor);        api.configure(actor);      // the GM dialog
 *   await api.purchase({ merchantUuid, buyerUuid, itemId, quantity });
 *   await api.sell({ merchantUuid, sellerUuid, itemId, quantity, payeeUuid });
 *   await api.transferItem({ fromUuid, toUuid, itemId, quantity, move });
 *   await api.revertReceipt(messageOrId, line);  // GM only: what the Revert button does
 *   api.isElect();                               // is this the client that acts?
 *   api.priceInCopper(item);     api.formatCopper(copper);
 */

import { MODULE_ID, gmRequest, priceInCopper, formatCopper, receipts } from "./transfer.js";
import "./container-sheet.js";
import "./merchant-sheet.js";
import "./canvas-drop.js";
import "./receipts.js";
import { setContainer, createLootContainer, isContainer } from "./container.js";
import { setMerchant, createMerchant, openShelf, isMerchant } from "./merchant.js";
import { configure } from "./config.js";
import { elect } from "./family.js";

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = {
    // setup
    setMerchant, createMerchant, isMerchant,
    setContainer, createLootContainer, isContainer,
    // ui
    openShelf, configure,
    // kernel (proxied through the GM-elect when needed)
    purchase: payload => gmRequest("purchase", payload),
    sell: payload => gmRequest("sell", payload),
    transferItem: payload => gmRequest("transferItem", payload),
    // the elect: is this client the one that acts (the active GM, in its leading window)?
    isElect: () => elect.isElect(),
    // receipts: ask the elect to revert one line of a receipt (GM only), as the button does
    revertReceipt: (message, line = 0) =>
      receipts.requestRevert(typeof message === "string" ? game.messages.get(message) : message, line),
    // helpers
    priceInCopper, formatCopper
  };
});

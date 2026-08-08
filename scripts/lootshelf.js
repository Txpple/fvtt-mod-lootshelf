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
 *
 *   2. MERCHANT SHELF (merchant.js) — the one custom window, ApplicationV2 + Handlebars.
 *      Stock with prices, buy and sell-back flows, per-item hide-from-shelf flag. All
 *      mutations go through the transfer kernel (transfer.js): a GM-elect proxy on plain
 *      `game.socket` that re-validates ownership, stock, and price GM-side.
 *
 * No dependencies, no bundled UI runtime, no Item Piles compat. Item copies carry system
 * data verbatim except attuned/equipped/container, and `system.attunement` is never
 * touched — see design.md ("Lineage") for why that sentence is the whole reason this
 * module exists.
 *
 * Public API (MCP-friendly by construction — the molten5e bridge drives these directly):
 *
 *   const api = game.modules.get("fvtt-mod-lootshelf").api;
 *   await api.createMerchant({ name, img, items: [uuid|itemData, ...], priceModifier,
 *                              sellModifier, infiniteStock, folder });
 *   await api.createLootContainer({ name, img, items, defaultOwnership, folder });
 *   await api.setMerchant(actor, { enabled, priceModifier, sellModifier, infiniteStock });
 *   await api.setContainer(actor, { enabled });
 *   api.openShelf(actor);        api.configure(actor);      // the GM dialog
 *   await api.purchase({ merchantUuid, buyerUuid, itemId, quantity });
 *   await api.sell({ merchantUuid, sellerUuid, itemId, quantity });
 *   await api.transferItem({ fromUuid, toUuid, itemId, quantity, move });
 */

import { MODULE_ID, gmRequest, priceInCopper, formatCopper } from "./transfer.js";
import "./container-sheet.js";
import "./merchant-sheet.js";
import { setContainer, createLootContainer, isContainer } from "./container.js";
import { setMerchant, createMerchant, openShelf, isMerchant } from "./merchant.js";
import { configure } from "./config.js";

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
    // helpers
    priceInCopper, formatCopper
  };
});

/**
 * Loot Shelf — merchants: flags, setup API, and the entry points that open a shop.
 *
 * A merchant is any actor with `flags.fvtt-mod-lootshelf.merchant.enabled`. The shelf
 * itself is that actor's SHEET (merchant-sheet.js) — a dnd5e sheet built on the system's
 * inventory, not a bespoke window as in v0.1. Shoppers can open it without owning the
 * shopkeeper because the sheet sets `viewPermission: NONE`, which is what keeps merchant
 * actors out of players' sidebars; every mutation still goes through the transfer
 * kernel's GM proxy, which re-validates ownership, stock, and price server-side.
 *
 * What appears on the shelf: physical, top-level (not-inside-a-bag) items that are not
 * equipped and not flagged hidden. Equipped exclusion is what keeps the shopkeeper's own
 * sword off the shelf by construction — items *stocked* onto a flagged merchant arrive
 * unequipped (normalization in transfer.js), while gear the shopkeeper actually wears
 * stays equipped and therefore invisible. The per-item hide flag handles everything else,
 * toggled by the GM from the eye column. The GM's view of the shelf shows EVERYTHING,
 * so the same window is also where a shop gets stocked.
 *
 * Pricing: per-item dnd5e price × the merchant's `priceModifier`, rounded up, computed
 * from the same helpers the GM-side kernel uses so the label always matches the charge.
 * Selling pays price × `sellModifier` (default half), rounded down, and fails cleanly if
 * a finite merchant can't afford the purchase. `infiniteStock` makes stock and coin
 * bottomless for the classic "general store" case.
 */

import { MODULE_ID, stockItems } from "./transfer.js";
import { MERCHANT_SHEET_ID, sheetClassUpdate } from "./sheets.js";
import { isContainer } from "./container.js";
import { configure } from "./config.js";

/* -------------------------------------------------- */
/*  Flags & setup API                                 */
/* -------------------------------------------------- */

export function isMerchant(actor) {
  return !!actor?.flags?.[MODULE_ID]?.merchant?.enabled;
}

/** Flag (or reconfigure) an existing actor as a merchant. */
export async function setMerchant(actor, { enabled = true, priceModifier, sellModifier, infiniteStock } = {}) {
  const cfg = { ...(actor.getFlag(MODULE_ID, "merchant") ?? {}), enabled };
  if (priceModifier !== undefined) cfg.priceModifier = Number(priceModifier);
  if (sellModifier !== undefined) cfg.sellModifier = Number(sellModifier);
  if (infiniteStock !== undefined) cfg.infiniteStock = !!infiniteStock;
  const flags = { ...(actor.flags?.[MODULE_ID] ?? {}), merchant: cfg };
  await actor.update({
    [`flags.${MODULE_ID}.merchant`]: cfg,
    ...sheetClassUpdate(actor, flags)
  });
  return cfg;
}

/** Create a ready-to-place merchant actor. `items` accepts Item uuids or plain data. */
export async function createMerchant({
  name = "Merchant", img, items = [], folder = null,
  priceModifier = 1, sellModifier = 0.5, infiniteStock = false
} = {}) {
  const actor = await Actor.implementation.create({
    name,
    type: "npc",
    img: img ?? "icons/svg/mystery-man.svg",
    folder,
    prototypeToken: { name, actorLink: true, disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL },
    flags: {
      core: { sheetClass: MERCHANT_SHEET_ID },
      [MODULE_ID]: { merchant: { enabled: true, priceModifier, sellModifier, infiniteStock } }
    }
  });
  await stockItems(actor, items);
  return actor;
}

/* -------------------------------------------------- */
/*  Opening the shelf                                 */
/* -------------------------------------------------- */

/**
 * Open (or refocus) the shelf for a merchant actor. The shelf IS the merchant's sheet
 * now (merchant-sheet.js), assigned via `flags.core.sheetClass`, so this is just a
 * render — kept as an API entry point because macros and the molten5e bridge call it.
 */
export function openShelf(actor) {
  actor = actor instanceof Actor ? actor : actor?.actor;
  if (!isMerchant(actor))
    return void ui.notifications.warn("Loot Shelf: that actor is not a merchant.");
  return actor.sheet.render({ force: true });
}

/* -------------------------------------------------- */
/*  Live refresh + entry points                       */
/* -------------------------------------------------- */

// Foundry re-renders a document's own sheet when that document changes, so stock edits
// refresh the shelf for free. The one thing it can't know about is the SHOPPER's purse,
// which the shelf header quotes: when a buyer's coin changes, nudge any shelf they have
// open. Cheap — there is rarely more than one.
function refreshBuyerPurse(actor) {
  if (!(actor instanceof Actor)) return;
  for (const app of foundry.applications.instances.values()) {
    try {
      if (isMerchant(app?.document) && app.buyer === actor) app.render();
    } catch (err) {
      console.error(`${MODULE_ID} | shelf refresh failed`, err);
    }
  }
}
Hooks.on("updateActor", actor => refreshBuyerPurse(actor));

// Let players double-click a shop or a chest they have no permission on.
//
// This is the reason the v0.1 "double-click a merchant token" flow never actually worked:
// core gates the event itself, not just the sheet. The interaction manager wires
// `clickLeft2: this._canView`, and Token#_canView ends with
//
//   return this.actor?.testUserPermission(user, "LIMITED");
//
// so for a player with no permission the double-click NEVER FIRES — any handler wrapped
// around _onClickLeft2 is dead code. Opening up the sheets' viewPermission is necessary
// but not sufficient; the click has to be allowed to reach them. Widen _canView for our
// two flagged roles only, and let core's own handler render the sheet as it always does.
Hooks.once("setup", () => {
  const proto = CONFIG.Token?.objectClass?.prototype;
  const orig = proto?._canView;
  if (!orig) {
    console.error(`${MODULE_ID} | Token#_canView not found — players will not be able to `
      + "open shops or chests they lack permission on; grant ownership as a workaround.");
    return;
  }
  proto._canView = function (user, event) {
    try {
      const actor = this.actor;
      if (isMerchant(actor) || isContainer(actor)) return true;
    } catch (err) {
      console.error(`${MODULE_ID} | token view check failed`, err);
    }
    return orig.call(this, user, event);
  };
});

// Actor directory context menu: configure (GM) and open shelf. v13 renamed the directory
// context hook; register both spellings and dedupe, since only one will fire per build.
function addContextOptions(options) {
  if (options.some(o => o.name === "Loot Shelf: Configure")) return;
  const getActor = li => {
    const el = li instanceof HTMLElement ? li : li?.[0];
    return game.actors.get(el?.dataset?.entryId ?? el?.dataset?.documentId);
  };
  options.push(
    {
      name: "Loot Shelf: Configure",
      icon: '<i class="fa-solid fa-box-open"></i>',
      condition: () => game.user.isGM,
      callback: li => {
        const actor = getActor(li);
        if (actor) configure(actor);
      }
    },
    {
      name: "Open Loot Shelf",
      icon: '<i class="fa-solid fa-shop"></i>',
      condition: li => isMerchant(getActor(li)),
      callback: li => {
        const actor = getActor(li);
        if (actor) openShelf(actor);
      }
    }
  );
}
Hooks.on("getActorDirectoryEntryContext", (html, options) => addContextOptions(options));
Hooks.on("getActorContextOptions", (app, options) => addContextOptions(options));

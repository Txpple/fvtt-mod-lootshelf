/**
 * Loot Shelf — merchant shelf, the module's ONE custom window.
 *
 * A merchant is any actor with `flags.fvtt-mod-lootshelf.merchant.enabled`. Players
 * double-click the merchant's token (they don't own it, so the stock sheet would refuse
 * them anyway) and get the shelf instead: an ApplicationV2 + Handlebars window listing
 * the stock with prices, a Buy button per row, and a drop zone for selling their own
 * items back. Every mutation goes through the transfer kernel's GM proxy, which
 * re-validates ownership, stock, and price server-side.
 *
 * What appears on the shelf: physical, top-level (not-inside-a-bag) items that are not
 * equipped and not flagged hidden. Equipped exclusion is what keeps the shopkeeper's own
 * sword off the shelf by construction — items *stocked* onto a flagged merchant arrive
 * unequipped (normalization in transfer.js), while gear the shopkeeper actually wears
 * stays equipped and therefore invisible. The per-item hide flag handles everything else,
 * toggled by the GM straight from the shelf via the eye icons (the GM's shelf view is a
 * curation view; GMs stock by dragging items onto the merchant's normal sheet).
 *
 * Pricing: per-item dnd5e price × the merchant's `priceModifier`, rounded up, computed
 * from the same helpers the GM-side kernel uses so the label always matches the charge.
 * Selling pays price × `sellModifier` (default half), rounded down, and fails cleanly if
 * a finite merchant can't afford the purchase. `infiniteStock` makes stock and coin
 * bottomless for the classic "general store" case.
 */

import {
  MODULE_ID, isPhysical, priceInCopper, formatCopper, totalCopper, gmRequest, stockItems
} from "./transfer.js";
import { configure } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

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
  await actor.update({ [`flags.${MODULE_ID}.merchant`]: cfg });
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
    flags: { [MODULE_ID]: { merchant: { enabled: true, priceModifier, sellModifier, infiniteStock } } }
  });
  await stockItems(actor, items);
  return actor;
}

/* -------------------------------------------------- */
/*  The shelf window                                  */
/* -------------------------------------------------- */

const shelfApps = new Set();

export class MerchantShelfApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(merchant, options = {}) {
    super({ id: `lootshelf-shelf-${merchant.id}`, ...options });
    this.merchant = merchant;
    this.buyer = null;
  }

  static DEFAULT_OPTIONS = {
    classes: ["lootshelf-shelf"],
    window: { icon: "fa-solid fa-shop", resizable: true },
    position: { width: 520, height: 560 },
    actions: {
      buy: MerchantShelfApp.#onBuy,
      toggleHidden: MerchantShelfApp.#onToggleHidden
    }
  };

  static PARTS = {
    shelf: {
      template: `modules/${MODULE_ID}/templates/merchant-shelf.hbs`,
      scrollable: [".lootshelf-stock"]
    }
  };

  get title() {
    return `${this.merchant.name} — Shelf`;
  }

  /** The actor doing the buying: assigned character first, else a controlled owned token. */
  #resolveBuyer() {
    if (game.user.isGM) return null; // the GM's shelf is a curation view
    if (game.user.character) return game.user.character;
    return canvas?.tokens?.controlled?.find(t => t.actor?.isOwner)?.actor ?? null;
  }

  async _prepareContext() {
    const cfg = this.merchant.getFlag(MODULE_ID, "merchant") ?? {};
    const priceMod = Number.isFinite(+cfg.priceModifier) ? +cfg.priceModifier : 1;
    const sellMod = Number.isFinite(+cfg.sellModifier) ? +cfg.sellModifier : 0.5;
    const isGM = game.user.isGM;
    this.buyer = this.#resolveBuyer();

    const rows = this.merchant.items
      .filter(i => isPhysical(i) && !i.system.container && !i.system.equipped)
      .filter(i => (i.system.quantity ?? 0) > 0 || cfg.infiniteStock)
      .filter(i => isGM || !i.getFlag(MODULE_ID, "hidden"))
      .map(i => ({
        id: i.id,
        name: i.name,
        img: i.img,
        qty: cfg.infiniteStock ? "∞" : Math.floor(i.system.quantity ?? 1),
        priceLabel: formatCopper(Math.ceil(priceInCopper(i) * priceMod)),
        hidden: !!i.getFlag(MODULE_ID, "hidden")
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      merchant: { name: this.merchant.name, img: this.merchant.img },
      rows,
      isGM,
      buyer: this.buyer
        ? { name: this.buyer.name, coins: formatCopper(totalCopper(this.buyer.system.currency)) }
        : null,
      sellPct: Math.round(sellMod * 100),
      priceNote: priceMod !== 1 ? `prices ×${priceMod}` : null
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const zone = this.element.querySelector(".lootshelf-sellzone");
    if (zone) {
      zone.addEventListener("dragover", ev => ev.preventDefault());
      zone.addEventListener("drop", ev => this.#onSellDrop(ev));
    }
  }

  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    shelfApps.add(this);
  }

  _onClose(options) {
    super._onClose(options);
    shelfApps.delete(this);
  }

  static async #onBuy(event, target) {
    const row = target.closest("[data-item-id]");
    const quantity = Math.max(1, Math.floor(row.querySelector(".buy-qty")?.valueAsNumber || 1));
    const buyer = this.buyer ?? this.#resolveBuyer();
    if (!buyer) {
      return void ui.notifications.warn(
        "Loot Shelf: assign a character to your user (or select a token you own) before buying.");
    }
    target.disabled = true;
    try {
      const res = await gmRequest("purchase", {
        merchantUuid: this.merchant.uuid,
        buyerUuid: buyer.uuid,
        itemId: row.dataset.itemId,
        quantity
      });
      ui.notifications.info(`Bought ${res.quantity} × ${res.name} for ${formatCopper(res.cost)}.`);
    } catch (err) {
      ui.notifications.warn(err.message);
    } finally {
      target.disabled = false;
      this.render();
    }
  }

  static async #onToggleHidden(event, target) {
    const item = this.merchant.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    if (item) await item.setFlag(MODULE_ID, "hidden", !item.getFlag(MODULE_ID, "hidden"));
  }

  async #onSellDrop(event) {
    event.preventDefault();
    let data;
    try {
      data = JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch {
      return;
    }
    if (data?.type !== "Item" || !data.uuid) return;
    const item = await fromUuid(data.uuid);
    const seller = item?.parent;
    if (!(item instanceof Item) || !(seller instanceof Actor))
      return void ui.notifications.warn("Loot Shelf: drag an item from an actor's sheet to sell it.");
    if (seller === this.merchant) return;
    if (!seller.isOwner)
      return void ui.notifications.warn(`Loot Shelf: you don't own ${seller.name}.`);
    if (!isPhysical(item))
      return void ui.notifications.warn("Loot Shelf: only physical items can be sold.");

    const cfg = this.merchant.getFlag(MODULE_ID, "merchant") ?? {};
    const sellMod = Number.isFinite(+cfg.sellModifier) ? +cfg.sellModifier : 0.5;
    const unit = Math.floor(priceInCopper(item) * sellMod);
    const max = Math.max(1, Math.floor(item.system.quantity ?? 1));
    const esc = Handlebars.escapeExpression;
    const qtyField = max > 1
      ? `<div class="form-group"><label>Quantity (up to ${max})</label>`
        + `<input type="number" name="qty" value="1" min="1" max="${max}" autofocus></div>`
      : "";
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: `Sell to ${this.merchant.name}` },
      content: `<p>${esc(this.merchant.name)} offers <strong>${formatCopper(unit)}</strong>`
        + ` each for ${esc(item.name)}.</p>${qtyField}`,
      buttons: [
        {
          action: "sell", label: "Sell", icon: "fa-solid fa-coins", default: true,
          callback: (ev, button) =>
            Math.max(1, Math.min(max, Math.floor(button.form?.elements?.qty?.valueAsNumber || 1)))
        },
        { action: "cancel", label: "Cancel" }
      ],
      rejectClose: false
    });
    if (result == null || result === "cancel") return;
    try {
      const res = await gmRequest("sell", {
        merchantUuid: this.merchant.uuid,
        sellerUuid: seller.uuid,
        itemId: item.id,
        quantity: Number(result) || 1
      });
      ui.notifications.info(`Sold ${res.quantity} × ${res.name} for ${formatCopper(res.gain)}.`);
    } catch (err) {
      ui.notifications.warn(err.message);
    }
  }
}

/** Open (or refocus) the shelf for a merchant actor. */
export function openShelf(actor) {
  actor = actor instanceof Actor ? actor : actor?.actor;
  if (!isMerchant(actor))
    return void ui.notifications.warn("Loot Shelf: that actor is not a merchant.");
  for (const app of shelfApps) {
    if (app.merchant === actor) return app.render({ force: true });
  }
  return new MerchantShelfApp(actor).render({ force: true });
}

/* -------------------------------------------------- */
/*  Live refresh + entry points                       */
/* -------------------------------------------------- */

function refreshShelves(actor) {
  if (!shelfApps.size || !(actor instanceof Actor)) return;
  for (const app of shelfApps) {
    if (app.merchant === actor || app.buyer === actor) app.render();
  }
}
Hooks.on("updateActor", actor => refreshShelves(actor));
Hooks.on("createItem", item => refreshShelves(item.parent));
Hooks.on("updateItem", item => refreshShelves(item.parent));
Hooks.on("deleteItem", item => refreshShelves(item.parent));

// Players double-click a merchant token they don't own -> shelf instead of the (refused)
// sheet. Owners and GMs keep the stock double-click so they can edit the merchant.
Hooks.once("setup", () => {
  const proto = CONFIG.Token?.objectClass?.prototype;
  const orig = proto?._onClickLeft2;
  if (!orig) {
    console.error(`${MODULE_ID} | Token#_onClickLeft2 not found — `
      + "merchant double-click disabled; use the actor directory context menu instead.");
    return;
  }
  proto._onClickLeft2 = function (event) {
    try {
      const actor = this.actor;
      if (isMerchant(actor) && !actor.isOwner && !game.user.isGM) {
        openShelf(actor);
        return;
      }
    } catch (err) {
      console.error(`${MODULE_ID} | merchant double-click check failed`, err);
    }
    return orig.call(this, event);
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

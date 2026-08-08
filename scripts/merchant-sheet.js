/**
 * Loot Shelf — the merchant shelf, rebuilt on the system's inventory (v0.2 uplift).
 *
 * Like the container sheet, this is a real dnd5e actor sheet: BaseActorSheet rendering the
 * system's own inventory tab, so the table, sections, search/filter/sort bar, row
 * expansion, and theming are all dnd5e's. What a shop adds on top is three custom COLUMNS
 * — shelf price, stock, and a Buy button (an eye toggle for the GM) — which the system
 * supports directly: `InventoryElement.mapColumns` merges an unrecognised descriptor as-is,
 * so a column id it has never heard of renders from our template alongside its own.
 *
 * THE PERMISSION PROBLEM, AND WHY THIS IS A SHEET AT ALL. Shoppers do not own the
 * shopkeeper, and a document sheet normally refuses to render for them — which is why v0.1
 * hand-rolled a standalone window instead. The supported way out is `viewPermission`, a
 * DEFAULT_OPTIONS field core itself sets to NONE on some of its sheets. Setting it here
 * lets anyone open the shelf while the merchant's ownership stays untouched, so merchant
 * actors do NOT appear in players' sidebars (the owner's objection to granting OBSERVER,
 * and the whole reason for this approach). Nothing is trusted client-side regardless:
 * every purchase and sale is re-validated GM-side by the transfer kernel.
 *
 * Because the merchant wears this sheet full-time, the GM's view doubles as the stocking
 * view: GMs see every item — including hidden and equipped ones — with the system's normal
 * quantity and controls columns plus the eye toggle, and stock the shop by dragging items
 * in exactly as before. Shoppers see the curated list with prices and Buy buttons.
 */

import {
  MODULE_ID, isPhysical, priceInCopper, formatCopper, formatPurse, totalCopper, gmRequest
} from "./transfer.js";

export { MERCHANT_SHEET_ID } from "./sheets.js";

Hooks.once("init", () => {
  const Base = globalThis.dnd5e?.applications?.actor?.BaseActorSheet;
  const DocumentSheetConfig =
    foundry.applications?.apps?.DocumentSheetConfig ?? globalThis.DocumentSheetConfig;
  if (!Base || !DocumentSheetConfig?.registerSheet) {
    console.error(`${MODULE_ID} | dnd5e BaseActorSheet or DocumentSheetConfig not found — `
      + "merchant shelf disabled; merchants fall back to the default actor sheet.");
    return;
  }

  class MerchantShelfSheet extends Base {
    static DEFAULT_OPTIONS = {
      classes: ["group", "lootshelf-sheet", "lootshelf-merchant"],
      position: { width: 620, height: 660 },
      // Anyone may LOOK at a shop. See the permission note above: this is what keeps
      // merchants out of players' sidebars, since no ownership is granted.
      viewPermission: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
      window: { icon: "" },
      actions: {
        buy: MerchantShelfSheet.#onBuy,
        toggleHidden: MerchantShelfSheet.#onToggleHidden
      }
    };

    static PARTS = {
      header: {
        template: `modules/${MODULE_ID}/templates/merchant-header.hbs`
      },
      inventory: {
        container: { classes: ["tab-body"], id: "tabs" },
        template: `modules/${MODULE_ID}/templates/container-inventory.hbs`,
        templates: [
          "systems/dnd5e/templates/inventory/inventory.hbs",
          "systems/dnd5e/templates/inventory/activity.hbs",
          "systems/dnd5e/templates/inventory/containers.hbs",
          `modules/${MODULE_ID}/templates/columns/shelf-price.hbs`,
          `modules/${MODULE_ID}/templates/columns/shelf-stock.hbs`,
          `modules/${MODULE_ID}/templates/columns/shelf-buy.hbs`,
          `modules/${MODULE_ID}/templates/columns/shelf-hide.hbs`
        ],
        scrollable: [".items-list"]
      }
    };

    static TABS = [
      { tab: "inventory", label: "DND5E.Inventory", svg: "systems/dnd5e/icons/svg/backpack.svg" }
    ];

    tabGroups = { primary: "inventory" };

    _filters = { inventory: { name: "", properties: new Set() } };

    /** See the long note in container-sheet.js: core chokes on a single-tab dnd5e sheet. */
    _getTabsConfig(group) {
      if (Array.isArray(this.constructor.TABS)) return { tabs: [] };
      return super._getTabsConfig(group);
    }

    /* ---------------------------------------------- */
    /*  Shop state                                    */
    /* ---------------------------------------------- */

    get config() {
      return this.actor.getFlag(MODULE_ID, "merchant") ?? {};
    }

    get priceModifier() {
      const m = Number(this.config.priceModifier);
      return Number.isFinite(m) ? m : 1;
    }

    get sellModifier() {
      const m = Number(this.config.sellModifier);
      return Number.isFinite(m) ? m : 0.5;
    }

    /** The actor doing the shopping: assigned character first, else a controlled owned token. */
    get buyer() {
      if (game.user.isGM) return null; // the GM's view is for curation, not shopping
      return game.user.character
        ?? canvas?.tokens?.controlled?.find(t => t.actor?.isOwner)?.actor
        ?? null;
    }

    /** What a shopper is allowed to see on the shelf. GMs see everything, to stock it. */
    #onShelf(item) {
      if (!isPhysical(item)) return false;
      if (item.system.container) return false;         // contents show under their bag
      if (item.system.equipped) return false;          // the shopkeeper's own gear
      if (item.getFlag(MODULE_ID, "hidden")) return false;
      return (item.system.quantity ?? 0) > 0 || !!this.config.infiniteStock;
    }

    /* ---------------------------------------------- */
    /*  Rendering                                     */
    /* ---------------------------------------------- */

    /**
     * Filtering the shelf through the system's own category hook keeps one list instead of
     * a parallel one: an item assigned no categories is simply not in any section.
     */
    _assignItemCategories(item) {
      if (!game.user.isGM && !this.#onShelf(item)) return [];
      return super._assignItemCategories(item);
    }

    /** @override */
    async _configureInventorySections(sections) {
      sections.forEach(s => s.minWidth = 200);
      const shelfPrice = {
        id: "shelfPrice", width: 90, order: 300, priority: 200, label: "DND5E.Price",
        template: `modules/${MODULE_ID}/templates/columns/shelf-price.hbs`
      };
      const stock = {
        id: "shelfStock", width: 60, order: 400, priority: 400, label: "Stock",
        template: `modules/${MODULE_ID}/templates/columns/shelf-stock.hbs`
      };
      const buy = {
        id: "shelfBuy", width: 90, order: 900, priority: 100, label: "",
        template: `modules/${MODULE_ID}/templates/columns/shelf-buy.hbs`
      };
      const hide = {
        id: "shelfHide", width: 40, order: 950, priority: 150, label: "",
        template: `modules/${MODULE_ID}/templates/columns/shelf-hide.hbs`
      };
      // The GM is stocking as well as pricing, so they keep the system's quantity and
      // controls columns; a shopper gets price, stock and a way to buy.
      const columns = game.user.isGM
        ? [shelfPrice, "quantity", hide, "controls"]
        : [shelfPrice, stock, buy];
      sections.forEach(s => s.columns = columns);
    }

    /** @inheritDoc */
    async _prepareInventoryContext(context, options) {
      context = await super._prepareInventoryContext(context, options);
      // The shelf trades in coin, not encumbrance; the merchant's own purse is the GM's
      // business and a shopper's purse belongs in the header, not in this row.
      context.showCurrency = game.user.isGM;
      const priceMod = this.priceModifier;
      const infinite = !!this.config.infiniteStock;
      for (const item of this.actor.items) {
        const ctx = context.itemContext?.[item.id];
        if (!ctx) continue;
        const unit = Math.ceil(priceInCopper(item) * priceMod);
        ctx.shelf = {
          price: unit,
          priceLabel: unit > 0 ? formatCopper(unit) : "",
          stockLabel: infinite ? "∞" : String(Math.floor(item.system.quantity ?? 0)),
          hidden: !!item.getFlag(MODULE_ID, "hidden"),
          equipped: !!item.system.equipped
        };
        // A shopper clicking the row should read the item, never "use" it — it isn't
        // theirs. Activity buttons would try to use it too, and fail on permissions.
        if (!game.user.isGM) {
          ctx.clickAction = "view";
          ctx.activities = [];
        }
        // Containers on a shelf are goods like any other; drop dnd5e's capacity-meter
        // column override so the row lines up with everything else (see container-sheet.js).
        delete ctx.columns;
      }
      return context;
    }

    /** @inheritDoc */
    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const buyer = this.buyer;
      const bits = [];
      if (game.user.isGM) {
        if (this.priceModifier !== 1) bits.push(`prices ×${this.priceModifier}`);
        bits.push(`buys back at ${Math.round(this.sellModifier * 100)}%`);
        if (this.config.infiniteStock) bits.push("infinite stock");
      } else {
        bits.push(buyer
          ? `${buyer.name}'s purse: ${formatPurse(totalCopper(buyer.system.currency))}`
          : "Select your token or assign a character to buy.");
        bits.push(`sells back at ${Math.round(this.sellModifier * 100)}%`);
      }
      context.shelf = { subtitle: bits.join(" · "), isGM: game.user.isGM };
      return context;
    }

    /** @inheritDoc */
    async _preparePartContext(partId, context, options) {
      context = await super._preparePartContext(partId, context, options);
      if (partId === "inventory") return this._prepareInventoryContext(context, options);
      return context;
    }

    /** @inheritDoc */
    async _onFirstRender(context, options) {
      await super._onFirstRender(context, options);
      // Stock a shop by dragging real goods in, not by minting blank rows.
      this.element.querySelector(".create-child")?.remove();
    }

    /**
     * Shoppers buy; they do not help themselves. Rows on a shelf are draggable like any
     * inventory row, and dragging one onto your own sheet created it there outright — the
     * goods never left the shop and no coin changed hands. Blocking the drag at its source
     * closes that, and the drop side is guarded too (merchant.js) so a drag begun some
     * other way still cannot land.
     */
    _canDragStart(selector) {
      if (!game.user.isGM) return false;
      return super._canDragStart(selector);
    }

    /**
     * The counterpart: shoppers must be able to drop goods ONTO the shelf to sell them.
     * The system ties dropping to editability, and a shopper cannot edit a shopkeeper they
     * do not own, so a sale drop was rejected before _onDropItem ever saw it. Allow the
     * drop and judge it ourselves — the sale runs GM-side through the transfer kernel.
     */
    _canDragDrop(selector) {
      return true;
    }

    /** Fail open: a broken shelf must never leave a shopkeeper that does nothing. */
    async render(options, _options) {
      try {
        return await super.render(options, _options);
      } catch (err) {
        console.error(`${MODULE_ID} | merchant shelf render failed; falling back to the `
          + "system sheet", err);
        ui.notifications.error(
          `Loot Shelf: the merchant shelf failed to render (${err.message}). `
          + "See the console (F12) for details.");
        if (!this.document.isOwner && !game.user.isGM) return this;
        const registered = CONFIG.Actor.sheetClasses?.[this.document.type] ?? {};
        const fallback = Object.values(registered).find(s => s.default && s.cls !== this.constructor)
          ?? Object.values(registered).find(s => s.cls !== this.constructor);
        if (!fallback) return this;
        return new fallback.cls({ document: this.document }).render({ force: true });
      }
    }

    /* ---------------------------------------------- */
    /*  Buying, selling, curating                     */
    /* ---------------------------------------------- */

    static async #onBuy(event, target) {
      const row = target.closest("[data-item-id]");
      const item = this.actor.items.get(row?.dataset.itemId);
      if (!item) return;
      const buyer = this.buyer;
      if (!buyer) {
        return void ui.notifications.warn(
          "Loot Shelf: assign a character to your user (or select a token you own) before buying.");
      }
      const unit = Math.ceil(priceInCopper(item) * this.priceModifier);
      const infinite = !!this.config.infiniteStock;
      const max = infinite ? 99 : Math.max(1, Math.floor(item.system.quantity ?? 1));
      const esc = Handlebars.escapeExpression;
      const qtyField = max > 1
        ? `<div class="form-group"><label>Quantity</label><div class="form-fields">`
          + `<input type="number" name="qty" value="1" min="1" max="${max}" autofocus>`
          + `</div><p class="hint">Up to ${max}.</p></div>`
        : "";
      const result = await foundry.applications.api.DialogV2.wait({
        classes: ["lootshelf-dialog"],
        window: { title: `Buy from ${this.actor.name}` },
        content: `<p><strong>${esc(item.name)}</strong> — ${formatCopper(unit)} each.</p>`
          + `<p>${esc(buyer.name)} carries ${formatCopper(totalCopper(buyer.system.currency))}.</p>`
          + qtyField,
        buttons: [
          {
            action: "buy", label: "Buy", icon: "fa-solid fa-coins", default: true,
            callback: (ev, button) =>
              Math.max(1, Math.min(max, Math.floor(button.form?.elements?.qty?.valueAsNumber || 1)))
          },
          { action: "cancel", label: "Cancel" }
        ],
        rejectClose: false
      });
      if (result == null || result === "cancel") return;
      try {
        const res = await gmRequest("purchase", {
          merchantUuid: this.actor.uuid,
          buyerUuid: buyer.uuid,
          itemId: item.id,
          quantity: Number(result) || 1
        });
        ui.notifications.info(`Bought ${res.quantity} × ${res.name} for ${formatCopper(res.cost)}.`);
      } catch (err) {
        ui.notifications.warn(err.message);
      }
      this.render();
    }

    static async #onToggleHidden(event, target) {
      if (!game.user.isGM) return;
      const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
      if (item) await item.setFlag(MODULE_ID, "hidden", !item.getFlag(MODULE_ID, "hidden"));
    }

    /**
     * Selling: a shopper drags their own goods onto the shelf. The GM keeps the system's
     * drop pipeline so they can stock the shop by dragging items in as usual.
     */
    async _onDropItem(event, item) {
      if (game.user.isGM) return super._onDropItem(event, item);
      const seller = item?.parent;
      if (!(item instanceof Item) || !(seller instanceof Actor)) return;
      if (seller === this.actor) return;
      if (!seller.isOwner) {
        return void ui.notifications.warn(`Loot Shelf: you don't own ${seller.name}.`);
      }
      if (!isPhysical(item)) {
        return void ui.notifications.warn("Loot Shelf: only physical goods can be sold.");
      }
      const unit = Math.floor(priceInCopper(item) * this.sellModifier);
      const carried = Math.max(1, Math.floor(item.system.quantity ?? 1));
      // A finite shop can only buy what it can pay for. Work that out here so the shopper
      // is told up front instead of being refused after committing to the sale.
      const purse = totalCopper(this.actor.system.currency);
      const infinite = !!this.config.infiniteStock;
      const affordable = (infinite || unit <= 0) ? carried : Math.floor(purse / unit);
      if (affordable < 1) {
        return void ui.notifications.warn(
          `Loot Shelf: ${this.actor.name} has ${formatPurse(purse)} and can't afford `
          + `${item.name} at ${formatCopper(unit)}.`);
      }
      const max = Math.min(carried, affordable);
      const esc = Handlebars.escapeExpression;
      const limitNote = max < carried
        ? `<p class="hint">Can only afford ${max} of your ${carried} `
          + `(purse: ${formatCopper(purse)}).</p>`
        : "";
      const qtyField = max > 1
        ? `<div class="form-group"><label>Quantity</label><div class="form-fields">`
          + `<input type="number" name="qty" value="1" min="1" max="${max}" autofocus>`
          + `</div><p class="hint">Up to ${max}.</p></div>`
        : "";
      const result = await foundry.applications.api.DialogV2.wait({
        classes: ["lootshelf-dialog"],
        window: { title: `Sell to ${this.actor.name}` },
        content: `<p>${esc(this.actor.name)} offers <strong>${formatCopper(unit)}</strong>`
          + ` each for ${esc(item.name)}.</p>${limitNote}${qtyField}`,
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
          merchantUuid: this.actor.uuid,
          sellerUuid: seller.uuid,
          itemId: item.id,
          quantity: Number(result) || 1
        });
        ui.notifications.info(`Sold ${res.quantity} × ${res.name} for ${formatCopper(res.gain)}.`);
      } catch (err) {
        ui.notifications.warn(err.message);
      }
      this.render();
    }
  }

  DocumentSheetConfig.registerSheet(Actor, MODULE_ID, MerchantShelfSheet, {
    types: ["npc"],
    label: "Loot Shelf: Merchant",
    makeDefault: false
  });
});

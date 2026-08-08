/**
 * Loot Shelf — the container sheet (v0.2 uplift).
 *
 * A loot container's window is a real dnd5e actor sheet: a subclass of the system's
 * BaseActorSheet whose PARTS are a slim header plus the system's OWN inventory tab.
 * Everything functional — the currency row, the search/filter/sort controls, the
 * sectioned item table with its columns, row expansion — is the same machinery that
 * renders the group sheet's Inventory tab. The native drop pipeline comes with the base
 * class, so container drops keep dnd5e's stack-merging and nesting, and the move-not-copy
 * wrap in container.js (patched onto BaseActorSheet.prototype) applies here by
 * inheritance.
 *
 * What this module actually contributes is small and deliberate: two templates (a slim
 * header, and the group inventory tab minus the party-members rail), the four behavioural
 * deltas below, and a handful of CSS rules in styles/lootshelf.css. A chest differs from
 * a party sheet in exactly these ways — no members rail, no banner header, no tab bar
 * worth drawing for one tab, no "create item" button, nested bags listed like ordinary
 * loot rather than as sub-inventories, and pinned currency/search while the list scrolls.
 * Anything beyond that list belongs to the system, not here.
 *
 * The sheet is registered for npc-type actors and assigned per-actor via
 * `flags.core.sheetClass` whenever the container role is enabled (see container.js and
 * config.js), so a GM can always flip an actor back to the stock statblock sheet from
 * core's Sheet configuration.
 */

import {
  MODULE_ID, isPhysical, priceInCopper, formatCopper, totalCopper, gmRequest
} from "./transfer.js";
import { trimSheetChrome } from "./sheets.js";

export { CONTAINER_SHEET_ID } from "./sheets.js";

Hooks.once("init", () => {
  const Base = globalThis.dnd5e?.applications?.actor?.BaseActorSheet;
  const DocumentSheetConfig =
    foundry.applications?.apps?.DocumentSheetConfig ?? globalThis.DocumentSheetConfig;
  if (!Base || !DocumentSheetConfig?.registerSheet) {
    console.error(`${MODULE_ID} | dnd5e BaseActorSheet or DocumentSheetConfig not found — `
      + "container sheet disabled; containers fall back to the default actor sheet.");
    return;
  }

  class LootContainerSheet extends Base {
    static DEFAULT_OPTIONS = {
      classes: ["group", "lootshelf-sheet", "lootshelf-container"],
      position: { width: 580, height: 640 },
      // Anyone may look inside a chest. Requiring ownership meant the GM had to hand out
      // permissions per chest, which also drops every chest into that player's sidebar —
      // the same objection that shaped the merchant shelf. Taking things out is the
      // guarded step, not looking: an unowned take is re-validated GM-side by the
      // transfer kernel's takeFromContainer (see container.js).
      viewPermission: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
      // No title-bar icon: the bar carries a one-word role label (see `title`) and an icon
      // beside it would only repeat what the portrait below already says.
      window: { icon: "" },
      actions: {
        take: LootContainerSheet.#onTake,
        takeCurrency: LootContainerSheet.#onTakeCurrency
      }
    };

    static PARTS = {
      header: {
        template: `modules/${MODULE_ID}/templates/container-header.hbs`
      },
      inventory: {
        container: { classes: ["tab-body"], id: "tabs" },
        template: `modules/${MODULE_ID}/templates/container-inventory.hbs`,
        templates: [
          "systems/dnd5e/templates/inventory/inventory.hbs",
          "systems/dnd5e/templates/inventory/activity.hbs",
          "systems/dnd5e/templates/inventory/containers.hbs",
          "systems/dnd5e/templates/inventory/encumbrance.hbs",
          `modules/${MODULE_ID}/templates/columns/loot-value.hbs`,
          `modules/${MODULE_ID}/templates/columns/loot-qty.hbs`,
          `modules/${MODULE_ID}/templates/columns/loot-take.hbs`
        ],
        scrollable: [".items-list"]
      }
    };

    static TABS = [
      { tab: "inventory", label: "DND5E.Inventory", svg: "systems/dnd5e/icons/svg/backpack.svg" }
    ];

    tabGroups = { primary: "inventory" };

    _filters = { inventory: { name: "", properties: new Set() } };

    /**
     * dnd5e hides the frame title on actor sheets because its own header card already names
     * the document — which on these slim sheets leaves the whole bar empty. Name the ROLE
     * instead: the chest's own name is right underneath, so repeating it would waste the
     * line, but "which kind of window is this" is not otherwise stated anywhere.
     * styles/lootshelf.css un-hides it.
     */
    get title() {
      return "Container";
    }

    /**
     * Core reads `static TABS` as a RECORD of tab groups; dnd5e overrides it with an
     * ARRAY of tabs and supplies the real thing from its own `_getTabs()`. Those two
     * shapes only coexist by luck: core's `_prepareContext` prepares tabs automatically
     * when `Object.keys(TABS).length === 1`, and every system sheet has two or more tabs,
     * so the branch never fires for them. A container has exactly ONE tab — `Object.keys`
     * on a 1-element array is `["0"]`, so core prepared group "0", read the tab object as
     * a group config, and died on `tabs.reduce` of undefined before dnd5e's tabs were
     * ever built. Hand core an empty group; `_getTabs()` still fills `context.tabs`.
     */
    _getTabsConfig(group) {
      if (Array.isArray(this.constructor.TABS)) return { tabs: [] };
      return super._getTabsConfig(group);
    }

    /* ---------------------------------------------- */
    /*  Chest state                                   */
    /* ---------------------------------------------- */

    get config() {
      return this.actor.getFlag(MODULE_ID, "container") ?? {};
    }

    /** The actor carrying the loot off: assigned character first, else a controlled token. */
    get looter() {
      if (game.user.isGM) return null; // the GM drags; the Take button is for players
      return game.user.character
        ?? canvas?.tokens?.controlled?.find(t => t.actor?.isOwner)?.actor
        ?? null;
    }

    /**
     * Where the loot can go: the looter, then any dnd5e group actor they belong to.
     *
     * A party with a shared stash is the normal destination for half of what comes out of
     * a chest — coin especially — and making that a second manual drag afterwards is how
     * loot ends up scattered across four sheets. The kernel allows a group destination on
     * the same membership test (`canReceive` in transfer.js), so nothing here is trusted.
     */
    #destinations(looter) {
      if (!looter) return [];
      const parties = game.actors.filter(a =>
        a.type === "group" && a.system?.members?.some(m => m.actor === looter));
      return [looter, ...parties];
    }

    /**
     * One button per destination, or a plain "Take" when the looter belongs to no party.
     * Each resolves to `{destUuid, qty}`; Cancel and the close button resolve to something
     * that is not an object, which is the caller's bail-out test.
     */
    #destinationButtons(destinations, looter, quantityOf) {
      const solo = destinations.length === 1;
      const buttons = destinations.map((dest, i) => ({
        action: `dest${i}`,
        label: dest === looter ? (solo ? "Take" : `Take for ${looter.name}`) : `Add to ${dest.name}`,
        icon: dest === looter ? "fa-solid fa-hand-holding" : "fa-solid fa-users",
        default: i === 0,
        callback: (event, button) => ({ destUuid: dest.uuid, qty: quantityOf?.(button) ?? 1 })
      }));
      buttons.push({ action: "cancel", label: "Cancel" });
      return buttons;
    }

    /**
     * What the chest is worth, as a one-line summary: how many things are in it and what
     * they are collectively worth. This is the default subtitle — see `_prepareContext`.
     */
    get #summary() {
      let count = 0;
      let value = totalCopper(this.actor.system?.currency);
      for (const item of this.actor.items) {
        if (!isPhysical(item)) continue;
        const qty = Math.floor(item.system.quantity ?? 1);
        if (qty <= 0) continue;
        count += qty;
        value += priceInCopper(item) * qty;
      }
      if (!count && value <= 0) return "Empty";
      const bits = [];
      if (count) bits.push(`${count} item${count === 1 ? "" : "s"}`);
      if (value > 0) bits.push(`${formatCopper(value)} all told`);
      return bits.join(" · ");
    }

    /** @override */
    async _configureInventorySections(sections) {
      sections.forEach(s => s.minWidth = 200);
      const value = {
        id: "lootValue", width: 90, order: 300, priority: 200, label: "Value",
        template: `modules/${MODULE_ID}/templates/columns/loot-value.hbs`
      };
      const qty = {
        id: "lootQty", width: 60, order: 500, priority: 400, label: "Qty",
        template: `modules/${MODULE_ID}/templates/columns/loot-qty.hbs`
      };
      const take = {
        id: "lootTake", width: 90, order: 900, priority: 100, label: "",
        template: `modules/${MODULE_ID}/templates/columns/loot-take.hbs`
      };
      // A looter reads the chest to decide what is worth carrying: what it's worth, what it
      // weighs, how many there are, and a way to take it. The system's own quantity column
      // is a live +/- editor and its charges column is about using an item you already own
      // — neither means anything to someone standing over a chest. The GM keeps the
      // editable quantity and the controls menu, which is how a chest gets stocked.
      //
      // Setting the list on EVERY section also settles nested bags: dnd5e gives the
      // Containers section a capacity meter instead of ordinary columns, which left a bag
      // sitting in a chest misaligned against the loot around it.
      const columns = game.user.isGM
        ? [value, "weight", "quantity", "controls"]
        : [value, "weight", qty, take];
      sections.forEach(s => s.columns = columns);
    }

    /** @inheritDoc */
    async _prepareInventoryContext(context, options) {
      context = await super._prepareInventoryContext(context, options);
      for (const item of this.actor.items) {
        const ctx = context.itemContext?.[item.id];
        if (!ctx) continue;
        const value = priceInCopper(item);
        ctx.loot = {
          valueLabel: value > 0 ? formatCopper(value) : "",
          qtyLabel: String(Math.floor(item.system.quantity ?? 0))
        };
        // The section change above is only half of it: dnd5e also stamps a per-ROW column
        // override (capacity + controls) onto every container item. Drop it so each row
        // falls back to the section's columns, which is what makes the grid line up.
        delete ctx.columns;
      }
      // Clicking a row in a chest you don't own should OPEN the item to read it, not try
      // to use it — using needs ownership and fails with a permissions error.
      if (!this.document.isOwner && !game.user.isGM) {
        for (const ctx of Object.values(context.itemContext ?? {})) {
          ctx.clickAction = "view";
          // Nobody swings a sword while it is still in the chest. Activity buttons would
          // try to USE the item, which needs ownership and fails the same way.
          ctx.activities = [];
        }
      }
      return context;
    }

    /**
     * The one line under the chest's name, mirroring the shelf's.
     *
     * A shop's subtitle writes itself from the deal on offer; a chest has no deal, so the
     * default is what the chest is WORTH — "7 items · 2,980 gp all told" — which is the
     * thing a party actually asks. A GM who wants to say something else (what it looks
     * like, who it belonged to, that it is trapped) types over it, and that note then shows
     * to everyone. The auto-summary stays as the input's placeholder so the GM can always
     * see what players are reading when no note is set.
     */
    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const note = this.config.note ?? "";
      context.loot = {
        isGM: game.user.isGM,
        note,
        summary: this.#summary,
        subtitle: note.trim() || this.#summary
      };
      return context;
    }

    /** @inheritDoc */
    async _preparePartContext(partId, context, options) {
      context = await super._preparePartContext(partId, context, options);
      if (partId === "inventory") return this._prepareInventoryContext(context, options);
      return context;
    }

    /**
     * dnd5e floats a "create item" button in the corner of every editable primary sheet.
     * A loot container is stocked by dragging real items into it — minting a blank one
     * inside a chest is never what someone means — so drop it. Removing the element
     * rather than hiding it in CSS keeps it out of the tab order too.
     */
    async _onFirstRender(context, options) {
      await super._onFirstRender(context, options);
      this.element.querySelector(".create-child")?.remove();
    }

    /** @inheritDoc */
    async _onRender(context, options) {
      await super._onRender(context, options);
      trimSheetChrome(this.element);
      this.#renderTakeCurrency();
      this.#bindNote();
    }

    /**
     * A "Take" at the end of the coin row. Coin is the one thing in a chest with no row of
     * its own, so before this there was simply no way for a player to pick it up — the
     * currency boxes are read-only to anyone who doesn't own the chest. Injected rather
     * than templated because the coin row comes from the system's inventory partial.
     *
     * Takes the WHOLE purse for now; splitting it is a later conversation.
     */
    #renderTakeCurrency() {
      if (game.user.isGM) return;
      const currency = this.element.querySelector(".inventory-element > .currency");
      if (!currency) return;
      const amount = totalCopper(this.actor.system?.currency);
      const button = document.createElement("button");
      button.type = "button";
      // `always-interactive` is required, not decorative: a looter does not own the chest,
      // so the sheet renders read-only and every control without it is disabled.
      button.className = "lootshelf-action-button lootshelf-take-currency always-interactive";
      button.dataset.action = "takeCurrency";
      // Kept in place and greyed when the chest is broke, rather than vanishing: the row
      // Take buttons hold their lane whatever the row says, and a control that disappears
      // reads as "this chest works differently" instead of "there is nothing here".
      button.disabled = amount <= 0;
      button.dataset.tooltip = amount > 0
        ? `Take ${formatCopper(amount)}`
        : "There is no coin in here.";
      button.setAttribute("aria-label", amount > 0
        ? `Take the coin from ${this.actor.name}`
        : "No coin to take");
      button.innerHTML = '<i class="fa-solid fa-coins" inert></i><span>Take</span>';
      currency.append(button);
    }

    /**
     * Persist the GM's subtitle note. This is deliberately NOT a plain form field: dnd5e
     * opens these sheets un-editable (the lock in the frame governs it), so a `name="..."`
     * input would neither submit nor even render enabled. Writing the flag directly is
     * always allowed for a GM and sidesteps the sheet's edit mode entirely.
     */
    #bindNote() {
      const input = this.element.querySelector(".lootshelf-note");
      if (!input) return;
      input.addEventListener("change", () => {
        const value = input.value.trim();
        this.actor.setFlag(MODULE_ID, "container.note", value)
          .catch(err => {
            console.error(`${MODULE_ID} | saving the container note failed`, err);
            ui.notifications.error("Loot Shelf: that note could not be saved.");
          });
      });
    }

    /**
     * Fail open (family convention). A render rejection here is otherwise INVISIBLE: the
     * double-click handler never awaits the promise, so a throw becomes an unhandled
     * rejection in the console and the token just looks dead. Surface it, then hand the
     * actor to the system's own sheet so the GM can still get at the loot.
     */
    async render(options, _options) {
      try {
        return await super.render(options, _options);
      } catch (err) {
        console.error(`${MODULE_ID} | container sheet render failed; falling back to the `
          + "system sheet", err);
        ui.notifications.error(
          `Loot Shelf: the container sheet failed to render (${err.message}). `
          + "Opening the default sheet instead — see the console (F12) for details.");
        const registered = CONFIG.Actor.sheetClasses?.[this.document.type] ?? {};
        const fallback = Object.values(registered).find(s => s.default && s.cls !== this.constructor)
          ?? Object.values(registered).find(s => s.cls !== this.constructor);
        if (!fallback) return this;
        return new fallback.cls({ document: this.document }).render({ force: true });
      }
    }

    /* ---------------------------------------------- */
    /*  Taking                                        */
    /* ---------------------------------------------- */

    /**
     * Take loot without dragging. The drag-out path still exists and still works — this is
     * the same operation behind a button, because "drag the row onto your character sheet"
     * is only discoverable if you already know it, and it needs both windows open.
     *
     * Routed through the kernel's `takeFromContainer` exactly like the drag, so an unowned
     * chest is re-validated GM-side rather than trusted here.
     */
    static async #onTake(event, target) {
      const item = this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId);
      if (!item) return;
      const looter = this.looter;
      if (!looter) {
        return void ui.notifications.warn("Loot Shelf: assign a character to your user "
          + "(or select a token you own) before taking loot.");
      }
      const max = Math.max(1, Math.floor(item.system.quantity ?? 1));
      const esc = Handlebars.escapeExpression;
      const qtyField = max > 1
        ? `<div class="form-group"><label>Quantity</label><div class="form-fields">`
          + `<input type="number" name="qty" value="${max}" min="1" max="${max}" autofocus>`
          + `</div><p class="hint">Up to ${max}.</p></div>`
        : "";
      const destinations = this.#destinations(looter);
      const prompt = destinations.length > 1
        ? `Take <strong>${esc(item.name)}</strong> — for ${esc(looter.name)}, or into the party's stash?`
        : `Give <strong>${esc(item.name)}</strong> to ${esc(looter.name)}.`;
      const result = await foundry.applications.api.DialogV2.wait({
        classes: ["lootshelf-dialog"],
        window: { title: `Take from ${this.actor.name}` },
        content: `<p>${prompt}</p>${qtyField}`,
        buttons: this.#destinationButtons(destinations, looter, button =>
          Math.max(1, Math.min(max, Math.floor(button.form?.elements?.qty?.valueAsNumber || max)))),
        rejectClose: false
      });
      if (!result || typeof result !== "object") return;
      try {
        const res = await gmRequest("takeFromContainer", {
          containerUuid: this.actor.uuid,
          actorUuid: result.destUuid,
          itemId: item.id,
          quantity: result.qty || 1
        });
        const dest = await fromUuid(result.destUuid);
        ui.notifications.info(`Took ${res.quantity} × ${res.name} for ${dest?.name ?? "you"}.`);
      } catch (err) {
        ui.notifications.warn(err.message);
      }
      this.render();
    }

    /** Empty the chest's purse into the looter's. Confirmed, because it is all-or-nothing. */
    static async #onTakeCurrency(event, target) {
      const looter = this.looter;
      if (!looter) {
        return void ui.notifications.warn("Loot Shelf: assign a character to your user "
          + "(or select a token you own) before taking coin.");
      }
      const amount = totalCopper(this.actor.system?.currency);
      if (amount <= 0) return void ui.notifications.warn(`${this.actor.name} has no coin.`);
      const esc = Handlebars.escapeExpression;
      const destinations = this.#destinations(looter);
      const prompt = destinations.length > 1
        ? `Take all <strong>${formatCopper(amount)}</strong> — for ${esc(looter.name)}, `
          + "or into the party's stash?"
        : `Give all <strong>${formatCopper(amount)}</strong> to ${esc(looter.name)}?`;
      const result = await foundry.applications.api.DialogV2.wait({
        classes: ["lootshelf-dialog"],
        window: { title: `Take coin from ${this.actor.name}` },
        content: `<p>${prompt}</p>`,
        buttons: this.#destinationButtons(destinations, looter),
        rejectClose: false
      });
      if (!result || typeof result !== "object") return;
      try {
        const res = await gmRequest("takeCurrencyFromContainer", {
          containerUuid: this.actor.uuid,
          actorUuid: result.destUuid
        });
        const dest = await fromUuid(result.destUuid);
        ui.notifications.info(`Took ${formatCopper(res.amount)} for ${dest?.name ?? "you"}.`);
      } catch (err) {
        ui.notifications.warn(err.message);
      }
      this.render();
    }
  }

  DocumentSheetConfig.registerSheet(Actor, MODULE_ID, LootContainerSheet, {
    types: ["npc"],
    label: "Loot Shelf: Container",
    makeDefault: false
  });
});

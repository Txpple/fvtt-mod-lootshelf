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

import { MODULE_ID } from "./transfer.js";

export const SHEET_CLASS_ID = `${MODULE_ID}.LootContainerSheet`;

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
      classes: ["group", "lootshelf-container"],
      position: { width: 580, height: 640 },
      // No title-bar icon: dnd5e sheets hide the window title, so an icon just floats
      // alone in the middle of the header bar with nothing to label.
      window: { icon: "" }
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
          "systems/dnd5e/templates/inventory/encumbrance.hbs"
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

    /** @override */
    async _configureInventorySections(sections) {
      sections.forEach(s => s.minWidth = 200);
      // A nested bag on a character is a sub-inventory you drill into, so dnd5e gives the
      // Containers section a capacity meter instead of the usual columns. Inside a loot
      // container a bag is just another thing to carry off, so it should line up with
      // everything else. Borrow the contents section's own column list rather than naming
      // columns here, so this tracks whatever the system considers standard.
      const Inventory = customElements.get(this.options.elements.inventory);
      const standard = Inventory?.SECTIONS?.contents?.columns;
      const containers = sections.find(s => s.id === "containers");
      if (containers && standard) containers.columns = [...standard];
    }

    /** @inheritDoc */
    async _prepareInventoryContext(context, options) {
      context = await super._prepareInventoryContext(context, options);
      // The section change above is only half of it: dnd5e also stamps a per-ROW column
      // override (capacity + controls) onto every container. Drop it so each row falls
      // back to the section's columns, which is what makes the grid line up.
      for (const container of context.containers ?? []) {
        delete context.itemContext?.[container.id]?.columns;
      }
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
  }

  DocumentSheetConfig.registerSheet(Actor, MODULE_ID, LootContainerSheet, {
    types: ["npc"],
    label: "Loot Shelf: Container",
    makeDefault: false
  });
});

/**
 * Loot Shelf — the GM configuration dialog.
 *
 * One DialogV2 form per actor covering both roles (merchant and/or loot container), built
 * from native form-groups and the core `<file-picker>` element — no custom application.
 * Saving writes the whole `flags.fvtt-mod-lootshelf` branch; the container art hooks in
 * container.js react to the flag update and swap token art on their own.
 */

import { MODULE_ID } from "./transfer.js";
import { sheetClassUpdate } from "./container.js";

const esc = s => Handlebars.escapeExpression(s ?? "");

function checkboxRow(name, label, checked, hint) {
  return `<div class="form-group"><label>${label}</label>`
    + `<input type="checkbox" name="${name}" ${checked ? "checked" : ""}>`
    + (hint ? `<p class="hint">${hint}</p>` : "") + `</div>`;
}

function numberRow(name, label, value, hint) {
  return `<div class="form-group"><label>${label}</label>`
    + `<input type="number" name="${name}" value="${value}" step="0.05" min="0">`
    + (hint ? `<p class="hint">${hint}</p>` : "") + `</div>`;
}

function pickerRow(name, label, value) {
  return `<div class="form-group"><label>${label}</label><div class="form-fields">`
    + `<file-picker name="${name}" type="imagevideo" value="${esc(value)}"></file-picker>`
    + `</div></div>`;
}

/** Open the Loot Shelf configuration dialog for an actor (GM only). */
export async function configure(actor) {
  if (!game.user.isGM) return void ui.notifications.warn("Loot Shelf: GM only.");
  const m = actor.getFlag(MODULE_ID, "merchant") ?? {};
  const c = actor.getFlag(MODULE_ID, "container") ?? {};

  const content = `
    <fieldset>
      <legend>Merchant shelf</legend>
      ${checkboxRow("merchant.enabled", "Enabled", m.enabled,
        "Players double-click the token to browse and buy.")}
      ${numberRow("merchant.priceModifier", "Price modifier", m.priceModifier ?? 1,
        "Shelf price = item price × this.")}
      ${numberRow("merchant.sellModifier", "Buyback modifier", m.sellModifier ?? 0.5,
        "What the merchant pays when players sell to them.")}
      ${checkboxRow("merchant.infiniteStock", "Infinite stock &amp; coin", m.infiniteStock,
        "Stock never depletes and the merchant always has money.")}
    </fieldset>
    <fieldset>
      <legend>Loot container</legend>
      ${checkboxRow("container.enabled", "Enabled", c.enabled,
        "Owners loot through the normal sheet; drags out move instead of copy.")}
      ${pickerRow("container.imgClosed", "Closed art", c.imgClosed)}
      ${pickerRow("container.imgOpen", "Open art", c.imgOpen)}
      ${pickerRow("container.imgEmpty", "Empty art", c.imgEmpty)}
      ${checkboxRow("container.opened", "Opened", c.opened,
        "Flips automatically the first time a player opens it — untick to reset the lid.")}
    </fieldset>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: `Loot Shelf — ${actor.name}`, icon: "fa-solid fa-box-open" },
    position: { width: 480 },
    content,
    buttons: [
      {
        action: "save", label: "Save", icon: "fa-solid fa-check", default: true,
        callback: (event, button) => {
          const FDE = foundry.applications.ux?.FormDataExtended ?? globalThis.FormDataExtended;
          return new FDE(button.form).object;
        }
      },
      { action: "cancel", label: "Cancel" }
    ],
    rejectClose: false
  });
  if (!result || result === "cancel") return;
  const flags = foundry.utils.expandObject(result);
  await actor.update({
    [`flags.${MODULE_ID}`]: flags,
    ...sheetClassUpdate(actor, !!flags.container?.enabled)
  });
}

/**
 * Loot Shelf — the GM configuration dialog.
 *
 * One DialogV2 form per actor, built from native form-groups — no custom application.
 *
 * An actor is a shop or a chest, never both, so the form is a single enable switch plus a
 * ROLE RADIO rather than two independent checkboxes. The old shape let a GM tick both and
 * then quietly resolved the conflict behind their back (`desiredSheet` preferred merchant),
 * which is the kind of state that is only discovered when a chest inexplicably has prices.
 * The radio makes the exclusivity a property of the form instead of a tie-break rule.
 *
 * The stored FLAGS keep their two-branch shape (`merchant.enabled` / `container.enabled`)
 * — the radio is a constraint on what the dialog can write, not a schema change. That
 * keeps every already-flagged actor in the world valid and leaves the public API alone.
 */

import { MODULE_ID } from "./transfer.js";
import { sheetClassUpdate } from "./sheets.js";

const esc = s => Handlebars.escapeExpression(s ?? "");

/** Keys the v0.1 art state machine wrote. Swept on save; see container.js. */
const RETIRED_CONTAINER_KEYS = ["imgClosed", "imgOpen", "imgEmpty", "opened"];

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

function radioRow(name, label, options, selected, hint) {
  const choices = options.map(o =>
    `<label class="checkbox"><input type="radio" name="${name}" value="${o.value}"`
    + `${o.value === selected ? " checked" : ""}> ${esc(o.label)}</label>`).join("");
  return `<div class="form-group" data-role-choice><label>${label}</label>`
    + `<div class="form-fields lootshelf-roles">${choices}</div>`
    + (hint ? `<p class="hint">${hint}</p>` : "") + `</div>`;
}

/** A finite number from a form value, or the fallback. Keeps a deliberate 0 intact. */
function num(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

/** Open the Loot Shelf configuration dialog for an actor (GM only). */
export async function configure(actor) {
  if (!game.user.isGM) return void ui.notifications.warn("Loot Shelf: GM only.");
  const m = actor.getFlag(MODULE_ID, "merchant") ?? {};
  const c = actor.getFlag(MODULE_ID, "container") ?? {};
  const role = m.enabled ? "merchant" : "container";

  const content = `
    ${checkboxRow("lsEnabled", "Loot Shelf enabled", m.enabled || c.enabled,
      "Off leaves the actor completely alone — its normal sheet, its normal permissions.")}
    ${radioRow("role", "This actor is a", [
      { value: "container", label: "Loot container" },
      { value: "merchant", label: "Merchant shelf" }
    ], role, "Players double-click the token either way: a chest to take from, a shop to buy from.")}
    <fieldset data-container-fields>
      <legend>Loot container</legend>
      ${checkboxRow("ephemeral", "Disappears when emptied", c.ephemeral,
        "Once players have taken everything — items and coin — the token is removed from "
        + "the map. On by default for containers made by dropping an item on the canvas, "
        + "off for chests you place yourself.")}
    </fieldset>
    <fieldset data-merchant-fields>
      <legend>Merchant pricing</legend>
      ${numberRow("priceModifier", "Price modifier", m.priceModifier ?? 1,
        "Shelf price = item price × this.")}
      ${numberRow("sellModifier", "Buyback modifier", m.sellModifier ?? 0.5,
        "What the merchant pays when players sell to them.")}
      ${checkboxRow("infiniteStock", "Infinite stock &amp; coin", m.infiniteStock,
        "Stock never depletes and the merchant always has money.")}
    </fieldset>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: `Loot Shelf — ${actor.name}`, icon: "fa-solid fa-box-open" },
    position: { width: 480 },
    content,
    // Each role's settings only exist for that role, so show one block or the other —
    // and neither when Loot Shelf is switched off for this actor.
    render: (event, dialog) => {
      const form = dialog.element.querySelector("form") ?? dialog.element;
      const sync = () => {
        const on = !!form.elements.lsEnabled?.checked;
        const isMerchant = form.elements.role?.value === "merchant";
        form.querySelector("[data-merchant-fields]")?.toggleAttribute("hidden", !(on && isMerchant));
        form.querySelector("[data-container-fields]")?.toggleAttribute("hidden", !(on && !isMerchant));
        for (const input of form.querySelectorAll("[data-role-choice] input")) input.disabled = !on;
      };
      form.addEventListener("change", sync);
      sync();
    },
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
  if (!result || typeof result !== "object") return;

  const on = !!result.lsEnabled;
  const picked = result.role === "merchant" ? "merchant" : "container";
  const flags = {
    merchant: {
      enabled: on && picked === "merchant",
      priceModifier: num(result.priceModifier, 1),
      sellModifier: num(result.sellModifier, 0.5),
      infiniteStock: !!result.infiniteStock
    },
    container: {
      enabled: on && picked === "container",
      ephemeral: !!result.ephemeral
    }
  };

  // Flag updates MERGE, so the retired art keys would linger on any actor configured
  // before v0.2. Clear them here — every such actor passes through this dialog eventually,
  // and a stale `imgClosed` no code reads is exactly the debris that makes a flag branch
  // hard to trust later.
  const sweep = {};
  for (const key of RETIRED_CONTAINER_KEYS) sweep[`flags.${MODULE_ID}.container.-=${key}`] = null;

  await actor.update({
    [`flags.${MODULE_ID}`]: flags,
    ...sweep,
    ...sheetClassUpdate(actor, flags)
  });
}

/**
 * Loot Shelf — the Receipt Settings block on the module's settings sheet.
 *
 * The policy itself lives with the audit line in transfer.js, which is the kernel and
 * imports nothing; this file is the UI half, and imports from there. The choice is rendered
 * as a labelled RADIO GROUP rather than the dropdown a `choices` setting gets by default:
 * two mutually exclusive policies with a paragraph of consequence each is exactly what
 * radios are for, and a `<select>` has nowhere to put the consequences.
 *
 * The registered `<select>` stays in the form as the real field, merely hidden. It is what
 * core reads on submit and what core's "Reset Defaults" writes to — that handler dispatches
 * a `change` event on `form[key]`, which would throw on the RadioNodeList that same-named
 * radios would make of it. The radios carry no submitting name of their own: they drive the
 * select, and follow it back when something else changes it. So if this whole file failed,
 * the setting would degrade to a plain working dropdown — the same graceful-degradation rule
 * the merchant sheet's render callbacks follow.
 */

import { MODULE_ID, RECEIPT_SETTING, RECEIPT_MODES } from "./transfer.js";

Hooks.on("renderSettingsConfig", (app, element) => {
  try {
    const el = element instanceof HTMLElement ? element : element?.[0];
    const select = el?.querySelector(`select[name="${MODULE_ID}.${RECEIPT_SETTING}"]`);
    if (!select || select.dataset.lootshelfRadios) return;
    select.dataset.lootshelfRadios = "true";
    select.hidden = true;

    // The module's settings render in registration order, and the kernel is imported first —
    // which would put Receipt Settings above the shop and chest toggles. Move the group to the
    // end of the module's own section instead, then chapter the section with headers, so the
    // page reads the same however the imports are later rearranged.
    const group = select.closest(".form-group");
    const section = group?.closest("section[data-category]");
    const divider = text => {
      const header = document.createElement("h4");
      header.className = "divider";
      header.textContent = text;
      return header;
    };
    if (section && group) {
      section.append(group);
      const first = section.querySelector(".form-group");
      if (first && first !== group) first.before(divider("Shop & Chest Behavior"));
    }
    group?.before(divider("Receipt Settings"));

    const radios = document.createElement("div");
    radios.className = "lootshelf-receipt-modes";
    for (const mode of RECEIPT_MODES) {
      const label = document.createElement("label");
      label.className = "checkbox";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `${MODULE_ID}.${RECEIPT_SETTING}.choice`; // unregistered: ignored on submit
      input.value = mode.value;
      input.checked = select.value === mode.value;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        select.value = mode.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      label.append(input, document.createTextNode(` ${mode.label}`));
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = mode.note;
      radios.append(label, note);
    }
    select.after(radios);

    // Follow the select rather than owning the state, so "Reset Defaults" — and any other
    // core path that rewrites the field — keeps the radios honest.
    select.addEventListener("change", () => {
      for (const input of radios.querySelectorAll("input")) input.checked = input.value === select.value;
    });
  } catch (err) {
    console.error(`${MODULE_ID} | rendering the Receipt Settings block failed — the choice `
      + "stays available as a dropdown", err);
  }
});

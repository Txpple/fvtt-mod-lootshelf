/**
 * Loot Shelf — which sheet an actor should be wearing.
 *
 * Both roles swap the actor onto one of our sheets via `flags.core.sheetClass`, and an
 * actor can carry both flags, so the choice lives in one place instead of two modules
 * racing to write the same field. A shopkeeper who also holds loot is still a shop: the
 * merchant sheet wins, and it shows the GM everything anyway.
 *
 * Turning a role off only clears the flag when it currently points at one of OUR sheets —
 * a sheet the GM chose deliberately (including an explicit reset to the system default,
 * which stores an empty string) is never clobbered.
 */

import { MODULE_ID } from "./transfer.js";

export const CONTAINER_SHEET_ID = `${MODULE_ID}.LootContainerSheet`;
export const MERCHANT_SHEET_ID = `${MODULE_ID}.MerchantShelfSheet`;

const OURS = new Set([CONTAINER_SHEET_ID, MERCHANT_SHEET_ID]);

/** The sheet id an actor with these Loot Shelf flags should use, or null for "not ours". */
export function desiredSheet(flags = {}) {
  if (flags.merchant?.enabled) return MERCHANT_SHEET_ID;
  if (flags.container?.enabled) return CONTAINER_SHEET_ID;
  return null;
}

/**
 * The `flags.core.sheetClass` fragment to merge into an actor update.
 * @param {Actor} actor   The actor being updated.
 * @param {object} flags  The module flag branch as it will be AFTER the update.
 * @returns {object}      An update fragment, possibly empty.
 */
export function sheetClassUpdate(actor, flags = {}) {
  const want = desiredSheet(flags);
  const current = actor.getFlag("core", "sheetClass");
  if (want) return current === want ? {} : { "flags.core.sheetClass": want };
  return OURS.has(current) ? { "flags.core.-=sheetClass": null } : {};
}

/** True when the actor has never had a sheet chosen for it — safe to adopt at startup. */
export function sheetUnset(actor) {
  return actor.getFlag("core", "sheetClass") === undefined;
}

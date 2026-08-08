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

/**
 * Chrome both Loot Shelf sheets drop, re-applied after every render.
 *
 * - The CURRENCY MANAGER button, which dnd5e puts at the head of the coin row. On a chest
 *   or a shelf that row is a readout of what is lying there, not a wallet to reorganise.
 * - The EQUIP / ATTUNE / PREPARE controls. dnd5e's controls cell renders edit+delete when
 *   the sheet is editable and these three when it is merely owned — which is what a GM
 *   gets here by default. Nobody wears the shop's stock or attunes to loot that is still
 *   sitting in the chest, and on a merchant equipping actively removes goods from sale.
 *
 * Removed from the DOM rather than hidden in CSS so they stay out of the tab order, the
 * same reasoning that applies to `.create-child` on both sheets.
 */
/* -------------------------------------------------- */
/*  Reach                                             */
/* -------------------------------------------------- */

export const REACH_SETTING = "requireAdjacency";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, REACH_SETTING, {
    name: "Players must stand next to a shop or chest",
    hint: "A player has to have a token beside the shop or chest to open it — diagonals "
      + "count. GMs are never restricted, and neither is anyone on a scene where the "
      + "distance cannot be measured. Turn this off for theatre-of-the-mind play.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

/** A token's footprint in pixels, from the DOCUMENT rather than the placeable's PIXI bounds. */
function footprint(token, gridSize) {
  const d = token.document;
  return { x: d.x, y: d.y, w: (d.width ?? 1) * gridSize, h: (d.height ?? 1) * gridSize };
}

/**
 * The gap between two token footprints, per axis, in pixels. Zero on an axis means they
 * touch or overlap along it. Edge-to-edge rather than centre-to-centre so a Large chest
 * is reachable from any square around it, not only from within one square of its middle.
 */
function edgeGap(a, b) {
  return {
    dx: Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)),
    dy: Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h))
  };
}

/**
 * Is this user standing next to `actor`, close enough to open it?
 *
 * "Next to" is a gap of less than one grid square on both axes, which makes touching
 * tokens adjacent — diagonals included, since a corner touch is a zero gap — and puts a
 * token with a full empty square between them out of reach. The sub-square threshold is
 * deliberate slack for tokens that were never snapped to the grid.
 *
 * FAILS OPEN whenever the distance cannot be honestly measured: no canvas, the actor has
 * no token on this scene, or the user has none. The alternative is locking a player out of
 * a shop for reasons they cannot see or fix, and looking inside is the unguarded half of
 * this module anyway — taking is what the kernel checks, and it checks it GM-side.
 */
export function canReachActor(actor) {
  try {
    if (game.user.isGM) return true;
    if (!game.settings.get(MODULE_ID, REACH_SETTING)) return true;
    if (!canvas?.ready || !canvas.scene) return true;
    const gridSize = canvas.scene.grid?.size;
    if (!gridSize) return true;

    const placeables = canvas.tokens?.placeables ?? [];
    const targets = placeables.filter(t => t.actor === actor || t.document?.actorId === actor?.id);
    const mine = placeables.filter(t => t.actor?.isOwner);
    if (!targets.length || !mine.length) return true;

    return targets.some(target => {
      const a = footprint(target, gridSize);
      return mine.some(token => {
        const { dx, dy } = edgeGap(a, footprint(token, gridSize));
        return dx < gridSize && dy < gridSize;
      });
    });
  } catch (err) {
    console.error(`${MODULE_ID} | reach check failed`, err);
    return true; // never let a broken check be the thing that locks a player out
  }
}

/** Warn, once, that the player is standing too far away. Returns false for convenience. */
export function warnOutOfReach(actor) {
  ui.notifications.warn(`Loot Shelf: you need to be standing next to ${actor.name}.`);
  return false;
}

export function trimSheetChrome(element) {
  if (!element) return;
  element.querySelector('.currency [data-action="currency"]')?.remove();
  for (const action of ["equip", "attune", "prepare"]) {
    for (const button of element.querySelectorAll(`.item-controls [data-action="${action}"]`)) {
      button.remove();
    }
  }
}

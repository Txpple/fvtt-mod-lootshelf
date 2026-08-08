/**
 * Loot Shelf — placeable loot containers.
 *
 * A container is any actor with `flags.fvtt-mod-lootshelf.container.enabled`. The GM
 * grants players ownership, they double-click the token, and a dnd5e-native sheet and
 * the system's own drop pipeline handle the looting. Since v0.2 that sheet is the
 * container sheet (container-sheet.js) — a BaseActorSheet subclass showing only the
 * system's inventory tab, assigned per-actor via `flags.core.sheetClass`. Around that
 * native flow the module adds exactly three things:
 *
 *   1. ART STATES — closed / open / empty images swapped on the container's tokens. The
 *      `opened` flag flips the first time a player renders the sheet; "empty" means no
 *      physical items and no coin. Swaps run only on the GM-elect client (players may
 *      lack token-update rights) and are skipped when the configured art is blank —
 *      fail open, the token just keeps its current look.
 *
 *   2. MOVE-BY-DEFAULT — a drag out of (or into) a container MOVES the item instead of
 *      copying it, via the same dnd5e `BaseActorSheet#_defaultDropBehavior` seam Party
 *      Stash wraps (both wraps chain cleanly in either load order). One-sided ownership
 *      is blocked with a warning rather than silently copying, because a copy out of a
 *      chest the player can't delete from is item duplication. Ctrl-drag still forces a
 *      deliberate copy, Shift-drag still forces a move elsewhere.
 *
 *   3. CLEAN CONTENTS — anything dropped in arrives unattuned/unequipped (normalization
 *      lives in transfer.js), so whatever is taken out is already clean.
 */

import { MODULE_ID, isPhysical, totalCopper, stockItems } from "./transfer.js";
import { SHEET_CLASS_ID } from "./container-sheet.js";

/* -------------------------------------------------- */
/*  Flags & state                                     */
/* -------------------------------------------------- */

export function isContainer(actor) {
  return !!actor?.flags?.[MODULE_ID]?.container?.enabled;
}

/** No physical items with quantity and no coin — time for the empty art. */
export function isEmptyContainer(actor) {
  const hasLoot = actor.items.some(i => isPhysical(i) && (i.system.quantity ?? 1) > 0);
  return !hasLoot && totalCopper(actor.system?.currency) <= 0;
}

/** The token image the container should be showing right now, or null for "leave it". */
function desiredArt(actor, cfg) {
  if (!cfg.opened) return cfg.imgClosed || null;
  if (cfg.imgEmpty && isEmptyContainer(actor)) return cfg.imgEmpty;
  return cfg.imgOpen || cfg.imgClosed || null;
}

/**
 * Swap every dependent token to the current art state. GM-elect client only: art writes
 * need a SINGLE writer just like the purchase proxy — two GM clients with different
 * hook-processing lag will fight each other with different views of the container's
 * emptiness (verified live: a backgrounded GM tab re-wrote stale art over fresh art).
 * If the elected GM's tab is suspended, swaps simply lag until it wakes or reloads; the
 * flag data is always authoritative, so every fresh load converges to the right art.
 */
export async function applyArt(actor) {
  if (game.users.activeGM !== game.user) return;
  const cfg = actor.getFlag(MODULE_ID, "container");
  if (!cfg?.enabled) return;
  const img = desiredArt(actor, cfg);
  if (!img) return;
  // getDependentTokens also tracks EPHEMERAL TokenDocuments (id: null — byproducts of
  // getTokenDocument and friends); updating one throws synchronously and would kill the
  // loop before any real token got its swap. Only persisted, scene-embedded tokens count.
  const tokens = actor.isToken ? [actor.token] : actor.getDependentTokens();
  for (const token of tokens) {
    if (!token?.id || !token.parent || token.texture?.src === img) continue;
    try {
      // animate: false matters — the token update animation restores a STALE texture
      // when it completes (core #12777 / #12118 family), so an animated swap renders
      // once and then sticks forever. Skipping animation sidesteps the whole bug class.
      await token.update({ "texture.src": img }, { animate: false });
    } catch (err) {
      console.error(`${MODULE_ID} | token art swap failed`, err);
    }
  }
}

function maybeRefreshArt(actor) {
  if (!(actor instanceof Actor) || !isContainer(actor)) return;
  applyArt(actor);
}

Hooks.on("createItem", item => maybeRefreshArt(item.parent));
Hooks.on("updateItem", item => maybeRefreshArt(item.parent));
Hooks.on("deleteItem", item => maybeRefreshArt(item.parent));
Hooks.on("updateActor", actor => maybeRefreshArt(actor));

// One sync pass at startup so world edits made while the GM was away still land. The
// same pass adopts pre-v0.2 containers onto the container sheet — but only ones whose
// core sheet flag is entirely unset, so a sheet the GM explicitly picked (including an
// explicit reset to the system default, which stores "") is never overridden.
Hooks.once("ready", () => {
  if (game.users.activeGM !== game.user) return;
  for (const actor of game.actors) {
    if (!isContainer(actor)) continue;
    applyArt(actor);
    if (actor.getFlag("core", "sheetClass") === undefined) {
      actor.update(sheetClassUpdate(actor, true))
        .catch(err => console.error(`${MODULE_ID} | container sheet adoption failed`, err));
    }
  }
});

// Foundry v14 core bug (#12118): a token's texture.src change only RENDERS the first
// time — later changes update the document but leave stale prepared data until a canvas
// redraw. Scoped workaround: when a container token's texture changes, every client
// re-derives the document and redraws the placeable. Cheap, idempotent, and harmless
// once core fixes it.
Hooks.on("updateToken", (doc, changes) => {
  try {
    if (!foundry.utils.hasProperty(changes, "texture.src")) return;
    if (!isContainer(doc.actor)) return;
    doc.reset();
    doc.object?.renderFlags.set({ redraw: true });
  } catch (err) {
    console.error(`${MODULE_ID} | container token redraw failed`, err);
  }
});

// Fresh tokens start on the right art (runs on the placing client, which has perms).
Hooks.on("preCreateToken", (doc, data, options, userId) => {
  if (userId !== game.user.id) return;
  const cfg = doc.actor?.getFlag(MODULE_ID, "container");
  if (!cfg?.enabled) return;
  const img = desiredArt(doc.actor, cfg);
  if (img) doc.updateSource({ "texture.src": img });
});

/* -------------------------------------------------- */
/*  Opened-on-first-look                              */
/* -------------------------------------------------- */

function onRenderSheet(app) {
  try {
    const actor = app.actor ?? app.document;
    if (!(actor instanceof Actor) || game.user.isGM) return; // GM peeking doesn't open the lid
    const cfg = actor.getFlag(MODULE_ID, "container");
    if (!cfg?.enabled || cfg.opened || !actor.isOwner) return;
    actor.setFlag(MODULE_ID, "container.opened", true)
      .catch(err => console.error(`${MODULE_ID} | failed to mark container opened`, err));
  } catch (err) {
    console.error(`${MODULE_ID} | opened-state check failed`, err);
  }
}
// AppV2 fires render hooks down the inheritance chain; register the stable names plus the
// V1 fallback. The handler is idempotent, so double fires are harmless.
for (const hook of ["renderActorSheetV2", "renderBaseActorSheet", "renderActorSheet"]) {
  Hooks.on(hook, onRenderSheet);
}

/* -------------------------------------------------- */
/*  Move-by-default drops (the Party Stash seam)      */
/* -------------------------------------------------- */

/** Recently-warned blocked drags, keyed "itemUuid->targetUuid" -> timestamp. */
const warned = new Map();
function warnThrottled(key, message) {
  const now = Date.now();
  if (now - (warned.get(key) ?? 0) < 4000) return;
  warned.set(key, now);
  for (const [k, t] of warned) if (now - t > 60000) warned.delete(k);
  ui.notifications.warn(message);
}

/**
 * Judge a drag against container scope. "move" when a flagged container is on one end and
 * the user owns both actors; "block" when a container is involved but only one side is
 * owned (a copy would duplicate loot); null when out of scope.
 */
function containerVerdict(sheet, event, data) {
  if (data?.type !== "Item" || !data.uuid) return null;
  const item = fromUuidSync(data.uuid);
  const source = item?.parent;
  if (!(item instanceof Item) || !(source instanceof Actor)) return null;
  if (!item.system?.schema?.fields?.quantity) return null; // physical items only
  const target = sheet.inventorySource ?? sheet.actor;
  if (!(target instanceof Actor) || target === source) return null;
  if (!isContainer(source) && !isContainer(target)) return null;

  if (source.isOwner && target.isOwner) return "move";

  const unowned = source.isOwner ? target : source;
  warnThrottled(`${data.uuid}->${target.uuid}`,
    `Loot Shelf: you don't own ${unowned.name}, so this drag would leave a duplicate behind `
    + "and was blocked. Ask the GM for ownership of the container, or hold Ctrl to copy on purpose.");
  return "block";
}

Hooks.once("setup", () => {
  const Base = globalThis.dnd5e?.applications?.actor?.BaseActorSheet;
  const orig = Base?.prototype?._defaultDropBehavior;
  if (!orig) {
    console.error(`${MODULE_ID} | dnd5e BaseActorSheet#_defaultDropBehavior not found — `
      + "container move semantics disabled (dnd5e 5.x required).");
    return;
  }
  Base.prototype._defaultDropBehavior = function (event, data) {
    const fallback = orig.call(this, event, data);
    if (fallback !== "copy") return fallback; // never touch same-sheet sorting etc.
    try {
      const verdict = containerVerdict(this, event, data);
      if (verdict === "move") return "move";
      if (verdict === "block") return "none"; // no-drop cursor; the drop never lands
    } catch (err) {
      console.error(`${MODULE_ID} | drop-behavior check failed`, err);
    }
    return fallback;
  };
});

/* -------------------------------------------------- */
/*  Setup API                                         */
/* -------------------------------------------------- */

/**
 * The `flags.core.sheetClass` update that keeps a container on the Loot Shelf sheet:
 * assign it when the role turns on, and hand the actor back to the system default when
 * it turns off (but never clobber some OTHER custom sheet the GM picked deliberately).
 */
export function sheetClassUpdate(actor, enabled) {
  const current = actor.getFlag("core", "sheetClass");
  if (enabled) return current === SHEET_CLASS_ID ? {} : { "flags.core.sheetClass": SHEET_CLASS_ID };
  return current === SHEET_CLASS_ID ? { "flags.core.-=sheetClass": null } : {};
}

/** Flag (or reconfigure) an existing actor as a loot container. */
export async function setContainer(actor, { enabled = true, imgClosed, imgOpen, imgEmpty, opened } = {}) {
  const cfg = { ...(actor.getFlag(MODULE_ID, "container") ?? {}), enabled };
  if (imgClosed !== undefined) cfg.imgClosed = imgClosed;
  if (imgOpen !== undefined) cfg.imgOpen = imgOpen;
  if (imgEmpty !== undefined) cfg.imgEmpty = imgEmpty;
  if (opened !== undefined) cfg.opened = !!opened;
  await actor.update({
    [`flags.${MODULE_ID}.container`]: cfg,
    ...sheetClassUpdate(actor, enabled)
  });
  return cfg;
}

/**
 * Create a ready-to-place loot container actor. `items` accepts Item uuids (compendium or
 * world) and/or plain item data. Ownership stays at the world default unless
 * `defaultOwnership` (a CONST.DOCUMENT_OWNERSHIP_LEVELS value) is passed.
 */
export async function createLootContainer({
  name = "Loot Chest", img, imgClosed, imgOpen, imgEmpty, opened = false,
  items = [], folder = null, defaultOwnership
} = {}) {
  const closed = imgClosed ?? img ?? "icons/svg/item-bag.svg";
  const data = {
    name,
    type: "npc",
    img: img ?? closed,
    folder,
    prototypeToken: {
      name,
      actorLink: true,
      disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
      texture: { src: closed }
    },
    flags: {
      core: { sheetClass: SHEET_CLASS_ID },
      [MODULE_ID]: {
        container: { enabled: true, imgClosed: closed, imgOpen: imgOpen ?? "", imgEmpty: imgEmpty ?? "", opened }
      }
    }
  };
  if (defaultOwnership !== undefined) data.ownership = { default: defaultOwnership };
  const actor = await Actor.implementation.create(data);
  await stockItems(actor, items);
  return actor;
}

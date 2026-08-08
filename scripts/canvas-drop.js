/**
 * Loot Shelf — drop an item on the map to leave it lying there.
 *
 * Drag an item out of a compendium or the Items sidebar onto the scene and it becomes a
 * loot container at that spot: an actor named and illustrated after the item, flagged as a
 * container, holding a copy of it. The Item Piles gesture, which design.md previously
 * recorded as deliberate non-parity — the owner reversed that on 2026-08-08 because it is
 * the one Item Piles habit worth keeping.
 *
 * TWO DELIBERATE LIMITS.
 *
 * GM ONLY. Players cannot create actors at all (`ACTOR_CREATE` is false below assistant),
 * so this would need a kernel op to work for them — and a player able to spawn chests
 * anywhere on the map is not a feature. Handled by leaving their drop alone entirely, so
 * whatever stock behavior exists still applies.
 *
 * SOURCE ITEMS ONLY — compendium entries and world items in the sidebar. An item dragged
 * off a CHARACTER'S sheet is ignored and falls through to stock behavior, because copying
 * it here would duplicate loot: the character keeps theirs and a second one appears on the
 * floor. That is precisely the failure `containerVerdict` blocks for chest drags and the
 * `asGear()` workaround exists to undo, and it would be perverse to reintroduce it through
 * a different door. Moving instead was considered and rejected as out of scope for now.
 */

import { MODULE_ID } from "./transfer.js";
import { createLootContainer } from "./container.js";

const SETTING = "canvasDrop";
const FOLDER_NAME = "Loot Shelf";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING, {
    name: "Drop items on the map to make loot",
    hint: "Dragging an item from a compendium or the Items sidebar onto the scene leaves it "
      + "there as a loot container, named and illustrated after the item. GM only; items "
      + "dragged off a character's sheet are left alone. Turn this off to restore the stock "
      + "behavior for canvas drops.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

/**
 * Is this uuid an item embedded on an actor?
 *
 * Tested on the STRING rather than by resolving the document, because the hook has to
 * decide synchronously whether it is claiming the drop, and `fromUuid` is async. Embedded
 * uuids always carry their parent's path — `Actor.abc.Item.def`, or
 * `Scene.s.Token.t.Actor.a.Item.i` for an unlinked token's actor. A compendium or sidebar
 * item never does. The resolved document is re-checked anyway once it loads.
 */
function isActorOwned(uuid) {
  return /(?:^|\.)Actor\.[^.]+\.Item\./.test(uuid ?? "");
}

/** The folder spawned containers live in. Created on first use; failure is not fatal. */
async function lootFolder() {
  const existing = game.folders.find(f => f.type === "Actor" && f.name === FOLDER_NAME);
  if (existing) return existing.id;
  try {
    const folder = await Folder.implementation.create({ name: FOLDER_NAME, type: "Actor" });
    return folder?.id ?? null;
  } catch (err) {
    console.error(`${MODULE_ID} | could not create the "${FOLDER_NAME}" folder`, err);
    return null; // the container still gets made, just at the directory root
  }
}

/**
 * Place the container's token so it sits under the cursor. A token's x/y is its TOP-LEFT
 * corner, so the drop point is offset by half the token before snapping — otherwise every
 * chest lands one half-cell down and to the right of where it was dropped.
 */
function tokenPosition(scene, point, tokenDoc) {
  const size = scene.grid.size;
  const topLeft = {
    x: point.x - (tokenDoc.width ?? 1) * size / 2,
    y: point.y - (tokenDoc.height ?? 1) * size / 2
  };
  try {
    return scene.grid.getSnappedPoint(topLeft, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX });
  } catch (err) {
    console.error(`${MODULE_ID} | grid snapping failed; dropping unsnapped`, err);
    return topLeft;
  }
}

/** Build the container actor and drop its token where the item landed. */
async function spawnLoot(scene, data) {
  const item = await fromUuid(data.uuid);
  if (!(item instanceof Item)) return;
  if (item.parent instanceof Actor) return; // re-check: never duplicate a character's gear
  if (!item.system?.schema?.fields?.quantity) {
    return void ui.notifications.warn(
      `Loot Shelf: ${item.name} isn't a physical item, so it can't be left on the ground.`);
  }

  const actor = await createLootContainer({
    name: item.name,
    img: item.img,
    items: [item.toObject()],
    folder: await lootFolder(),
    // An item dropped on the floor is scenery that exists to be picked up, so once players
    // have taken everything the token removes itself (transfer.js). A chest the GM placed
    // and furnished is a fixture and stays — hence the flag rather than a blanket rule.
    ephemeral: true
  });

  const tokenDoc = await actor.getTokenDocument();
  const position = tokenPosition(scene, { x: data.x, y: data.y }, tokenDoc);
  tokenDoc.updateSource(position);
  await scene.createEmbeddedDocuments("Token", [tokenDoc.toObject()]);
  ui.notifications.info(`Loot Shelf: left ${item.name} on the ground.`);
}

/**
 * Core calls this for anything dropped on the canvas and treats a `false` return as "some
 * handler claimed this drop". Everything that would make us decline is checked
 * synchronously, so the claim is honest — the async work only starts once we have.
 */
Hooks.on("dropCanvasData", (canvas, data) => {
  try {
    if (data?.type !== "Item" || !data.uuid) return;
    if (!game.user.isGM) return;
    if (!game.settings.get(MODULE_ID, SETTING)) return;
    if (isActorOwned(data.uuid)) return;
    const scene = canvas?.scene;
    if (!scene) return;
    spawnLoot(scene, data).catch(err => {
      console.error(`${MODULE_ID} | leaving loot on the canvas failed`, err);
      ui.notifications.error(
        `Loot Shelf: that item could not be left on the ground (${err.message}).`);
    });
    return false;
  } catch (err) {
    console.error(`${MODULE_ID} | canvas drop check failed`, err);
  }
});

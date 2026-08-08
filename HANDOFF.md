# Loot Shelf — handoff (v0.2 uplift, 2026-08-07)

Working state for a fresh session. Branch **`feat/container-sheet-v0.2`**, 8 commits ahead
of `master`, nothing pushed. The commit messages are deliberately detailed — read them
before changing any of the areas below, they record *why* each workaround exists.

## What this session did

Rebuilt both UIs on dnd5e's own sheet framework. The owner's mandate: v0.1 had "blindly
copied Item Piles", which was itself legacy UI; everything must be modern FVTT 13+ /
dnd5e 5.x, reusing the system's components rather than hand-building lookalikes.

- **Container sheet** (`scripts/container-sheet.js`) — a `BaseActorSheet` subclass showing
  the system's inventory tab. Replaces the raw NPC statblock.
- **Merchant shelf** (`scripts/merchant-sheet.js`) — same construction, plus three custom
  inventory COLUMNS (shelf price / stock / Buy, an eye toggle for the GM). Replaces the
  hand-rolled v0.1 window entirely; `templates/merchant-shelf.hbs` is deleted.
- **Sheet assignment** (`scripts/sheets.js`) — both roles swap the actor onto our sheet via
  `flags.core.sheetClass`. Merchant wins if an actor is flagged both.

## Environment

- Local Foundry install, **copy-deploy** (owner explicitly does not want a symlink):
  run `tools/deploy.ps1` from the repo root. World reload (F5) for scripts and CSS; full
  Foundry restart only for `module.json`.
- Live world **"The Broken Heart of Greenrest"** (`localhost:30000`), Foundry 14.365,
  dnd5e 5.3.3. Item Piles is disabled in this world.
- **A Foundry user "Claude" (GM, no password) exists so the assistant can verify its own
  UI work.** Join via the browser tools, resize to >= 1024x768, drive with
  `javascript_tool` (wrap `await` in an IIFE — top-level await is a SyntaxError there).
  Do NOT join as "DM Assistant"; that is the MCP bridge's user and would kick it.

## Verification technique that worked

Screenshots require the Browser pane to be visible on the user's screen, and it renders
scaled, so screenshot pixel coordinates do not match page coordinates. **Measure the DOM
instead** — `getBoundingClientRect()`, `getComputedStyle`, reading
`.item-header[data-column-id]`. That is more precise than eyeballing for CSS work.

To exercise a drag without a mouse, dispatch the real sequence on the real elements and
let Foundry populate the payload: `new DataTransfer()` -> `dragstart` on the source
`.item-row.draggable` -> `dragover` -> `drop` on the target `.inventory-element`.
Hand-building drop data and calling `_onDrop`/`_onDropItem` does not reproduce the real
path. Synthetic events still resolve as "copy" because a real drag's `dropEffect` comes
from modifier keys, so stub `sheet._dropBehavior = () => "move"` to exercise moves.

To see the shopper's view from a GM session:
`Object.defineProperty(game.user, "isGM", {value: false, configurable: true})`, render,
inspect, then `delete game.user.isGM`.

## Landmines found (all worked around, all in commit messages)

1. **Core vs dnd5e `TABS` shape.** Core reads `static TABS` as a record of tab *groups*;
   dnd5e overrides it with an *array*. They only coexist because core auto-prepares tabs
   when `Object.keys(TABS).length === 1` and every system sheet has 2+ tabs. A one-tab
   sheet made core read the tab object as a group config and throw on `tabs.reduce` of
   undefined. Both sheets override `_getTabsConfig` to hand core an empty group.
2. **Column widths come from CSS**, keyed on `.item-<columnId>`, applied to header and row
   cells together. The `width` in a column descriptor is advisory metadata only. Custom
   column ids need matching CSS or they collapse to zero width.
3. **dnd5e's move-delete targets the wrong document.** `_onDropCreateItems` transforms NPC
   gear via `asGear()` — which returns a *clone of the compendium entry* — then deletes
   from the transformed array. Deleting out of a container errored on the locked compendium
   and duplicated the loot. Worked around in `container.js`; **worth reporting upstream**,
   it affects any NPC-to-PC move drag, not just this module.
4. **Foundry checks ownership at every layer independently.** Three separate gates blocked
   players, none visible from a GM session: `Token#_canView` (the double-click event is
   never dispatched), the actor sheet's `viewPermission`, and the *item* sheet's
   `viewPermission` (an embedded item inherits its parent actor's permissions). All three
   are widened for flagged actors only.
5. **Drag permissions are tied to editability**, which is why shoppers could drag goods out
   for free and could not drop items in to sell. Both are now decided by the sheet
   (`_canDragStart` / `_canDragDrop`) rather than by ownership.

## Design decisions the owner made (do not silently revert)

- **No ownership grants for merchants or containers.** Players open both via
  `viewPermission: NONE`. Granting OBSERVER was explicitly rejected: it would put ten shops
  in every player's sidebar. Looking is unguarded; taking is guarded GM-side.
- **Taking from an unowned chest** goes through the kernel op `takeFromContainer`.
  `transferItem` keeps its stricter both-endpoints-owned contract on purpose.
- **Shop funds gate selling.** The owner first said not to track merchant money, then
  reversed. Current behavior: the shelf caps the offered quantity by the shop's purse and
  refuses when it cannot afford one; the kernel enforces the same rule.
- UI trims requested and applied: no tab strip, no create-item button, no window title
  icon, no item property glyphs on the shelf, slim 52px header, currency and search pinned
  while only the list scrolls.

## NOT YET VERIFIED — needs a real player client

Everything below is the reason this branch is not merged. The assistant's session is
itself the elected GM, and Foundry does not loop a socket emit back to its sender, so the
**player -> GM socket hop could not be exercised from here**. That path is unchanged v0.1
code, smoke-tested in the previous release, but these flows are unconfirmed end to end:

1. A player clicking **Buy** on the shelf.
2. A player completing a **sale** by dropping an item on the shelf.
3. A player **dragging loot out of a chest** they do not own (routes through
   `takeFromContainer`).
4. Container **token art** swapping closed/open/empty, and the opened-flag flip on first
   player open — untouched this session but still unverified from v0.1.

If any of those fail, the useful first move is to check the browser console **on the
player's client**, not the GM's; the error is raised there.

## Test fixtures left in the world

- Actor **"Merchant Test"** — flagged merchant, priceModifier 1.2, sellModifier 0.5,
  purse set to 100 gp, stocked with Leather Armor and a Lute (quantity 3 each) purely for
  testing. Delete or repurpose freely.
- Two macros: **"LS: Capture drag error"** (arms a diagnostic that whispers a stack trace)
  and **"LS: Diagnose container sheet"**. Both are debug aids and can be deleted.
- The macro **"LS: Test Chest v0.2"** creates a container through the public API.
- Gren Greenmantle may hold one **Leather Armor** created during earlier testing that could
  not be cleanly separated from the owner's own edits — worth a glance.

## Loose ends

- `module.json` is bumped to **0.2.0** and its `download` URL points at a `v0.2.0` tag that
  does not exist yet. Valid once that release is cut.
- The **loot-split** feature in `design.md` is still unbuilt.
- `design.md` is binding. When in doubt, the answer that keeps Loot Shelf *smaller* wins.

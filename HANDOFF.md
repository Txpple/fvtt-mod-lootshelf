# Loot Shelf — handoff (v0.2, 2026-08-08)

**v0.2 is finished, verified, and merged to `master` (pushed).** The commit messages are
deliberately detailed — read them before changing any of the areas below, they record *why*
each workaround exists. The one thing not yet done is cutting the release: `module.json`
says `0.2.0` and its `download` URL points at a `v0.2.0` tag that does not exist, so the
manifest's update check is broken until that tag and zip exist.

## What v0.2 is

Both UIs rebuilt on dnd5e's own sheet framework. The owner's mandate: v0.1 had "blindly
copied Item Piles", which was itself legacy UI; everything must be modern FVTT 13+ /
dnd5e 5.x, reusing the system's components rather than hand-building lookalikes.

- **Container sheet** (`scripts/container-sheet.js`) — a `BaseActorSheet` subclass showing
  the system's inventory tab. Replaces the raw NPC statblock. Custom columns Value / Qty /
  Take, a Take on the coin row, and a subtitle that defaults to what the chest is worth and
  can be typed over by the GM.
- **Merchant shelf** (`scripts/merchant-sheet.js`) — same construction, plus three custom
  inventory COLUMNS (shelf price / stock / Buy, an eye toggle for the GM). Replaces the
  hand-rolled v0.1 window entirely; `templates/merchant-shelf.hbs` is deleted.
- **Sheet assignment** (`scripts/sheets.js`) — both roles swap the actor onto our sheet via
  `flags.core.sheetClass`. Also home to the reach check.
- **Taking** — Take routes through the kernel, so an unowned chest can be looted without
  ownership, and offers the looter's **party stash** (a dnd5e group actor they belong to)
  as a destination. `canReceive` in transfer.js widens the ownership rule for exactly that.
- **Canvas drop** (`scripts/canvas-drop.js`) — a GM dragging an item from a compendium or
  the sidebar onto the scene leaves it there as a container. GM only, source items only.
- **Reach** — players must have a token beside a shop or chest to open it. Fails open when
  distance cannot be measured. World setting.
- **Self-clearing loot** — a container flagged `ephemeral` (what canvas-drop sets) removes
  its tokens once players empty it. Deliberately NOT every container.

An actor is a merchant **or** a container, never both — the config dialog enforces it with
a radio. The stored flags keep their two-branch shape for back-compat.

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

## The player -> GM socket hop IS testable — join as a player

The previous note here claimed this could not be exercised, because the assistant's
session was itself the elected GM and Foundry never loops a socket emit back to its
sender. That was a property of *which user was joined*, not a limitation. **Join one of
the spare `Open Player 1` / `Open Player 2` slots instead** (no password; `Open Player 1`
owns the PC **Salyth**, which makes it a complete shopper and looter) and leave any other
GM client connected. Verified 2026-08-08: a 4ms round trip, the rejection raised by the
GM-side validator.

To probe the transport without mutating anything, call
`api.purchase({ merchantUuid, buyerUuid, itemId: "bogus" })` and check the rejection text
comes back from the kernel rather than timing out.

Two traps that cost real time:

- **Only `game.users.activeGM` answers**, and after a deploy every GM client must be
  reloaded or ops fail with `unknown operation "<op>"`. Election does not prefer the human
  — a leftover **Claude** session outranked the owner's own `Matt the DM` and kept
  answering with stale code. Check `game.users.activeGM?.name` before blaming the code.
- **The MCP bridge's writes do not reach the live world.** `update-actor` returns
  `success: true` and the browser client never sees the change; its `list-actors` /
  `list-users` are stale too. Read and write through the browser session.

### Verified end to end (2026-08-08)

Confirmed by the owner in a real player client, over the real socket:

- **Buy** — a player purchasing from the shelf.
- **Sell** — a player completing a sale by dropping an item on the shelf.
- **Take** — both the per-item button and the coin button, with the audit whisper.
- **Party destination** — taking into a group actor's stash.
- **Canvas drop** — dragging a compendium/sidebar item onto the scene.
- **Reach** — refused at range, opens when adjacent.
- **Self-clearing loot** — an emptied ephemeral container removing itself.
- The **transport itself**, measured separately at a 4ms round trip.

That is every flow this document ever opened as a blocker. The token-art and opened-flag
items that used to sit on this list are gone rather than verified — the feature was cut,
see the note in container.js.

- **Drag-out of an unowned chest** — the `_onDropCreateItems` path in container.js, where
  the dnd5e `asGear()` duplication bug is worked around.

**Nothing is left unverified.** Every flow this document ever listed as a blocker has been
run against a real player client.

If something does break later, check the browser console **on the player's client**, not
the GM's; these errors surface there.

### Accepted, not a loose end

An emptied ephemeral container loses its TOKENS but keeps its ACTOR in the "Loot Shelf"
folder, and canvas-drop mints one actor per drop, so those husks accumulate. The owner
reviewed this on 2026-08-08 and chose to leave it: deleting the actor is irreversible, and
clearing the canvas was the actual goal. Do not "fix" it unprompted.

## Test fixtures left in the world

- Actor **"Merchant Test"** — flagged merchant, priceModifier 1.2, sellModifier 0.5,
  purse set to 100 gp, stocked with Leather Armor and a Lute (quantity 3 each) purely for
  testing. Delete or repurpose freely. (Note: the MCP bridge cannot see this actor —
  see the bridge warning above. The browser client can.)
- **"The Party"** is the owner's real dnd5e **group actor**, set as the world's primary
  party. Not a Loot Shelf fixture, and not ours to touch — but worth knowing it is the
  sheet both our windows are built on, which is where their look comes from.
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

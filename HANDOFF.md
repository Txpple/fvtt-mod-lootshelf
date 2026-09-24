# Loot Shelf — handoff (v1.2.3, 2026-09-23)

**v1.2.3 is released and deployed to the Greenrest prod world.** It has the same code as 1.2.2;
it only changes the manifest (its version, and dnd5e verified 6.0.5). `main` is the only
branch and releases are committed straight to it. Prod and the local sandbox both run
**Foundry 14.368 + dnd5e 6.0.5**. Every flow has been play-tested from a real player client,
not only from a GM session, and nothing is known to be broken.

What the module does at the table is in the [README](README.md). Its scope is in
[design.md](design.md), which is binding: when in doubt, the answer that keeps Loot Shelf
*smaller* wins. The commit messages are deliberately detailed and record *why* each
workaround exists — read them before changing any of the areas below.

## Releases

| Version | Date | What changed |
| --- | --- | --- |
| 1.0.0 | 2026-08-07 | The "v0.2" rebuild (never tagged on its own): both UIs on dnd5e's sheet framework, token-art states cut, canvas drop, reach, self-clearing loot, public loot log |
| 1.0.1 | 2026-08-08 | Dropped loot shows its name on hover |
| 1.1.0 | 2026-08-12 | Sell proceeds can be paid into the seller's party purse |
| 1.2.0 | 2026-08-12 | Receipt Settings: broadcast, or whisper to participants and DMs |
| 1.2.1 | 2026-09-23 | The shelf ignores `equipped` — dnd5e 6 re-equips NPC goods on its own |
| 1.2.2 | 2026-09-23 | Loot moves into bags instead of duplicating; shop goods can't be bagged |
| 1.2.3 | 2026-09-23 | Verified on dnd5e 6.0.5; no code change |

## Code map

- **`transfer.js`** — the kernel. A GM-elect proxy over plain `game.socket` with five ops:
  `purchase`, `sell`, `takeFromContainer`, `takeCurrencyFromContainer`, `transferItem`.
  Every op re-validates ownership, stock and price GM-side; a client never names its own
  number. `canReceive` lets a player deliver into a dnd5e group actor they belong to (the
  party stash). The audit line and the receipt-visibility setting live here too.
- **`container.js`** — container flags, the ephemeral cleanup, and the fixes for dnd5e's
  bag and inventory drop paths (see landmine 3).
- **`container-sheet.js`, `merchant-sheet.js`** — `BaseActorSheet` subclasses built on the
  system's own inventory tab. The shelf adds three custom columns: price, stock, and Buy
  (an eye toggle for the GM).
- **`merchant.js`** — merchant flags, the shop drop guards, and the `Token#_canView`
  widening that lets a player double-click a shop they don't own.
- **`sheets.js`** — which sheet an actor wears (via `flags.core.sheetClass`), plus the reach
  check.
- **`config.js`** — the per-actor GM dialog. `canvas-drop.js` — drop an item on the map to
  make loot. `receipts.js` — the radio UI for the receipt setting.

## Development loop

- **Deploy to the sandbox** from the sibling MCP repo, `../fvtt-mcp-dnd5e`:
  `node scripts/deploy-house-module.mjs fvtt-mod-lootshelf --local`. It copies (the owner
  does not want a symlink) and reads the bytes back. Reload the world for scripts, styles
  and templates; `module.json` changes need a Foundry process restart. A sandbox refresh
  (`pull-prod-to-local.mjs`) mirrors prod's modules, so re-run `--local` after one.
- **The sandbox is shared.** Battle Flow's test battery also uses it, restarts the server,
  and needs to be the only GM. Check whether a sibling session is using it before a live
  run, and hand it back when done.
- **Live gates** in `tools/` import the MCP repo's client (`npm install` links it as a file
  dependency). Run each with `FOUNDRY_HOST=local`:
  - `verify-lootshelf.mjs` — both Greenrest shelves render, filter, price, reject bad
    buys, and complete a real buy + sell-back. It **resets** Wend's purse to 1000 gp and the
    probe Longsword stock to 20 (fixed baseline values, not what was there before), so
    snapshot and restore around it if Wend has moved on.
  - `verify-loot-drops.mjs` — 10 checks that loot *moves* on all three dnd5e drop paths and
    that shop goods can't leave by any of them. The regression gate for v1.2.2.
  - `verify-receipt-settings.mjs` — both receipt policies, for Loot Shelf and Party Stash.
    It joins as Tester Assistant on purpose: Party Stash posts a receipt from every live
    session of the acting user, so running it as DM Assistant while an MCP bridge is online
    doubles the stash receipts and fails two checks for no real reason.
- **Identities.** Headless runs join as the `suite` identity (Tester Assistant), which does
  not kick the MCP bridge; the player side is `Open Player 1`, who owns **Salyth** — a
  complete shopper and looter. When the owner asks for testing to be *hosted* in a browser,
  the assistant joins as **DM Assistant** (the owner types the password) and accepts that
  this kicks the bridge.
- **Only `game.users.activeGM` answers socket ops** — the highest-role active GM, not
  necessarily the human. After a deploy every GM client must reload or ops fail with
  `unknown operation "<op>"`. Check `game.users.activeGM?.name` before blaming the code.
- **The kernel grants before it decrements**, so when asserting a take or a sale, wait on
  the *source* side, not the recipient.
- **Player errors surface in the player's browser console**, not the GM's.

### Verifying UI by hand

Screenshots need the Browser pane visible and render scaled, so **measure the DOM**:
`getBoundingClientRect()`, `getComputedStyle`, `.item-header[data-column-id]`.

To exercise a drag, dispatch the real event sequence on the real elements and let Foundry
build the payload: `new DataTransfer()` → `dragstart` on the source sheet's
`li.item > .item-row` → `dragover` → `drop` on the target → `dragend`. dnd5e 6 records the
payload only on a handled dragstart and resolves move-vs-copy in `dragover`, so dispatching
`dragover` before `drop` yields the real behavior. Hand-built drop data does not reproduce
the real path.

## Release and prod deploy

1. A fix commit, then a `release: vX.Y.Z` commit that touches only `module.json`. Bump
   `version` **and** the `download` URL's tag together.
2. **Zip trap.** Do not build the zip with PowerShell's `Compress-Archive`: on Windows
   PowerShell 5.1 it writes backslash entry names (`scripts\transfer.js`), Foundry's
   Linux-side extractor treats that as a literal filename, and the module fails to load.
   Build with `[IO.Compression.ZipFile]::Open` + `CreateEntryFromFile` using forward-slash
   entry names, and assert there are zero backslash entries before uploading.
3. The GitHub release needs **two** assets: `fvtt-mod-lootshelf.zip` and a bare
   `module.json` (the latter makes `releases/latest/download/module.json` resolve). Verify
   both URLs return 200.
4. **Prod only with the owner's word.** From `../fvtt-mcp-dnd5e`:
   `FOUNDRY_HOST=molten node scripts/deploy-house-module.mjs fvtt-mod-lootshelf --check`,
   then again without `--check`. It hot-deploys over WebDAV with byte read-back and
   disconnects nobody. The in-app version string stays old until prod's process next
   restarts — expected, and not ours to restart. (`register-module.mjs` restarts the box
   and is only for a module that was never installed. Never `game.shutDown()` through the
   bridge.)
5. After a prod deploy the MCP bridge still runs the old code and may be the active GM —
   call `disconnect-bridge` on the prod server so its next call reloads.
6. Read-only prod check: join headless as `Open Player 1`, render each merchant sheet, and
   count `[data-action="buy"]`. Last result (v1.2.2 code, dnd5e 6.0.5): Wend 151/151, Selma 26/26.

## Landmines (all worked around; details in the commit messages)

1. **Core vs dnd5e `TABS` shape.** Core reads `static TABS` as a record of tab groups;
   dnd5e overrides it with an array. A one-tab sheet made core misread it and throw. Both
   sheets override `_getTabsConfig` to hand core an empty group.
2. **Column widths come from CSS**, keyed on `.item-<columnId>`. The `width` in a column
   descriptor is advisory only; a custom column without matching CSS collapses to zero.
3. **dnd5e has three drop paths, and each one's move-delete is broken for loot.** The
   inventory list (`_onDropCreateItems`, where `asGear()` swaps in a *compendium clone* and
   the delete misses the real source), the bag tile (`_onDropItemContainer`), and an open
   bag sheet (ContainerSheet, which treats any cross-actor drag as a copy — intercepted via
   `dnd5e.dropItemSheetData` → kernel `takeFromContainer({ intoContainerId })`). The shop
   guard covers all three; before v1.2.2 a player took 42 Longswords free through a bag.
   **If dnd5e adds a fourth drop path, this is the class of bug to look for.**
4. **Foundry checks ownership at every layer independently.** `Token#_canView` (the
   double-click is never dispatched), the actor sheet's `viewPermission`, and the item
   sheet's `viewPermission` each blocked players. All three are widened for flagged actors
   only.
5. **Drag permissions are tied to editability**, so the sheets decide them
   (`_canDragStart` / `_canDragDrop`) rather than ownership.
6. **dnd5e 6 owns `system.equipped` on NPCs.** A weapon or armor created on an NPC arrives
   equipped, and every world migration re-equips every unequipped NPC item. The shelf and
   the kernel ignore `equipped`; the hide flag is the only curation signal. **Don't
   reintroduce an equipped filter.**
7. **Stocked items must detach `system.container`** — compendium items carry stale refs
   (SRD Rations → Backpack).
8. **`getDependentTokens()` returns ephemeral id-null tokens** whose `update()` throws
   synchronously; the emptied-container cleanup filters `t.id && t.parent`.
9. dnd5e's header `.preparation-warnings` ⚠ is always present on a re-equipped shop and
   threw, so `sheets.js` removes it.

## Owner decisions (do not silently revert)

- **No ownership grants** for merchants or containers. Players open both via
  `viewPermission: NONE`; granting OBSERVER was rejected because it would put every shop in
  every player's sidebar. Looking is unguarded; taking is guarded GM-side.
- **Taking from an unowned chest** goes through `takeFromContainer`. `transferItem` keeps
  its stricter both-endpoints-owned contract on purpose.
- **Shop funds gate selling.** The shelf caps the offered quantity by the shop's purse, and
  the kernel enforces the same rule.
- **An actor is a merchant or a container, never both** — a radio in the config dialog.
- **Whole coins only.** The kernel floors every coin amount. dnd5e 6.0 dropped
  `integer: true` on currency, but Loot Shelf will never support fractional coins, so this
  is by design and not a gap.
- **Receipts are a public loot log by default**; the Receipt Settings option whispers them
  instead.
- **The container token-art state machine was cut in the v0.2 rebuild** (closed/open/empty
  art and the `opened` flag). Do not re-add it; design.md records why.
- **Actor husks stay.** An emptied ephemeral container deletes its tokens but keeps its
  actor in the "Loot Shelf" folder, so they accumulate. The owner chose this — deleting
  actors is irreversible. Do not "fix" it unprompted.
- UI trims: no tab strip, no create-item button, no window title icon, no item property
  glyphs on the shelf, a slim 52px header, and currency and search pinned while only the
  list scrolls.

## Leftovers in the worlds

None. The v0.2 debug macros ("LS: Capture drag error", "LS: Diagnose container sheet",
"LS: Test Chest v0.2") were deleted from prod on 2026-09-23; the sandbox copies go with its
next refresh, which mirrors prod's world data.

## Loose ends

- Cosmetic, GM-only, pre-existing: expanded shelf rows repeat the eye column on each
  activity row.

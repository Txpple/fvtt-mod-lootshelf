# Loot Shelf — design (binding)

Owner-authored scope, decided 2026-08-07. This document is the north star for the module:
when in doubt, the answer that keeps Loot Shelf *smaller* is the right one.

## Mission

Replace Item Piles for the **next campaign** with a lean, 5e-only house module. Not a fork,
not a port — a net-new build with **no backward compatibility**: no `item-piles` flag
migration, no behavior matching. The current (Greenrest) campaign rides Item Piles + the
local NaN hotfix to its end; both retire with it.

## Scope — locked

Two features. **That's it.**

1. **Placeable loot containers** — chests/crates/bodies as scene-placeable loot.
2. **Merchant shelf** — a shop UI for buying (and selling to) an NPC merchant.

### Explicit non-goals

- **No trading / shared inventory** — [Party Stash](https://github.com/Txpple/fvtt-mod-partystash)
  owns member↔group movement.
- **No vaults**, no banking, no auctions.
- **No multi-currency UI** — dnd5e's native pp/gp/ep/sp/cp paths, straight math.
- **No multi-system support** — dnd5e only, field paths hardcoded.
- **No Item Piles compat** — new flag namespace, no migration tooling.

## Design principles

- **Native UI or no UI.** ApplicationV2 + Handlebars mixin, inheriting current Foundry
  window chrome, theming (light/dark), and dnd5e styling. **No Svelte/TyphonJS or any
  bundled UI runtime** (owner: "simple, clean UI… conforms with current version of
  Foundry"). Prefer the system's own sheets over custom windows wherever possible.
- **Steer the native pipeline** (the Party Stash lesson): dnd5e's drop behavior, container
  items, and currency paths do the work; the module nudges defaults and fills permission
  gaps. Don't build a parallel inventory universe.
- **No dependencies.** Plain `game.socket` + a GM-elect pattern for the GM proxy — no
  socketlib.
- **No transformer layer.** Item copies carry system data verbatim; clear exactly what must
  be cleared (attunement state, equipped). This is the design that structurally deletes the
  Item Piles NaN-attunement bug class (its root cause was a config/transformer registration
  race between two modules — see lineage below).
- **MCP-friendly by construction.** Merchant and container setup exposed as a small
  documented API (`game.modules.get('fvtt-mod-lootshelf').api`), so the molten5e bridge can
  get `create-merchant` / `create-loot-container` tools without UI scripting.
- **Fail open, never destructive** (family convention): if a system seam moves, log and fall
  back to stock behavior.

## Architecture sketch (pre-code, from 2026-08-07 ideation)

- **Transfer kernel** — GM-proxy socket service: move/copy an item actor→actor with
  quantity-merge into existing stacks, coin deduction/award, attunement/equipped cleared on
  the way. A few hundred lines; everything else calls through it.
- **Loot container** — an actor + module flags; dnd5e container items handle
  nesting/capacity natively. *(Art states — closed/open/empty token images swapped as the
  chest was opened and emptied — were built, shipped in v0.1, and **cut in v0.2**: unused
  by the owner, and the source of the module's two worst workarounds, a single-writer rule
  to stop GM clients fighting over stale art and a document-reset/redraw dance for core
  #12118. A GM who wants an open-looking chest changes the token art.)*
  *(v0.2 uplift, owner-decided 2026-08-07):* contents are browsed through a **container
  sheet** — a subclass of dnd5e's `BaseActorSheet` whose parts are a minimal header plus
  the system's own inventory tab (currency row, search/filter controls, sectioned item
  table — the group-sheet look), assigned via `flags.core.sheetClass`. This replaces the
  raw NPC statblock sheet, which read as legacy Item-Piles-era UX. The rule stands:
  reuse the system's sheet framework and components; never hand-build lookalike item
  lists. The merchant shelf gets the same visual uplift next.
- **Merchant shelf** — *(v0.2 uplift)* no longer a custom window: the shelf is the
  merchant's own dnd5e sheet, built on the system's inventory with three custom COLUMNS
  (shelf price, stock, Buy — an eye toggle for the GM), since `InventoryElement.mapColumns`
  merges unrecognised column descriptors as-is. Shoppers open it without owning the
  shopkeeper via `viewPermission: NONE`, so merchant actors never appear in a player's
  sidebar — the constraint that forced the bespoke window in v0.1. The GM's view shows
  everything, so it is also the stocking view. Original v0.1 sketch, for the record:
  the ONE custom window (ApplicationV2): stock list with prices
  (global price-modifier flag), buy flow through the transfer kernel, per-item
  hide-from-shelf flag (the shopkeeper's own weapons/armor never leak onto the shelf —
  fixing properly what needed a workaround on Item Piles). Optional v1-minus fallback:
  context-menu Buy + chat-card confirm, pretty shelf second.
- **Loot split** — small dialog or chat-card flow; once-a-session feature, keep it tiny.

## Lineage / why this exists

Item Piles (+ its `itempilesdnd5e` companion) served the Greenrest campaign but: (a) stock
companion 1.1.0 corrupts `system.attunement` to `"NaN"` on every transfer — root-caused to
a registration race between core's cached `SYSTEMS.DATA` and the companion's legacy
`Math.min` transformer; upstream is frozen at 1.1.0 with no fix coming (checked
2026-08-07); we run a fenced local hotfix + a verify tripwire. (b) It predates
ApplicationV2, modern dnd5e containers, and is multi-system — heavy abstraction and a
bundled Svelte/TyphonJS UI runtime for features this table doesn't use. Owner decision
2026-08-07: replace, don't vendor-fork.

## Conventions (family)

- House module #5 under **Txpple** (public GitHub), sibling of openserver, autoexplore,
  combatplus, partystash.
- Module id `fvtt-mod-lootshelf`, title **Loot Shelf**, MIT, author Matthew Sippel.
- Layout mirrors partystash: `module.json` + `scripts/lootshelf.js` (+ `templates/`,
  `styles/` as the merchant sheet needs them). Release = manifest URL off GitHub releases.
- Compat pins (min v13 / verify on current, dnd5e 5.x min) set at first release against the
  live world's versions, not guessed now.

## First-session checklist

1. Scaffold `module.json` + entry script per family conventions.
2. Build the transfer kernel first (it's the foundation and the testable core).
3. Loot container second (smallest user-visible win; dogfood in a dev session).
4. Merchant shelf last (the one real UI).
5. Deploy note (Molten-era, if it still applies): package registry is PROCESS-boot-scoped —
   a brand-new module needs `/setup` `installPackage`, not just a world bounce; never
   `game.shutDown()` through the bridge.

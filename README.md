# Loot Shelf

> **Status: v0.1.0, unreleased.** Core is implemented — transfer kernel, loot containers,
> merchant shelf — but not yet play-tested in a live world or released. See
> [design.md](design.md) for the binding scope and architecture.

A lean, 5e-only loot & merchant module for Foundry VTT. Two features, nothing else:

- **Placeable loot containers** — a chest is an actor on the scene: token art swaps
  open/closed/empty, players with ownership open it and take what's inside through the
  system's own sheets and drop pipeline.
- **A merchant shelf** — one clean ApplicationV2 window: browsable stock with prices,
  a buy flow that checks coin and hands the item over GM-side, and a per-item
  hide-from-shelf flag so a shopkeeper's own sword never ends up for sale.

Built native: current-Foundry ApplicationV2 + dnd5e styling, plain `game.socket` for the
GM proxy. No bundled UI framework, no multi-system abstraction, no dependencies.

Sibling of [Party Stash](https://github.com/Txpple/fvtt-mod-partystash) — Party Stash owns
shared party inventory; Loot Shelf owns loot on the ground and goods for sale. There is
deliberately no trading, no vaults, and no multi-currency machinery here.

## GM quickstart

- Right-click an actor in the sidebar → **Loot Shelf: Configure** to turn Loot Shelf on
  and pick what the actor is: a loot container or a merchant shelf (with price modifiers
  and infinite stock). An actor is one or the other, never both.
- Stock either one by dragging items onto its normal sheet — attunement and equipped
  state are cleared on the way in. On a merchant, equipped or hidden (eye icon on the
  shelf) items never show to players.
- Players double-click a merchant token to browse and buy, and drag their own items onto
  the shelf to sell. The shelf is the merchant's own sheet, opened without granting any
  ownership, so shop actors never clutter a player's sidebar. Buys and sells run GM-side
  over a plain-socket proxy, so a GM client must be connected.
- **Drag an item from a compendium or the Items sidebar onto the scene** and it is left
  lying there: a loot container named and illustrated after the item, holding a copy of it,
  filed under a "Loot Shelf" folder. GM only. Items dragged off a character's sheet are
  deliberately left alone — copying one there would duplicate it. Switchable off in module
  settings.
- Players double-click a chest to loot it through a dnd5e-native container sheet (the
  system's own inventory tab — currency, search, sectioned item table). Each row has a
  **Take** button and the coin row has its own, so no ownership needs granting; drags out
  are *moves* rather than copies. If the looter belongs to a party (a dnd5e group actor),
  Take offers that party's stash as a destination alongside the character.
- Everything is also scriptable: `game.modules.get("fvtt-mod-lootshelf").api` exposes
  `createMerchant`, `createLootContainer`, `setMerchant`, `setContainer`, `openShelf`,
  `configure`, `purchase`, `sell`, and `transferItem`.

## Compatibility

Will target the **dnd5e** system 5.x+ on Foundry v13+ (pins verified at first release).

## Installation

Not yet — nothing to install. First release will ship the usual manifest URL:

```
https://github.com/Txpple/fvtt-mod-lootshelf/releases/latest/download/module.json
```

## License

MIT

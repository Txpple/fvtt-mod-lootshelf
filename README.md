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

- Right-click an actor in the sidebar → **Loot Shelf: Configure** to flag it as a
  merchant and/or loot container (art states, price modifiers, infinite stock).
- Stock either one by dragging items onto its normal sheet — attunement and equipped
  state are cleared on the way in. On a merchant, equipped or hidden (eye icon on the
  shelf) items never show to players.
- Players double-click a merchant token to browse and buy, and drag their own items into
  the shelf window to sell. Buys and sells run GM-side over a plain-socket proxy, so a
  GM client must be connected.
- Containers need no proxy: grant players ownership of the chest actor and they loot
  through a dnd5e-native container sheet (the system's own inventory tab — currency,
  search, sectioned item table) — drags out are *moves*, and the token art swaps
  closed/open/empty on its own.
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

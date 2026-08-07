# Loot Shelf

> **Status: pre-code.** Design locked, nothing implemented yet. See [design.md](design.md)
> for the binding scope and architecture.

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

## Compatibility

Will target the **dnd5e** system 5.x+ on Foundry v13+ (pins verified at first release).

## Installation

Not yet — nothing to install. First release will ship the usual manifest URL:

```
https://github.com/Txpple/fvtt-mod-lootshelf/releases/latest/download/module.json
```

## License

MIT

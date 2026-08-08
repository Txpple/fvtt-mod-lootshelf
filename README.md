# Loot Shelf

A lean, 5e-only loot & merchant module for Foundry VTT. Two features, nothing else:

- **Placeable loot containers** — a chest is an actor on the scene. Players open it and
  take what's inside through a dnd5e-native sheet built from the system's own inventory
  components. No ownership needs granting.
- **A merchant shelf** — the shopkeeper's own sheet, wearing prices: browsable stock, a buy
  flow that checks coin and hands the item over GM-side, sell-back at a configurable rate,
  and a per-item hide-from-shelf flag so a shopkeeper's own sword never ends up for sale.

Built native: dnd5e's own sheet framework and inventory components, plain `game.socket` for
the GM proxy. No bundled UI framework, no multi-system abstraction, no dependencies.

Sibling of [Party Stash](https://github.com/Txpple/fvtt-mod-partystash) — Party Stash owns
shared party inventory; Loot Shelf owns loot on the ground and goods for sale. There is
deliberately no trading, no vaults, and no multi-currency machinery here.

## Installation

Paste this manifest URL into Foundry's **Install Module** dialog:

```
https://github.com/Txpple/fvtt-mod-lootshelf/releases/latest/download/module.json
```

## GM quickstart

- Right-click an actor in the sidebar → **Loot Shelf: Configure** to turn Loot Shelf on and
  pick what the actor is: a loot container or a merchant shelf. An actor is one or the
  other, never both.
- **Stock either one by dragging items onto its sheet.** Attunement and equipped state are
  cleared on the way in. On a merchant, equipped or hidden (the eye column) items never
  show to players — the GM's view of the shelf is also the stocking view.
- **Drag an item from a compendium or the Items sidebar onto the scene** to leave it lying
  there: a container named and illustrated after the item, holding a copy of it, filed
  under a "Loot Shelf" folder. GM only. Items dragged off a character's sheet are
  deliberately left alone, since copying one there would duplicate it.

## What players do

- **Double-click a chest** to loot it. Every row has a **Take** button and the coin row has
  its own, so nothing needs to be dragged and no ownership needs granting. Dragging still
  works, and drags out of a container are *moves* rather than copies.
- **Take into the party.** If the looter belongs to a dnd5e group actor, Take offers that
  party's stash as a destination alongside their character.
- **Double-click a shop** to browse and buy, or drag their own goods onto the shelf to sell
  them back. A finite shop can only buy what its purse can cover.
- **Stand next to it.** Players need a token beside the shop or chest to open it, diagonals
  included. GMs are never restricted, and the check yields whenever distance cannot honestly
  be measured — no canvas, or no token on either side.
- Buys, sells and takes are announced in chat so the whole table shares one loot log.

Every mutation is re-validated GM-side by the transfer kernel — ownership, stock, and above
all the price. A client never gets to name its own number. A GM client must be connected.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Players must stand next to a shop or chest | on | Turn off for theatre-of-the-mind play. |
| Drop items on the map to make loot | on | Turn off to restore stock canvas-drop behavior. |

Per container, in **Loot Shelf: Configure**, *Disappears when emptied* removes the token
from the map once players have taken everything — items and coin. On by default for
containers made by dropping an item on the canvas, off for chests you place yourself.

## Scripting

`game.modules.get("fvtt-mod-lootshelf").api` exposes:

```js
await api.createMerchant({ name, img, items, priceModifier, sellModifier, infiniteStock, folder });
await api.createLootContainer({ name, img, items, folder, defaultOwnership, ephemeral });
await api.setMerchant(actor, { enabled, priceModifier, sellModifier, infiniteStock });
await api.setContainer(actor, { enabled, ephemeral });
api.openShelf(actor);   api.configure(actor);   api.isMerchant(actor);   api.isContainer(actor);
await api.purchase({ merchantUuid, buyerUuid, itemId, quantity });
await api.sell({ merchantUuid, sellerUuid, itemId, quantity });
await api.transferItem({ fromUuid, toUuid, itemId, quantity, move });
api.priceInCopper(item);   api.formatCopper(copper);
```

`items` accepts Item uuids (compendium or world) and/or plain item data.

## Compatibility

**dnd5e 5.x** on **Foundry v13+**. Verified against Foundry 14.365 and dnd5e 5.3.3.

## License

MIT

# Open Roll 5e: Loot Shelf

A Foundry VTT module for the dnd5e system that adds loot containers and merchant shelves. Stock
Foundry makes a player own an actor before they can open it, so every chest and shop meant handing
out ownership, and every one of them then sat in the players' sidebars. Loot Shelf lets players
open a chest or a shop they do not own, take loot or buy goods through buttons, and sell their own
goods back, while every change is checked and carried out on the GM's client.

## How it works

- **A chest is an actor on the scene.** Players double-click it and see its contents on a sheet
  built from dnd5e's own inventory, with a **Take** button on every row and one for the coin.
- **A shop is the shopkeeper's own sheet, wearing prices.** Players browse the stock, buy with a
  **Buy** button, and drag their own goods onto the shelf to sell them back.
- **No ownership is granted.** Looking is open to everyone; taking, buying and selling go to the
  GM's client, which checks ownership, stock and the price itself. A GM must be connected.
- **Drags out of a chest move the item** instead of copying it, so loot never ends up in two
  places. Goods only leave a shop by being bought.
- **Every buy, sale and take posts a receipt** to chat, to the whole table or to the participants
  and the DMs.

Sibling of [Open Roll 5e: Party Stash](https://github.com/Txpple/fvtt-mod-partystash): Party Stash
owns the shared party inventory, Loot Shelf owns loot on the ground and goods for sale. Neither
needs the other.

## Installation

Paste the manifest URL into Foundry's *Install Module* dialog:

```
https://github.com/Txpple/fvtt-mod-lootshelf/releases/latest/download/module.json
```

Requires Foundry VTT v13 or v14 and the dnd5e system 5.x or 6.x (verified on dnd5e 6.0.5 /
Foundry 14.368). No other dependencies.

## Setting up chests and shops

Right-click an actor in the sidebar and choose **Loot Shelf: Configure**. Turn Loot Shelf on and
pick whether the actor is a loot container or a merchant shelf; an actor is one or the other,
never both. A merchant has a price modifier, a buyback modifier (half price by default) and an
**Infinite stock & coin** switch for a shop that never runs out. A container has **Disappears when
emptied**, which removes its token from the map once players have taken every item and all the
coin.

Stock either one by dragging items onto its sheet. Items arrive unattuned and unequipped. On a
merchant everything is for sale except what you hide with the eye column, so the GM's view of the
shelf is also the stocking view. When you turn an existing NPC into a shop, hide its own weapons
and armor there.

A GM can also drag an item from a compendium or the Items sidebar onto the scene to leave it lying
there: a container named and illustrated after the item, holding a copy of it, filed in a "Loot
Shelf" folder and set to disappear when emptied. Items dragged off a character's sheet are left
alone, since copying one there would duplicate it.

On a chest, the line under its name shows how many items it holds and what they are worth. A GM
can type a note over it, and players see the note instead.

## Looting

**Take** asks how many from a stack, then where to put it. If the looter belongs to a dnd5e group
actor, the party's stash is offered alongside their character. The coin row's **Take** empties the
chest's purse in one go, keeping the denominations: two platinum arrive as two platinum.

Dragging still works: onto your character sheet, onto one of your bags, or into an open bag. A
drag that would leave a duplicate behind, such as a player putting their own item into a chest
they do not own, is blocked with a warning. Players can open any item in a chest or a shop to read
it.

## Buying and selling

The shelf shows each item's price after the merchant's modifier, how many are in stock, and the
buyer's purse. Buying spends the buyer's smallest coins first and gives change in gold, silver and
copper. Selling pays the buyback rate, rounded down; a finite shop pays from its own purse and only
offers to buy as many as it can afford. If the seller belongs to a dnd5e group actor, the sale can
pay into the party's purse instead.

Players buy and take with their assigned character, or with a token they own and have selected.

## Settings

*Game Settings → Configure Settings → Open Roll 5e: Loot Shelf.*

| Setting | Default | What it does |
| --- | --- | --- |
| Players must stand next to a shop or chest | on | A player needs a token beside it to open it, diagonals included. GMs are never restricted, and the check yields when the distance cannot be measured. Turn off for theatre-of-the-mind play. |
| Drop items on the map to make loot | on | Off restores the stock behavior for canvas drops. |
| Receipts | broadcast | Who reads the chat line for each buy, sale and take. |

**Receipts** is a choice of two, and Party Stash offers the same one:

- **Broadcast receipts to the server** (default): posted to the chat log for the whole table.
- **Receipts to the transaction participants and the DMs**: whispered to whoever bought, sold, was
  paid or took the loot, and to the DMs. Assistant DMs count as DMs.

## Scripting

`game.modules.get("fvtt-mod-lootshelf").api` exposes:

```js
await api.createMerchant({ name, img, items, priceModifier, sellModifier, infiniteStock, folder });
await api.createLootContainer({ name, img, items, folder, defaultOwnership, ephemeral });
await api.setMerchant(actor, { enabled, priceModifier, sellModifier, infiniteStock });
await api.setContainer(actor, { enabled, ephemeral });
api.openShelf(actor);   api.configure(actor);   api.isMerchant(actor);   api.isContainer(actor);
await api.purchase({ merchantUuid, buyerUuid, itemId, quantity });
await api.sell({ merchantUuid, sellerUuid, itemId, quantity, payeeUuid });
await api.transferItem({ fromUuid, toUuid, itemId, quantity, move });
api.priceInCopper(item);   api.formatCopper(copper);
```

`items` accepts Item uuids (compendium or world) and plain item data.

## Sister modules

Loot Shelf is one of the Open Roll 5e modules for Foundry VTT. Each installs and works on its own and
none needs another; together they cover the table from the fog of war to the loot. The rest of the family:

- [Open Roll 5e: Autoexplore](https://github.com/Txpple/fvtt-mod-autoexplore): lets a scene start fully explored, so the whole map shows through the fog of war while tokens still need line of sight.
- [Battle Flow](https://github.com/Txpple/fvtt-mod-battleflow): combat automation for dnd5e 2024 rules: a hit rolls and applies its own damage, saves resolve themselves, reactions hold, and concentration is tracked.
- [Open Roll 5e: Combat Plus](https://github.com/Txpple/fvtt-mod-combatplus): automates the chores of running a fight: combat music, an initiative gate, an out-of-turn movement block, defeated marking at 0 HP and turn alerts.
- [Open Roll 5e: Errata](https://github.com/Txpple/fvtt-mod-errata5e): corrects, in memory, bugs in the premium D&D 2024 books, the dnd5e system and Foundry itself, each fix held until the vendor ships its own.
- [Open Roll 5e: FX Studio](https://github.com/Txpple/fvtt-mod-fxstudio): visual and sound effects for dnd5e, played from what actually happened at the table, with about a thousand stock FX and a window for authoring your own.
- [Open Roll 5e: Open Server](https://github.com/Txpple/fvtt-mod-openserver): for hosted worlds: clears the startup pause so players can play before the GM arrives, and gives any user a landing scene of their own.
- [Open Roll 5e: Party Stash](https://github.com/Txpple/fvtt-mod-partystash): makes a dnd5e Group actor's inventory a working party stash: drags move instead of copying, coin moves through a dialog, and every transfer posts a receipt.
- [Open Roll 5e: Soundscape](https://github.com/Txpple/fvtt-mod-soundscape): background sound for scenes: random one-shots with silence between them, seamless crossfaded loops, day and night gating, and quiet during combat.

## License

MIT. See [LICENSE](LICENSE).

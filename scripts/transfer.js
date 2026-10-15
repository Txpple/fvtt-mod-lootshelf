/**
 * Loot Shelf — transfer kernel.
 *
 * The one place items and coin change hands. Everything else in the module (loot
 * containers, the merchant shelf, the public API) calls through here, so the rules live
 * here exactly once:
 *
 *   - Item copies carry system data VERBATIM except for what must be cleared on the way:
 *     `system.attuned` and `system.equipped` go false, `system.container` is detached.
 *     `system.attunement` (the *requirement* string) is never touched — corrupting that
 *     field was the Item Piles NaN bug this module exists to structurally delete
 *     (see design.md, "Lineage").
 *   - Quantities merge into an existing stack on the target (same type + name + img);
 *     container-type items never merge and bring their contents along recursively.
 *   - The target copy is created BEFORE the source is decremented or deleted, so a failed
 *     transfer never destroys the original (family convention: fail open, never
 *     destructive).
 *   - Currency is straight dnd5e pp/gp/ep/sp/cp math, field paths hardcoded. Payment
 *     spends small coins first and breaks the smallest sufficient coin for the remainder,
 *     giving change back in gp/sp/cp — no silent re-denomination of a player's purse.
 *
 * Players can't write to a merchant or an unowned chest, so mutations ride a GM proxy:
 * plain `game.socket` on `module.fvtt-mod-lootshelf`, handled only by the elect (the kit's
 * elect.js: the active GM, in its leading window, so a GM with the game open in two windows
 * answers once — no socketlib). The GM handler re-validates everything server-side: flags,
 * ownership, stock, and above all the PRICE — a client never gets to name its own number.
 * The requester is the `userId` the sending client stamps on the request, which a table of
 * trusted players can live with: the ownership and price checks still run as that user.
 *
 * Every buy, sale and take posts one receipt line (the kit's receipt.js), and the line
 * carries what moved, so a GM can put it back with one click: the item back where it came
 * from, the coin back in the purses it left, an emptied chest back on the map. Every write
 * here is made under the receipt's echo marker, so Party Stash, hearing coin or goods land
 * in a group actor, does not post a second line for the same move.
 */

import { createReceipts, html, MODE_SETTING, MODES } from "./kit/receipt.js";
import { elect, log, MODULE_ID } from "./family.js";

export { MODULE_ID };
const SOCKET = `module.${MODULE_ID}`;
const REQUEST_TIMEOUT = 15000;

/* -------------------------------------------------- */
/*  Currency — dnd5e pp/gp/ep/sp/cp, straight math    */
/* -------------------------------------------------- */

/** Copper value of one coin of each denomination. */
export const RATES = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const ASCENDING = ["cp", "sp", "ep", "gp", "pp"];

/** A sanitized copy of an actor's currency object (non-negative integers, all five keys). */
export function coins(currency) {
  const out = {};
  for (const c of ASCENDING) out[c] = Math.max(0, Math.floor(currency?.[c] ?? 0));
  return out;
}

/** Total value of a currency object in copper. */
export function totalCopper(currency) {
  const c = coins(currency);
  return ASCENDING.reduce((total, k) => total + c[k] * RATES[k], 0);
}

/** An item's base price in copper (dnd5e `system.price.{value,denomination}`). */
export function priceInCopper(item) {
  const price = item?.system?.price;
  const rate = RATES[price?.denomination] ?? RATES.gp;
  return Math.round((Number(price?.value) || 0) * rate);
}

/** Human label for a copper amount, e.g. "12 gp 5 sp 3 cp". Zero reads "free". */
export function formatCopper(total) {
  total = Math.max(0, Math.floor(total));
  if (total === 0) return "free";
  const parts = [
    [Math.floor(total / 100), "gp"],
    [Math.floor((total % 100) / 10), "sp"],
    [total % 10, "cp"]
  ];
  return parts.filter(([n]) => n > 0).map(([n, d]) => `${n} ${d}`).join(" ");
}

/**
 * Human label for the CONTENTS of a purse. `formatCopper` reads zero as "free", which is
 * right for a price tag and nonsense for a wallet — "only has free" is not a sentence.
 */
export function formatPurse(total) {
  return Math.floor(total) > 0 ? formatCopper(total) : "no coin";
}

/** A new currency object with `amount` copper added, canonically as gp/sp/cp. */
export function addCopper(currency, amount) {
  const c = coins(currency);
  amount = Math.max(0, Math.floor(amount));
  c.gp += Math.floor(amount / 100);
  c.sp += Math.floor((amount % 100) / 10);
  c.cp += amount % 10;
  return c;
}

/**
 * Plan paying `cost` copper out of a currency object, or null if it can't be afforded.
 * Spends small denominations first (exact multiples only), then breaks the smallest
 * remaining coin that covers what's left, returning change in gp/sp/cp. The result is the
 * complete post-payment currency object, ready for `actor.update`.
 */
export function planDeduction(currency, cost) {
  const c = coins(currency);
  cost = Math.max(0, Math.floor(cost));
  if (totalCopper(c) < cost) return null;
  let remaining = cost;
  for (const coin of ASCENDING) {
    const spend = Math.min(c[coin], Math.floor(remaining / RATES[coin]));
    c[coin] -= spend;
    remaining -= spend * RATES[coin];
  }
  if (remaining > 0) {
    // After the exact pass every held coin is worth more than the remainder, and the
    // affordability check guarantees one exists — break the smallest and take change.
    const coin = ASCENDING.find(k => c[k] > 0 && RATES[k] >= remaining);
    c[coin] -= 1;
    const change = RATES[coin] - remaining;
    c.gp += Math.floor(change / 100);
    c.sp += Math.floor((change % 100) / 10);
    c.cp += change % 10;
  }
  return c;
}

/** How a purse changed, per denomination, signed: `after` minus `before`. */
export function purseDelta(before, after) {
  const b = coins(before);
  const a = coins(after);
  const out = {};
  for (const k of ASCENDING) out[k] = a[k] - b[k];
  return out;
}

/**
 * The purse with a recorded change taken back out of it, or null when it can no longer
 * cover that. Coins it gained go back as themselves while it still holds them; a shortfall
 * in a denomination is paid out of the rest of the purse by `planDeduction`'s manners, so
 * the value is exact and only the denominations it can no longer give back are converted.
 */
export function reverseDelta(purse, delta) {
  const c = coins(purse);
  let owed = 0;
  for (const k of ASCENDING) {
    c[k] -= Math.trunc(Number(delta?.[k]) || 0);
    if (c[k] < 0) {
      owed += -c[k] * RATES[k];
      c[k] = 0;
    }
  }
  return owed > 0 ? planDeduction(c, owed) : c;
}

/* -------------------------------------------------- */
/*  Items — clean copy, stack merge, contents         */
/* -------------------------------------------------- */

/** Physical items are the ones with a quantity field (same test Party Stash uses). */
export function isPhysical(item) {
  return !!item?.system?.schema?.fields?.quantity;
}

/**
 * Plain creation data for a copy of `item`: system data verbatim, minus the state that
 * must not travel between actors. `system.attunement` (the requirement) stays as-is.
 */
function cleanItemData(item, quantity) {
  const data = item.toObject();
  delete data._id;
  delete data.folder;
  data.sort = 0;
  const sys = data.system ?? {};
  if ("attuned" in sys) sys.attuned = false;
  if ("equipped" in sys) sys.equipped = false;
  if ("container" in sys) sys.container = null;
  if (quantity != null && "quantity" in sys) sys.quantity = quantity;
  return data;
}

/**
 * An existing stack on `target` that a copy of `item` can merge into — at the top level, or
 * inside the bag `container` when the goods are headed into one.
 */
function findStack(target, item, container = null) {
  if (item.type === "container") return null;
  return target.items.find(i =>
    i.type === item.type && i.name === item.name && i.img === item.img
    && (i.system.container ?? null) === container && i.system.quantity != null
  ) ?? null;
}

/** Recursively copy a container item's contents onto `target`, under `containerId`. */
async function copyContents(sourceContainer, target, containerId, options = {}) {
  const contents = sourceContainer.system?.contents;
  if (!contents) return;
  for (const c of contents) {
    const data = cleanItemData(c);
    data.system.container = containerId;
    const [created] = await target.createEmbeddedDocuments("Item", [data], options);
    if (c.type === "container") await copyContents(c, target, created.id, options);
  }
}

/**
 * Create `quantity` of `item` on `target` (merging into an existing stack when possible)
 * and return the created or updated item. Does NOT touch the source — callers decrement
 * afterwards, so the copy always lands before anything is destroyed. `container` is the id
 * of a bag on `target` to put it in; the caller has already checked it is one. `options`
 * ride on every write (the receipt's echo marker).
 */
export async function grantItem(target, item, quantity = 1, { container = null, options = {} } = {}) {
  if (item.type === "container") {
    const data = cleanItemData(item, 1);
    if (container) data.system.container = container;
    const [created] = await target.createEmbeddedDocuments("Item", [data], options);
    await copyContents(item, target, created.id, options);
    return created;
  }
  const stack = findStack(target, item, container);
  if (stack) {
    await stack.update({ "system.quantity": Math.floor(stack.system.quantity ?? 0) + quantity }, options);
    return stack;
  }
  const data = cleanItemData(item, quantity);
  if (container) data.system.container = container;
  const [created] = await target.createEmbeddedDocuments("Item", [data], options);
  return created;
}

/** Remove `quantity` from a source item — delete the item when the stack runs out. */
export async function decrementItem(item, quantity = 1, options = {}) {
  if (item.type === "container") return item.delete({ ...options, deleteContents: true });
  const q = Math.floor(item.system.quantity ?? 1);
  if (q - quantity > 0) return item.update({ "system.quantity": q - quantity }, options);
  return item.delete(options);
}

/* -------------------------------------------------- */
/*  Incoming-item normalization                       */
/* -------------------------------------------------- */

// Anything dropped onto a flagged container or merchant arrives unattuned and unequipped
// — items sitting in a chest or on a shelf belong to nobody. This runs on the creating
// client (preCreate hooks fire initiator-side only), so whatever is taken OUT later via
// the native drag pipeline is already clean without a transformer layer in the middle.
// Tidiness only on a merchant: the shelf does not read `equipped` (see #onShelf).
Hooks.on("preCreateItem", (item, _data, _options, _userId) => {
  try {
    const actor = item.parent;
    if (!(actor instanceof Actor)) return;
    const flags = actor.flags?.[MODULE_ID];
    if (!flags?.container?.enabled && !flags?.merchant?.enabled) return;
    const update = {};
    if (item.system?.schema?.fields?.attuned) update["system.attuned"] = false;
    if (item.system?.schema?.fields?.equipped) update["system.equipped"] = false;
    if (!foundry.utils.isEmpty(update)) item.updateSource(update);
  } catch (err) {
    log.error("incoming-item normalization failed", err);
  }
});

/* -------------------------------------------------- */
/*  GM proxy — plain socket, GM-elect handler         */
/* -------------------------------------------------- */

const pending = new Map(); // request id -> {resolve, reject, timer}

/** Resolve an actor from a uuid that may point at an Actor or a TokenDocument. */
async function resolveActor(uuid) {
  if (!uuid) return null;
  const doc = await fromUuid(uuid).catch(() => null);
  if (doc instanceof Actor) return doc;
  return doc?.actor instanceof Actor ? doc.actor : null;
}

/**
 * May `user` have loot delivered onto `actor`?
 *
 * Ownership is the usual answer, plus one widening: a dnd5e GROUP actor whose membership
 * includes a character the user owns. Dropping loot into your own party's stash is the
 * same act as taking it, one step further along — and the GM routinely does not hand
 * players OWNER on the party actor itself, so demanding it would make "add to party" fail
 * for exactly the tables that use a party stash.
 *
 * Deliberately NOT used by `transferItem`, which keeps its stricter both-endpoints-owned
 * contract; this is the looting rule, and looting is the case that cannot satisfy that.
 */
function canReceive(actor, user) {
  if (!actor || !user) return false;
  if (user.isGM) return true;
  if (actor.testUserPermission(user, "OWNER")) return true;
  return actor.type === "group"
    && !!actor.system?.members?.some(m => m.actor?.testUserPermission(user, "OWNER"));
}

/** Nothing physical left and no coin — the chest has been cleaned out. */
function isEmptied(actor) {
  const hasLoot = actor.items.some(i => isPhysical(i) && (i.system.quantity ?? 1) > 0);
  return !hasLoot && totalCopper(actor.system?.currency) <= 0;
}

/**
 * Take a looted-out container off the map — but only one that was never meant to persist.
 * Returns what it removed, `[{ scene, data }]` (the scene's uuid, the token's own data), so
 * the receipt can put the chest back where it stood; an empty list when nothing went.
 *
 * Gated on `container.ephemeral`, which is set by the canvas-drop gesture (canvas-drop.js)
 * and by `createLootContainer({ephemeral: true})`. A dropped-on-the-floor item is scenery
 * that exists to be picked up, so an empty one is litter; a chest the GM placed and
 * furnished is a fixture, and making it vanish the moment it is emptied would delete their
 * work. A GM can flip the flag either way from the config dialog.
 *
 * Called only from the take ops, which additionally scopes this to PLAYERS emptying a
 * chest. A hook on item deletion would also fire when the GM clears one to re-stock it,
 * and having the token vanish mid-restock is a worse bug than the clutter this fixes.
 *
 * Coin counts as contents: a chest holding 50 gp and no items is not empty, and deleting
 * it would destroy the money.
 *
 * `getDependentTokens` also returns EPHEMERAL TokenDocuments (id: null — byproducts of
 * getTokenDocument and friends); those have no scene to be deleted from and throw if you
 * try. Only persisted, scene-embedded tokens count. Deletes are grouped per scene so a
 * container placed several times costs one call per scene rather than one per token.
 */
async function removeEmptiedContainer(container, options = {}) {
  try {
    if (!container.getFlag(MODULE_ID, "container")?.ephemeral) return [];
    if (!isEmptied(container)) return [];
    const tokens = container.isToken ? [container.token] : container.getDependentTokens();
    const byScene = new Map();
    for (const token of tokens) {
      if (!token?.id || !token.parent) continue;
      if (!byScene.has(token.parent)) byScene.set(token.parent, []);
      byScene.get(token.parent).push(token);
    }
    const removed = [];
    for (const [scene, list] of byScene) {
      const data = list.map(t => t.toObject());
      await scene.deleteEmbeddedDocuments("Token", list.map(t => t.id), options);
      for (const d of data) removed.push({ scene: scene.uuid, data: d });
    }
    return removed;
  } catch (err) {
    log.error("removing the emptied container failed", err);
    return []; // the loot already changed hands; a stuck token is not worth throwing over
  }
}

/* -------------------------------------------------- */
/*  Receipts — one line per move, and its revert      */
/* -------------------------------------------------- */

/** The world setting holding who reads a receipt; the choices are the kit's MODES. */
export const RECEIPT_SETTING = MODE_SETTING;
export const RECEIPT_MODES = MODES;

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, RECEIPT_SETTING, {
    name: "Receipts",
    hint: "Who reads the receipt for a purchase, a sale, or loot taken from a chest.",
    scope: "world",
    config: true,
    type: String,
    default: "public",
    choices: Object.fromEntries(RECEIPT_MODES.map(m => [m.value, m.label]))
  });
});

/**
 * The receipts. Each is posted as the acting user (not as whichever GM client handled the
 * socket request), so the line sits under the right person in chat; the speaker alias keeps
 * it visibly a Loot Shelf line rather than something their character said. Public by
 * default: a shared loot log is what settles "who picked up the potion?". PARTICIPANTS, for
 * a whispered receipt, are the PERSONAL side of the move: the buyer, the seller, whoever
 * the proceeds were paid to, whoever the loot went to. The SHARED vessel at the other end
 * (the merchant, the chest) is never consulted for readers: a loot container can carry
 * default player ownership, which would quietly turn every whisper back into a broadcast.
 *
 * Each line's `moves`, as this kernel records them and `revertLine` reads them back:
 *   { kind: "item", from, to, item, qty, name, type, img }
 *       `qty` of the goods went from actor `from` (null: an infinite shop's bottomless stock)
 *       to actor `to`, where they are the item `item` (a stack they merged into, or a new row).
 *   { kind: "coin", actor, delta }
 *       actor `actor`'s purse changed by `delta`, signed per denomination.
 *   { kind: "tokens", actor, tokens: [{ scene, data }] }
 *       the emptied chest `actor`'s tokens, taken off the map.
 * Actors are uuids (a token's actor for an unlinked chest).
 */
export const receipts = createReceipts(MODULE_ID, { elect, log, alias: "Loot Shelf", revert: revertLine });

const itemMove = (from, to, granted, qty, source) => ({
  kind: "item",
  from: from?.uuid ?? null,
  to: to.uuid,
  item: granted?.id ?? null,
  qty,
  name: source.name,
  type: source.type,
  img: source.img
});

const coinMove = (actor, delta) => ({ kind: "coin", actor: actor.uuid, delta });

/** Post one receipt line; resolves with the message's id, or null when it could not be posted. */
async function postLine(line, moves, user, participants) {
  const message = await receipts.post({
    lines: [{ html: line, moves }],
    acting: user?.id ?? null,
    participants
  });
  return message?.id ?? null;
}

/** The goods a move left on `to`: the item it named, else a row of the same name and look. */
function goodsOf(actor, move) {
  const named = actor.items.get(move.item);
  if (named && named.name === move.name) return named;
  return actor.items.find(i => i.type === move.type && i.name === move.name && i.img === move.img) ?? null;
}

/**
 * Reverse one receipt line, on the elect (the kit's receipt.js calls it with the echo-marked
 * `options`). Everything is checked before the first write: the goods still where the move
 * left them, in the quantity it moved; every purse able to give back what it gained. Then
 * an emptied chest goes back on the map (an unlinked chest's actor lives on its token), the
 * purses that gain are paid, the goods go back where they came from (credit before debit, as
 * every move here), and the purses that lose pay last. A failure after the first write says
 * so: the line is then for a GM to check by hand.
 */
async function revertLine(line, { options = {} } = {}) {
  const moves = Array.isArray(line?.moves) ? line.moves : [];
  const tokenMoves = moves.filter(m => m.kind === "tokens");
  const onTokens = new Set(tokenMoves.map(m => m.actor));

  const scenes = [];
  for (const m of tokenMoves) {
    for (const { scene, data } of m.tokens ?? []) {
      const doc = await fromUuid(scene).catch(() => null);
      if (doc) scenes.push([doc, data]);
    }
  }

  const items = [];
  for (const m of moves.filter(x => x.kind === "item")) {
    const to = await resolveActor(m.to);
    if (!to) throw new Error(`the ${m.name} went to an actor that no longer exists`);
    const goods = goodsOf(to, m);
    if (!goods) throw new Error(`${to.name} no longer holds ${m.name}`);
    const held = Math.floor(goods.system?.quantity ?? 1);
    if (goods.type !== "container" && held < m.qty) {
      throw new Error(`${to.name} holds ${held} × ${m.name}, not the ${m.qty} to give back`);
    }
    const from = m.from ? await resolveActor(m.from) : null;
    if (m.from && !from && !onTokens.has(m.from)) {
      throw new Error(`the ${m.name} came from an actor that no longer exists`);
    }
    items.push({ m, to, goods, from });
  }

  const purses = [];
  const purseOf = async m => {
    const actor = await resolveActor(m.actor);
    if (!actor) throw new Error("a purse on this receipt belongs to an actor that no longer exists");
    const after = reverseDelta(actor.system?.currency, m.delta);
    if (!after) {
      throw new Error(`${actor.name} no longer has the coin to give back `
        + `(${formatPurse(totalCopper(actor.system?.currency))})`);
    }
    return { m, actor, after };
  };
  for (const m of moves.filter(x => x.kind === "coin")) {
    purses.push(onTokens.has(m.actor) ? { m, actor: null, after: null } : await purseOf(m));
  }

  let wrote = false;
  try {
    for (const [scene, data] of scenes) {
      await scene.createEmbeddedDocuments("Token", [data], { ...options, keepId: true });
      wrote = true;
    }
    for (let i = 0; i < purses.length; i++) if (!purses[i].actor) purses[i] = await purseOf(purses[i].m);
    for (const it of items) {
      if (it.m.from && !it.from) it.from = await resolveActor(it.m.from);
      if (it.m.from && !it.from) throw new Error(`the ${it.m.name} came from an actor that no longer exists`);
    }
    const gain = p => totalCopper(p.after) - totalCopper(p.actor.system?.currency);
    for (const p of purses.filter(x => gain(x) >= 0)) {
      await p.actor.update({ "system.currency": p.after }, options);
      wrote = true;
    }
    for (const it of items) {
      if (it.from) await grantItem(it.from, it.goods, it.m.qty, { options });
      wrote = true;
      await decrementItem(it.goods, it.m.qty, options);
    }
    for (const p of purses.filter(x => gain(x) < 0)) {
      await p.actor.update({ "system.currency": p.after }, options);
      wrote = true;
    }
  } catch (err) {
    if (wrote) throw new Error(`the revert stopped partway (${err.message}); check the sheets by hand`);
    throw err;
  }
  return { note: scenes.length ? "the chest is back on the map" : "" };
}

/** GM-side operation handlers. Every op re-validates permissions and prices itself. */
const OPS = {

  async purchase({ merchantUuid, buyerUuid, itemId, quantity = 1 }, user) {
    const merchant = await resolveActor(merchantUuid);
    const cfg = merchant?.getFlag(MODULE_ID, "merchant");
    if (!cfg?.enabled) throw new Error("Loot Shelf: that actor is not a merchant.");
    // The same rule the shelf lists by (merchant-sheet.js #onShelf): the hide flag, never
    // `system.equipped`, which dnd5e rewrites on NPCs.
    const item = merchant.items.get(itemId);
    if (!item || !isPhysical(item) || item.system.container
      || item.getFlag(MODULE_ID, "hidden")) throw new Error("Loot Shelf: that item is not for sale.");
    const buyer = await resolveActor(buyerUuid);
    if (!buyer || buyer === merchant) throw new Error("Loot Shelf: no valid buyer.");
    if (!user?.isGM && !buyer.testUserPermission(user, "OWNER"))
      throw new Error(`Loot Shelf: you don't own ${buyer.name}.`);

    const stock = Math.max(0, Math.floor(item.system.quantity ?? 1));
    const qty = Math.min(Math.max(1, Math.floor(quantity)), 9999);
    if (!cfg.infiniteStock && qty > stock) throw new Error(`Loot Shelf: only ${stock} in stock.`);

    const priceMod = Number.isFinite(+cfg.priceModifier) ? +cfg.priceModifier : 1;
    const cost = Math.ceil(priceInCopper(item) * priceMod) * qty;
    const before = coins(buyer.system.currency);
    const paid = planDeduction(before, cost);
    if (!paid) throw new Error(`${buyer.name} can't afford ${formatCopper(cost)}.`);

    const options = receipts.options();
    const name = item.name;
    if (cost > 0) await buyer.update({ "system.currency": paid }, options);
    let granted;
    try {
      granted = await grantItem(buyer, item, qty, { options });
    } catch (err) {
      if (cost > 0) {
        await buyer.update({ "system.currency": before }, options)
          .catch(refund => log.error(`the refund to ${buyer.name} after a failed purchase did not land`, refund));
      }
      throw err;
    }
    const moves = [itemMove(cfg.infiniteStock ? null : merchant, buyer, granted, qty, item)];
    if (cost > 0) moves.push(coinMove(buyer, purseDelta(before, paid)));
    if (!cfg.infiniteStock) {
      await decrementItem(item, qty, options);
      if (cost > 0) {
        const till = coins(merchant.system.currency);
        const after = addCopper(till, cost);
        await merchant.update({ "system.currency": after }, options);
        moves.push(coinMove(merchant, purseDelta(till, after)));
      }
    }
    const receipt = await postLine(html`<strong>${buyer.name}</strong> bought ${qty} × <em>${name}</em> from `
      + html`<strong>${merchant.name}</strong> for ${formatCopper(cost)}.`, moves, user, [buyer]);
    return { name, quantity: qty, cost, receipt };
  },

  async sell({ merchantUuid, sellerUuid, itemId, quantity = 1, payeeUuid = null }, user) {
    const merchant = await resolveActor(merchantUuid);
    const cfg = merchant?.getFlag(MODULE_ID, "merchant");
    if (!cfg?.enabled) throw new Error("Loot Shelf: that actor is not a merchant.");
    const seller = await resolveActor(sellerUuid);
    if (!seller || seller === merchant) throw new Error("Loot Shelf: no valid seller.");
    if (!user?.isGM && !seller.testUserPermission(user, "OWNER"))
      throw new Error(`Loot Shelf: you don't own ${seller.name}.`);
    const item = seller.items.get(itemId);
    if (!item || !isPhysical(item)) throw new Error("Loot Shelf: that item can't be sold.");

    // Where the proceeds go: the seller's own purse unless the request routes them
    // elsewhere — the party-stash case, judged by the same membership rule as looting
    // (`canReceive`), so a seller can bank a sale with their group without owning the
    // group actor itself.
    let payee = seller;
    if (payeeUuid) {
      payee = await resolveActor(payeeUuid);
      if (!payee || payee === merchant) throw new Error("Loot Shelf: no valid payee.");
      if (!canReceive(payee, user))
        throw new Error(`Loot Shelf: you can't route coin to ${payee.name}.`);
    }

    const stock = Math.max(1, Math.floor(item.system.quantity ?? 1));
    const qty = Math.min(Math.max(1, Math.floor(quantity)), stock);
    const sellMod = Number.isFinite(+cfg.sellModifier) ? +cfg.sellModifier : 0.5;
    const gain = Math.floor(priceInCopper(item) * sellMod) * qty;

    // A finite shop pays out of its own purse and cannot buy what it can't afford. The
    // shelf caps the offered quantity by what the shopkeeper is holding, so reaching this
    // error normally means the purse moved between the offer and the confirmation.
    const till = coins(merchant.system.currency);
    let merchantAfter = null;
    if (!cfg.infiniteStock && gain > 0) {
      merchantAfter = planDeduction(till, gain);
      if (!merchantAfter) {
        throw new Error(`${merchant.name} has `
          + `${formatPurse(totalCopper(till))} and can't pay `
          + `${formatCopper(gain)}.`);
      }
    }

    const options = receipts.options();
    const name = item.name;
    const granted = await grantItem(merchant, item, qty, { options });
    await decrementItem(item, qty, options);
    const moves = [itemMove(seller, merchant, granted, qty, item)];
    if (gain > 0) {
      const purse = coins(payee.system.currency);
      const paid = addCopper(purse, gain);
      await payee.update({ "system.currency": paid }, options);
      moves.push(coinMove(payee, purseDelta(purse, paid)));
      if (merchantAfter) {
        await merchant.update({ "system.currency": merchantAfter }, options);
        moves.push(coinMove(merchant, purseDelta(till, merchantAfter)));
      }
    }
    const receipt = await postLine(html`<strong>${seller.name}</strong> sold ${qty} × <em>${name}</em> to `
      + html`<strong>${merchant.name}</strong> for ${formatCopper(gain)}`
      + (payee !== seller ? html`, paid into <strong>${payee.name}</strong>'s purse.` : "."),
      moves, user, [seller, payee]);
    return { name, quantity: qty, gain, payee: payee.name, receipt };
  },

  /**
   * Take loot out of a container the player does NOT own.
   *
   * `transferItem` deliberately demands ownership of both endpoints — it is the general
   * primitive and should stay strict. Looting is the case that cannot satisfy it: a chest
   * on the floor belongs to nobody, and handing every player OWNER on every chest would
   * put each one in their sidebar (the same objection that shaped the merchant shelf).
   * So the rule here is narrower and checked GM-side: the source must be a flagged loot
   * container, and the caller must own only the actor receiving the goods.
   *
   * `intoContainerId` files the goods straight into one of the recipient's bags — the drag
   * onto a bag tile or an open bag sheet (container.js). It must name a container item the
   * recipient actually holds.
   */
  async takeFromContainer({ containerUuid, actorUuid, itemId, quantity, intoContainerId = null }, user) {
    const container = await resolveActor(containerUuid);
    const to = await resolveActor(actorUuid);
    if (!container || !to || container === to)
      throw new Error("Loot Shelf: invalid loot endpoints.");
    if (!container.flags?.[MODULE_ID]?.container?.enabled)
      throw new Error("Loot Shelf: that actor is not a loot container.");
    if (!canReceive(to, user))
      throw new Error(`Loot Shelf: you can't put loot on ${to.name}.`);
    const item = container.items.get(itemId);
    if (!item || !isPhysical(item))
      throw new Error("Loot Shelf: no such physical item in the container.");
    const bag = intoContainerId ? to.items.get(intoContainerId) : null;
    if (intoContainerId && bag?.type !== "container")
      throw new Error(`Loot Shelf: ${to.name} has no such bag.`);
    const stock = Math.max(1, Math.floor(item.system.quantity ?? 1));
    const qty = Math.min(Math.max(1, Math.floor(quantity ?? stock)), stock);
    const options = receipts.options();
    const name = item.name;
    const granted = await grantItem(to, item, qty, { container: bag?.id ?? null, options });
    await decrementItem(item, qty, options);
    const removed = await removeEmptiedContainer(container, options);
    const emptied = removed.length > 0;
    const moves = [itemMove(container, to, granted, qty, item)];
    if (emptied) moves.push({ kind: "tokens", actor: container.uuid, tokens: removed });
    const receipt = await postLine(html`<strong>${to.name}</strong> took ${qty} × <em>${name}</em> from `
      + html`<strong>${container.name}</strong>.`
      + (emptied ? html` <em>${container.name} was picked clean and is gone.</em>` : ""), moves, user, [to]);
    return { name, quantity: qty, emptied, receipt };
  },

  /**
   * Take the coin out of a container the player does NOT own — the currency counterpart
   * to `takeFromContainer`, and subject to the same narrow rule: flagged loot container on
   * one end, an actor the caller owns on the other.
   *
   * Coin moves DENOMINATION BY DENOMINATION rather than through `addCopper`, which
   * canonicalises to gp/sp/cp: a chest holding 2 pp should put two platinum in the
   * player's purse, not twenty gold. Re-denominating someone's coin behind their back is
   * the same thing `planDeduction` is careful not to do when making change.
   */
  async takeCurrencyFromContainer({ containerUuid, actorUuid }, user) {
    const container = await resolveActor(containerUuid);
    const to = await resolveActor(actorUuid);
    if (!container || !to || container === to)
      throw new Error("Loot Shelf: invalid loot endpoints.");
    if (!container.flags?.[MODULE_ID]?.container?.enabled)
      throw new Error("Loot Shelf: that actor is not a loot container.");
    if (!canReceive(to, user))
      throw new Error(`Loot Shelf: you can't put coin on ${to.name}.`);

    const taken = coins(container.system?.currency);
    const amount = totalCopper(taken);
    if (amount <= 0) throw new Error(`Loot Shelf: ${container.name} has no coin.`);

    // Credit before emptying, so a failed update never destroys the coin (fail open).
    const options = receipts.options();
    const before = coins(to.system?.currency);
    const purse = coins(before);
    for (const k of ASCENDING) purse[k] += taken[k];
    await to.update({ "system.currency": purse }, options);
    await container.update({ "system.currency": coins(null) }, options);
    const moves = [coinMove(to, purseDelta(before, purse)), coinMove(container, purseDelta(taken, coins(null)))];

    const removed = await removeEmptiedContainer(container, options);
    const emptied = removed.length > 0;
    if (emptied) moves.push({ kind: "tokens", actor: container.uuid, tokens: removed });
    const receipt = await postLine(html`<strong>${to.name}</strong> took ${formatCopper(amount)} from `
      + html`<strong>${container.name}</strong>.`
      + (emptied ? html` <em>${container.name} was picked clean and is gone.</em>` : ""), moves, user, [to]);
    return { amount, emptied, receipt };
  },

  async transferItem({ fromUuid: fromId, toUuid: toId, itemId, quantity, move = true }, user) {
    const from = await resolveActor(fromId);
    const to = await resolveActor(toId);
    if (!from || !to || from === to) throw new Error("Loot Shelf: invalid transfer endpoints.");
    if (!user?.isGM && !(from.testUserPermission(user, "OWNER") && to.testUserPermission(user, "OWNER")))
      throw new Error("Loot Shelf: you must own both actors.");
    const item = from.items.get(itemId);
    if (!item || !isPhysical(item)) throw new Error("Loot Shelf: no such physical item on the source.");
    const stock = Math.max(1, Math.floor(item.system.quantity ?? 1));
    const qty = Math.min(Math.max(1, Math.floor(quantity ?? stock)), stock);
    const name = item.name;
    await grantItem(to, item, qty);
    if (move) await decrementItem(item, qty);
    return { name, quantity: qty };
  }
};

async function handle(op, payload, user) {
  const fn = OPS[op];
  if (!fn) throw new Error(`Loot Shelf: unknown operation "${op}".`);
  if (!user) throw new Error("Loot Shelf: unknown requesting user.");
  return fn(payload, user);
}

async function onSocket(msg) {
  if (msg?.t === "req") {
    if (!elect.isElect()) return; // the elect: exactly one client answers
    let res;
    try {
      res = { ok: true, data: await handle(msg.op, msg.payload, game.users.get(msg.userId)) };
    } catch (err) {
      log.error(`${msg.op} failed`, err);
      res = { ok: false, error: err.message };
    }
    game.socket.emit(SOCKET, { t: "res", id: msg.id, ...res });
  } else if (msg?.t === "res") {
    const p = pending.get(msg.id);
    if (!p) return; // someone else's response
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error ?? "Loot Shelf: the request failed."));
  }
}

/**
 * Run a kernel operation, locally when this client is the elect, otherwise proxied over
 * the socket (to the elect, which may be this same user's other window). Resolves with the
 * op's result or rejects with a user-facing Error.
 */
export async function gmRequest(op, payload) {
  if (!game.users.activeGM) throw new Error("Loot Shelf: no GM is connected.");
  if (elect.isElect()) return handle(op, payload, game.user);
  return new Promise((resolve, reject) => {
    const id = foundry.utils.randomID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Loot Shelf: the GM client did not respond."));
    }, REQUEST_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    game.socket.emit(SOCKET, { t: "req", id, op, payload, userId: game.user.id });
  });
}

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
});

/* -------------------------------------------------- */
/*  Stocking helper (shared by the create-* API)      */
/* -------------------------------------------------- */

/**
 * Embed a list of items (uuids or plain item data) onto an actor. Each entry is stocked
 * as an independent top-level item: `system.container` is detached, because compendium
 * items routinely carry stale container refs from their source pack (the SRD's Rations
 * point at a Backpack that won't exist on the target), which would make them invisible
 * to the shelf and unsellable.
 */
export async function stockItems(actor, items = []) {
  const docs = [];
  for (const entry of items) {
    if (typeof entry === "string") {
      const doc = await fromUuid(entry);
      if (doc instanceof Item) docs.push(doc.toObject());
      else log.warn(`stockItems: "${entry}" is not an Item uuid — skipped.`);
    } else if (entry && typeof entry === "object") {
      docs.push(foundry.utils.deepClone(entry));
    }
  }
  for (const d of docs) {
    delete d._id;
    if (d.system && "container" in d.system) d.system.container = null;
  }
  if (docs.length) await actor.createEmbeddedDocuments("Item", docs);
  return docs.length;
}

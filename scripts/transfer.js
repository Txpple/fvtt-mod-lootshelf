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
 * plain `game.socket` on `module.fvtt-mod-lootshelf`, handled only by the client whose
 * user is `game.users.activeGM` (the GM-elect pattern — no socketlib). The GM handler
 * re-validates everything server-side: flags, ownership, stock, and above all the PRICE —
 * a client never gets to name its own number.
 */

export const MODULE_ID = "fvtt-mod-lootshelf";
const SOCKET = `module.${MODULE_ID}`;
const REQUEST_TIMEOUT = 15000;

/* -------------------------------------------------- */
/*  Currency — dnd5e pp/gp/ep/sp/cp, straight math    */
/* -------------------------------------------------- */

/** Copper value of one coin of each denomination. */
export const RATES = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const ASCENDING = ["cp", "sp", "ep", "gp", "pp"];

/** A sanitized copy of an actor's currency object (non-negative integers, all five keys). */
function coins(currency) {
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

/** An existing top-level stack on `target` that a copy of `item` can merge into. */
function findStack(target, item) {
  if (item.type === "container") return null;
  return target.items.find(i =>
    i.type === item.type && i.name === item.name && i.img === item.img
    && !i.system.container && i.system.quantity != null
  ) ?? null;
}

/** Recursively copy a container item's contents onto `target`, under `containerId`. */
async function copyContents(sourceContainer, target, containerId) {
  const contents = sourceContainer.system?.contents;
  if (!contents) return;
  for (const c of contents) {
    const data = cleanItemData(c);
    data.system.container = containerId;
    const [created] = await target.createEmbeddedDocuments("Item", [data]);
    if (c.type === "container") await copyContents(c, target, created.id);
  }
}

/**
 * Create `quantity` of `item` on `target` (merging into an existing stack when possible)
 * and return the created or updated item. Does NOT touch the source — callers decrement
 * afterwards, so the copy always lands before anything is destroyed.
 */
export async function grantItem(target, item, quantity = 1) {
  if (item.type === "container") {
    const [created] = await target.createEmbeddedDocuments("Item", [cleanItemData(item, 1)]);
    await copyContents(item, target, created.id);
    return created;
  }
  const stack = findStack(target, item);
  if (stack) {
    await stack.update({ "system.quantity": Math.floor(stack.system.quantity ?? 0) + quantity });
    return stack;
  }
  const [created] = await target.createEmbeddedDocuments("Item", [cleanItemData(item, quantity)]);
  return created;
}

/** Remove `quantity` from a source item — delete the item when the stack runs out. */
export async function decrementItem(item, quantity = 1) {
  if (item.type === "container") return item.delete({ deleteContents: true });
  const q = Math.floor(item.system.quantity ?? 1);
  if (q - quantity > 0) return item.update({ "system.quantity": q - quantity });
  return item.delete();
}

/* -------------------------------------------------- */
/*  Incoming-item normalization                       */
/* -------------------------------------------------- */

// Anything dropped onto a flagged container or merchant arrives unattuned and unequipped
// — items sitting in a chest or on a shelf belong to nobody. This runs on the creating
// client (preCreate hooks fire initiator-side only), so whatever is taken OUT later via
// the native drag pipeline is already clean without a transformer layer in the middle.
Hooks.on("preCreateItem", (item, data, options, userId) => {
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
    console.error(`${MODULE_ID} | incoming-item normalization failed`, err);
  }
});

/* -------------------------------------------------- */
/*  GM proxy — plain socket, GM-elect handler         */
/* -------------------------------------------------- */

const pending = new Map(); // request id -> {resolve, reject, timer}

/** Resolve an actor from a uuid that may point at an Actor or a TokenDocument. */
async function resolveActor(uuid) {
  if (!uuid) return null;
  const doc = await fromUuid(uuid);
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

/** Whisper an audit line to the GMs and the acting user. */
function audit(content, user) {
  const whisper = new Set(game.users.filter(u => u.isGM).map(u => u.id));
  if (user) whisper.add(user.id);
  ChatMessage.implementation.create({
    content,
    whisper: [...whisper],
    speaker: { alias: "Loot Shelf" }
  }).catch(err => console.error(`${MODULE_ID} | audit message failed`, err));
}

/** GM-side operation handlers. Every op re-validates permissions and prices itself. */
const OPS = {

  async purchase({ merchantUuid, buyerUuid, itemId, quantity = 1 }, user) {
    const merchant = await resolveActor(merchantUuid);
    const cfg = merchant?.getFlag(MODULE_ID, "merchant");
    if (!cfg?.enabled) throw new Error("Loot Shelf: that actor is not a merchant.");
    const item = merchant.items.get(itemId);
    if (!item || !isPhysical(item) || item.system.container || item.system.equipped
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

    const name = item.name;
    if (cost > 0) await buyer.update({ "system.currency": paid });
    try {
      await grantItem(buyer, item, qty);
    } catch (err) {
      if (cost > 0) await buyer.update({ "system.currency": before }).catch(() => {});
      throw err;
    }
    if (!cfg.infiniteStock) {
      await decrementItem(item, qty);
      if (cost > 0) await merchant.update({ "system.currency": addCopper(merchant.system.currency, cost) });
    }
    audit(`<strong>${buyer.name}</strong> bought ${qty} × <em>${name}</em> from `
      + `<strong>${merchant.name}</strong> for ${formatCopper(cost)}.`, user);
    return { name, quantity: qty, cost };
  },

  async sell({ merchantUuid, sellerUuid, itemId, quantity = 1 }, user) {
    const merchant = await resolveActor(merchantUuid);
    const cfg = merchant?.getFlag(MODULE_ID, "merchant");
    if (!cfg?.enabled) throw new Error("Loot Shelf: that actor is not a merchant.");
    const seller = await resolveActor(sellerUuid);
    if (!seller || seller === merchant) throw new Error("Loot Shelf: no valid seller.");
    if (!user?.isGM && !seller.testUserPermission(user, "OWNER"))
      throw new Error(`Loot Shelf: you don't own ${seller.name}.`);
    const item = seller.items.get(itemId);
    if (!item || !isPhysical(item)) throw new Error("Loot Shelf: that item can't be sold.");

    const stock = Math.max(1, Math.floor(item.system.quantity ?? 1));
    const qty = Math.min(Math.max(1, Math.floor(quantity)), stock);
    const sellMod = Number.isFinite(+cfg.sellModifier) ? +cfg.sellModifier : 0.5;
    const gain = Math.floor(priceInCopper(item) * sellMod) * qty;

    // A finite shop pays out of its own purse and cannot buy what it can't afford. The
    // shelf caps the offered quantity by what the shopkeeper is holding, so reaching this
    // error normally means the purse moved between the offer and the confirmation.
    let merchantAfter = null;
    if (!cfg.infiniteStock && gain > 0) {
      merchantAfter = planDeduction(merchant.system.currency, gain);
      if (!merchantAfter) {
        throw new Error(`${merchant.name} has `
          + `${formatPurse(totalCopper(merchant.system.currency))} and can't pay `
          + `${formatCopper(gain)}.`);
      }
    }

    const name = item.name;
    await grantItem(merchant, item, qty);
    await decrementItem(item, qty);
    if (gain > 0) {
      await seller.update({ "system.currency": addCopper(seller.system.currency, gain) });
      if (merchantAfter) await merchant.update({ "system.currency": merchantAfter });
    }
    audit(`<strong>${seller.name}</strong> sold ${qty} × <em>${name}</em> to `
      + `<strong>${merchant.name}</strong> for ${formatCopper(gain)}.`, user);
    return { name, quantity: qty, gain };
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
   */
  async takeFromContainer({ containerUuid, actorUuid, itemId, quantity }, user) {
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
    const stock = Math.max(1, Math.floor(item.system.quantity ?? 1));
    const qty = Math.min(Math.max(1, Math.floor(quantity ?? stock)), stock);
    const name = item.name;
    await grantItem(to, item, qty);
    await decrementItem(item, qty);
    audit(`<strong>${to.name}</strong> took ${qty} × <em>${name}</em> from `
      + `<strong>${container.name}</strong>.`, user);
    return { name, quantity: qty };
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
    const purse = coins(to.system?.currency);
    for (const k of ASCENDING) purse[k] += taken[k];
    await to.update({ "system.currency": purse });
    await container.update({ "system.currency": coins(null) });

    audit(`<strong>${to.name}</strong> took ${formatCopper(amount)} from `
      + `<strong>${container.name}</strong>.`, user);
    return { amount };
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
    if (game.users.activeGM !== game.user) return; // GM-elect: exactly one client answers
    let res;
    try {
      res = { ok: true, data: await handle(msg.op, msg.payload, game.users.get(msg.userId)) };
    } catch (err) {
      console.error(`${MODULE_ID} | ${msg.op} failed`, err);
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
 * Run a kernel operation, locally when this client is the GM-elect, otherwise proxied
 * over the socket. Resolves with the op's result or rejects with a user-facing Error.
 */
export async function gmRequest(op, payload) {
  const gm = game.users.activeGM;
  if (!gm) throw new Error("Loot Shelf: no GM is connected.");
  if (gm === game.user) return handle(op, payload, game.user);
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
      else console.warn(`${MODULE_ID} | stockItems: "${entry}" is not an Item uuid — skipped.`);
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

// The live check of the kit's receipt and its revert, on a real world (the local sandbox).
//
//   FOUNDRY_HOST=local node tools/live-check.mjs
//
// Joins as the suite identity (FOUNDRY_SUITE_USER in the MCP repo's .env), refuses to run beside
// another GM client (an older copy of the module there would answer the kernel), and then:
//   A. a purchase at a probe shop posts one receipt line whose flag carries the moves;
//   B. the revert, asked as the Revert button asks it (api.revertReceipt), puts the goods back on
//      the shelf and the coin back in both purses, and the line reads reverted;
//   C. a sale paid into a party's purse posts one Loot Shelf line and no Party Stash line (the
//      echo marker), and its revert takes the coin back out of the party and the goods off the shelf.
// Every fixture (the shop, the buyer, the party, the chat lines) is removed in `finally`.
import { connectFoundry } from "fvtt-mcp-dnd5e/client";

const PROBE = "ZZ-4g Live";
let fails = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) fails++;
};

const { f, dispose } = await connectFoundry({ host: "local", identity: "suite", tag: "live-check", watchdogMs: 300_000 });

/** In the page: who else is a GM here, and whether this client is Loot Shelf's elect. */
const PREFLIGHT = async () => {
  const api = game.modules.get("fvtt-mod-lootshelf")?.api;
  const others = game.users.filter(u => u.active && u.isGM && !u.isSelf).map(u => u.name);
  const until = Date.now() + 10_000;
  while (api && !api.isElect() && Date.now() < until) await new Promise(r => setTimeout(r, 200));
  return {
    active: !!game.modules.get("fvtt-mod-lootshelf")?.active,
    partyStash: !!game.modules.get("fvtt-mod-partystash")?.active,
    hasKit: typeof api?.revertReceipt === "function",
    elect: !!api?.isElect?.(),
    others
  };
};

/** In the page: the shop, the buyer and the party. */
const FIXTURE = async ({ probe }) => {
  const api = game.modules.get("fvtt-mod-lootshelf").api;
  const shop = await api.createMerchant({
    name: `${probe} Shop`,
    items: [{ name: `${probe} Rope`, type: "loot", system: { quantity: 5, price: { value: 2, denomination: "gp" } } }],
    priceModifier: 1, sellModifier: 0.5, infiniteStock: false
  });
  const buyer = await Actor.implementation.create({
    name: `${probe} Buyer`, type: "character", system: { currency: { pp: 0, gp: 10, ep: 0, sp: 0, cp: 0 } }
  });
  const party = await Actor.implementation.create({ name: `${probe} Party`, type: "group" });
  await party.system.addMember(buyer);
  return { shop: shop.uuid, buyer: buyer.uuid, party: party.uuid, ids: [shop.id, buyer.id, party.id] };
};

/** In the page: the scenario, each step's facts for the asserts. */
const SCENARIO = async ({ probe, fx }) => {
  const LS = "fvtt-mod-lootshelf";
  const api = game.modules.get(LS).api;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const shop = await fromUuid(fx.shop);
  const buyer = await fromUuid(fx.buyer);
  const party = await fromUuid(fx.party);
  const rope = a => a.items.find(i => i.name === `${probe} Rope`);
  const qty = a => Math.floor(rope(a)?.system?.quantity ?? 0);
  const gp = a => Math.floor(a.system.currency?.gp ?? 0);
  const state = m => m?.flags?.[LS]?.receipt?.state?.l0?.state ?? null;
  const waitState = async (id, want) => {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const s = state(game.messages.get(id));
      if (s === want || s === "refused") return s;
      await sleep(200);
    }
    return state(game.messages.get(id));
  };
  const linesSince = (start, alias) => game.messages.contents
    .filter(m => !start.has(m.id) && m.speaker?.alias === alias && (m.content ?? "").includes(probe));
  const drawn = id => {
    const el = document.querySelector(`[data-message-id="${id}"]`);
    const row = el?.querySelector("[data-receipt-line]");
    return { rendered: !!el, button: !!el?.querySelector(".openroll5e-receipt-revert"),
      struck: row?.style?.textDecoration === "line-through" };
  };
  const out = {};

  // A. The purchase and its receipt.
  let start = new Set(game.messages.keys());
  const bought = await api.purchase({ merchantUuid: shop.uuid, buyerUuid: buyer.uuid, itemId: rope(shop).id, quantity: 2 });
  await sleep(300);
  const msg = game.messages.get(bought.receipt);
  const flag = msg?.flags?.[LS]?.receipt;
  out.a = {
    receiptId: bought.receipt,
    lines: linesSince(start, "Loot Shelf").length,
    text: (msg?.content ?? "").replace(/<[^>]+>/g, ""),
    version: flag?.v ?? null,
    flagLines: flag?.lines?.length ?? 0,
    moves: flag?.lines?.[0]?.moves ?? [],
    revertible: !!flag?.lines?.[0]?.revertible,
    buyerGp: gp(buyer), buyerRope: qty(buyer), shopRope: qty(shop), shopGp: gp(shop),
    shopUuid: shop.uuid, buyerUuid: buyer.uuid
  };
  out.a.drawnBefore = drawn(bought.receipt);

  // B. The revert, as the button asks it.
  start = new Set(game.messages.keys());
  out.b = { asked: await api.revertReceipt(bought.receipt, 0) };
  out.b.state = await waitState(bought.receipt, "done");
  out.b.why = game.messages.get(bought.receipt)?.flags?.[LS]?.receipt?.state?.l0?.why ?? null;
  await sleep(800);
  Object.assign(out.b, {
    buyerGp: gp(buyer), buyerRope: qty(buyer), shopRope: qty(shop), shopGp: gp(shop),
    newLines: game.messages.contents.filter(m => !start.has(m.id)).length,
    again: await api.revertReceipt(bought.receipt, 0)
  });
  out.b.drawnAfter = drawn(bought.receipt);

  // C. A sale paid into the party: one Loot Shelf line, no Party Stash line; then its revert.
  const second = await api.purchase({ merchantUuid: shop.uuid, buyerUuid: buyer.uuid, itemId: rope(shop).id, quantity: 1 });
  await sleep(300);
  start = new Set(game.messages.keys());
  const partyBefore = gp(party);
  const sold = await api.sell({ merchantUuid: shop.uuid, sellerUuid: buyer.uuid, itemId: rope(buyer).id, quantity: 1, payeeUuid: party.uuid });
  await sleep(1500); // past Party Stash's 500 ms receipt batch
  out.c = {
    secondReceipt: second.receipt,
    soldReceipt: sold.receipt,
    lootLines: linesSince(start, "Loot Shelf").length,
    stashLines: game.messages.contents.filter(m => !start.has(m.id) && m.speaker?.alias === "Party Stash").length,
    partyGained: gp(party) - partyBefore,
    shopRopeAfterSale: qty(shop), buyerRopeAfterSale: qty(buyer)
  };
  start = new Set(game.messages.keys());
  await api.revertReceipt(sold.receipt, 0);
  out.c.state = await waitState(sold.receipt, "done");
  out.c.why = game.messages.get(sold.receipt)?.flags?.[LS]?.receipt?.state?.l0?.why ?? null;
  await sleep(1500);
  Object.assign(out.c, {
    partyAfterRevert: gp(party) - partyBefore,
    buyerRopeAfterRevert: qty(buyer), shopRopeAfterRevert: qty(shop),
    linesAfterRevert: game.messages.contents.filter(m => !start.has(m.id)).length
  });
  return out;
};

/** In the page: everything the check made. */
const TEARDOWN = async ({ probe, ids }) => {
  const messages = game.messages.contents.filter(m => (m.content ?? "").includes(probe)).map(m => m.id);
  if (messages.length) await ChatMessage.implementation.deleteDocuments(messages);
  const actors = [...new Set([...(ids ?? []), ...game.actors.filter(a => a.name?.startsWith(probe)).map(a => a.id)])]
    .filter(id => game.actors.has(id));
  if (actors.length) await Actor.implementation.deleteDocuments(actors);
  return { messages: messages.length, actors: actors.length };
};

let fx = null;
try {
  console.log("# preflight");
  const pre = await f.evaluate(PREFLIGHT, null);
  check(pre.active && pre.hasKit, "Loot Shelf is active and carries the kit (api.revertReceipt)");
  check(pre.others.length === 0, `no other GM client is connected (${pre.others.join(", ") || "none"})`);
  check(pre.elect, "this client is Loot Shelf's elect");
  check(pre.partyStash, "Party Stash is active (section C needs it)");
  if (fails) throw new Error("preflight failed; nothing was made");

  await f.evaluate(TEARDOWN, { probe: PROBE, ids: [] }); // a crashed run's leavings
  fx = await f.evaluate(FIXTURE, { probe: PROBE });
  const r = await f.evaluate(SCENARIO, { probe: PROBE, fx });

  console.log("# A — the purchase posts one line carrying its moves");
  console.log(`  [receipt] ${r.a.text}`);
  check(r.a.lines === 1, `one Loot Shelf line (got ${r.a.lines})`);
  check(/Buyer bought 2 × ZZ-4g Live Rope from ZZ-4g Live Shop for 4 gp\./.test(r.a.text), "the line says who bought what, from whom, for how much");
  check(r.a.version === 1 && r.a.flagLines === 1 && r.a.revertible, "the flag is version 1, one revertible line");
  const item = r.a.moves.find(m => m.kind === "item");
  check(item?.from === r.a.shopUuid && item?.to === r.a.buyerUuid && item?.qty === 2, "the item move: 2 from the shop to the buyer");
  const legs = r.a.moves.filter(m => m.kind === "coin");
  check(legs.length === 2 && legs.some(l => l.actor === r.a.buyerUuid) && legs.some(l => l.actor === r.a.shopUuid), "a coin leg for each purse");
  check(r.a.buyerGp === 6 && r.a.buyerRope === 2 && r.a.shopRope === 3 && r.a.shopGp === 4, `the sale landed (buyer ${r.a.buyerGp} gp, ${r.a.buyerRope} rope; shop ${r.a.shopRope} rope, ${r.a.shopGp} gp)`);

  console.log("# B — the revert puts it back, once");
  check(r.b.asked === true, "the ask was written");
  check(r.b.state === "done", `the elect reverted the line (${r.b.state}${r.b.why ? `: ${r.b.why}` : ""})`);
  check(r.b.buyerGp === 10 && r.b.buyerRope === 0 && r.b.shopRope === 5 && r.b.shopGp === 0, `as before the sale (buyer ${r.b.buyerGp} gp, ${r.b.buyerRope} rope; shop ${r.b.shopRope} rope, ${r.b.shopGp} gp)`);
  check(r.b.newLines === 0, `the revert posted no line of its own (got ${r.b.newLines})`);
  check(r.b.again === false, "a reverted line cannot be asked again");
  if (r.a.drawnBefore.rendered) {
    check(r.a.drawnBefore.button, "the card the chat log drew carries the Revert button");
    check(r.b.drawnAfter.struck && !r.b.drawnAfter.button, "once reverted the line is struck through and the button gone");
  } else console.log("  note  the chat log did not draw the card here; the button was not looked at");

  console.log("# C — a sale into the party: one line, and its revert");
  check(r.c.lootLines === 1, `one Loot Shelf line (got ${r.c.lootLines})`);
  check(r.c.stashLines === 0, `no Party Stash line for the same coin (got ${r.c.stashLines})`);
  check(r.c.partyGained === 1, `the party's purse gained 1 gp (got ${r.c.partyGained})`);
  check(r.c.state === "done", `the sale was reverted (${r.c.state}${r.c.why ? `: ${r.c.why}` : ""})`);
  check(r.c.partyAfterRevert === 0 && r.c.buyerRopeAfterRevert === 1 && r.c.shopRopeAfterRevert === r.c.shopRopeAfterSale - 1,
    `the coin left the party and the rope went back to the seller (party ${r.c.partyAfterRevert}, seller ${r.c.buyerRopeAfterRevert}, shop ${r.c.shopRopeAfterRevert})`);
  check(r.c.linesAfterRevert === 0, `the revert posted no line in either module (got ${r.c.linesAfterRevert})`);
} catch (err) {
  fails++;
  console.error(`  FAIL  ${err.message}`);
} finally {
  try {
    const gone = await f.evaluate(TEARDOWN, { probe: PROBE, ids: fx?.ids ?? [] });
    console.log(`# teardown: ${gone.actors} actors, ${gone.messages} chat lines removed`);
  } catch (err) {
    fails++;
    console.error(`  FAIL  teardown: ${err.message}`);
  }
  await dispose();
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);

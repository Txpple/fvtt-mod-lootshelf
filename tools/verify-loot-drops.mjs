// Live verification that loot MOVES — never duplicates — on every path dnd5e has for dropping an item
// into an inventory, and that shop goods cannot be carried off along any of them.
//
// dnd5e creates dropped items in three places, each with its own move-delete that is broken for loot
// (see container.js): the inventory list (`_onDropCreateItems`), a bag tile (`_onDropItemContainer`),
// and a bag's own item sheet (ContainerSheet#_onDropItem). Before 1.2.2 only the first was covered, so
// dropping chest loot onto a bag left the original in the chest, and dropping a shop good onto a bag
// handed the whole stack over for free. This drives each path through the REAL event sequence —
// dragstart on the source row, dragover + drop on the target — from two clients at once:
//
//   GM     "Tester Assistant" (the client's 'suite' identity; also the elected activeGM that answers
//          the player's socket requests, so it must stay connected for the run)
//   player "Open Player 1", whose assigned character is Salyth
//
// Fixtures are prefixed ZZ-LSDROPS and deleted at the end; Salyth's items and purse are snapshotted
// first and restored after. Take receipts are public chat by design and stay in the log.
//
//   FOUNDRY_HOST=local node tools/verify-loot-drops.mjs      (the local sandbox)
import { connectFoundry } from 'fvtt-mcp-dnd5e/client';

const TAG = 'ZZ-LSDROPS';
const WEND = 'JBEHNnZOEsNrtDmV'; // Mother Wend — any merchant with a Longsword in stock will do
const PLAYER = 'Open Player 1';

/** In-page helpers, prepended to every evaluated body. */
const HELPERS = `
  const LS = 'fvtt-mod-lootshelf';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (pred, ms = 10000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { try { const v = await pred(); if (v) return v; } catch {} await wait(100); }
    return null;
  };
  window.__lsd ??= { notes: [], errors: [] };
  if (!window.__lsd.wrapped) {
    window.__lsd.wrapped = true;
    for (const lvl of ['info', 'warn', 'error']) {
      const orig = ui.notifications[lvl].bind(ui.notifications);
      ui.notifications[lvl] = (msg, opts) => { window.__lsd.notes.push(lvl + ': ' + String(msg)); return orig(msg, opts); };
    }
    const ce = console.error.bind(console);
    console.error = (...a) => { window.__lsd.errors.push(a.map(x => x?.message ?? String(x)).join(' ').slice(0, 300)); return ce(...a); };
    window.addEventListener('unhandledrejection', e => window.__lsd.errors.push('unhandled: ' + String(e.reason?.message ?? e.reason).slice(0, 300)));
  }
  const drain = () => { const o = { notes: [...window.__lsd.notes], errors: window.__lsd.errors.filter(e => !/ResizeObserver/.test(e)) }; window.__lsd.notes.length = 0; window.__lsd.errors.length = 0; return o; };
  const renderSheet = async (doc, opts = {}) => { await doc.sheet.render({ force: true, ...opts }); await waitFor(() => doc.sheet.rendered && doc.sheet.element); await wait(250); return doc.sheet; };
  const qtyOf = (actor, name) => actor.items.filter(i => i.name === name).reduce((n, i) => n + (i.system.quantity ?? 1), 0);
  const inBag = (actor, bagId, name) => actor.items.filter(i => i.name === name && i.system.container === bagId).reduce((n, i) => n + i.system.quantity, 0);
  const rowOf = (sheet, item) => sheet.element.querySelector('li.item[data-item-id="' + item.id + '"] > .item-row');
  const dragDrop = async (srcEl, dstEl) => {
    const dt = new DataTransfer();
    srcEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(80);
    dstEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(80);
    dstEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(80);
    srcEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
  };
  // A hand-built drop onto an open bag sheet — for shop goods, whose rows refuse the dragstart.
  const dropUuid = async (el, uuid) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', JSON.stringify({ type: 'Item', uuid }));
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(60);
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  };
  const out = [];
  const ok = (name, pass, detail = '') => out.push({ name, pass: !!pass, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  // One drop that must MOVE qty of source into the bag: in the bag, gone from the chest, no error.
  // Waits on the chest side too — the kernel grants before it decrements.
  const expectMove = async (label, { chest, source, actor, bag, qty, drop }) => {
    const name = source.name;
    const b0 = inBag(actor, bag.id, name);
    const t0 = qtyOf(actor, name);
    drain();
    await drop();
    await waitFor(() => !chest.items.get(source.id) && inBag(actor, bag.id, name) === b0 + qty, 12000);
    await wait(1500);
    const d = drain();
    ok(label, inBag(actor, bag.id, name) - b0 === qty && qtyOf(actor, name) - t0 === qty
      && !chest.items.get(source.id) && !d.errors.length,
      { inBag: inBag(actor, bag.id, name) - b0, total: qtyOf(actor, name) - t0,
        leftInChest: chest.items.get(source.id)?.system.quantity ?? 0, errors: d.errors });
  };
`;
const run = (f, body, payload) =>
  f.evaluate(new Function('P', `return (async () => { ${HELPERS}\n${body}\n return out; })();`), payload);

const results = [];
const record = (who, list) => { for (const r of list) results.push({ who, ...r }); };

const gm = await connectFoundry({ identity: 'suite', tag: 'verify-drops', watchdogMs: 600_000 });
let player = null;
let fx = null;
try {
  // --- fixtures: a chest nobody owns, a chest every player owns, and a snapshot of Salyth --------
  fx = await gm.f.evaluate(async ({ TAG, PLAYER }) => {
    const LS = 'fvtt-mod-lootshelf';
    const api = game.modules.get(LS).api;
    for (const a of game.actors.filter(a => a.name.startsWith(TAG))) await a.delete();
    const salyth = game.users.getName(PLAYER)?.character;
    if (!salyth) throw new Error(`${PLAYER} has no assigned character`);
    const bag = salyth.items.find(i => i.type === 'container' && !i.system.container);
    if (!bag) throw new Error(`${salyth.name} carries no top-level bag to drop into`);
    const snapshot = { currency: foundry.utils.deepClone(salyth._source.system.currency),
      items: Object.fromEntries(salyth.items.map(i => [i.id, i._source.system.quantity ?? null])) };
    const pack = game.packs.get('dnd5e.items');
    const idx = await pack.getIndex();
    // withSource = what a GM dragging from a compendium produces; dnd5e's gear transform then swaps
    // in a clone of the compendium entry, which is what made the stock move-delete hit a locked pack.
    const data = async (name, extra = {}, withSource = true) => {
      const doc = await pack.getDocument(idx.find(i => i.name === name)._id);
      const d = doc.toObject(); delete d._id;
      if (withSource) d._stats = { ...(d._stats ?? {}), compendiumSource: doc.uuid };
      return foundry.utils.mergeObject(d, extra);
    };
    const unowned = await api.createLootContainer({ name: `${TAG} Unowned`, items: [
      await data('Dagger', { system: { quantity: 2 } }, false),
      await data('Potion of Healing', { system: { quantity: 2 } }),
      await data('Longsword'), await data('Crowbar')] });
    const owned = await api.createLootContainer({ name: `${TAG} Owned`, defaultOwnership: 3, items: [
      await data('Longsword'), await data('Potion of Healing', { system: { quantity: 3 } })] });
    return { snapshot, ids: { salyth: salyth.id, bag: bag.id, unowned: unowned.id, owned: owned.id } };
  }, { TAG, PLAYER });

  player = await connectFoundry({ identity: { user: PLAYER }, tag: 'verify-drops', watchdogMs: 600_000 });

  // --- player: both chests, all three landing spots, and the shop -----------------------------
  record('player', await run(player.f, `
    const salyth = game.actors.get(P.ids.salyth);
    const bag = salyth.items.get(P.ids.bag);
    const U = game.actors.get(P.ids.unowned), O = game.actors.get(P.ids.owned);
    ok('socket requests are answered', game.users.activeGM, game.users.activeGM?.name ?? 'no GM connected');
    const ss = await renderSheet(salyth, { tab: 'inventory' });
    const tile = () => ss.element.querySelector('li.container[data-item-id="' + bag.id + '"]');
    const us = await renderSheet(U), os = await renderSheet(O), bs = await renderSheet(bag);
    const bagBody = () => bs.element.querySelector('.window-content') ?? bs.element;

    const dagger = U.items.find(i => i.name === 'Dagger');
    await expectMove('unowned chest -> inventory list', { chest: U, source: dagger, actor: salyth, bag: { id: null }, qty: 2,
      drop: () => dragDrop(rowOf(us, dagger), ss.element.querySelector('.inventory-element .items-list')) });
    const potion = U.items.find(i => i.name === 'Potion of Healing');
    await expectMove('unowned chest -> bag tile', { chest: U, source: potion, actor: salyth, bag, qty: 2,
      drop: () => dragDrop(rowOf(us, potion), tile()) });
    const bar = U.items.find(i => i.name === 'Crowbar');
    await expectMove('unowned chest -> open bag sheet', { chest: U, source: bar, actor: salyth, bag, qty: 1,
      drop: () => dragDrop(rowOf(us, bar), bagBody()) });
    const sword = O.items.find(i => i.name === 'Longsword');
    await expectMove('owned chest, compendium gear item -> bag tile', { chest: O, source: sword, actor: salyth, bag, qty: 1,
      drop: () => dragDrop(rowOf(os, sword), tile()) });
    const opot = O.items.find(i => i.name === 'Potion of Healing');
    await expectMove('owned chest -> open bag sheet', { chest: O, source: opot, actor: salyth, bag, qty: 3,
      drop: () => dragDrop(rowOf(os, opot), bagBody()) });

    const wend = game.actors.get(P.wend);
    const good = wend.items.find(i => i.name === 'Longsword');
    const l0 = qtyOf(salyth, 'Longsword');
    drain();
    await ss._onDropCreateItems(new DragEvent('drop'), [good], 'copy');
    await ss._onDropItemContainer(Object.assign(new DragEvent('drop'), { _behavior: 'copy' }), good, bag);
    await dropUuid(bagBody(), good.uuid);
    await wait(1500);
    const shop = drain();
    ok('shop goods refused on list, bag tile and open bag', qtyOf(salyth, 'Longsword') === l0
      && shop.notes.filter(n => n.includes('have to be bought')).length === 3,
      { gained: qtyOf(salyth, 'Longsword') - l0, notes: shop.notes });

    const ws = await renderSheet(wend);
    ok('shelf shows no preparation-warnings button', !ws.element.querySelector('.preparation-warnings'));
    for (const s of [ws, bs, us, os, ss]) await s.close();
  `, { ids: fx.ids, wend: WEND }));

  // --- GM: an owned chest, so dnd5e's own creation path runs and the module deletes the source ------
  record('gm', await run(gm.f, `
    const salyth = game.actors.get(P.ids.salyth);
    const bag = salyth.items.get(P.ids.bag);
    const U = game.actors.get(P.ids.unowned);
    const ss = await renderSheet(salyth, { tab: 'inventory' });
    const us = await renderSheet(U);
    const sword = U.items.find(i => i.name === 'Longsword');
    await expectMove('GM: chest gear item -> bag tile', { chest: U, source: sword, actor: salyth, bag, qty: 1,
      drop: () => dragDrop(rowOf(us, sword), ss.element.querySelector('li.container[data-item-id="' + bag.id + '"]')) });
    for (const s of [us, ss]) await s.close();
  `, { ids: fx.ids }));
} catch (err) {
  results.push({ who: '-', name: 'run aborted', pass: false, detail: String(err?.message ?? err) });
} finally {
  if (fx) {
    try {
      const restored = await gm.f.evaluate(async ({ TAG, ids, snapshot }) => {
        for (const a of game.actors.filter(a => a.name.startsWith(TAG))) await a.delete();
        const s = game.actors.get(ids.salyth);
        const extra = s.items.filter(i => !(i.id in snapshot.items)).map(i => i.id);
        if (extra.length) await s.deleteEmbeddedDocuments('Item', extra);
        const upd = Object.entries(snapshot.items)
          .filter(([id, q]) => s.items.get(id) && q != null && s.items.get(id)._source.system.quantity !== q)
          .map(([id, q]) => ({ _id: id, 'system.quantity': q }));
        if (upd.length) await s.updateEmbeddedDocuments('Item', upd);
        await s.update({ 'system.currency': snapshot.currency });
        return { missing: Object.keys(snapshot.items).filter(id => !s.items.get(id)).length,
          fixtures: game.actors.filter(a => a.name.startsWith(TAG)).length };
      }, { TAG, ids: fx.ids, snapshot: fx.snapshot });
      results.push({ who: 'gm', name: 'restore: Salyth + fixtures', pass: !restored.missing && !restored.fixtures, detail: JSON.stringify(restored) });
    } catch (err) {
      results.push({ who: 'gm', name: 'restore', pass: false, detail: String(err?.message ?? err) });
    }
  }
  await player?.dispose();
  await gm.dispose();
}

let fails = 0;
for (const r of results) {
  if (!r.pass) fails++;
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  [${r.who}] ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}
console.log(`\n[verify-drops] RESULT: ${fails ? `FAIL (${fails})` : 'PASS'} — ${results.length} checks`);
process.exit(fails ? 1 : 0);

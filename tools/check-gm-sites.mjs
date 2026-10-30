// Static GM-site check (no Foundry, milliseconds): every read of `isGM` in scripts/ is tagged with what
// it means when several GM clients are on at once. `game.user.isGM` is true on EVERY GM client (the
// Gamemaster's window, an Assistant GM's, the MCP bridge), so a site behind it runs once per GM screen.
// That is right for what a screen shows and for a gesture only its own client hears, and wrong for a
// consequence every client hears: that lands once, on the elect (the kit's elect.js; the kernel in
// transfer.js answers on it alone), never behind `isGM`.
//
//   node tools/check-gm-sites.mjs            # the check (gate: npm run gmsites, part of verify)
//   node tools/check-gm-sites.mjs --list     # every site, its tag and its reason
//
// What it reads: every `.isGM` property read outside comments in scripts/ (the kit's copies excepted:
// they are the suite's, checked there). A read of `game.user.isGM` (this client's own role) is a GATE;
// any other (`user.isGM`, the requesting user in the kernel) is a ROLE read. Each file's reads are pinned
// in ALLOW by `"<file> <gate|role>"`, one row per site in source order, each with its tag and reason:
//   presentation  what this screen draws or offers: a column, a button, a view, a render gate. Every GM
//                 screen shows it; a click on it is that GM's own act, below
//   act           a gate on this user's own gesture (a drop, a click, a drag), heard only by the client
//                 that made it, so its write lands once
//   role          a user's role, not this client's gate: who the kernel lets do what
// A gate cannot be tagged `consequence`: a write that must land once goes through the kernel (or the
// elect's `onElected`). A read with no row fails, a row with no read fails, and a moved count fails.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");
const TAGS = new Set(["presentation", "act", "role"]);

const P = (why) => ({ tag: "presentation", why });
const A = (why) => ({ tag: "act", why });
const R = (why) => ({ tag: "role", why });

/** `"<file> <gate|role>"` → one row per read, in source order. */
const ALLOW = new Map([
  ["canvas-drop.js gate", [
    A("dropCanvasData: only the GM who dropped the item hears it; that client makes the one chest")
  ]],
  ["config.js gate", [
    A("the Configure dialog, opened by this GM's own click; its save is that GM's write")
  ]],
  ["container-sheet.js gate", [
    P("the looter: a GM drags, the Take button is a player's"),
    P("the inventory columns: the GM's editing view against a looter's"),
    P("rows open to read for a looter who does not own the chest"),
    P("the template's isGM switch"),
    P("the coin row's Take button, a looter's")
  ]],
  ["merchant-sheet.js gate", [
    P("the buyer: the GM's view is for curation, not shopping"),
    P("the shelf filter: the GM sees hidden goods"),
    P("the inventory columns: the GM's against a shopper's"),
    P("the purse shown to the GM"),
    P("rows open to read for a shopper"),
    P("the subtitle: the GM's prices against a shopper's purse"),
    P("the template's isGM switch"),
    A("a drag out of the shelf: the GM's own drag; a shopper's is blocked at the source"),
    P("the fallback sheet after a render failure, for a GM or an owner"),
    A("hiding a good: the GM's own click writes the flag"),
    A("a drop on the shelf: the GM's own drop stocks it through the system pipeline; a shopper's sells through the kernel")
  ]],
  ["merchant.js gate", [
    A("the drop guard on a shop good: the dropping client's own drop, a player's refused"),
    P("the directory context menu's Configure entry, for a GM")
  ]],
  ["sheets.js gate", [
    P("the reach gate on opening a sheet: a GM reaches everything")
  ]],
  ["transfer.js role", [
    R("canReceive: a GM requester may move loot to any actor"),
    R("purchase: a GM requester may buy for any actor"),
    R("sell: a GM requester may sell for any actor"),
    R("transferItem: a GM requester may move between any actors")
  ]]
]);

/** The source with comments blanked (strings and template literals kept), so line numbers hold. */
function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const list = process.argv.includes("--list");
const failures = [];
const lines = [];
const seen = new Map();

for (const file of readdirSync(SCRIPTS).filter((f) => f.endsWith(".js")).sort()) {
  const text = stripComments(readFileSync(join(SCRIPTS, file), "utf8")).split("\n");
  text.forEach((line, i) => {
    for (const m of line.matchAll(/([\w$.?]+)\.isGM\b/g)) {
      const kind = m[1].replace(/\?/g, "") === "game.user" ? "gate" : "role";
      const pin = `${file} ${kind}`;
      const at = seen.get(pin) ?? [];
      at.push(`${file}:${i + 1}`);
      seen.set(pin, at);
    }
  });
}

for (const [pin, at] of seen) {
  const rows = ALLOW.get(pin);
  if (!rows) {
    failures.push(`${at.join(", ")} (${pin}) reads isGM untagged — add a row: presentation, act or role; a write every client hears goes through the kernel, not isGM`);
    continue;
  }
  if (rows.length !== at.length) {
    failures.push(`${pin}: ${at.length} isGM read(s) where ALLOW has ${rows.length} row(s) (${at.join(", ")}) — tag the new read, or remove the row of the one that went`);
  }
  rows.forEach((row, i) => {
    if (!TAGS.has(row.tag)) failures.push(`${pin} row ${i + 1}: tag "${row.tag}" — a site is presentation, act or role`);
    else if ((row.tag === "role") !== pin.endsWith(" role")) failures.push(`${pin} row ${i + 1}: a ${pin.endsWith(" role") ? "role read" : "gate on game.user.isGM"} cannot be tagged ${row.tag}`);
    lines.push(`${row.tag.padEnd(12)} ${at[i] ?? `${pin} (no read)`} — ${row.why}`);
  });
}
for (const pin of ALLOW.keys()) {
  if (!seen.has(pin)) failures.push(`stale pin: ${pin} is in ALLOW and no isGM read sits there — remove the rows`);
}

if (list) for (const line of lines) console.log(line);
if (failures.length) {
  console.error("");
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`\n${failures.length} GM-site failure(s). Every isGM read is tagged in tools/check-gm-sites.mjs ALLOW.`);
  process.exit(1);
}
const count = (tag) => [...ALLOW.values()].flat().filter((r) => r.tag === tag).length;
const total = [...seen.values()].reduce((n, at) => n + at.length, 0);
console.log(`PASS every isGM read in scripts/ is tagged (${total} reads: ${count("presentation")} presentation, ${count("act")} act, ${count("role")} role; no consequence behind isGM).`);

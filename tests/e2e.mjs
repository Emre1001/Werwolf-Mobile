// End-to-end: N independent browser sessions play a full online game on a mocked Firestore.
// Run: python3 -m http.server 8765 & node tests/e2e.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://localhost:8765/";
const N = Number(process.env.N || 5);
const SHOTS = process.env.SHOTS || "";
const here = path.dirname(new URL(import.meta.url).pathname);
const mockFs = fs.readFileSync(path.join(here, "firestore-mock.js"), "utf8");

// ---- shared store ----
const store = new Map(); // path -> { v, d }
const subs = new Map();  // key -> { page, id, spec }
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
function applyUpd(d, upd) {
  const out = clone(d);
  for (const [k, v] of Object.entries(upd)) {
    const parts = k.split(".");
    let o = out;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {}; o = o[parts[i]]; }
    const last = parts.at(-1);
    if (v && v.__op === "delete") delete o[last];
    else if (v && v.__op === "arrayUnion") { const arr = Array.isArray(o[last]) ? o[last] : []; for (const x of v.v) if (!arr.some(y => JSON.stringify(y) === JSON.stringify(x))) arr.push(x); o[last] = arr; }
    else o[last] = clone(v);
  }
  return out;
}
const colDocs = (col, c) => {
  let docs = [...store.entries()].filter(([p]) => p.startsWith(col + "/") && !p.slice(col.length + 1).includes("/")).map(([p, e]) => [p, e.d]);
  for (const f of c) {
    if (f.w) docs = docs.filter(([, d]) => d[f.w[0]] === f.w[2]);
    if (f.o) docs.sort((a, b) => (a[1][f.o] || 0) - (b[1][f.o] || 0));
    if (f.l) docs = docs.slice(-f.l);
  }
  return docs;
};
let pushQueue = Promise.resolve();
function notify() {
  for (const s of subs.values()) {
    const payload = s.spec.doc ? (store.get(s.spec.doc)?.d ?? null) : colDocs(s.spec.col, s.spec.c);
    const json = JSON.stringify(payload);
    if (s.last === json) continue;
    s.last = json;
    pushQueue = pushQueue.then(() => s.page.evaluate(([id, p]) => window.__fsPush(id, JSON.parse(p)), [s.id, json]).catch(() => {}));
  }
}
let msgId = 0;
let writes = 0;
async function handle(page, op, args) {
  const a = JSON.parse(args);
  await new Promise(r => setTimeout(r, 5 + Math.random() * 25)); // network jitter
  switch (op) {
    case "get": return JSON.stringify(store.get(a[0])?.d ?? null);
    case "getv": { const e = store.get(a[0]); return JSON.stringify([e?.v ?? 0, e?.d ?? null]); }
    case "update": { const e = store.get(a[0]); if (!e) return "false"; store.set(a[0], { v: e.v + 1, d: applyUpd(e.d, a[1]) }); writes++; notify(); return "true"; }
    case "delete": store.delete(a[0]); notify(); return "true";
    case "add": store.set(`${a[0]}/m${++msgId}`, { v: 1, d: clone(a[1]) }); notify(); return "true";
    case "query": return JSON.stringify(colDocs(a[0], a[1]));
    case "sub": { const key = page.__idx + ":" + a[0]; subs.set(key, { page, id: a[0], spec: a[1] }); notify(); return "true"; }
    case "unsub": subs.delete(page.__idx + ":" + a[0]); return "true";
    case "commit": {
      const [reads, ws] = a;
      for (const [p, v] of Object.entries(reads)) if ((store.get(p)?.v ?? 0) !== v) return "false";
      for (const [kind, p, x] of ws) {
        const e = store.get(p);
        if (kind === "set") store.set(p, { v: (e?.v ?? 0) + 1, d: clone(x) });
        else if (kind === "delete") store.delete(p);
        else if (e) store.set(p, { v: e.v + 1, d: applyUpd(e.d, x) });
      }
      writes++; notify(); return "true";
    }
  }
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const errors = [];
async function newPlayer(i, name, url = BASE) {
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.VW || 390), height: Number(process.env.VH || 844) }, deviceScaleFactor: 1, isMobile: !process.env.DESKTOP, hasTouch: !process.env.DESKTOP, colorScheme: process.env.SCHEME || "light" });
  await ctx.addInitScript(([n]) => { localStorage.setItem("werwolf_consent_given", "true"); localStorage.setItem("ww_name", n); localStorage.setItem("ww_lang", "de"); localStorage.setItem("ww_install_dismissed", String(Date.now())); }, [name]);
  await ctx.route(/gstatic\.com\/firebasejs\/.*firebase-app\.js/, r => r.fulfill({ contentType: "text/javascript", body: "export const initializeApp = () => ({});" }));
  await ctx.route(/gstatic\.com\/firebasejs\/.*firebase-firestore\.js/, r => r.fulfill({ contentType: "text/javascript", body: mockFs }));
  await ctx.route(/service-worker\.js/, r => r.fulfill({ contentType: "text/javascript", body: "" }));
  const page = await ctx.newPage();
  page.__idx = i;
  page.on("pageerror", e => errors.push(`[${name}] ${e.message}`));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) errors.push(`[${name}] console: ${m.text()}`); });
  await page.exposeBinding("__fs", ({ page: p }, op, args) => handle(page, op, args));
  await page.goto(url);
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const names = ["Anna", "Ben", "Cem", "Dana", "Emre", "Finn", "Gül", "Hans"].slice(0, N);
const host = await newPlayer(0, names[0]);
await host.waitForSelector("#quickGameBtn");
await shot(host, "01-menu");
await host.click("#quickGameBtn");
await host.waitForSelector(".code-big");
const code = (await host.textContent(".code-big")).trim();
console.log("lobby", code);

const players = [host];
for (let i = 1; i < N; i++) {
  const p = await newPlayer(i, names[i], `${BASE}?join=${code}`);
  await p.waitForSelector("#confirmJoin", { timeout: 8000 });
  await p.click("#confirmJoin");
  await p.waitForSelector(".code-big");
  players.push(p);
}
await host.waitForFunction((n) => document.querySelectorAll(".lobby-player").length === n, N);
await shot(host, "02-lobby-host");
await shot(players[1], "03-lobby-guest");
await host.click("#startGameBtn");

const seen = new Set();
let reloaded = false;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  let ended = 0;
  for (const [i, p] of players.entries()) {
    try {
      if (await p.isVisible("#role-display")) { if (!seen.has("reveal")) { seen.add("reveal"); await shot(p, "04-role-reveal"); } await p.click("#role-display"); }
      if (await p.$(".win-card")) { ended++; continue; }
      const stageKey = await p.evaluate(() => (document.querySelector(".game") ? [...document.querySelectorAll(".stage h2")].map(h => h.textContent).join("|") : ""));
      if (stageKey && !seen.has(stageKey)) { seen.add(stageKey); await shot(p, `05-${String(seen.size).padStart(2, "0")}-${names[i]}`); }
      // Act on whatever this player can do right now.
      const btnSel = ["#hunterSubmit", "#amorSubmit", "#guardSubmit", "#submitWolfVote", "#seerSubmit", "#castVote"];
      for (const b of btnSel) {
        const el = await p.$(b);
        if (!el || !(await el.isDisabled())) { if (el) await el.click(); continue; }
        const grid = await p.$$(".pick-grid .pick:not(.disabled)");
        const need = b === "#amorSubmit" ? 2 : 1;
        for (const g of grid.slice(0, need)) await g.click();
        if (b === "#castVote" || b === "#submitWolfVote") { const all = await p.$$(".pick-grid .pick:not(.disabled)"); if (all.length) await all[Math.floor(Math.random() * all.length)].click(); }
        if (!(await el.isDisabled())) await el.click();
      }
      if (await p.$("#witchDoneBtn")) await p.click("#witchDoneBtn");
      const ready = await p.$("#readyBtn:not(.btn-success)");
      if (ready) await ready.click();
      // Mid-game reload of a guest: must reconnect straight back into the game.
      if (!reloaded && i === 2 && (await p.$(".game")) && Date.now() - t0 > Number(process.env.RELOAD_AT || 8000)) {
        reloaded = true;
        await p.reload();
        try { await p.waitForSelector(".game, .win-card", { timeout: 10000 }); }
        catch (e) { console.log("RELOAD DOM:", (await p.evaluate(() => document.body.innerText)).slice(0, 600), "\nSESSION:", await p.evaluate(() => localStorage.getItem("ww_session"))); throw e; }
        console.log("reload → reconnected into game ✓");
      }
    } catch (e) { if (!/Target closed|detached|not attached|navigat|Execution context/.test(e.message)) errors.push(`[${names[i]}] driver: ${e.message.split("\n")[0]}`); }
  }
  if (ended === players.length) break;
  await sleep(400);
}
const results = await Promise.all(players.map(p => p.evaluate(() => document.querySelector(".win-card h1")?.textContent || null)));
console.log("result per player:", results, "screens seen:", seen.size, "writes:", writes, "time:", ((Date.now() - t0) / 1000).toFixed(1) + "s");
if (results.some(r => !r)) errors.push("not every player reached the win screen");
if (results.length && new Set(results).size !== 1) errors.push("players disagree on the winner");
if (results.every(Boolean)) {
  await shot(host, "06-win");
  await host.click("#playAgain");
  await players[1].waitForSelector(".code-big", { timeout: 8000 });
  console.log("play again → everyone back in lobby ✓");
  const kickBtns = await host.$$(".kick-btn");
  await kickBtns[kickBtns.length - 1].click();
  await host.click("#confirmYes");
  await players[N - 1].waitForSelector("#quickGameBtn", { timeout: 8000 });
  console.log("kick → kicked player back in menu ✓");
  await players[1].click("#leaveLobbyBtn");
  await players[1].waitForSelector("#quickGameBtn");
  await host.waitForFunction((n) => document.querySelectorAll(".lobby-player").length === n, N - 2);
  console.log("leave → lobby updated ✓");
}
await browser.close();
if (errors.length) { console.error("ERRORS:\n" + [...new Set(errors)].join("\n")); process.exit(1); }
console.log("E2E OK");

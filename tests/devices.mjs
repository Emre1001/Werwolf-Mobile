// Device matrix: renders key screens on many viewports, reports horizontal overflow, saves screenshots.
// Run: python3 -m http.server 8765 & node tests/devices.mjs   (SHOTS=<dir> to keep screenshots)
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { STATES } from "./fixtures.mjs";
const BASE = process.env.BASE || "http://localhost:8765/";
const SHOTS = process.env.SHOTS || "";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const mockFs = fs.readFileSync(new URL("./firestore-mock.js", import.meta.url), "utf8");

const DEVICES = [
  ["fold-cover", 280, 653, true], ["iphone-se1", 320, 568, true], ["android-s", 360, 740, true],
  ["iphone", 390, 844, true], ["promax", 430, 932, true],
  ["land-se", 568, 320, true], ["land-android", 740, 360, true], ["land-promax", 932, 430, true],
  ["ipad-mini", 768, 1024, true], ["ipad-land", 1024, 768, true], ["ipad-pro", 1024, 1366, true],
  ["laptop", 1280, 800, false], ["laptop-l", 1440, 900, false], ["desktop", 1920, 1080, false], ["qhd", 2560, 1440, false]
].filter(d => !ONLY || ONLY.includes(d[0]));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const problems = [];
async function openWith(dev, stateName) {
  const [, w, h, mobile] = dev;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, colorScheme: "dark", reducedMotion: "reduce" });
  await ctx.addInitScript(([session]) => {
    localStorage.setItem("werwolf_consent_given", "true"); localStorage.setItem("ww_name", "Anna"); localStorage.setItem("ww_lang", "de");
    localStorage.setItem("ww_install_dismissed", String(Date.now())); localStorage.setItem("ww_player_id", "me-0000"); localStorage.setItem("ww_device_id", "d0");
    if (session) localStorage.setItem("ww_session", "WLF7X2"); else localStorage.removeItem("ww_session");
  }, [!!stateName]);
  await ctx.route(/firebase-app\.js/, r => r.fulfill({ contentType: "text/javascript", body: "export const initializeApp = () => ({});" }));
  await ctx.route(/firebase-firestore\.js/, r => r.fulfill({ contentType: "text/javascript", body: mockFs }));
  await ctx.route(/service-worker\.js/, r => r.fulfill({ contentType: "text/javascript", body: "" }));
  const page = await ctx.newPage();
  page.on("pageerror", e => problems.push(`${dev[0]}/${stateName || "menu"}: JS error ${e.message}`));
  let docState = stateName ? JSON.parse(JSON.stringify(STATES[stateName])) : null;
  const subs = new Map();
  await page.exposeBinding("__fs", async (_, op, args) => {
    const a = JSON.parse(args);
    const lobbyPath = "lobbies/WLF7X2";
    const push = () => { for (const [id, spec] of subs) page.evaluate(([i, p]) => window.__fsPush(i, p), [id, spec.doc ? docState : []]).catch(() => {}); };
    switch (op) {
      case "get": return JSON.stringify(a[0] === lobbyPath ? docState : null);
      case "getv": return JSON.stringify([1, a[0] === lobbyPath ? docState : null]);
      case "sub": subs.set(a[0], a[1]); setTimeout(push, 10); return "true";
      case "unsub": subs.delete(a[0]); return "true";
      case "query": return "[]";
      case "commit": return "true"; // ignore writes: keep the seeded state stable for screenshots
      default: return "true";
    }
  });
  await page.goto(BASE);
  return page;
}
async function check(page, label) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
    for (const el of document.querySelectorAll("#ui-container *, .topbar *, .modal-content *, .guide-container *, .dock *")) {
      const b = el.getBoundingClientRect();
      if (!b.width || getComputedStyle(el).position === "fixed") continue;
      if (b.right > vw + 1 || b.left < -1) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} [${Math.round(b.left)}..${Math.round(b.right)}]`);
    }
    return [...new Set(out)].slice(0, 6);
  });
  if (r.length) problems.push(`${label}: overflow → ${r.join(" | ")}`);
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png") }); };

for (const dev of DEVICES) {
  // menu + modals
  let page = await openWith(dev, null);
  await page.waitForSelector("#quickGameBtn");
  await page.waitForTimeout(150);
  await check(page, `${dev[0]}/menu`); await shot(page, `${dev[0]}-1-menu`);
  await page.click("#createPrivateLobby");
  await page.waitForSelector("#confirmCreate");
  await check(page, `${dev[0]}/create`); await shot(page, `${dev[0]}-2-create`);
  await page.click(".modal .sheet-close");
  await page.click("#joinLobbyIcon");
  await page.waitForSelector("#codeInput");
  await page.waitForTimeout(150);
  await check(page, `${dev[0]}/join`); await shot(page, `${dev[0]}-3-join`);
  await page.click(".modal .sheet-close");
  await page.click("#settings-btn");
  await page.waitForSelector(".settings-sheet");
  await check(page, `${dev[0]}/settings`); await shot(page, `${dev[0]}-4-settings`);
  await page.click("#setGuide");
  await page.waitForSelector(".guide-container");
  await check(page, `${dev[0]}/guide`); await shot(page, `${dev[0]}-4-guide`);
  await page.goBack(); await page.waitForTimeout(150);
  if (await page.locator(".guide-overlay").count()) problems.push(`${dev[0]}: back did not close the guide`);
  if (!(await page.locator(".settings-sheet").count())) problems.push(`${dev[0]}: back closed more than the guide`);
  await page.context().close();
  // game states
  for (const st of ["lobby", "night", "day", "win"]) {
    page = await openWith(dev, st);
    await page.waitForSelector(st === "lobby" ? ".code-big" : st === "win" ? ".win-card" : ".game", { timeout: 8000 }).catch(() => problems.push(`${dev[0]}/${st}: screen did not render`));
    await page.evaluate(() => { const r = document.getElementById("role-display"); if (r) r.style.display = "none"; });
    await page.waitForTimeout(200);
    await check(page, `${dev[0]}/${st}`); await shot(page, `${dev[0]}-5-${st}`);
    if (st === "day") {
      await page.click("#chat-top"); await page.waitForTimeout(350);
      await check(page, `${dev[0]}/chat`); await shot(page, `${dev[0]}-6-chat`);
    }
    await page.context().close();
  }
  process.stdout.write(dev[0] + " ");
}
await browser.close();
console.log();
if (problems.length) { console.log("PROBLEMS:\n" + problems.join("\n")); process.exit(1); }
console.log("DEVICES OK");

// Theme transition check: toggles dark⇄light and captures the circular reveal at fixed animation times.
// Run: python3 -m http.server 8765 & node tests/theme.mjs   (SHOTS=<dir> to keep screenshots)
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const BASE = process.env.BASE || "http://localhost:8765/";
const SHOTS = process.env.SHOTS || "";
const mockFs = fs.readFileSync(new URL("./firestore-mock.js", import.meta.url), "utf8");
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const errors = [];
async function open(vw, vh, scheme, mobile) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, isMobile: mobile, hasTouch: mobile, colorScheme: scheme });
  await ctx.addInitScript(() => { localStorage.setItem("werwolf_consent_given", "true"); localStorage.setItem("ww_name", "Anna"); localStorage.setItem("ww_lang", "de"); localStorage.setItem("ww_install_dismissed", String(Date.now())); localStorage.removeItem("ww_theme"); });
  await ctx.route(/firebase-app\.js/, r => r.fulfill({ contentType: "text/javascript", body: "export const initializeApp = () => ({});" }));
  await ctx.route(/firebase-firestore\.js/, r => r.fulfill({ contentType: "text/javascript", body: mockFs }));
  await ctx.route(/service-worker\.js/, r => r.fulfill({ contentType: "text/javascript", body: "" }));
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) errors.push("console: " + m.text()); });
  await page.exposeBinding("__fs", async (_, op) => (op === "get" ? "null" : "true"));
  await page.goto(BASE);
  await page.waitForSelector("#quickGameBtn");
  return page;
}
const theme = (p) => p.evaluate(() => document.documentElement.dataset.theme);
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, n + ".png") }); };

for (const [label, vw, vh, mobile] of [["phone", 390, 844, true], ["laptop", 1366, 768, false]]) {
  const page = await open(vw, vh, "dark", mobile);
  if ((await theme(page)) !== "dark") errors.push(`${label}: should start dark`);
  await shot(page, `${label}-1-dark`);
  const hasVT = await page.evaluate(() => typeof document.startViewTransition === "function");
  console.log(label, "View Transitions:", hasVT);

  await page.click("#theme-toggle");
  // Pause every running animation (incl. the ::view-transition pseudo animations) at a fixed time.
  for (const t of [120, 300, 520]) {
    await page.evaluate((ms) => { document.getAnimations().forEach(a => { const name = a.effect?.pseudoElement || ""; if (name.includes("view-transition") || a.effect?.target === document.documentElement) { a.pause(); a.currentTime = ms; } }); }, t);
    await shot(page, `${label}-2-mid-${t}`);
  }
  await page.evaluate(() => document.getAnimations().forEach(a => a.play()));
  await page.waitForFunction(() => !document.documentElement.classList.contains("theme-switching"), null, { timeout: 5000 });
  if ((await theme(page)) !== "light") errors.push(`${label}: did not switch to light`);
  if ((await page.evaluate(() => localStorage.getItem("ww_theme"))) !== "light") errors.push(`${label}: theme not saved`);
  await page.waitForTimeout(1300);
  await shot(page, `${label}-3-light`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundImage.includes("rgb(232, 241, 255)") || getComputedStyle(document.documentElement).getPropertyValue("--bg-1").trim());
  console.log(label, "light bg token ok:", !!bg);

  // rapid double click must not break anything
  await page.click("#theme-toggle"); await page.click("#theme-toggle", { force: true }).catch(() => {});
  await page.waitForFunction(() => !document.documentElement.classList.contains("theme-switching") && !document.documentElement.classList.contains("theme-fade"), null, { timeout: 5000 });
  const t2 = await theme(page);
  await page.reload(); await page.waitForSelector("#quickGameBtn");
  if ((await theme(page)) !== t2) errors.push(`${label}: theme not restored after reload`);

  // fallback path: no View Transitions API
  await page.evaluate(() => { document.startViewTransition = undefined; });
  const before = await theme(page);
  await page.click("#theme-toggle");
  await page.waitForTimeout(350);
  const mid = await page.evaluate(() => ({ fade: document.documentElement.classList.contains("theme-fade"), bg: getComputedStyle(document.documentElement).getPropertyValue("--bg-1").trim() }));
  await shot(page, `${label}-4-fallback-mid`);
  await page.waitForFunction(() => !document.documentElement.classList.contains("theme-fade"), null, { timeout: 4000 });
  if ((await theme(page)) === before) errors.push(`${label}: fallback did not switch`);
  if (!mid.fade) errors.push(`${label}: fallback fade class missing`);
  console.log(label, "fallback mid-fade --bg-1:", mid.bg);
  await page.context().close();
}

// reduced motion → instant switch, no transition classes
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await ctx.addInitScript(() => { localStorage.setItem("werwolf_consent_given", "true"); localStorage.setItem("ww_name", "A"); localStorage.removeItem("ww_theme"); });
  await ctx.route(/firebase-app\.js/, r => r.fulfill({ contentType: "text/javascript", body: "export const initializeApp = () => ({});" }));
  await ctx.route(/firebase-firestore\.js/, r => r.fulfill({ contentType: "text/javascript", body: mockFs }));
  await ctx.route(/service-worker\.js/, r => r.fulfill({ contentType: "text/javascript", body: "" }));
  const p = await ctx.newPage();
  await p.exposeBinding("__fs", async (_, op) => (op === "get" ? "null" : "true"));
  await p.goto(BASE); await p.waitForSelector("#quickGameBtn");
  const a = await theme(p);
  await p.click("#theme-toggle");
  if ((await theme(p)) === a) errors.push("reduced motion: theme did not switch instantly");
  if (await p.evaluate(() => document.documentElement.classList.contains("theme-switching"))) errors.push("reduced motion: transition class set");
  console.log("reduced motion: instant switch ok");
}
await browser.close();
if (errors.length) { console.error("ERRORS:\n" + [...new Set(errors)].join("\n")); process.exit(1); }
console.log("THEME OK");

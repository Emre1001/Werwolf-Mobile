// Settings sheet: System / Hell / Dunkel, language picker, update popup (Später / Überspringen / Aktualisieren).
// Run: node tests/preview-server.mjs & node tests/settings.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:8766/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

async function open(query = "", scheme = "dark") {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: scheme, locale: "de-DE" });
  const page = await ctx.newPage();
  page.on("pageerror", e => fails.push(`JS error ${e.message}`));
  await page.goto(BASE + query);
  await page.waitForSelector("#quickGameBtn");
  return page;
}
const html = (page, attr) => page.evaluate((a) => document.documentElement.getAttribute(a), attr);
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const idle = (page) => page.waitForFunction(() => !document.documentElement.classList.contains("theme-switching") && !document.documentElement.classList.contains("theme-fade"), null, { timeout: 5000 });

// Theme: three states, persisted, System follows the device.
{
  const page = await open("", "dark");
  await page.evaluate(() => localStorage.removeItem("ww_theme"));
  await page.click("#settings-btn"); await page.waitForSelector(".theme-seg");
  ok(await page.getAttribute('[data-theme-pref="system"]', "aria-checked") === "true", "theme: System not preselected");
  await page.click('[data-theme-pref="light"]'); await idle(page);
  ok(await html(page, "data-theme") === "light" && await stored(page, "ww_theme") === "light", "theme: Hell not applied/saved");
  ok(await page.getAttribute('[data-theme-pref="light"]', "aria-checked") === "true", "theme: segment did not follow");
  await page.click('[data-theme-pref="system"]'); await idle(page);
  ok(await html(page, "data-theme") === "dark" && await stored(page, "ww_theme") === null, "theme: System did not follow the device (dark)");
  await page.emulateMedia({ colorScheme: "light" }); await page.waitForTimeout(1200); await idle(page);
  ok(await html(page, "data-theme") === "light", "theme: System did not react live to the OS switching to light");
  ok(await page.evaluate(() => document.getElementById("app-shell").inert), "theme: app behind the open sheet is not inert");
  await page.goBack(); await page.waitForTimeout(300);
  await page.click("#theme-toggle"); await idle(page);
  ok(await stored(page, "ww_theme") === "dark", "theme: top-bar toggle did not store an explicit choice");
  await page.click("#settings-btn"); await page.waitForSelector(".theme-seg");
  ok(await page.getAttribute('[data-theme-pref="dark"]', "aria-checked") === "true", "theme: settings do not show the top-bar choice");
  await page.reload(); await page.waitForSelector("#quickGameBtn");
  ok(await html(page, "data-theme") === "dark", "theme: choice not restored after reload");
  await page.context().close();
}

// Language: picker, live switch of the open sheet, system language.
{
  const page = await open();
  await page.evaluate(() => localStorage.removeItem("ww_lang"));
  await page.reload(); await page.waitForSelector("#quickGameBtn");
  ok(await html(page, "lang") === "de", "lang: system language (de-DE) not used");
  await page.click("#settings-btn"); await page.click("#lang-trigger"); await page.waitForSelector(".lang-pop .lang-item");
  ok(await page.locator(".lang-item").count() === 9, "lang: picker should list System + 8 languages");
  ok(!(await page.locator(".lang-pop").innerText()).match(/\p{Regional_Indicator}/u), "lang: picker shows flag emoji");
  await page.locator(".lang-item", { hasText: "Türkçe" }).click(); await page.waitForTimeout(900);
  ok(await html(page, "lang") === "tr" && await stored(page, "ww_lang") === "tr", "lang: Türkçe not applied/saved");
  ok((await page.locator(".settings-sheet h3").innerText()).includes("Ayarlar"), "lang: open settings sheet did not switch language");
  ok((await page.locator("#lang-trigger").innerText()).includes("Türkçe"), "lang: trigger label not updated");
  await page.click("#lang-trigger"); await page.locator(".lang-item").first().click(); await page.waitForTimeout(900);
  ok(await html(page, "lang") === "de" && await stored(page, "ww_lang") === null, "lang: Systemsprache did not reset to the device language");
  await page.context().close();
}

// Update popup (mock adapter): Später hides it for a day, Überspringen remembers the version, Aktualisieren runs.
{
  let page = await open("?update=1");
  await page.waitForSelector(".upd-overlay.is-open .upd-card", { timeout: 4000 });
  ok((await page.locator(".upd-title").innerText()).length > 0, "update: popup has no title");
  await page.locator(".upd-btn", { hasText: "Später" }).click(); await page.waitForTimeout(500);
  ok(await page.locator(".upd-overlay").count() === 0, "update: Später did not close the popup");
  ok(Number(await stored(page, "update.remindAfter")) > Date.now() + 23 * 3600e3, "update: Später did not snooze for a day");
  await page.reload(); await page.waitForSelector("#quickGameBtn"); await page.waitForTimeout(1500);
  ok(await page.locator(".upd-overlay").count() === 0, "update: popup came back despite Später");
  await page.evaluate(() => localStorage.removeItem("update.remindAfter"));
  await page.reload(); await page.waitForSelector(".upd-overlay.is-open .upd-card", { timeout: 4000 });
  await page.locator(".upd-btn", { hasText: "überspringen" }).click(); await page.waitForTimeout(500);
  ok(await stored(page, "update.skipped") === "6.1", "update: Überspringen did not remember the version");
  await page.reload(); await page.waitForSelector("#quickGameBtn"); await page.waitForTimeout(1500);
  ok(await page.locator(".upd-overlay").count() === 0, "update: skipped version was offered again");
  // the manual check in settings still offers it
  await page.click("#settings-btn"); await page.click("[data-update-check]");
  await page.waitForSelector(".upd-overlay.is-open", { timeout: 4000 }).catch(() => fails.push("update: manual check did not offer the skipped version"));
  await page.goBack(); await page.waitForTimeout(500);
  ok(await page.locator(".upd-overlay").count() === 0, "update: back did not close the popup");
  ok(await page.locator(".settings-sheet").count() === 1, "update: back from the popup also closed settings");
  await page.click("[data-update-check]"); await page.waitForSelector(".upd-overlay.is-open");
  await page.locator(".upd-btn--primary", { hasText: "aktualisieren" }).click();
  await page.waitForSelector('.upd-card[data-state="installing"]', { timeout: 6000 }).catch(() => fails.push("update: install did not reach the installing state"));
  await page.context().close();
}

await browser.close();
if (fails.length) { console.log("SETTINGS FAILURES:\n" + fails.join("\n")); process.exit(1); }
console.log("SETTINGS OK");

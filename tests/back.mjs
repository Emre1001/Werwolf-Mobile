// Back gesture / back button: back closes the most recent thing and never leaves the app by accident.
// Run: node tests/preview-server.mjs & node tests/back.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:8766/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

async function open(preview = "") {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("pageerror", e => fails.push(`${preview || "menu"}: JS error ${e.message}`));
  await page.goto(BASE + (preview ? `?preview=${preview}` : ""));
  await page.waitForSelector(preview === "lobby" ? ".code-big" : preview ? ".game" : "#quickGameBtn");
  await page.waitForTimeout(300);
  return page;
}
const back = async (page) => { await page.goBack().catch(() => {}); await page.waitForTimeout(250); };
const count = (page, sel) => page.locator(sel).count();
const onPage = (page) => page.evaluate(() => !!document.getElementById("app-shell"));

// Menu: settings → guide → language picker, each closed by back, in order.
{
  const page = await open();
  await page.click("#settings-btn"); await page.waitForSelector(".settings-sheet");
  await page.click("#setGuide"); await page.waitForSelector(".guide-overlay");
  await back(page);
  ok(await count(page, ".guide-overlay") === 0, "menu: back did not close the guide");
  ok(await count(page, ".settings-sheet") === 1, "menu: back from the guide also closed settings");
  await page.click("#lang-trigger"); await page.waitForSelector(".lang-pop");
  await back(page); await page.waitForTimeout(400);
  ok(await count(page, ".lang-pop") === 0, "menu: back did not close the language picker");
  ok(await count(page, ".settings-sheet") === 1, "menu: back from the language picker also closed settings");
  await back(page);
  ok(await count(page, ".settings-sheet") === 0, "menu: back did not close settings");
  ok(await onPage(page), "menu: back left the app while a sheet was open");
  // closing by X must drop its history entry: the next back must not be swallowed by a dead entry
  await page.click("#createPrivateLobby"); await page.waitForSelector("#confirmCreate");
  await page.click(".modal .sheet-close"); await page.waitForTimeout(250);
  await page.click("#joinLobbyIcon"); await page.waitForSelector("#codeInput");
  await back(page);
  ok(await count(page, ".dyn-modal") === 0, "menu: back after an X-closed sheet did not close the next sheet");
  await page.context().close();
}

// Lobby: chat closes first, then back leaves the lobby to the menu (no confirm before the game starts).
{
  const page = await open("lobby");
  await page.click("#chat-top"); await page.waitForTimeout(300);
  ok(await page.locator("#chat-container.open").count() === 1, "lobby: chat did not open");
  await back(page);
  ok(await page.locator("#chat-container.open").count() === 0, "lobby: back did not close the chat");
  ok(await count(page, ".code-big") === 1, "lobby: back from the chat also left the lobby");
  await back(page); await page.waitForTimeout(400);
  ok(await count(page, "#quickGameBtn") === 1, "lobby: back did not return to the menu");
  ok(await onPage(page), "lobby: back left the app");
  await page.context().close();
}

// Running game: role card first, then back asks before leaving; back again keeps the game.
{
  const page = await open("night");
  ok(await page.locator("#role-display").isVisible(), "game: role card not shown at start");
  await back(page);
  ok(!(await page.locator("#role-display").isVisible()), "game: back did not close the role card");
  ok(await count(page, ".game") === 1, "game: back from the role card left the game");
  await back(page);
  ok(await count(page, "#confirmYes") === 1, "game: back did not ask before leaving a running game");
  ok(await count(page, ".game") === 1, "game: back left the running game without asking");
  await back(page);
  ok(await count(page, "#confirmYes") === 0, "game: back did not close the leave dialog");
  ok(await count(page, ".game") === 1, "game: closing the leave dialog left the game");
  await back(page);
  ok(await count(page, "#confirmYes") === 1, "game: second back did not ask again");
  await page.click("#confirmYes"); await page.waitForTimeout(500);
  ok(await count(page, "#quickGameBtn") === 1, "game: confirming did not return to the menu");
  ok(await onPage(page), "game: leaving the game left the app");
  await page.context().close();
}

await browser.close();
if (fails.length) { console.log("BACK FAILURES:\n" + fails.join("\n")); process.exit(1); }
console.log("BACK OK");

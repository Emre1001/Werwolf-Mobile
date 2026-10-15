// Regenerates every PNG icon from assets/icon.svg + assets/icon-maskable.svg.
// Run from the repo root: node assets/build-icons.mjs   (needs: npm i playwright)
import { chromium } from "playwright";
import fs from "node:fs";
const jobs = [
  ["assets/icon.svg", "icon-192.png", 192], ["assets/icon.svg", "icon-512.png", 512],
  ["assets/icon.svg", "icon.png", 512], ["assets/icon.svg", "wolf-icon.png", 512], ["assets/icon.svg", "favicon-32.png", 32],
  ["assets/icon-maskable.svg", "icon-maskable-192.png", 192], ["assets/icon-maskable.svg", "icon-maskable-512.png", 512],
  ["assets/icon-maskable.svg", "apple-touch-icon.png", 180]
];
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
for (const [src, out, size] of jobs) {
  const svg = fs.readFileSync(src, "utf8").replace("<svg ", `<svg width="${size}" height="${size}" `);
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  // apple-touch-icon must be opaque (iOS fills transparency with black)
  await page.screenshot({ path: out, omitBackground: !out.startsWith("apple") });
  await page.close();
  console.log("✓", out);
}
fs.copyFileSync("assets/icon.svg", "favicon.svg");
await browser.close();

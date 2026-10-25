// Preview server: serves the app with a mocked Firestore so any screen can be opened by URL.
//   node tests/preview-server.mjs            → http://localhost:8766/?preview=lobby|night|day|win  (no param = menu)
//   &update=1 shows the update popup with UpdateUI.mockAdapter (design and test it without a deploy)
// Used for the layout check:  python check-layout.py "http://localhost:8766/?preview=day" --target phone
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { STATES } from "./fixtures.mjs";

const PORT = Number(process.env.PORT || 8766);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FB = "https://www.gstatic.com/firebasejs/10.7.1/";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

// In-page stand-in for the Node side of firestore-mock.js: serves the seeded lobby, ignores writes.
const head = (state, update) => `
<script type="importmap">{"imports":{"${FB}firebase-app.js":"/__preview/firebase-app.js","${FB}firebase-firestore.js":"/tests/firestore-mock.js"}}</script>
<script>
  (function () {
    var s = ${JSON.stringify(state || null)};
    if (s) s.heartbeats = Object.fromEntries(s.players.map(function (p) { return [p.id, Date.now()]; }));
    localStorage.setItem("werwolf_consent_given", "true"); localStorage.setItem("ww_name", "Anna");
    localStorage.setItem("ww_install_dismissed", String(Date.now()));
    localStorage.setItem("ww_player_id", "me-0000"); localStorage.setItem("ww_device_id", "d0");
    if (s) localStorage.setItem("ww_session", "WLF7X2"); else localStorage.removeItem("ww_session");
    var subs = {};
    window.__fs = function (op, args) {
      var a = JSON.parse(args), mine = a[0] === "lobbies/WLF7X2" ? s : null, r = "true";
      if (op === "get") r = JSON.stringify(mine);
      else if (op === "getv") r = JSON.stringify([1, mine]);
      else if (op === "query") r = "[]";
      else if (op === "sub") { subs[a[0]] = a[1]; setTimeout(function () { window.__fsPush(a[0], a[1].doc ? s : []); }, 10); }
      return Promise.resolve(r);
    };
  })();
  ${update ? `addEventListener("load", function () { setTimeout(function () { UpdateUI.init({ adapter: UpdateUI.mockAdapter({ mode: "web", version: "6.1", current: "6.0" }), currentVersion: "6.0", firstDelayMs: 50 }); }, 100); });` : ""}
</script>`;

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__preview/firebase-app.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end("export const initializeApp = () => ({});"); return; }
  if (url.pathname === "/service-worker.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(""); return; }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (url.pathname === "/") file = path.join(ROOT, "index.html");
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    let body = buf;
    if (file.endsWith("index.html")) {
      const key = url.searchParams.get("preview");
      body = buf.toString().replace("<head>", "<head>" + head(key && STATES[key], url.searchParams.has("update")));
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  });
}).listen(PORT, () => console.log(`preview on http://localhost:${PORT}/?preview=${Object.keys(STATES).join("|")}`));

// Bump APP_VERSION together with version.json, APP_VERSION in app.js and the ?v= query strings in index.html / app.js.
const APP_VERSION = "6.0";
const CACHE_NAME = "werwolf-pwa-" + APP_VERSION;
const V = "?v=" + APP_VERSION;
const urls = ["./", "./index.html", "./style.css" + V, "./app.js" + V, "./engine.js" + V, "./i18n.js" + V,
  "./lib/back-stack.js" + V, "./lib/language-picker.js" + V, "./lib/language-picker.css" + V, "./lib/update-dialog.js" + V, "./lib/update-dialog.css" + V,
  "./manifest.json", "./icon-192.png", "./icon-512.png", "./favicon.svg", "./apple-touch-icon.png"];

// First install activates right away. An update waits until the app's update popup sends SKIP_WAITING,
// so a new version never swaps code under a running game.
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urls.map(u => new Request(u, { cache: "reload" })))).then(async () => {
    if (!self.registration.active) self.skipWaiting();
  }));
});
self.addEventListener("message", e => { if (e.data?.type === "SKIP_WAITING") self.skipWaiting(); });

self.addEventListener("fetch", e => {
  // Only same-origin GETs. Cross-origin traffic (Firebase SDK, Firestore's realtime streams,
  // fonts/CDNs) goes straight to the network.
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith("/version.json")) return;   // always the network: the update check reads it
  e.respondWith(
    // cache:"no-cache" always revalidates with the server. Without it the browser's HTTP cache
    // (GitHub Pages: 10 min) could hand out an old app.js/style.css next to a new index.html.
    fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" }).then(r => {
      // Navigations must not be answered with a followed redirect → let the browser redirect.
      if (r.redirected && e.request.mode === "navigate") return Response.redirect(r.url, 302);
      if (r.ok) {
        const c = r.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, c));
      }
      return r;
    }).catch(() =>
      caches.match(e.request).then(r => r ||
        caches.match(e.request, { ignoreSearch: true }).then(r2 => r2 ||
          (e.request.mode === "navigate" ? caches.match("./index.html") : Response.error())))
    )
  );
});

self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME && caches.delete(k)))).then(() => self.clients.claim())
));

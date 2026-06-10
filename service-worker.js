const CACHE_NAME = "werwolf-pwa-v14";
const urls = ["./", "./index.html", "./style.css", "./app.js", "./i18n.js", "./manifest.json", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urls))); });
self.addEventListener("fetch", e => {
  // Only handle GET requests; let POST/PUT etc. (e.g. backend writes) pass straight through,
  // since cache.put() throws on non-GET requests.
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).then(r => {
      // Only cache successful same-origin responses to avoid storing opaque/error responses.
      if (r.ok && new URL(e.request.url).origin === location.origin) {
        const c = r.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, c));
      }
      return r;
    }).catch(() =>
      // Offline: serve the cached request, falling back to the app shell for navigations
      // so unknown routes don't render a blank network-error page.
      caches.match(e.request).then(r => r || (e.request.mode === "navigate" ? caches.match("./index.html") : undefined))
    )
  );
});
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME && caches.delete(k)))).then(() => self.clients.claim())));

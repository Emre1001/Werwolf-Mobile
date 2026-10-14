const CACHE_NAME = "werwolf-pwa-v15";
const urls = ["./", "./index.html", "./style.css", "./app.js", "./engine.js", "./i18n.js", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urls)));
});

self.addEventListener("fetch", e => {
  // Only handle same-origin GETs. Cross-origin traffic (Firebase SDK, Firestore's realtime
  // long-polling streams, fonts/CDNs) goes straight to the network: proxying those through the
  // worker can stall the live connection, and a failed proxy fetch used to break the app load.
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) {
        const c = r.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, c));
      }
      return r;
    }).catch(() =>
      // Offline: serve from cache, falling back to the app shell for navigations.
      caches.match(e.request, { ignoreSearch: e.request.mode === "navigate" })
        .then(r => r || (e.request.mode === "navigate" ? caches.match("./index.html") : Response.error()))
    )
  );
});

self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME && caches.delete(k)))).then(() => self.clients.claim())
));

const CACHE_NAME = "werwolf-pwa-v6";
const urls = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urls))); });
self.addEventListener("fetch", e => {
  e.respondWith(
    fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request))
  );
});
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME && caches.delete(k)))).then(() => self.clients.claim())));
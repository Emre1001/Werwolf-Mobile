// Bump APP_VERSION together with the ?v= query strings in index.html / app.js.
const APP_VERSION = "4.1";
const CACHE_NAME = "werwolf-pwa-" + APP_VERSION;
const V = "?v=" + APP_VERSION;
const urls = ["./", "./index.html", "./style.css" + V, "./app.js" + V, "./engine.js" + V, "./i18n.js" + V, "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urls.map(u => new Request(u, { cache: "reload" })))));
});

self.addEventListener("fetch", e => {
  // Only same-origin GETs. Cross-origin traffic (Firebase SDK, Firestore's realtime streams,
  // fonts/CDNs) goes straight to the network.
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
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

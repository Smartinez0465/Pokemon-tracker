"use strict";

// Bump CACHE when you want every device to drop old cached files.
const CACHE = "pokemon-tracker-v16";
const ASSETS = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "config.js",
  "sync.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "assets/gengar.jpg",
  "assets/mew.jpg",
  "data/sealed.json",
  "data/nicknames.json",
];

self.addEventListener("install", (e) => {
  // "reload" skips the browser's own copy (GitHub Pages lets browsers reuse files for 10 minutes), so a new version
  // never saves stale files
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates show up), falling back to the cache when offline. "no-cache" makes the browser check
// with the server every time instead of reusing a copy it was told was good for 10 minutes.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        // only a page visit falls back to the app shell; anything else fails honestly
        return e.request.mode === "navigate" ? caches.match("index.html") : Response.error();
      })
  );
});

/*
 * TubeStream Service Worker — v6
 * Caches ONLY static assets + thumbnails.
 * Feed/search/stream-resolve APIs are network-only so the user always gets
 * fresh random videos, and /api/stream is never intercepted (HLS ranges must
 * pass through untouched — caching partial 206 responses corrupts playback).
 */
const STATIC_CACHE = "ts-static-v6";
const THUMB_CACHE = "ts-thumbs-v6";

// Static assets to pre-cache on install
const PRECACHE_URLS = [
  "/",
  "/style.css",
  "/app.js",
  "/vendor/hls.min.js",
];

// Never let an old SW serve a stale app shell after an update
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== STATIC_CACHE && k !== THUMB_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const path = url.pathname;

  // HLS playlists + segments: ALWAYS pass through — no interception, ever.
  if (path === "/api/stream") return;

  // Feed/search/stream-resolve: network-only — fresh data on every request.
  if (
    path === "/api/videos" ||
    path === "/api/search" ||
    path === "/api/stream-url" ||
    path === "/api/refresh" ||
    path === "/api/batch-pages" ||
    path === "/api/videos/pages"
  ) return;

  // Thumbnails: cache-first with 24h TTL (proxied images are stable per URL)
  if (path === "/api/thumb") {
    e.respondWith(thumbCacheFirst(e.request));
    return;
  }

  // Static app shell: network-first (so deploys land), cache fallback offline
  if (
    path === "/" ||
    path === "/style.css" ||
    path === "/app.js" ||
    path === "/vendor/hls.min.js"
  ) {
    e.respondWith(networkFirst(e.request, STATIC_CACHE));
    return;
  }

  // Everything else (sidebar categories, stats, docs): pass through untouched
});

// Thumbnail cache-first with TTL
async function thumbCacheFirst(req) {
  const cache = await caches.open(THUMB_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    const at = Number(cached.headers.get("sw-cached-at") || 0);
    if (at && Date.now() - at < 24 * 3600 * 1000) return cached;
    cache.delete(req); // stale — refetch
  }
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const headers = new Headers(resp.headers);
      headers.set("sw-cached-at", String(Date.now()));
      const body = await resp.blob();
      cache.put(req, new Response(body, { status: resp.status, statusText: resp.statusText, headers }));
      return new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    }
    return resp;
  } catch (err) {
    const fallback = await cache.match(req);
    if (fallback) return fallback;
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

// Network-first (static shell)
async function networkFirst(req, cacheName) {
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch (e) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}

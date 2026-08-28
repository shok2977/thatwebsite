/*
 * TubeStream Service Worker — Zero-Loading Cache Layer
 * Caches thumbnails, API responses, static assets for offline-first experience
 */
const CACHE_NAME = "ts-v5";
const STATIC_CACHE = "ts-static-v5";
const THUMB_CACHE = "ts-thumbs-v5";
const API_CACHE = "ts-api-v5";

// Static assets to pre-cache on install
const PRECACHE_URLS = [
  "/",
  "/style.css",
  "/app.js",
  "/vendor/hls.min.js",
];

// Install — pre-cache shell
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== STATIC_CACHE && k !== THUMB_CACHE && k !== API_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — routing strategy
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Thumbnails (xhamster CDN images) — Cache-First, long TTL
  if (
    url.hostname.includes("xhcdn.com") ||
    url.hostname.includes("phncdn.com") ||
    e.request.destination === "image"
  ) {
    e.respondWith(cacheFirst(e.request, THUMB_CACHE, 30 * 24 * 3600));
    return;
  }

  // API responses — Stale-While-Revalidate
  if (url.pathname.startsWith("/api/")) {
    // Don't cache mutating endpoints
    if (url.pathname === "/api/refresh" || url.pathname === "/api/prefetch") {
      return;
    }
    e.respondWith(staleWhileRevalidate(e.request, API_CACHE));
    return;
  }

  // HLS stream segments — Network-First (live content)
  if (url.pathname === "/api/stream") {
    e.respondWith(networkFirst(e.request, API_CACHE));
    return;
  }

  // Static assets — Network-First (avoid stale cache issues)
  if (
    url.pathname === "/style.css" ||
    url.pathname === "/app.js" ||
    url.pathname === "/vendor/hls.min.js"
  ) {
    e.respondWith(networkFirst(e.request, STATIC_CACHE));
    return;
  }

  // Everything else — Network-First
  e.respondWith(networkFirst(e.request, STATIC_CACHE));
});

// Cache-First strategy
async function cacheFirst(req, cacheName, maxAgeSeconds) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    // Check age via headers
    const dateHeader = cached.headers.get("sw-cached-at");
    if (dateHeader) {
      const age = (Date.now() - Number(dateHeader)) / 1000;
      if (age > maxAgeSeconds) {
        // Stale — revalidate in background
        fetchAndCache(req, cache);
      }
    }
    return cached;
  }
  return fetchAndCache(req, cache);
}

// Stale-While-Revalidate strategy
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetchAndCache(req, cache);
  if (cached) return cached;
  return networkPromise;
}

// Network-First strategy
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

// Fetch and cache a response
async function fetchAndCache(req, cache) {
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const toCache = resp.clone();
      // Add timestamp header for age checking
      const headers = new Headers(toCache.headers);
      headers.set("sw-cached-at", String(Date.now()));
      const timedResponse = new Response(await toCache.blob(), {
        status: toCache.status,
        statusText: toCache.statusText,
        headers,
      });
      cache.put(req, timedResponse);
    }
    return resp;
  } catch (e) {
    return new Response("[]", { status: 503, statusText: "Offline" });
  }
}

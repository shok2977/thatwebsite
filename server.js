require("dotenv").config();
const express = require("express");
const compression = require("compression");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { Readable } = require("stream");
const swaggerUi = require("swagger-ui-express");
const cron = require("node-cron");
const { connectDB, isConnected } = require("./services/mongodb");
const Video = require("./models/Video");
const swaggerSpec = require("./api-docs/swagger");

// Playwright — optional, loaded lazily
let chromium = null;
try { chromium = require("playwright").chromium; console.log("[Playwright] Chromium loaded"); } catch (e) { console.warn("[Playwright] Not available — using relay-only mode"); }

const app = express();
const PORT = Number(process.env.PORT) || 3080;

// Keep-alive connection pooling for ALL upstream fetches (thumbs, playlists,
// segments) — reusing TLS connections cuts per-request latency dramatically
// versus a fresh handshake every time.
const { Agent: UndiciAgent, setGlobalDispatcher } = require("undici");
setGlobalDispatcher(new UndiciAgent({
  connections: 64,
  pipelining: 1,
  keepAliveTimeout: 30 * 1000,
  keepAliveMaxTimeout: 120 * 1000,
}));

/* ---------- Middleware ---------- */
app.use(compression({ threshold: 512 }));
app.use(express.json());

// CORS — allow all origins (Electron + browser)
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Range");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Request logging (lightweight)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") && !req.path.startsWith("/api/stream") && !req.path.startsWith("/api/thumb")) {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      if (ms > 500 || res.statusCode >= 400) {
        console.log("[HTTP]", req.method, req.path, res.statusCode, ms + "ms");
      }
    });
  }
  next();
});

/* ---------- Simple in-memory rate limiter ---------- */
const rateBuckets = new Map();
function rateLimit(windowMs, maxReqs) {
  return (req, res, next) => {
    const key = req.ip || req.connection.remoteAddress || "unknown";
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > maxReqs) {
      return res.status(429).json({ success: false, error: "Too many requests — slow down" });
    }
    next();
  };
}
// Clean up stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) {
    if (now - v.start > 10 * 60 * 1000) rateBuckets.delete(k);
  }
}, 5 * 60 * 1000);

/* ---------- Category URL mappings — loaded dynamically from categories-map.json ---------- */
const CATEGORIES_FILE = path.join(__dirname, "categories-map.json");

// Main feeds (always available, not from categories page)
const MAIN_FEEDS = {
  all:       null,
  newest:    "https://xhamster.com/newest",
  popular:   "https://xhamster.com/best/weekly",
  top:       "https://xhamster.com/best/monthly",
  hd:        "https://xhamster.com/best/year",
  longest:   "https://xhamster.com/best/longest",
  hot:       "https://xhamster.com/best/today",
};

// Load ALL xhamster categories from the generated JSON file
let CATEGORIES = { ...MAIN_FEEDS };
try {
  if (fs.existsSync(CATEGORIES_FILE)) {
    const catMap = JSON.parse(fs.readFileSync(CATEGORIES_FILE, "utf8"));
    for (const [key, info] of Object.entries(catMap)) {
      if (!CATEGORIES[key]) {
        CATEGORIES[key] = info.url;
      }
    }
    console.log("[Categories] Loaded", Object.keys(catMap).length, "categories from file");
  } else {
    console.warn("[Categories] categories-map.json not found — run: node scripts/build-categories.js");
  }
} catch (e) { console.warn("[Categories] Failed to load:", e.message); }

const CATEGORY_KEYS = Object.keys(CATEGORIES).filter(k => k !== "all");
const RELAY_BASE = "https://r.jina.ai/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const CACHE_FILE = path.join(__dirname, "feed-cache.json");
const STREAM_CACHE_FILE = path.join(__dirname, "stream-cache.json");

let feedCache = { pages: {} };
let streamCache = {};
const searchCache = {};

const CACHE_MS = Number(process.env.CACHE_TTL_MS) || 10 * 60 * 1000;
const STREAM_CACHE_MS = Number(process.env.STREAM_CACHE_TTL_MS) || 30 * 60 * 1000;
const STREAM_CACHE_MAX = Number(process.env.STREAM_CACHE_MAX) || 500;
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_TTL_MS) || 5 * 60 * 1000;
const SEARCH_CACHE_MAX = Number(process.env.SEARCH_CACHE_MAX) || 50;
const STREAM_EXPIRY_MARGIN_MS = 5 * 60 * 1000; // stop serving 5min before token death

// Track which categories are currently being fetched in background
const backgroundFetches = new Set();

/* ---------- Always-fresh stream URLs ---------- */
// xHamster m3u8 tokens embed an expiry epoch: "...,1787954400/..." or "end=1787954400"
function parseStreamExpiry(url) {
  if (typeof url !== "string") return 0;
  let m = /[,&]end=(\d{10,13})/.exec(url) || /[=,](\d{13})\/|[,=](\d{10})\//.exec(url);
  if (m) {
    const raw = m[1] || m[2] || m[3];
    if (raw) return Number(raw) < 1e12 ? Number(raw) * 1000 : Number(raw);
  }
  const comma = /,(\d{10,13})\//.exec(url);
  if (comma) {
    const raw = comma[1];
    return Number(raw) < 1e12 ? Number(raw) * 1000 : Number(raw);
  }
  return 0;
}

function isStreamFresh(entry, now) {
  if (!entry || !entry.m3u8Url) return false;
  now = now || Date.now();
  // Token URLs live for hours (the end=/,epoch token embedded in the CDN url).
  // Judge freshness by the TOKEN's own expiry — falling back to wall-clock age
  // only when the URL carries no parseable token.
  const exp = entry.exp || parseStreamExpiry(entry.m3u8Url) || 0;
  if (exp) return now < exp - STREAM_EXPIRY_MARGIN_MS;
  return now - (entry.ts || 0) < STREAM_CACHE_MS;
}

function purgeExpiredStreams() {
  const now = Date.now();
  let purged = 0;
  for (const key of Object.keys(streamCache)) {
    if (!isStreamFresh(streamCache[key], now)) { delete streamCache[key]; purged++; }
  }
  // Hard cap: drop oldest entries if still over limit
  const keys = Object.keys(streamCache);
  if (keys.length > STREAM_CACHE_MAX) {
    keys.sort((a, b) => (streamCache[a].ts || 0) - (streamCache[b].ts || 0));
    for (let i = 0; i < keys.length - STREAM_CACHE_MAX; i++) delete streamCache[keys[i]];
  }
  if (purged > 0) { console.log("[StreamCache] Purged", purged, "expired entries"); saveStreamCache(); }
  return purged;
}
setInterval(purgeExpiredStreams, 5 * 60 * 1000).unref();

function cacheStream(videoUrl, m3u8Url) {
  // Latest URL always wins — replace any older entry
  streamCache[videoUrl] = { ts: Date.now(), m3u8Url, exp: parseStreamExpiry(m3u8Url) || 0 };
}

/* ---------- Cache persistence ---------- */
function loadCachesFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (saved && saved.pages) {
        const migratedPages = {};
        for (const [k, v] of Object.entries(saved.pages)) {
          if (Array.isArray(v)) migratedPages[k] = { ts: saved.ts || 0, cards: v };
          else if (v && Array.isArray(v.cards)) migratedPages[k] = v;
        }
        feedCache = { pages: migratedPages };
      } else if (saved && Array.isArray(saved.cards) && saved.cards.length) {
        feedCache = { pages: { "newest:1": { ts: saved.ts || 0, cards: saved.cards } } };
      }
    }
  } catch (e) { /* ignore */ }
  try {
    if (fs.existsSync(STREAM_CACHE_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(STREAM_CACHE_FILE, "utf8"));
      const now = Date.now();
      let kept = 0;
      for (const [k, v] of Object.entries(loaded)) {
        // Keep only entries that are still fresh (token-valid) — drops dead URLs from disk
        if (v && v.m3u8Url && isStreamFresh(v)) { streamCache[k] = v; kept++; }
      }
      console.log("[StreamCache] Loaded", kept, "fresh of", Object.keys(loaded).length, "on disk");
    }
  } catch (e) { /* ignore */ }
  // SELF-HEALING purge: category entries saved before canonical-verification
  // existed may contain wrong videos. Flush them all — correct ones re-fetch
  // on first visit (hover-prefetch + prewarm rebuild the hot ones quickly).
  try {
    const PROTECTED = /^(all|newest|popular|top|hd|longest|hot):/;
    const catKeys = Object.keys(feedCache.pages).filter((k) => !PROTECTED.test(k));
    for (const k of catKeys) delete feedCache.pages[k];
    if (catKeys.length) console.log("[Cache] Purged", catKeys.length, "category pages (pre-verification data)");
  } catch (e) { /* ignore */ }
}
loadCachesFromDisk();

function atomicWrite(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

let feedSaveTimer = null;
let streamSaveTimer = null;
// Debounced + atomic saves — a 10MB sync write on every fetch was blocking the event loop
function saveFeedCache() {
  if (feedSaveTimer) return;
  feedSaveTimer = setTimeout(() => {
    feedSaveTimer = null;
    try { atomicWrite(CACHE_FILE, JSON.stringify(feedCache)); } catch (e) {}
  }, 5000);
}
function saveStreamCache() {
  if (streamSaveTimer) return;
  streamSaveTimer = setTimeout(() => {
    streamSaveTimer = null;
    try { atomicWrite(STREAM_CACHE_FILE, JSON.stringify(streamCache)); } catch (e) {}
  }, 2000);
}
function flushCaches() {
  if (feedSaveTimer) { clearTimeout(feedSaveTimer); feedSaveTimer = null; }
  if (streamSaveTimer) { clearTimeout(streamSaveTimer); streamSaveTimer = null; }
  try { atomicWrite(CACHE_FILE, JSON.stringify(feedCache)); } catch (e) {}
  try { atomicWrite(STREAM_CACHE_FILE, JSON.stringify(streamCache)); } catch (e) {}
}

/* ---------- Jina relay fetch ---------- */
const RELAY_TIMEOUT_MS = 8000;
const RELAY_HEADERS = { "X-Respond-With": "html" };

/* ---------- Playwright browser (lazy singleton) ---------- */
let playwrightBrowser = null;
let playwrightLaunchPromise = null;

async function getPlaywrightBrowser() {
  if (!chromium) throw new Error("Playwright not installed");
  if (playwrightBrowser && playwrightBrowser.isConnected()) return playwrightBrowser;
  if (playwrightLaunchPromise) return playwrightLaunchPromise;
  playwrightLaunchPromise = chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  }).then((b) => { playwrightBrowser = b; return b; })
    .catch((e) => { playwrightLaunchPromise = null; throw e; });
  return playwrightLaunchPromise;
}

async function scrapeViaPlaywright(targetUrl) {
  const browser = await getPlaywrightBrowser();
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  try {
    console.log("[Playwright] Navigating to:", targetUrl);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait up to 15s for Cloudflare challenge to resolve (real browser solves it)
    try {
      await page.waitForFunction(
        () => !document.title.includes("Just a moment") && !document.title.includes("Checking") && !document.title.includes("attention"),
        { timeout: 15000 }
      );
    } catch (e) { /* challenge may not exist */ }
    // Poll for window.initials (xhamster's video data)
    try {
      await page.waitForFunction(
        () => document.documentElement.innerHTML.includes("window.initials"),
        { timeout: 20000, polling: 500 }
      );
    } catch (e) { /* may not exist */ }
    // Also try data-previewvideo as fallback
    if (targetUrl.includes('xhamster')) {
      try {
        await page.waitForFunction(
          () => document.documentElement.innerHTML.includes('data-previewvideo'),
          { timeout: 5000, polling: 500 }
        );
      } catch (e) { /* fallback may not exist */ }
    }
    await page.waitForTimeout(500);
    const html = await page.content();
    console.log("[Playwright] Got", html.length, "bytes, has initials:", html.includes("window.initials"));
    return html;
  } finally {
    await context.close();
  }
}

/* ---------- Jina relay fetch (with Playwright fallback) ---------- */
const { execFile } = require("child_process");

/* ---------- Direct fetch (fail-fast racer) ---------- */
// execFile — no shell, so no Windows cmd.exe quoting pitfalls
function curlFetch(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile("curl", args, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error("curl failed: " + (err.message || String(err))));
      resolve(stdout);
    });
  });
}

function fetchDirectCurl(url, timeoutSec) {
  const timeout = timeoutSec || 3;
  return curlFetch(
    ["-s", "-L", "--compressed", "--max-time", String(timeout),
     "-H", "User-Agent: " + UA,
     "-H", "Accept: text/html,application/xhtml+xml",
     "-H", "Accept-Language: en-US,en;q=0.9",
     "-H", "Referer: https://xhamster.com/",
     url],
    timeout * 1000 + 2000
  ).then((t) => { if (!isValidPageHtml(t)) throw new Error("direct: no initials"); return t; });
}

function isValidPageHtml(html, requireM3u8) {
  if (typeof html !== "string" || html.length <= 5000 || !html.includes("window.initials")) return false;
  // For video pages a render WITHOUT the stream manifest is useless — don't let
  // it win the race over a racer that actually carries the m3u8.
  return !requireM3u8 || html.includes(".m3u8");
}

function timedFetchText(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { headers, redirect: "follow", signal: ctrl.signal })
    .then((r) => { if (!r.ok) throw new Error("http " + r.status); return r.text(); })
    .finally(() => clearTimeout(t));
}

// r.jina.ai via curl — node-fetch gets 403 (TLS/UA fingerprinting), curl works.
// noCache=true for video pages: jina otherwise caches a degraded render forever.
function fetchJinaCurl(url, timeoutSec, noCache) {
  const timeout = timeoutSec || 9;
  const args = ["-s", "--max-time", String(timeout), "-H", "X-Respond-With: html"];
  if (noCache) args.push("-H", "X-No-Cache: true");
  args.push(RELAY_BASE + url);
  return curlFetch(args, timeout * 1000 + 2000)
    .then((t) => { if (!isValidPageHtml(t, noCache && /\/videos\//.test(url))) throw new Error("jina: invalid render"); return t; });
}

/* ---------- Global relay limiter — tiered semaphore ----------
 * The relay (jina) slows under high parallel load, so concurrency is capped
 * per tier: 0 = user clicks/search (up to 3), 1 = warmer (up to 2),
 * 2 = feed refresh/cron (up to 1). Clicks always preempt queued background
 * jobs, and total concurrent render requests never exceed 4.
 */
const RELAY_MAX_CONCURRENT = 4;
const relayQueue = []; // { priority, resolve }
let relayActive = 0;

const TIER_CAPS = { 0: 3, 1: 2, 2: 1 };
const tierActive = { 0: 0, 1: 0, 2: 0 };

function pumpRelay() {
  for (;;) {
    let idx = -1;
    let best = Infinity;
    for (let i = 0; i < relayQueue.length; i++) {
      const pr = relayQueue[i].priority;
      const cap = TIER_CAPS[pr] || 1;
      if (tierActive[pr] < cap && relayActive < RELAY_MAX_CONCURRENT && pr < best) {
        best = pr; idx = i;
      }
    }
    if (idx === -1) break;
    const job = relayQueue.splice(idx, 1)[0];
    tierActive[job.priority]++;
    relayActive++;
    job.resolve(() => {
      tierActive[job.priority]--;
      relayActive--;
      pumpRelay();
    });
  }
}

function acquireRelaySlot(priority) {
  const tier = TIER_CAPS[priority] !== undefined ? priority : 1;
  return new Promise((resolve) => {
    relayQueue.push({ priority: tier, resolve });
    pumpRelay();
  });
}

async function withRelaySlot(priority, fn) {
  const release = await acquireRelaySlot(priority);
  try { return await fn(); } finally { release(); }
}

/* ---------- Race fetch: 3 parallel strategies, first VALID page wins ---------- */
// direct xhamster is network-blocked here, so the relay racers do the real work;
// racing them in parallel turns a 3-9s sequential worst case into the fastest path.
// priority: 0 = user-facing (click/search), 1 = background (feed refresh/warmer)
async function fetchPageHtml(url, priority, opts) {
  // Tiers: 0 = user click/search, 1 = warmer, 2 = feed refresh/cron
  const prio = priority === 0 ? 0 : priority === 1 ? 1 : priority === 2 ? 2 : 1;
  const bypass = opts && opts.bypassLimiter;
  const requireM3u8 = !!(opts && opts.requireM3u8);
  const check = (t) => { if (!isValidPageHtml(t, requireM3u8)) throw new Error("invalid render"); return t; };
  // Video pages: bypass jina's render cache — it can pin a degraded (stream-less) render forever
  const viaJina = bypass
    ? fetchJinaCurl(url, 9, requireM3u8)
    : withRelaySlot(prio, () => fetchJinaCurl(url, 9, requireM3u8)).then(check);
  const racers = [
    // r.jina.ai — renders the page (beats Cloudflare), returns html
    viaJina.then(check),
    // allorigins mirror — plain server-side fetch; slower but independent of jina
    timedFetchText("https://api.allorigins.win/raw?url=" + encodeURIComponent(url), { "User-Agent": UA }, 12000)
      .then(check),
    // direct curl — fails fast when blocked, wins big when not
    fetchDirectCurl(url, 3).then(check),
  ];
  try {
    return await Promise.any(racers);
  } catch (e) {
    // All three failed — one sequential jina retry (transient failures happen),
    // then Playwright as the last resort
    try { return await (bypass ? fetchJinaCurl(url, 10) : withRelaySlot(prio, () => fetchJinaCurl(url, 10)))
      .then(check); } catch (e2) { /* fall through */ }
    if (chromium) {
      try {
        const html = await Promise.race([
          scrapeViaPlaywright(url),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Playwright timeout")), 40000)),
        ]);
        if (html && html.includes("window.initials")) return html;
      } catch (pwErr) { /* fall through */ }
    }
    throw new Error("all fetch strategies failed");
  }
}

/* ---------- JSON parser ---------- */
function parseInitialsJson(html) {
  const marker = "window.initials";
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const eqIdx = html.indexOf("=", idx + marker.length);
  if (eqIdx === -1) return null;
  const jsonStart = html.indexOf("{", eqIdx);
  if (jsonStart === -1 || jsonStart - eqIdx > 5) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = jsonStart; i < html.length && i < jsonStart + 5000000; i++) {
    const c = html.charCodeAt(i);
    if (esc) { esc = false; continue; }
    if (c === 92 && inStr) { esc = true; continue; }       // backslash
    if (c === 34) { inStr = !inStr; continue; }              // double quote
    if (inStr) continue;
    if (c === 123) depth++;                                   // {
    if (c === 125) { depth--; if (depth === 0) { end = i; break; } } // }
  }
  if (end === -1) return null;
  try { return JSON.parse(html.substring(jsonStart, end + 1)); }
  catch (e) { return null; }
}

function extractM3u8FromHtml(html) {
  const r = extractM3u8WithSource(html);
  return r ? r.url : null;
}

function extractM3u8WithSource(html) {
  // PRIMARY (new frontend "API"): xhamster's SSR payload embeds the player
  // manifest as <link rel="preload" href="...m3u8" as="fetch"> — deterministic
  // on every fresh render, so prefer it over everything else.
  const linkPatterns = [
    /<link\b[^>]*href="(https?:\/\/[^"]+?\.m3u8[^"]*)"[^>]*as="fetch"[^>]*>/i,
    /<link\b[^>]*as="fetch"[^>]*href="(https?:\/\/[^"]+?\.m3u8[^"]*)"[^>]*>/i,
    /<link\b[^>]*href="(https?:\/\/[^"]+?\.m3u8[^"]*)"/i,
  ];
  for (const pat of linkPatterns) {
    const m = pat.exec(html);
    if (m && m[1]) return { url: m[1], fromPreload: true };
  }
  const obj = parseInitialsJson(html);
  if (obj) {
    const ps = obj.xplayerSettings || {};
    const vm = obj.videoModel || {};
    if (ps.sources && ps.sources.hls) {
      if (ps.sources.hls.url) return { url: ps.sources.hls.url, fromPreload: false };
      if (ps.sources.hls.fallback) return { url: ps.sources.hls.fallback, fromPreload: false };
    }
    if (vm.hlsUrl) return { url: vm.hlsUrl, fromPreload: false };
    if (vm.videoUrl) return { url: vm.videoUrl, fromPreload: false };
    if (Array.isArray(vm.sources)) {
      for (const s of vm.sources) { if (s.url && /\.m3u8/i.test(s.url)) return { url: s.url, fromPreload: false }; }
    }
  }
  const patterns = [/\"(https?:\/\/[^\"]*\.m3u8[^\"]*)\"/gi];
  for (const pat of patterns) { const m = pat.exec(html); if (m && m[1]) return { url: m[1], fromPreload: false }; }
  return null;
}

/* ---------- Card parser ---------- */
function formatDuration(seconds) {
  if (!seconds || typeof seconds !== "number") return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}

function parseCards(html) {
  const cards = [];
  const obj = parseInitialsJson(html);
  if (obj) {
    // Try multiple JSON paths for videoThumbProps
    let vp = null;
    if (obj.layoutPage && obj.layoutPage.videoListProps && obj.layoutPage.videoListProps.videoThumbProps) {
      vp = obj.layoutPage.videoListProps.videoThumbProps;
    } else if (obj.popularVideoListComponent && obj.popularVideoListComponent.videoThumbProps) {
      vp = obj.popularVideoListComponent.videoThumbProps;
    }
    if (Array.isArray(vp)) {
      for (const v of vp) {
        const pageUrl = v.pageURL || "";
        if (!pageUrl) continue;
        cards.push({
          id: String(v.id || ""),
          title: (v.title || "").replace(/&amp;/g, "&").trim(),
          pageUrl,
          preview: "",
          fallback: "",
          stream: "",
          thumb: v.thumbURL || v.imageURL || "",
          duration: formatDuration(v.duration),
        });
      }
      if (cards.length > 0) return cards;
    }
  }
  // Fallback: scan all videoThumbProps anywhere in the JSON
  if (obj && cards.length === 0) {
    function findVideoThumbProps(node, depth) {
      if (!node || depth > 5) return null;
      if (Array.isArray(node.videoThumbProps)) return node.videoThumbProps;
      for (const key of Object.keys(node)) {
        if (typeof node[key] === "object" && node[key] !== null) {
          const found = findVideoThumbProps(node[key], depth + 1);
          if (found) return found;
        }
      }
      return null;
    }
    const vp = findVideoThumbProps(obj, 0);
    if (Array.isArray(vp)) {
      for (const v of vp) {
        const pageUrl = v.pageURL || "";
        if (!pageUrl) continue;
        cards.push({
          id: String(v.id || ""),
          title: (v.title || "").replace(/&amp;/g, "&").trim(),
          pageUrl,
          preview: "",
          fallback: "",
          stream: "",
          thumb: v.thumbURL || v.imageURL || "",
          duration: formatDuration(v.duration),
        });
      }
      if (cards.length > 0) return cards;
    }
  }
  // Fallback HTML parsing
  const re = /<a\b([^>]*data-previewvideo="[^"]*"[^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1], body = m[2] || "";
    const preview = /data-previewvideo="([^"]*)"/.exec(tag);
    if (!preview) continue;
    const href = /href="([^"]*)"/.exec(tag);
    const title = /aria-label="([^"]*)"/.exec(tag) || /title="([^"]*)"/.exec(tag);
    let pageUrl = href ? href[1] : "";
    try { const u = new URL(pageUrl, "https://xhamster.com"); const p = u.searchParams.get("path"); if (p) pageUrl = "https://xhamster.com" + p; } catch (e) {}
    const vidMatch = /data-video-id="(\d+)"/.exec(tag);
    const thumbMatch = /<img[^>]*src="(https?:\/\/[^"]+)"/.exec(body);
    cards.push({
      id: vidMatch ? vidMatch[1] : "",
      title: (title ? title[1] : "").replace(/&amp;/g, "&").trim(),
      pageUrl,
      preview: preview[1],
      fallback: preview[1],
      stream: preview[1],
      thumb: thumbMatch ? thumbMatch[1] : "",
      duration: "",
    });
  }
  return cards;
}

async function fetchVideoPageForStream(pageUrl, priority) {
  const full = /^https?:\/\//.test(pageUrl) ? pageUrl : "https://xhamster.com" + pageUrl;
  const prio = priority === 0 ? 0 : 1;
  let lastErr;
  // Up to 2 extraction attempts. Every URL is deep-validated before it is
  // returned or cached: master #EXTM3U → level with segments → FIRST SEGMENT
  // magic bytes (ftyp/TS sync). A URL that passes but can't actually play
  // (dead tokens, preview manifests) is caught here, not by the player.
  // Validation races a 2.5s timer — a slow check must NOT delay the click;
  // a timed-out URL is returned unvalidated (player recovery covers it).
  // Per-attempt time budget — a stubborn strict attempt must not eat the whole click
  const BUDGETS = [9000, 10000];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Attempt 0: strict — only renders that actually carry an m3u8 may win the
      // race. Attempt 1: loose — accept any valid page (old-format initials may
      // still yield a stream, and preload-less renders recover via the retry).
      const attemptWork = (async () => {
        const html = await fetchPageHtml(full, prio, { requireM3u8: attempt === 0 });
        const extracted = extractM3u8WithSource(html);
        if (!extracted) { lastErr = new Error("no m3u8 in page"); return null; }
        const m3u8Url = extracted.url;
        // Preload-link URLs are xhamster's own SSR payload — authoritative, no
        // deep validation needed. Just seed the master playlist cache in the
        // background and return immediately (saves 1-2.5s on every resolve).
        if (extracted.fromPreload) {
          fetchUpstreamText(m3u8Url)
            .then((b) => { if (b && b.includes("#EXTM3U")) cachePlaylist(m3u8Url, b); })
            .catch(() => {});
          return m3u8Url;
        }
        const verdict = await Promise.race([
        (async () => {
          const master = await fetchUpstreamText(m3u8Url);
          if (!master || !master.includes("#EXTM3U")) return { ok: false };
          const lvlLine = master.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
          if (!lvlLine) return { ok: false };
          const lvlUrl = new URL(lvlLine, m3u8Url).href;
          const level = await fetchUpstreamText(lvlUrl);
          const segLine = level.split("\n").map((l) => l.trim()).reverse().find((l) => l && !l.startsWith("#") && !l.includes(".m3u8"));
          if (!segLine) return { ok: false };
          // fetch just the first bytes of the first segment and check it's real media
          const segUrl = new URL(segLine, lvlUrl).href;
          const segResp = await fetch(segUrl, { headers: { "User-Agent": UA, Referer: "https://xhamster.com/", Range: "bytes=0-2047" }, redirect: "follow" });
          if (!segResp.ok && segResp.status !== 206) return { ok: false };
          const reader = segResp.body.getReader();
          const chunk = await reader.read();
          reader.cancel().catch(() => {});
          const sb = chunk && chunk.value ? Buffer.from(chunk.value) : Buffer.alloc(0);
          // fMP4 media segments open with "styp" (init = "ftyp"), TS with 0x47 sync byte
          const box = sb.slice(4, 8).toString("latin1");
          const isMedia = sb.length > 512 &&
            (box === "ftyp" || box === "styp" || box === "moof" || sb[0] === 0x47 || sb.indexOf(Buffer.from("moov")) !== -1);
          if (!isMedia) return { ok: false };
          cachePlaylist(m3u8Url, master);
          cachePlaylist(lvlUrl, level);
          return { ok: true };
        })(),
        new Promise((res) => setTimeout(() => res({ ok: null }), 2500)),
      ]);
      if (verdict.ok === false) { lastErr = new Error("m3u8 failed playback-validation"); return null; }
      // ok === true → fully validated + cached; ok === null → timed out, return unvalidated
      return m3u8Url;
      })();
      const result = await Promise.race([
        attemptWork,
        new Promise((_, rej) => setTimeout(() => rej(new Error("attempt budget exhausted")), BUDGETS[attempt])),
      ]);
      if (result) return result;
    } catch (e) { lastErr = e; }
  }
  throw new Error("Could not fetch video page: " + (lastErr ? lastErr.message : "unknown"));
}

function evictSearchCache() {
  const keys = Object.keys(searchCache);
  if (keys.length <= SEARCH_CACHE_MAX) return;
  const sorted = keys.sort((a, b) => {
    const aTs = Object.values(searchCache[a].pages).reduce((m, p) => Math.max(m, p.ts || 0), 0);
    const bTs = Object.values(searchCache[b].pages).reduce((m, p) => Math.max(m, p.ts || 0), 0);
    return aTs - bTs;
  });
  for (let i = 0; i < sorted.length - SEARCH_CACHE_MAX + 10; i++) delete searchCache[sorted[i]];
}

/* ============================================================ */
/*                ENRICH CARDS WITH STREAM URLs                  */
/* ============================================================ */
// ONLY fresh streams are attached — an expired-token URL must never reach the player
function enrichCardsWithStreams(cards) {
  return cards.map(card => {
    const videoUrl = card.pageUrl ? (fullUrl(card.pageUrl) || card.pageUrl) : null;
    const entry = videoUrl ? streamCache[videoUrl] : null;
    if (isStreamFresh(entry)) {
      return { ...card, stream: entry.m3u8Url };
    }
    return { ...card, stream: "" };
  });
}

/* ============================================================ */
/*                     BACKGROUND FETCH                          */
/* ============================================================ */
async function backgroundFetchCategory(cacheKey, catUrl) {
  if (backgroundFetches.has(cacheKey)) return;
  backgroundFetches.add(cacheKey);
  try {
    console.log("[Background] Fetching", cacheKey, "...");
    const html = await fetchVerifiedPage(catUrl, 2);
    if (!html) { console.warn("[Background] Wrong render for", cacheKey, "— skipped"); return; }
    const cards = parseCards(html);
    if (cards.length > 0) {
      feedCache.pages[cacheKey] = { ts: Date.now(), cards };
      enforceFeedCacheCap();
      saveFeedCache();
    }
    console.log("[Background]", cacheKey + ":", cards.length, "videos loaded");
  } catch (e) {
    console.warn("[Background] Failed:", cacheKey, e.message);
  } finally {
    backgroundFetches.delete(cacheKey);
  }
}

/* ---------- Paced refresh queue (keeps relay load gentle) ---------- */
const refreshQueue = [];
let refreshActive = 0;
const REFRESH_CONCURRENCY = 1; // jina degrades under parallel load — sequential refresh is faster overall

function queuePageRefresh(cacheKey, catUrl, priority) {
  if (backgroundFetches.has(cacheKey)) return;
  if (refreshQueue.some((j) => j.cacheKey === cacheKey)) return;
  refreshQueue.push({ cacheKey, catUrl, priority });
  refreshQueue.sort((a, b) => a.priority - b.priority); // lower = sooner
  pumpRefreshQueue();
}

function pumpRefreshQueue() {
  while (refreshActive < REFRESH_CONCURRENCY && refreshQueue.length > 0) {
    const job = refreshQueue.shift();
    if (backgroundFetches.has(job.cacheKey)) continue;
    refreshActive++;
    backgroundFetchCategory(job.cacheKey, job.catUrl)
      .catch(() => {})
      .finally(() => { refreshActive--; setTimeout(pumpRefreshQueue, 500); });
  }
}

// Queue a page for fetch if missing OR stale — page-1 of each feed gets top priority
function ensurePageFresh(catKey, page, priority) {
  if (!/^[a-z0-9-]{2,60}$/.test(catKey)) return;
  const cacheKey = catKey + ":" + page;
  const entry = feedCache.pages[cacheKey];
  const missing = !entry || !entry.cards || entry.cards.length === 0;
  const stale = !missing && (Date.now() - (entry.ts || 0) >= CACHE_MS);
  if (missing || stale) {
    const pUrl = categoryUrl(catKey, page);
    queuePageRefresh(cacheKey, pUrl, priority);
  }
}

/* ============================================================ */
/*                          API ROUTES                           */
/* ============================================================ */

// Helper: get mixed videos from main feeds for the "all" homepage
const MAIN_FEED_KEYS = ["newest", "popular", "top", "hd", "longest", "hot"];
function getMixedVideos() {
  const byId = new Map();
  for (const catKey of MAIN_FEED_KEYS) {
    for (let p = 1; p <= 5; p++) {
      const entry = feedCache.pages[catKey + ":" + p];
      if (!entry || !entry.cards) continue;
      for (const card of entry.cards) {
        const id = card.id || card.pageUrl;
        if (id && !byId.has(id)) byId.set(id, card); // dedupe across feeds
      }
    }
  }
  return [...byId.values()];
}

// Fisher–Yates shuffle (crypto-random) — a NEW order on every request
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// GET /api/videos — "all" serves the warm-first random pool; REAL categories
// fetch on demand at user priority so the first visit returns that
// category's actual videos (never a random mix).
app.get("/api/videos", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const catKey = (req.query.category || "all").toLowerCase();
    const PAGE_SIZE = 36;

    // Handle "all" category — WARM-FIRST random feed.
    // Videos whose streams are already resolved are shown first, so every
    // visible card is instantly playable (zero-wait feel); unwarmed videos
    // pad the tail only if the warm pool is short. Order reshuffles per request.
    if (catKey === "all") {
      const pool = getMixedVideos();
      const warm = [], cold = [];
      for (const c of pool) {
        const u = c.pageUrl ? (fullUrl(c.pageUrl) || c.pageUrl) : null;
        if (u && isStreamFresh(streamCache[u])) warm.push(c); else cold.push(c);
      }
      const cards = shuffleArray(warm).concat(shuffleArray(cold)).slice((page - 1) * PAGE_SIZE, (page - 1) * PAGE_SIZE + PAGE_SIZE);
      // Keep main-feed pages fresh: page-1 first, then deeper pages
      for (const ck of MAIN_FEED_KEYS) {
        for (let p = 1; p <= 5; p++) {
          ensurePageFresh(ck, p, p === 1 ? ck === "newest" ? 0 : 1 : 10 + p);
        }
      }
      res.set("Cache-Control", "no-store"); // every request = a new random shuffle
      return res.json({
        success: true,
        page,
        category: "all",
        count: cards.length,
        totalPool: pool.length,
        warmPool: warm.length,
        videos: enrichCardsWithStreams(cards),
        cached: true,
        fetching: backgroundFetches.size > 0 || refreshQueue.length > 0,
      });
    }

    // REAL category — sanitize and route honestly (unknown keys still try
    // xhamster.com/categories/<key> instead of silently returning random videos)
    if (!/^[a-z0-9-]{2,60}$/.test(catKey)) {
      return res.status(400).json({ success: false, error: "invalid category" });
    }
    const catUrl = categoryUrl(catKey, page);
    const cacheKey = catKey + ":" + page;
    const pageEntry = feedCache.pages[cacheKey];
    const hasCache = pageEntry && pageEntry.cards && pageEntry.cards.length > 0;
    const fresh = hasCache && (Date.now() - pageEntry.ts < CACHE_MS);

    let cards = (pageEntry && pageEntry.cards) || [];
    // CACHE MISS → block briefly (max 7s) and fetch THIS category on demand
    if (!cards.length) {
      try {
        const fetched = await Promise.race([
          fetchCategoryNow(cacheKey, catUrl),
          sleep(7000).then(() => null),
        ]);
        if (fetched && fetched.length) cards = fetched;
      } catch (e) { /* fall through with empty + fetching flag */ }
    } else if (!fresh) {
      ensurePageFresh(catKey, page, 0); // stale → instant cache + background refresh
    }

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      page,
      category: catKey,
      count: cards.length,
      videos: enrichCardsWithStreams(cards),
      cached: !!fresh || cards.length > 0,
      fetching: backgroundFetches.has(cacheKey) || refreshQueue.some((j) => j.cacheKey === cacheKey) || cards.length === 0,
    });

    // Warm neighbouring pages in the background (paced queue)
    for (let np = page + 1; np <= page + 2; np++) ensurePageFresh(catKey, np, 10 + np);
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

app.get("/api/categories", (req, res) => res.json({ success: true, categories: Object.keys(CATEGORIES) }));

// Full category list grouped by type for sidebar — DYNAMIC from all 582+ categories
app.get("/api/categories/full", (req, res) => {
  // Load labels from categories-map.json if available
  let catMap = {};
  try {
    if (fs.existsSync(CATEGORIES_FILE)) catMap = JSON.parse(fs.readFileSync(CATEGORIES_FILE, "utf8"));
  } catch (e) {}

  const feedKeys = Object.keys(MAIN_FEEDS);
  const catKeys = CATEGORY_KEYS.filter(k => !feedKeys.includes(k));

  // Heuristic grouping based on slug keywords
  const KW = {
    "🎬 Types": ["amateur", "homemade", "hardcore", "softcore", "hentai", "cartoon", "retro", "vintage", "webcam", "animation", "3d", "gonzo", "pov", "compilation", "uncensored", "behind-the-scenes", "show", "erotica", "pmv", "jav", "interactive"],
    "💋 Actions": ["anal", "blowjob", "cumshot", "handjob", "massage", "masturbation", "threesome", "gangbang", "orgy", "group", "doggystyle", "cowgirl", "missionary", "riding", "facial", "deepthroat", "creampie", "squirting", "striptease", "footjob", "fingering", "cunnilingus", "blowbang", "rimjob", "facesitting", "scissoring", "69", "titty", "oral", "titfuck", "spitting", "edging", "pussy", "ass-licking", "ass-to-mouth", "double-penetration"],
    "🍑 Body": ["big-ass", "big-tits", "big-cock", "small-tits", "hairy", "chubby", "petite", "bbw", "skinny", "muscular", "pregnant", "tattoo", "piercing", "body", "nipples", "cameltoe", "clit", "tits", "legs", "nude", "beauty", "flexible", "giant", "monster", "perfect-body", "pawg", "fake-tits", "saggy-tits", "tight-pussy", "big-natural-tits", "big-nipples", "hermaphrodite", "futanari", "giantess", "midget", "ssbbw", "fbb"],
    "🌍 Ethnicity": ["asian", "latina", "black", "european", "arab", "desi", "japanese", "korean", "indian", "german", "french", "russian", "brazilian", "thai", "african", "american", "interracial", "amwf", "mexican", "colombian", "filipina", "turkish", "chinese", "taiwanese", "vietnamese", "indonesian", "malay", "pakistani", "bangladeshi", "persian", "iranian", "iraqi", "lebanese", "jewish", "mzansi", "british", "spanish", "dutch", "italian", "polish", "czech", "romania", "hungarian", "swedish", "norwegian", "danish", "finnish", "portuguese", "greek", "ukrainian", "belarusian", "serbian", "croatian", "bulgarian", "georgian", "armenian", "azeri", "kazakh", "uzbek", "mongolian", "nepali", "sri-lankan", "burmese", "cambodian", "laotian", "tibetan", "filipino", "hawaiian", "maori", "aboriginal", "caribbean", "jamaican", "cuban", "puerto-rican", "dominican", "honduran", "guatemalan", "salvadoran", "costa-rican", "panamanian", "venezuelan", "ecuadorian", "peruvian", "bolivian", "paraguayan", "uruguayan", "argentinian", "chilean", "south-african", "nigerian", "kenyan", "ethiopian", "egyptian", "moroccan", "tunisian", "algerian", "libyan", "sudanese", "somali", "congolese", "cameroonian", "ghanaian", "senegalese", "ivorian", "malagasy", "mauritian", "reunionese", "guadeloupean", "martiniquan", "french-polynesian", "new-zealand", "australian", "canadian", "scottish", "irish", "welsh"],
    "👩 Age": ["milf", "teen", "mature", "granny", "gilf", "cougar", "old-young", "18-year", "old-man", "young"],
    "💈 Hair": ["blonde", "brunette", "redhead", "colored-hair", "long-hair", "short-hair"],
    "⛓️ Fetish": ["bdsm", "bondage", "domination", "femdom", "fetish", "humiliation", "oiled", "pissing", "shibari", "hogtied", "tied-up", "spanking", "whipping", "chastity", "cbt", "estim", "pet-play", "sissy", "submissive", "suspension", "tape", "wax", "ball", "blindfold", "gag", "foot-worship", "face-fetish", "hand-fetish", "mouth-fetish", "belly-fetish", "armpit", "body-hair-fetish", "body-paint", "dogging", "farting", "food", "gokkun", "gyno-fetish", "human-ashtray", "human-furniture", "kinky", "lactating", "lezdom", "milk", "mind-control", "orgasm-control", "pedal-pumping", "predicament-bondage", "punishment", "raceplay", "smoking", "smothering", "spitting", "trampling", "wedgie", "weird", "wet-messy", "wrestling", "balloon", "extreme-insertion", "fisting", "prostate-massage"],
    "👗 Clothing": ["lingerie", "stockings", "uniform", "bikini", "latex", "leather", "high-heels", "nylon", "fishnet", "pantyhose", "panties", "thong", "bra", "gloves", "jeans", "leggings", "socks", "spandex", "bodystocking", "school-uniform", "masked"],
    "🎭 Scenarios": ["cosplay", "boss", "teacher", "nurse", "maid", "babysitter", "secretary", "plumber", "doctor", "police", "cheating", "cuckold", "taboo", "fantasy", "role-play", "casting", "celebrity", "parody", "neighbor", "stranger", "stuck", "time-stop", "truth-or-dare", "twins", "nun", "princess", "superhero", "vampire", "horror", "comic", "story", "interview", "pick-up", "party", "game", "fighting", "first-time", "seduce", "sex-instruction", "joi", "slave", "sport", "asmr", "agent", "alien", "audition", "baddie", "birthday", "body-swap", "bunny", "cfnm", "cmnf", "catfight", "cheerleader", "clown", "coed", "cook", "dance", "doll", "e-girl", "emo", "escort", "gamer-girl", "ghetto", "girlfriend", "glory-hole", "gothic", "halloween", "housewife", "medical", "medieval", "military", "mistress", "monster", "morning", "naughty", "nerd", "nudist", "nympho", "passionate", "police", "princess", "public-nudity", "reverse-gangbang", "romantic", "secretary", "slave", "student", "surprise", "swingers", "virgin", "voyeur", "waitress", "wedding", "wife", "wife-sharing", "wife-swap", "xmas"],
    "📍 Location": ["outdoor", "public", "bathroom", "beach", "car", "hotel", "kitchen", "office", "pool", "shower", "gym", "forest", "jungle", "farm", "prison", "taxi", "bus", "train", "underwater", "village", "sauna", "hospital", "college", "camping"],
  };

  const feedItems = feedKeys.map(k => ({
    key: k,
    label: { all: "All", newest: "Newest", popular: "Popular", top: "Top Rated", hd: "HD", longest: "Longest", hot: "Hot Today" }[k] || k,
    url: CATEGORIES[k],
  }));

  const groups = [{ name: "🔥 Feeds", items: feedItems }];
  const assigned = new Set(feedKeys);

  // Assign categories to groups by keyword matching
  for (const [groupName, keywords] of Object.entries(KW)) {
    const items = [];
    for (const catKey of catKeys) {
      if (assigned.has(catKey)) continue;
      const slug = catMap[catKey]?.slug || catKey;
      if (keywords.some((kw) => slug.includes(kw) || catKey.includes(kw))) {
        items.push({
          key: catKey,
          label: catMap[catKey]?.label || catKey.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          url: CATEGORIES[catKey],
        });
        assigned.add(catKey);
      }
    }
    if (items.length > 0) groups.push({ name: groupName, items });
  }

  // Remaining uncategorized → "📦 All Categories"
  const remaining = catKeys.filter((k) => !assigned.has(k));
  if (remaining.length > 0) {
    const items = remaining.map((k) => ({
      key: k,
      label: catMap[k]?.label || k.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      url: CATEGORIES[k],
    }));
    groups.push({ name: "📦 All Categories (" + remaining.length + ")", items });
  }

  res.json({ success: true, groups, totalCategories: CATEGORY_KEYS.length });
});

app.get("/api/stats", (req, res) => {
  res.json({
    success: true,
    uptime: Math.round(process.uptime()),
    mongodb: isConnected(),
    cachedPages: Object.keys(feedCache.pages).length,
    cachedStreams: Object.keys(streamCache).length,
    cachedSearches: Object.keys(searchCache).length,
    backgroundFetches: [...backgroundFetches],
  });
});

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customCss: ".swagger-ui .topbar { display: none }", customSiteTitle: "TubeStream API Docs" }));
app.get("/api-docs.json", (req, res) => res.json(swaggerSpec));

// NOTE: /api/videos/pages MUST come before /api/videos/:id
app.get("/api/videos/pages", (req, res) => {
  try {
    const from = Math.max(1, parseInt(req.query.from) || 1);
    const to = Math.min(from + 4, parseInt(req.query.to) || from + 2);
    const catKey = (req.query.category || "newest").toLowerCase();
    const allVideos = [];
    for (let p = from; p <= to; p++) {
      const entry = feedCache.pages[catKey + ":" + p];
      if (entry && entry.cards) allVideos.push(...entry.cards);
    }
    res.json({ success: true, from, to, category: catKey, count: allVideos.length, videos: enrichCardsWithStreams(allVideos) });
    // Queue refresh for stale/missing pages (paced)
    for (let p = from; p <= to; p++) ensurePageFresh(catKey, p, p <= 1 ? 0 : 10 + p);
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

app.post("/api/batch-pages", rateLimit(60 * 1000, 20), async (req, res) => {
  try {
    const { category, from, to } = req.body;
    if (!category) return res.status(400).json({ error: "category required" });
    const catKey = category.toLowerCase();
    const start = Math.max(1, from || 1);
    const end = Math.min(start + 9, to || start + 4); // max 10 pages
    const allVideos = [];
    const missingPages = [];

    for (let p = start; p <= end; p++) {
      const entry = feedCache.pages[catKey + ":" + p];
      if (entry && entry.cards && entry.cards.length > 0) {
        allVideos.push(...entry.cards);
      } else {
        missingPages.push(p);
      }
    }

    // Return cached immediately
    res.json({ success: true, category: catKey, from: start, to: end, count: allVideos.length, videos: enrichCardsWithStreams(allVideos), missingPages });

    // Queue refresh for missing pages (paced)
    for (const p of missingPages) ensurePageFresh(catKey, p, p <= 1 ? 0 : 10 + p);
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

async function fetchSearchViaRelay(keyword, pageNum) {
  const url = "https://xhamster.com/search/" + encodeURIComponent(keyword) + "/" + pageNum;
  return fetchPageHtml(url, 0); // user-initiated search — high priority
}

app.get("/api/videos/:id", (req, res) => {
  try {
    const id = req.params.id;
    for (const [, entry] of Object.entries(feedCache.pages)) {
      if (!entry.cards) continue;
      const found = entry.cards.find((c) => c.id === id);
      if (found) return res.json({ success: true, video: found });
    }
    res.status(404).json({ success: false, error: "Video not found" });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

app.get("/api/search", rateLimit(60 * 1000, 20), async (req, res) => {
  try {
    const keyword = (req.query.q || "").trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    if (!keyword) return res.status(400).json({ success: false, error: "q parameter required" });
    const key = keyword.toLowerCase();
    if (!searchCache[key]) searchCache[key] = { pages: {} };
    const cache = searchCache[key];
    const pageEntry = cache.pages[page];
    const hasCache = pageEntry && pageEntry.cards && pageEntry.cards.length > 0;
    const fresh = hasCache && (Date.now() - pageEntry.ts < SEARCH_CACHE_MS);

    // Return whatever we have immediately, enriched with FRESH cached streams only
    const cards = enrichCardsWithStreams((pageEntry && pageEntry.cards) || []);
    res.json({ success: true, keyword, page, count: cards.length, videos: cards, cached: !!fresh });

    // Background fetch if stale
    if (!fresh) {
      try {
        const html = await fetchSearchViaRelay(keyword, page);
        const newCards = parseCards(html);
        cache.pages[page] = { ts: Date.now(), cards: newCards };
        evictSearchCache();
      } catch (e) {
        console.warn("[Search] Fetch failed:", e.message);
      }
    }
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

app.get("/api/refresh", rateLimit(60 * 1000, 10), async (req, res) => {
  const catKey = (req.query.category || "all").toLowerCase();
  try {
    if (catKey === "all") {
      // Queue a paced refresh of all main-feed pages (page-1 first); respond immediately
      for (let p = 1; p <= 5; p++) {
        for (const feedKey of MAIN_FEED_KEYS) {
          ensurePageFresh(feedKey, p, p === 1 ? (feedKey === "newest" ? 0 : 1) : 10 + p);
        }
      }
      return res.json({ success: true, queued: true, message: "Main feeds refresh queued" });
    }
    // Single category refresh — queue page 1 at top priority
    const resolved = CATEGORIES[catKey] ? catKey : "newest";
    ensurePageFresh(resolved, 1, 0);
    res.json({ success: true, queued: true, category: resolved });
  } catch (e) { res.status(502).json({ success: false, error: String(e.message || e) }); }
});

// Resolve the m3u8 for a video page — fresh cache-hit is instant; otherwise live race-resolve.
// ?refresh=1 forces re-extraction (frontend error-recovery path).
const streamResolving = new Map(); // url -> in-flight promise (dedupe concurrent requests)
app.get("/api/stream-url", async (req, res) => {
  try {
    const videoUrl = req.query.url;
    const forceRefresh = req.query.refresh === "1";
    if (!videoUrl) return res.status(400).json({ error: "url parameter required" });

    if (!forceRefresh) {
      const cached = streamCache[videoUrl];
      if (isStreamFresh(cached)) {
        warmPlaylists(cached.m3u8Url).catch(() => {});
        return res.json({ success: true, m3u8Url: cached.m3u8Url, cached: true });
      }
    }

    // Dedupe: if the same URL is already being resolved, join it — but ALWAYS
    // also race a fresh HIGH-priority resolve. The in-flight one may be a
    // background (LOW) job still queued behind other work; a click must never
    // wait for that queue. Loser result is discarded; winner is already cached.
    let resolvePromise = streamResolving.get(videoUrl);
    if (resolvePromise && !forceRefresh) {
      const high = fetchVideoPageForStream(videoUrl, 0)
        .then((m3u8Url) => { if (!m3u8Url) throw new Error("No m3u8 stream found"); cacheStream(videoUrl, m3u8Url); saveStreamCache(); warmPlaylists(m3u8Url).catch(() => {}); return m3u8Url; });
      resolvePromise = Promise.race([resolvePromise.promise, high]);
    }
    if (forceRefresh || !streamResolving.has(videoUrl)) {
      const entry = { startedAt: Date.now(), promise: null };
      entry.promise = fetchVideoPageForStream(videoUrl, 0)
        .then((m3u8Url) => {
          if (!m3u8Url) throw new Error("No m3u8 stream found");
          cacheStream(videoUrl, m3u8Url); // latest URL always replaces the old one
          saveStreamCache();
          // Fire-and-forget: warm remaining level playlists so hls.js requests hit cache
          warmPlaylists(m3u8Url).catch(() => {});
          return m3u8Url;
        })
        .finally(() => { if (streamResolving.get(videoUrl) === entry) streamResolving.delete(videoUrl); });
      streamResolving.set(videoUrl, entry);
      resolvePromise = entry.promise;
    }

    const m3u8Url = await resolvePromise;
    res.json({ success: true, m3u8Url, cached: false });
  } catch (e) { res.status(502).json({ success: false, error: String(e.message || e) }); }
});

/* ---------- Playlist warm (resolve-time, for the CLICKED video only) ---------- */
async function fetchUpstreamText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://xhamster.com/", Accept: "*/*" }, redirect: "follow" });
  if (!r.ok) throw new Error("upstream " + r.status);
  return r.text();
}

function cachePlaylist(url, body) {
  if (playlistLRU.size >= PLAYLIST_LRU_MAX) {
    const oldest = playlistLRU.keys().next().value;
    if (oldest !== undefined) playlistLRU.delete(oldest);
  }
  playlistLRU.set(url, { body, ctype: "application/vnd.apple.mpegurl", ts: Date.now() });
}

// Warm a master playlist + its level variants into playlistLRU so that the
// player's sequential master→level hops become cache-hits. Also pre-fetches the
// init segment + first media segment of the smallest level (segmentLRU) — those
// two sequential upstream hops are the biggest chunk of click-to-play latency.
async function warmPlaylists(m3u8Url) {
  try {
    let body;
    const cached = playlistLRU.get(m3u8Url);
    if (cached && Date.now() - cached.ts < PLAYLIST_TTL) {
      body = cached.body; // master already validated+cached at resolve time
    } else {
      body = await fetchUpstreamText(m3u8Url);
      cachePlaylist(m3u8Url, body);
    }
    const variants = [];
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      try { variants.push(new URL(t, m3u8Url).href); } catch (e) { /* skip */ }
      if (variants.length >= 8) break;
    }
    // concurrency-capped level warm
    let idx = 0;
    async function worker() {
      while (idx < variants.length) {
        const vUrl = variants[idx++];
        try { cachePlaylist(vUrl, await fetchUpstreamText(vUrl)); } catch (e) { /* skip */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, variants.length) }, worker));
    // Pre-fetch init + first media segment of the smallest variant (fastest decode start)
    const smallest = variants[0];
    if (smallest) {
      const lvl = playlistLRU.get(smallest);
      if (lvl && lvl.body) {
        const lines = lvl.body.split("\n").map((l) => l.trim()).filter(Boolean);
        const initLine = lines.find((l) => l.startsWith("#") && /URI="([^"]+)"/.test(l));
        if (initLine) {
          const iu = /URI="([^"]+)"/.exec(initLine)[1];
          try { await cacheSegment(new URL(iu, smallest).href); } catch (e) { /* skip */ }
        }
        const segLine = lines.reverse().find((l) => !l.startsWith("#") && !l.includes(".m3u8"));
        if (segLine) {
          try { await cacheSegment(new URL(segLine, smallest).href, 262144); } catch (e) { /* skip */ }
        }
      }
    }
  } catch (e) { /* warming is best-effort */ }
}

/* ---------- Segment LRU — init + first media segments for warmed videos ---------- */
const segmentLRU = new Map(); // url -> { buf, ts }
const SEGMENT_LRU_MAX = 100;
const SEGMENT_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of segmentLRU) if (now - v.ts > SEGMENT_TTL) segmentLRU.delete(k);
}, 5 * 60 * 1000).unref();

function cacheSegmentUrl(url, buf) {
  if (segmentLRU.size >= SEGMENT_LRU_MAX) {
    const oldest = segmentLRU.keys().next().value;
    if (oldest !== undefined) segmentLRU.delete(oldest);
  }
  segmentLRU.set(url, { buf, ts: Date.now() });
}

async function cacheSegment(url, maxBytes) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://xhamster.com/", Accept: "*/*", ...(maxBytes ? { Range: "bytes=0-" + (maxBytes - 1) } : {}) }, redirect: "follow" });
  if (!r.ok && r.status !== 206) return false;
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(Buffer.from(value));
    total += value.length;
    if (total >= (maxBytes || 512 * 1024)) { reader.cancel().catch(() => {}); break; }
    if (total > 512 * 1024) { reader.cancel().catch(() => {}); break; } // don't cache huge segments
  }
  const buf = Buffer.concat(chunks);
  if (buf.length < 512) return false;
  cacheSegmentUrl(url, buf);
  return true;
}

/* ---------- Gentle visible-page warmer ----------
 * Frontend sends the current page's video URLs; the server resolves TWO streams
 * at a time (staggered 1.5s) so that clicking any visible video is a cache-hit.
 * Strictly bounded — nothing like the old 20-parallel/500-preseed prefetch engine.
 */
const warmQueue = [];
const warmRetried = new Set();
let warmActive = 0;
const WARM_WORKERS = 2;          // 2 concurrent = visible page warm in ~20s without degrading jina
const WARM_STAGGER_MS = 800;
const WARM_QUEUE_MAX = 60;

app.post("/api/warm", rateLimit(60 * 1000, 20), (req, res) => {
  try {
    const urls = req.body && req.body.urls;
    if (!Array.isArray(urls)) return res.status(400).json({ error: "urls array required" });
    // New page render = the user navigated; the old page's queue is stale. Flush it
    // so background load stays proportional to what's actually on screen.
    warmQueue.length = 0;
    const valid = urls.slice(0, 12).filter((u) =>
      typeof u === "string" && /^https:\/\/xhamster\.com\/videos\//.test(u) && !isStreamFresh(streamCache[u])
    );
    // URGENT: first 6 cards resolve in parallel at USER tier — users
    // overwhelmingly click one of the first visible cards, so those must be warm
    // within a few seconds of page render even while the paced queue covers the rest.
    const urgentUrls = valid.slice(0, 6).filter((u) => !streamResolving.has(u) && !warmQueue.includes(u));
    let urgent = urgentUrls.length;
    if (urgent > 0) {
      // Urgent trio resolves IN PARALLEL at USER tier — they're what the user
      // is most likely to click within seconds, so they must never queue behind
      // background work.
      for (const u of urgentUrls) {
        const entry = { startedAt: Date.now(), promise: null };
        entry.promise = (async () => {
          const m3u8Url = await fetchVideoPageForStream(u, 0);
          if (m3u8Url) { cacheStream(u, m3u8Url); saveStreamCache(); warmPlaylists(m3u8Url).catch(() => {}); }
        })().finally(() => { if (streamResolving.get(u) === entry) streamResolving.delete(u); });
        streamResolving.set(u, entry);
        entry.promise.catch(() => { retryWarm(u); });
      }
    }
    let queued = 0;
    for (const u of valid) {
      if (warmQueue.includes(u) || streamResolving.has(u)) continue;
      if (warmQueue.length >= WARM_QUEUE_MAX) break;
      warmQueue.push(u);
      queued++;
    }
    pumpWarmQueue();
    res.json({ success: true, queued, urgent });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

function pumpWarmQueue() {
  while (warmActive < WARM_WORKERS && warmQueue.length > 0) {
    const next = warmQueue.shift();
    if (isStreamFresh(streamCache[next])) continue;
    warmActive++;
    (async () => {
      try {
        const m3u8Url = await fetchVideoPageForStream(next, 1);
        if (m3u8Url) {
          cacheStream(next, m3u8Url);
          saveStreamCache();
          warmPlaylists(m3u8Url).catch(() => {});
        } else {
          retryWarm(next);
        }
      } catch (e) {
        retryWarm(next);
      } finally {
        warmActive--;
        if (warmQueue.length > 0) setTimeout(pumpWarmQueue, WARM_STAGGER_MS);
        else setTimeout(pumpWarmQueue, WARM_STAGGER_MS * 2); // poll for new arrivals
      }
    })();
  }
}

// One retry per failed URL, requeued at the back (transient relay failures)
function retryWarm(url) {
  if (warmRetried.has(url)) { warmRetried.delete(url); return; }
  warmRetried.add(url);
  if (warmQueue.length < WARM_QUEUE_MAX) warmQueue.push(url);
}

/* ---------- WARM POOL — the zero-wait engine ----------
 * A background worker keeps a rotating pool of main-feed videos with FRESH
 * streams (m3u8 + playlists + first segments). The homepage serves warm
 * videos FIRST, so every card the user sees is already playable — a click at
 * ANY moment (even the second the page opens) is a cache-hit.
 * Tokens live ~3h, so keeping ~60 warm costs one resolve every few seconds
 * at most — negligible relay load.
 */
const WARM_POOL_TARGET = 60;
let poolCursor = 0;
let poolCycle = 0;

function countWarmStreams() {
  const now = Date.now();
  let n = 0;
  for (const v of Object.values(streamCache)) if (isStreamFresh(v, now)) n++;
  return n;
}

// Round-robin unique main-feed video URLs; skips ones already warm
function nextPoolCandidate() {
  const urls = getMixedVideos()
    .map((c) => c.pageUrl ? (fullUrl(c.pageUrl) || c.pageUrl) : null)
    .filter(Boolean);
  if (urls.length === 0) return null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[(poolCursor + i) % urls.length];
    if (!isStreamFresh(streamCache[url]) && !streamResolving.has(url)) {
      poolCursor = (poolCursor + i + 1) % urls.length;
      return url;
    }
  }
  return null; // everything warm (or resolving)
}

/* ---------- Category helpers ---------- */
// Resolve the listing URL for any category key — known map URLs are used as-is,
// unknown-but-plausible keys construct /categories/<key> (honest: no random-feed trap)
function categoryUrl(catKey, page) {
  const known = CATEGORIES[catKey];
  const base = known || "https://xhamster.com/categories/" + encodeURIComponent(catKey);
  if (page <= 1) return base;
  const m = /xhamster\.com\/categories\/([^\/?]+)/.exec(base);
  if (m) return "https://xhamster.com/categories/" + m[1] + "/" + page; // categories paginate as /<slug>/<n>
  return base + "/" + page; // main feeds paginate as /<feed>/<n>
}

// Keep storage bounded: category pages evict oldest-first; main feeds are protected
function enforceFeedCacheCap() {
  const MAX_CAT_PAGES = 220;
  const catEntries = Object.entries(feedCache.pages).filter(([k]) => !MAIN_FEED_KEYS.some((fk) => k.startsWith(fk + ":")));
  if (catEntries.length <= MAX_CAT_PAGES) return;
  catEntries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  for (let i = 0; i < catEntries.length - MAX_CAT_PAGES; i++) delete feedCache.pages[catEntries[i][0]];
}

// Category page integrity: SSR initials carry the page's own route metadata
// (activePage/category slug). If the render landed somewhere else (redirect,
// consent wall), don't cache it as this category.
/* ---------- Render verification via canonical tag ----------
 * Every valid xhamster render carries <link rel="canonical"> pointing at the
 * page ITSELF. A wrong render (geo-variant, redirect, feed page) has a
 * different canonical — so this check is exact, unlike substring matching.
 */
function isCorrectRender(html, targetUrl) {
  if (typeof html !== "string" || !html) return false;
  const canon = /rel="canonical"\s+href="([^"]+)"/.exec(html) || /href="([^"]+)"\s+rel="canonical"/.exec(html);
  if (!canon) return false;
  const norm = (u) => {
    try { return new URL(u).pathname.replace(/\/\d+\/?$/, "").replace(/\/$/, ""); }
    catch (e) { return ""; }
  };
  return norm(canon[1]) === norm(targetUrl);
}

// Fetch + verify; on a wrong winner, force one uncached jina render.
// Returns verified html, or null if we can't get the right page.
async function fetchVerifiedPage(targetUrl, tier) {
  let html = await fetchPageHtml(targetUrl, tier);
  if (isCorrectRender(html, targetUrl)) return html;
  console.warn("[Verify] Wrong render won for", targetUrl, "— forcing uncached retry");
  const retry = await fetchJinaCurl(targetUrl, 10, true).catch(() => "");
  if (isCorrectRender(retry, targetUrl)) return retry;
  return null;
}

// waits (max ~7s) and returns THAT category's real videos instead of an empty page
const categoryResolving = new Map(); // cacheKey -> { startedAt, promise }
function fetchCategoryNow(cacheKey, catUrl) {
  const existing = categoryResolving.get(cacheKey);
  if (existing) return existing.promise;
  const entry = { startedAt: Date.now(), promise: null };
  entry.promise = (async () => {
    if (backgroundFetches.has(cacheKey)) {
      // a background job is already on it — wait for the cache to fill, then read it
      for (let i = 0; i < 14; i++) {
        await sleep(500);
        const e = feedCache.pages[cacheKey];
        if (e && e.cards && e.cards.length) return e.cards;
        if (!backgroundFetches.has(cacheKey)) break;
      }
      const e = feedCache.pages[cacheKey];
      return (e && e.cards) || [];
    }
    const html = await fetchVerifiedPage(catUrl, 0);
    if (!html) return []; // honest empty — never cache wrong videos
    const cards = parseCards(html);
    if (cards.length > 0) {
      feedCache.pages[cacheKey] = { ts: Date.now(), cards };
      enforceFeedCacheCap();
      saveFeedCache();
    }
    return cards;
  })().finally(() => { if (categoryResolving.get(cacheKey) === entry) categoryResolving.delete(cacheKey); });
  categoryResolving.set(cacheKey, entry);
  return entry.promise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function warmPoolWorker() {
  console.log("[WarmPool] Worker started — target:", WARM_POOL_TARGET, "fresh streams");
  for (;;) {
    try {
      // Active user browsing takes precedence — if a category page is being warmed,
      // let it finish before pool churn adds relay load
      if (warmQueue.length > 0 || categoryResolving.size > 0) { await sleep(4000); continue; }
      const fresh = countWarmStreams();
      if (fresh >= WARM_POOL_TARGET) {
        await sleep(10000); // pool is full — idle check
        continue;
      }
      const url = nextPoolCandidate();
      if (!url) { await sleep(8000); continue; }
      const entry = { startedAt: Date.now(), promise: null };
      entry.promise = fetchVideoPageForStream(url, 1)
        .then((m3u8Url) => {
          if (m3u8Url) { cacheStream(url, m3u8Url); saveStreamCache(); warmPlaylists(m3u8Url).catch(() => {}); }
        })
        .finally(() => { if (streamResolving.get(url) === entry) streamResolving.delete(url); });
      streamResolving.set(url, entry);
      await entry.promise.catch(() => {});
      poolCycle++;
      if (poolCycle % 20 === 0) console.log("[WarmPool]", countWarmStreams(), "/", WARM_POOL_TARGET, "warm");
      await sleep(500); // gentle pacing between resolves
    } catch (e) {
      await sleep(3000);
    }
  }
}

/* ---------- Thumbnail proxy (fixes CORS/network in Electron) + in-memory LRU ---------- */
const THUMB_HOST = /^https:\/\/([\w-]+\.)*xhcdn\.com\//;
const thumbLRU = new Map(); // url -> { buf, ctype, ts }
const THUMB_LRU_MAX = 500;
const THUMB_LRU_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of thumbLRU) {
    if (now - v.ts > THUMB_LRU_TTL) thumbLRU.delete(k);
  }
}, 5 * 60 * 1000).unref();

app.get("/api/thumb", async (req, res) => {
  const url = req.query.url;
  if (!url || !THUMB_HOST.test(url)) return res.status(400).json({ error: "invalid thumb url" });

  // LRU hit — instant, no upstream round-trip
  const hit = thumbLRU.get(url);
  if (hit && Date.now() - hit.ts < THUMB_LRU_TTL) {
    thumbLRU.delete(url); thumbLRU.set(url, hit); // refresh recency
    res.set("Content-Type", hit.ctype);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Length", hit.buf.length);
    return res.end(hit.buf);
  }

  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://xhamster.com/" },
      redirect: "follow",
    });
    if (!upstream.ok) return res.status(502).json({ error: "upstream " + upstream.status });
    const ctype = upstream.headers.get("content-type") || "image/webp";
    const buf = Buffer.from(await upstream.arrayBuffer());
    // Store in LRU (evict oldest if over cap)
    if (thumbLRU.size >= THUMB_LRU_MAX) {
      const oldestKey = thumbLRU.keys().next().value;
      if (oldestKey !== undefined) thumbLRU.delete(oldestKey);
    }
    thumbLRU.set(url, { buf, ctype, ts: Date.now() });
    res.set("Content-Type", ctype);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Length", buf.length);
    res.end(buf);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

const ALLOWED_HOST = /^https:\/\/([\w-]+\.)*(xhcdn|phncdn|xhamster|ahcdn)\.com\//;

// VOD playlists are immutable — cache raw bodies so repeat plays skip upstream RTTs
const playlistLRU = new Map(); // url -> { body, ctype, ts }
const PLAYLIST_LRU_MAX = 300;
const PLAYLIST_TTL = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of playlistLRU) if (now - v.ts > PLAYLIST_TTL) playlistLRU.delete(k);
}, 5 * 60 * 1000).unref();

function rewritePlaylistLine(line, baseUrl) {
  const t = line.trim();
  if (!t) return line;
  if (t.startsWith("#")) {
    // Rewrite URI="..." attributes (#EXT-X-KEY, #EXT-X-MAP, ...) — must handle
    // RELATIVE URIs too, or hls.js resolves them against /api/stream and 404s
    return t.replace(/URI="([^"]+)"/g, (m, u) => {
      try { return 'URI="/api/stream?url=' + encodeURIComponent(new URL(u, baseUrl).href) + '"'; } catch (e) { return m; }
    });
  }
  try { return "/api/stream?url=" + encodeURIComponent(new URL(t, baseUrl).href); } catch (e) { return line; }
}

app.get("/api/stream", async (req, res) => {
  const url = req.query.url;
  if (!url || !ALLOWED_HOST.test(url)) return res.status(400).json({ error: "invalid url" });
  try {
    const hdrs = { "User-Agent": UA, Referer: "https://xhamster.com/", Accept: "*/*" };
    if (req.headers.range) hdrs.Range = req.headers.range;
    const upstream = await fetch(url, { headers: hdrs, redirect: "follow" });
    if (!upstream.ok) return res.status(502).json({ error: "upstream " + upstream.status });
    const ctype = upstream.headers.get("content-type") || "application/octet-stream";
    res.set("Content-Type", ctype);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Accept-Ranges", "bytes");
    const cl = upstream.headers.get("content-length");
    if (cl) res.set("Content-Length", cl);
    if (upstream.headers.get("content-range")) { res.status(206); res.set("Content-Range", upstream.headers.get("content-range")); }
    const isPlaylist = /mpegurl/i.test(ctype) || /\.m3u8/i.test(url);
    if (isPlaylist) {
      let body = null;
      const cachedPl = playlistLRU.get(url);
      if (cachedPl && Date.now() - cachedPl.ts < PLAYLIST_TTL) {
        body = cachedPl.body;
      } else {
        body = await upstream.text();
        if (playlistLRU.size >= PLAYLIST_LRU_MAX) {
          const oldest = playlistLRU.keys().next().value;
          if (oldest !== undefined) playlistLRU.delete(oldest);
        }
        playlistLRU.set(url, { body, ctype, ts: Date.now() });
      }
      return res.send(body.split("\n").map((line) => rewritePlaylistLine(line, url)).join("\n"));
    }
    // Segment cache — warmed init/first segments serve instantly (no Range requests only)
    if (!req.headers.range) {
      const seg = segmentLRU.get(url);
      if (seg && Date.now() - seg.ts < SEGMENT_TTL) {
        res.set("Content-Type", "video/mp4");
        res.set("Content-Length", seg.buf.length);
        res.set("Cache-Control", "public, max-age=86400");
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Accept-Ranges", "bytes");
        return res.end(seg.buf);
      }
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* ---------- Aggressive caching headers ---------- */
function setCacheHeaders(res, maxAge) {
  res.set("Cache-Control", "public, max-age=" + maxAge + ", immutable");
}

// Cache static assets aggressively

app.use("/vendor", express.static(path.join(__dirname, "node_modules/hls.js/dist"), {
  maxAge: "30d", etag: true, lastModified: true
}));
app.use(express.static(path.join(__dirname, "public"), {
  etag: true, lastModified: true,
  setHeaders: (res, filePath) => {
    // HTML must never be cached — stale index.html pins an old app.js and
    // the user keeps running the previous build for up to an hour.
    if (filePath.endsWith(".html")) res.set("Cache-Control", "no-store");
    else res.set("Cache-Control", "public, max-age=3600");
  }
}));

/* ---------- Root health check (API) ---------- */
app.get("/api/health", (req, res) => {
  res.json({
    name: "TubeStream",
    version: "2.0.0",
    status: "ok",
    uptime: Math.round(process.uptime()),
    mongodb: isConnected(),
    cachedPages: Object.keys(feedCache.pages).length,
    cachedStreams: Object.keys(streamCache).length,
  });
});

/* ---------- Auto refresh (cron) — main feeds only, gentle paced load ---------- */
const REFRESH_CRON = process.env.REFRESH_CRON || "*/15 * * * *";
async function autoRefresh() {
  console.log("[Cron] Refreshing main feeds...");
  // Interleaved: page-1 of every feed first, then deeper pages (via priority queue)
  for (let p = 1; p <= 5; p++) {
    for (const feedKey of MAIN_FEED_KEYS) {
      ensurePageFresh(feedKey, p, p === 1 ? 0 : p);
    }
  }
}

module.exports = { parseCards, fetchPageHtml, parseInitialsJson, extractM3u8FromHtml };

/* ---------- Browser cleanup ---------- */
async function cleanupBrowser() {
  try {
    if (playwrightBrowser && playwrightBrowser.isConnected()) {
      await playwrightBrowser.close();
    }
  } catch (e) { /* ignore */ }
  playwrightBrowser = null;
  playwrightLaunchPromise = null;
}

process.on("exit", () => { /* sync cleanup — best effort */ });

/* ---------- Graceful shutdown ---------- */
function gracefulShutdown(signal) {
  console.log("[Shutdown] Received", signal + " — cleaning up...");
  flushCaches();
  cleanupBrowser().finally(() => process.exit(0));
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
// Log-and-continue guards — a stray async error must not kill the whole server
process.on("uncaughtException", (e) => console.error("[FATAL-uncaught]", e && (e.stack || e.message || e)));
process.on("unhandledRejection", (e) => console.error("[FATAL-unhandled]", e && (e.stack || e.message || e)));

function fullUrl(pageUrl) {
  if (!pageUrl) return null;
  return /^https?:\/\//.test(pageUrl) ? pageUrl : "https://xhamster.com" + pageUrl;
}

/* ---------- Startup: serve disk cache instantly, refresh stale pages gently ---------- */
async function startupSeed() {
  const cachedCount = Object.keys(feedCache.pages).filter(k => {
    const e = feedCache.pages[k];
    return e && e.cards && e.cards.length > 0;
  }).length;
  const staleCount = Object.keys(feedCache.pages).filter(k => {
    const e = feedCache.pages[k];
    return e && e.cards && e.cards.length > 0 && Date.now() - (e.ts || 0) >= CACHE_MS;
  }).length;
  console.log("[Seed] Serving", cachedCount, "cached pages from disk (" + staleCount + " stale — refreshing in background)");

  // Queue refresh of every stale main-feed page, page-1 first (paced, concurrency 2)
  for (let p = 1; p <= 5; p++) {
    for (const feedKey of MAIN_FEED_KEYS) {
      ensurePageFresh(feedKey, p, p === 1 ? (feedKey === "newest" ? 0 : 1) : 10 + p);
    }
  }

  // Zero-wait engine: keep the homepage's visible videos stream-warm at all times
  warmPoolWorker().catch((e) => console.warn("[WarmPool] Worker crashed:", e.message));

  // Startup category pre-warm: page-1 of the first 24 sidebar categories loads
  // in the background (tier-2) so the FIRST click on a category is instant too.
  // Bounded by the feedCache LRU cap — storage stays flat.
  setTimeout(async () => {
    const catKeys = Object.keys(CATEGORIES).filter((k) => !MAIN_FEED_KEYS.includes(k)).slice(0, 24);
    console.log("[PreWarm] Pre-fetching", catKeys.length, "category pages...");
    for (const ck of catKeys) {
      ensurePageFresh(ck, 1, 2);
      await sleep(250); // paced
    }
  }, 15000); // after main feeds are warm
}

/* ---------- Start server ---------- */
if (require.main === module) {
  (async () => {
    const dbConnected = await connectDB();
    app.listen(PORT, "0.0.0.0", async () => {
      console.log("TubeStream — http://localhost:" + PORT);
      console.log("API docs — http://localhost:" + PORT + "/api-docs");
      console.log("MongoDB:", dbConnected ? "connected" : "file cache only");
      if (cron.validate(REFRESH_CRON)) { cron.schedule(REFRESH_CRON, autoRefresh); console.log("[Cron] Scheduled refresh:", REFRESH_CRON); }
      // Auto-seed in background — don't block server startup
      startupSeed().catch(() => {});
    });
  })();
}

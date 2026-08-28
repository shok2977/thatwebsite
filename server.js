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
  if (now - (entry.ts || 0) >= STREAM_CACHE_MS) return false;
  if (entry.exp && now > entry.exp - STREAM_EXPIRY_MARGIN_MS) return false;
  // No stored exp — parse from URL as a safety net
  const exp = entry.exp || parseStreamExpiry(entry.m3u8Url);
  if (exp && now > exp - STREAM_EXPIRY_MARGIN_MS) return false;
  return true;
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
        // Keep only entries that are still fresh — drops expired-token URLs from disk
        if (v && v.m3u8Url && now - (v.ts || 0) < STREAM_CACHE_MS) { streamCache[k] = v; kept++; }
      }
      console.log("[StreamCache] Loaded", kept, "fresh of", Object.keys(loaded).length, "on disk");
    }
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
const { exec } = require("child_process");

function fetchViaRelayCurl(url, timeoutSec) {
  const timeout = timeoutSec || 8;
  // Quote header value for shell (spaces in "X-Respond-With: html")
  const cmd = `curl -s --max-time ${timeout} -H "X-Respond-With: html" "${url}"`;
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeout * 1000 + 2000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error("curl failed: " + (err.message || String(err))));
      resolve(stdout);
    });
  });
}

/* ---------- Direct fetch (fastest path, no relay round-trip) ---------- */
function shellEscapeSingleQuoted(s) {
  return String(s).replace(/'/g, `'\\''`);
}

function fetchDirectCurl(url, timeoutSec) {
  const timeout = timeoutSec || 7;
  const safeUrl = shellEscapeSingleQuoted(url);
  const cmd = `curl -s -L --compressed --max-time ${timeout} -H 'User-Agent: ${shellEscapeSingleQuoted(UA)}' -H 'Accept: text/html,application/xhtml+xml' -H 'Accept-Language: en-US,en;q=0.9' -H 'Referer: https://xhamster.com/' '${safeUrl}'`;
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeout * 1000 + 2000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error("direct curl failed: " + (err.message || String(err))));
      resolve(stdout);
    });
  });
}

function isValidPageHtml(html) {
  return typeof html === "string" && html.length > 5000 && html.includes("window.initials");
}

async function fetchViaRelayUrl(fullUrl) {
  const relayUrl = RELAY_BASE + fullUrl;
  let lastErr;
  // Try relay via curl (avoids TLS fingerprinting)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fetchViaRelayCurl(relayUrl, 8);
      if (isValidPageHtml(html)) return html;
      lastErr = new Error("relay returned no valid content (" + (html ? html.length : 0) + " bytes)");
    } catch (e) { lastErr = e; }
    if (attempt < 1) await new Promise((r) => setTimeout(r, 1500));
  }
  // Relay failed — try Playwright fallback (with overall timeout)
  if (chromium) {
    try {
      console.log("[Playwright] Relay failed (" + (lastErr ? lastErr.message : "unknown") + ") — trying browser scrape of direct URL...");
      const pwPromise = scrapeViaPlaywright(fullUrl);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Playwright timeout")), 40000));
      const html = await Promise.race([pwPromise, timeoutPromise]);
      if (html && html.includes("window.initials")) return html;
      console.warn("[Playwright] No window.initials found in scraped page");
    } catch (pwErr) {
      console.warn("[Playwright] Scrape failed:", pwErr.message);
    }
  }
  throw lastErr || new Error("relay fetch failed");
}

/* ---------- Race fetch: direct-first + relay in parallel, first valid wins ---------- */
async function fetchPageHtml(url) {
  // Promise.race where only VALID html resolves; first valid wins, loser ignored
  const tryDirect = (async () => {
    const html = await fetchDirectCurl(url, 7);
    if (!isValidPageHtml(html)) throw new Error("direct: no initials");
    return html;
  })();
  const tryRelay = (async () => {
    // small head start for direct (usually much faster); relay starts right after
    const html = await fetchViaRelayUrl(url);
    if (!isValidPageHtml(html)) throw new Error("relay: no initials");
    return html;
  })();
  try {
    return await Promise.race([tryDirect, tryRelay]);
  } catch (e) {
    // Both rejected — see if the other one eventually made it
    const results = await Promise.allSettled([tryDirect, tryRelay]);
    for (const r of results) if (r.status === "fulfilled") return r.value;
    throw new Error("all fetch strategies failed: " + (e.message || e));
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
  const obj = parseInitialsJson(html);
  if (obj) {
    const ps = obj.xplayerSettings || {};
    const vm = obj.videoModel || {};
    if (ps.sources && ps.sources.hls) {
      if (ps.sources.hls.url) return ps.sources.hls.url;
      if (ps.sources.hls.fallback) return ps.sources.hls.fallback;
    }
    if (vm.hlsUrl) return vm.hlsUrl;
    if (vm.videoUrl) return vm.videoUrl;
    if (Array.isArray(vm.sources)) {
      for (const s of vm.sources) { if (s.url && /\.m3u8/i.test(s.url)) return s.url; }
    }
  }
  const patterns = [/\"(https?:\/\/[^\"]*\.m3u8[^\"]*)\"/gi];
  for (const pat of patterns) { const m = pat.exec(html); if (m && m[1]) return m[1]; }
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

async function fetchVideoPageForStream(pageUrl) {
  const full = /^https?:\/\//.test(pageUrl) ? pageUrl : "https://xhamster.com" + pageUrl;
  try {
    // Direct-first race — usually resolves in well under 2s
    const html = await fetchPageHtml(full);
    return extractM3u8FromHtml(html);
  } catch (e) {
    throw new Error("Could not fetch video page: " + e.message);
  }
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
    const html = await fetchPageHtml(catUrl);
    const cards = parseCards(html);
    if (cards.length > 0) {
      feedCache.pages[cacheKey] = { ts: Date.now(), cards };
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
const REFRESH_CONCURRENCY = 2;

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
  const catUrl = CATEGORIES[catKey] || CATEGORIES.newest;
  if (!catUrl) return;
  const cacheKey = catKey + ":" + page;
  const entry = feedCache.pages[cacheKey];
  const missing = !entry || !entry.cards || entry.cards.length === 0;
  const stale = !missing && (Date.now() - (entry.ts || 0) >= CACHE_MS);
  if (missing || stale) {
    const pUrl = page <= 1 ? catUrl : catUrl + "/" + page;
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

// GET /api/videos — NEVER blocks on network, returns cache immediately
app.get("/api/videos", (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const catKey = (req.query.category || "all").toLowerCase();
    const PAGE_SIZE = 36;

    // Handle "all" category — mixed + DEDUPED + RANDOM pool, different on every request
    if (catKey === "all" || !CATEGORIES[catKey]) {
      const pool = getMixedVideos();
      const shuffled = pool.length > 0 ? shuffleArray(pool) : [];
      const start = (page - 1) * PAGE_SIZE;
      const cards = shuffled.slice(start, start + PAGE_SIZE);
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
        videos: enrichCardsWithStreams(cards),
        cached: true,
        fetching: backgroundFetches.size > 0 || refreshQueue.length > 0,
      });
    }

    // Normal category — natural source order (Newest stays newest, etc.)
    const catUrl = CATEGORIES[catKey];
    const cacheKey = catKey + ":" + page;
    const pageEntry = feedCache.pages[cacheKey];
    const hasCache = pageEntry && pageEntry.cards && pageEntry.cards.length > 0;
    const fresh = hasCache && (Date.now() - pageEntry.ts < CACHE_MS);

    const cards = (pageEntry && pageEntry.cards) || [];
    res.json({
      success: true,
      page,
      category: catKey,
      count: cards.length,
      videos: enrichCardsWithStreams(cards),
      cached: !!fresh,
      fetching: backgroundFetches.has(cacheKey) || refreshQueue.some((j) => j.cacheKey === cacheKey),
    });

    // Refresh stale/missing pages gently (paced queue), current + next pages
    ensurePageFresh(catKey, page, page <= 1 ? 0 : 5);
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
  return fetchPageHtml(url);
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
        return res.json({ success: true, m3u8Url: cached.m3u8Url, cached: true });
      }
    }

    // Dedupe: if the same URL is already being resolved, wait for that result
    let resolvePromise = streamResolving.get(videoUrl);
    if (forceRefresh || !resolvePromise) {
      resolvePromise = fetchVideoPageForStream(videoUrl)
        .then((m3u8Url) => {
          if (!m3u8Url) throw new Error("No m3u8 stream found");
          cacheStream(videoUrl, m3u8Url); // latest URL always replaces the old one
          saveStreamCache();
          return m3u8Url;
        })
        .finally(() => streamResolving.delete(videoUrl));
      streamResolving.set(videoUrl, resolvePromise);
    }

    const m3u8Url = await resolvePromise;
    res.json({ success: true, m3u8Url, cached: false });
  } catch (e) { res.status(502).json({ success: false, error: String(e.message || e) }); }
});

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

const ALLOWED_HOST = /^https:\/\/([\w-]+\.)*(xhcdn|phncdn|xhamster)\.com\//;

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
  maxAge: "1h", etag: true, lastModified: true
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

module.exports = { parseCards, fetchViaRelayUrl, parseInitialsJson, extractM3u8FromHtml };

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

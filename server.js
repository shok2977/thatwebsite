require("dotenv").config();
const express = require("express");
const compression = require("compression");
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
const STREAM_CACHE_MAX = Number(process.env.STREAM_CACHE_MAX) || 200;
const SEARCH_CACHE_MS = Number(process.env.SEARCH_CACHE_TTL_MS) || 5 * 60 * 1000;
const SEARCH_CACHE_MAX = Number(process.env.SEARCH_CACHE_MAX) || 50;

// Track which categories are currently being fetched in background
const backgroundFetches = new Set();

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
      streamCache = JSON.parse(fs.readFileSync(STREAM_CACHE_FILE, "utf8"));
    }
  } catch (e) { /* ignore */ }
}
loadCachesFromDisk();

function saveFeedCache() { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(feedCache)); } catch (e) {} }
function saveStreamCache() { try { fs.writeFileSync(STREAM_CACHE_FILE, JSON.stringify(streamCache)); } catch (e) {} }

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

async function fetchViaRelayUrl(fullUrl) {
  const relayUrl = RELAY_BASE + fullUrl;
  let lastErr;
  // Try relay via curl (avoids TLS fingerprinting)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fetchViaRelayCurl(relayUrl, 8);
      if (html && html.length > 5000 && html.includes("window.initials")) return html;
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
  const fullUrl = /^https?:\/\//.test(pageUrl) ? pageUrl : "https://xhamster.com" + pageUrl;
  try {
    const html = await fetchViaRelayUrl(fullUrl);
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
function enrichCardsWithStreams(cards) {
  return cards.map(card => {
    const videoUrl = card.pageUrl ? (fullUrl(card.pageUrl) || card.pageUrl) : null;
    if (videoUrl && streamCache[videoUrl] && streamCache[videoUrl].m3u8Url) {
      return { ...card, stream: streamCache[videoUrl].m3u8Url };
    }
    return card;
  });
}

/* ============================================================ */
/*             AUTO-FETCH STREAMS FOR CARDS                     */
/* ============================================================ */
const autoStreamFetching = new Set();
async function autoFetchStreamsForCards(cards) {
  const urls = cards
    .map(c => c.pageUrl ? (fullUrl(c.pageUrl) || c.pageUrl) : null)
    .filter(u => u && !streamCache[u] && !autoStreamFetching.has(u));
  if (urls.length === 0) return;
  if (autoStreamFetching.size > 3) return; // limit concurrent batches
  urls.forEach(u => autoStreamFetching.add(u));
  console.log("[AutoStream] Fetching streams for", urls.length, "videos...");
  const CONCURRENCY = 5; // low concurrency to avoid blocking event loop
  let done = 0;
  const allBatches = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    allBatches.push(urls.slice(i, i + CONCURRENCY));
  }
  for (const batch of allBatches) {
    await Promise.allSettled(batch.map(async (url) => {
      try {
        const html = await fetchViaRelayUrl(url);
        const m3u8 = extractM3u8FromHtml(html);
        if (m3u8) {
          streamCache[url] = { ts: Date.now(), m3u8Url: m3u8 };
          done++;
        }
      } catch (e) { /* skip */ }
    }));
    saveStreamCache();
    // Small delay between batches to keep event loop responsive
    await new Promise(r => setTimeout(r, 200));
  }
  urls.forEach(u => autoStreamFetching.delete(u));
  saveStreamCache();
  console.log("[AutoStream] Done:", done + "/" + urls.length, "streams cached");
}

/* ============================================================ */
/*                     BACKGROUND FETCH                          */
/* ============================================================ */
async function backgroundFetchCategory(cacheKey, catUrl) {
  if (backgroundFetches.has(cacheKey)) return;
  backgroundFetches.add(cacheKey);
  try {
    console.log("[Background] Fetching", cacheKey, "...");
    const html = await fetchViaRelayUrl(catUrl);
    const cards = parseCards(html);
    feedCache.pages[cacheKey] = { ts: Date.now(), cards };
    saveFeedCache();
    console.log("[Background]", cacheKey + ":", cards.length, "videos loaded");
    // AUTO-FETCH streams for all newly loaded cards (fire-and-forget)
    autoFetchStreamsForCards(cards).catch(() => {});
  } catch (e) {
    console.warn("[Background] Failed:", cacheKey, e.message);
  } finally {
    backgroundFetches.delete(cacheKey);
  }
}

/* ============================================================ */
/*                          API ROUTES                           */
/* ============================================================ */

// Helper: get mixed videos from main feeds for the "all" homepage
const MAIN_FEED_KEYS = ["newest", "popular", "top", "hd", "longest", "hot"];
function getMixedVideos(page) {
  const allCards = [];
  for (const catKey of MAIN_FEED_KEYS) {
    const cacheKey = catKey + ":" + page;
    const entry = feedCache.pages[cacheKey];
    if (entry && entry.cards) allCards.push(...entry.cards);
  }
  return allCards;
}

// GET /api/videos — NEVER blocks on relay, returns cache immediately
app.get("/api/videos", (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const catKey = (req.query.category || "newest").toLowerCase();
    const catUrl = CATEGORIES[catKey] || CATEGORIES.newest;

    // Handle "all" category — mix from main feeds only
    if (catKey === "all") {
      const cards = getMixedVideos(page);
      // Background-fetch missing pages for main feeds
      for (const ck of MAIN_FEED_KEYS) {
        for (let p = page; p <= page + 1; p++) {
          const cacheKey = ck + ":" + p;
          const entry = feedCache.pages[cacheKey];
          if ((!entry || !entry.cards || entry.cards.length === 0) && !backgroundFetches.has(cacheKey)) {
            const pUrl = p <= 1 ? CATEGORIES[ck] : CATEGORIES[ck] + "/" + p;
            backgroundFetchCategory(cacheKey, pUrl).catch(() => {});
          }
        }
      }
      // AUTO-FETCH streams for all mixed cards (fire-and-forget)
      if (cards.length > 0) autoFetchStreamsForCards(cards).catch(() => {});
      return res.json({
        success: true,
        page,
        category: "all",
        count: cards.length,
        totalPages: Object.keys(feedCache.pages).length,
        videos: enrichCardsWithStreams(cards),
        cached: true,
        fetching: backgroundFetches.size > 0,
      });
    }

    // Normal category
    const cacheKey = catKey + ":" + page;
    const pageEntry = feedCache.pages[cacheKey];
    const hasCache = pageEntry && pageEntry.cards && pageEntry.cards.length > 0;
    const fresh = hasCache && (Date.now() - pageEntry.ts < CACHE_MS);

    // Return whatever we have immediately
    const cards = (pageEntry && pageEntry.cards) || [];
    res.json({
      success: true,
      page,
      category: catKey,
      count: cards.length,
      totalPages: Object.keys(feedCache.pages).length,
      videos: enrichCardsWithStreams(cards),
      cached: !!fresh,
      fetching: backgroundFetches.has(catKey),
    });

    // AUTO-FETCH streams for cards without cached streams (fire-and-forget)
    if (cards.length > 0) autoFetchStreamsForCards(cards).catch(() => {});

    // Trigger background fetch if cache is missing/stale — ANY page, not just page 1
    if (!fresh && !backgroundFetches.has(cacheKey)) {
      const pUrl = page <= 1 ? catUrl : catUrl + "/" + page;
      backgroundFetchCategory(cacheKey, pUrl).catch(() => {});
    }
    // Pre-fetch next 5 pages for paginated view
    for (let np = page + 1; np <= page + 5; np++) {
      const nextKey = catKey + ":" + np;
      const nextEntry = feedCache.pages[nextKey];
      if ((!nextEntry || !nextEntry.cards || nextEntry.cards.length === 0) && !backgroundFetches.has(nextKey)) {
        const npUrl = catUrl + "/" + np;
        backgroundFetchCategory(nextKey, npUrl).catch(() => {});
      }
    }
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

app.get("/api/categories", (req, res) => res.json({ success: true, categories: Object.keys(CATEGORIES) }));

// Bulk stream map — returns all cached m3u8 URLs so frontend can play instantly
app.get("/api/stream-map", (req, res) => {
  const map = {};
  for (const [url, entry] of Object.entries(streamCache)) {
    if (entry.m3u8Url) map[url] = entry.m3u8Url;
  }
  res.json({ success: true, count: Object.keys(map).length, streams: map });
});

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
      const cacheKey = catKey + ":" + p;
      const entry = feedCache.pages[cacheKey];
      if (entry && entry.cards) allVideos.push(...entry.cards);
    }
    res.json({ success: true, from, to, category: catKey, count: allVideos.length, videos: allVideos });
    // Trigger background fetch for missing pages
    const catUrl = CATEGORIES[catKey] || CATEGORIES.newest;
    for (let p = from; p <= to; p++) {
      const cacheKey = catKey + ":" + p;
      const entry = feedCache.pages[cacheKey];
      if (!entry || !entry.cards || entry.cards.length === 0) {
        const pUrl = p <= 1 ? catUrl : catUrl + "/" + p;
        backgroundFetchCategory(cacheKey, pUrl).catch(() => {});
      }
    }
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

app.post("/api/batch-pages", rateLimit(60 * 1000, 20), async (req, res) => {
  try {
    const { category, from, to } = req.body;
    if (!category) return res.status(400).json({ error: "category required" });
    const catKey = category.toLowerCase();
    const catUrl = CATEGORIES[catKey] || CATEGORIES.newest;
    const start = Math.max(1, from || 1);
    const end = Math.min(start + 9, to || start + 4); // max 10 pages
    const allVideos = [];
    const missingPages = [];

    for (let p = start; p <= end; p++) {
      const cacheKey = catKey + ":" + p;
      const entry = feedCache.pages[cacheKey];
      if (entry && entry.cards && entry.cards.length > 0) {
        allVideos.push(...entry.cards);
      } else {
        missingPages.push(p);
      }
    }

    // Return cached immediately
    res.json({ success: true, category: catKey, from: start, to: end, count: allVideos.length, videos: allVideos, missingPages });

    // Background-fetch all missing pages in parallel
    for (const p of missingPages) {
      const cacheKey = catKey + ":" + p;
      if (!backgroundFetches.has(cacheKey)) {
        const pUrl = p <= 1 ? catUrl : catUrl + "/" + p;
        backgroundFetchCategory(cacheKey, pUrl).catch(() => {});
      }
    }
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

app.post("/api/prefetch", rateLimit(60 * 1000, 30), async (req, res) => {
  try {
    const urls = req.body.urls;
    if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: "urls array required" });
    const batch = urls.slice(0, 50);
    const results = {};
    const CONCURRENCY = 10;
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (videoUrl) => {
        const cached = streamCache[videoUrl];
        if (cached && (Date.now() - cached.ts < STREAM_CACHE_MS)) { results[videoUrl] = { m3u8Url: cached.m3u8Url, cached: true }; return; }
        try {
          const m3u8Url = await fetchVideoPageForStream(videoUrl);
          if (m3u8Url) {
            results[videoUrl] = { m3u8Url, cached: false };
            const keys = Object.keys(streamCache);
            if (keys.length >= STREAM_CACHE_MAX) { const sorted = keys.sort((a, b) => (streamCache[a].ts || 0) - (streamCache[b].ts || 0)); for (let j = 0; j < Math.ceil(STREAM_CACHE_MAX / 4); j++) delete streamCache[sorted[j]]; }
            streamCache[videoUrl] = { ts: Date.now(), m3u8Url };
          } else { results[videoUrl] = { m3u8Url: null, error: "No m3u8 found" }; }
        } catch (e) { results[videoUrl] = { m3u8Url: null, error: e.message }; }
      }));
      if (i + CONCURRENCY < batch.length) await new Promise((r) => setTimeout(r, 400));
    }
    saveStreamCache();
    res.json({ success: true, results });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

async function fetchSearchViaRelay(keyword, pageNum) {
  const url = "https://xhamster.com/search/" + encodeURIComponent(keyword) + "/" + pageNum;
  return fetchViaRelayUrl(url);
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

    // Return whatever we have immediately, enriched with cached streams
    const cards = ((pageEntry && pageEntry.cards) || []).map(card => {
      const videoUrl = card.pageUrl ? (fullUrl(card.pageUrl) || card.pageUrl) : null;
      if (videoUrl && streamCache[videoUrl] && streamCache[videoUrl].m3u8Url) {
        return { ...card, stream: streamCache[videoUrl].m3u8Url };
      }
      return card;
    });
    res.json({ success: true, keyword, page, count: cards.length, videos: cards, cached: !!fresh });

    // Background fetch if stale
    if (!fresh) {
      try {
        const html = await fetchSearchViaRelay(keyword, page);
        const newCards = parseCards(html);
        cache.pages[page] = { ts: Date.now(), cards: newCards };
        evictSearchCache();
        // Auto-fetch streams for search results
        autoFetchStreamsForCards(newCards).catch(() => {});
      } catch (e) {
        console.warn("[Search] Fetch failed:", e.message);
      }
    }
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

app.get("/api/refresh", rateLimit(60 * 1000, 5), async (req, res) => {
  const catKey = (req.query.category || "all").toLowerCase();
  try {
    if (catKey === "all") {
      // Refresh categories in parallel batches of 6
      const results = {};
      const REFRESH_CONCURRENCY = 6;
      for (let i = 0; i < CATEGORY_KEYS.length; i += REFRESH_CONCURRENCY) {
        const batch = CATEGORY_KEYS.slice(i, i + REFRESH_CONCURRENCY);
        await Promise.allSettled(batch.map(async (ck) => {
          const catUrl = CATEGORIES[ck];
          try {
            const html = await fetchViaRelayUrl(catUrl);
            const cards = parseCards(html);
            feedCache.pages[ck + ":1"] = { ts: Date.now(), cards };
            results[ck] = cards.length;
            console.log("[Refresh]", ck + ":", cards.length, "videos");
          } catch (e) {
            results[ck] = 0;
            console.warn("[Refresh] Failed:", ck, e.message);
          }
        }));
      }
      saveFeedCache();
      return res.json({ success: true, results });
    }
    // Single category refresh
    const catUrl = CATEGORIES[catKey] || CATEGORIES.newest;
    const html = await fetchViaRelayUrl(catUrl);
    const cards = parseCards(html);
    feedCache.pages[catKey + ":1"] = { ts: Date.now(), cards };
    saveFeedCache();
    res.json({ success: true, category: catKey, count: cards.length });
  } catch (e) { res.status(502).json({ success: false, error: String(e.message || e) }); }
});

// Pre-buffer: fetch first HLS segment and cache the m3u8 + first .ts file
app.get("/api/prebuffer", async (req, res) => {
  try {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: "url parameter required" });
    // Check if we already have this stream cached
    const cached = streamCache[videoUrl];
    if (cached && cached.m3u8Url && (Date.now() - cached.ts < STREAM_CACHE_MS)) {
      return res.json({ success: true, m3u8Url: cached.m3u8Url, prebuffered: true, cached: true });
    }
    // Fetch the video page and extract m3u8
    const m3u8Url = await fetchVideoPageForStream(videoUrl);
    if (!m3u8Url) return res.json({ success: false, error: "No m3u8 found" });
    // Cache it
    const keys = Object.keys(streamCache);
    if (keys.length >= STREAM_CACHE_MAX) {
      const sorted = keys.sort((a, b) => (streamCache[a].ts || 0) - (streamCache[b].ts || 0));
      for (let i = 0; i < Math.ceil(STREAM_CACHE_MAX / 4); i++) delete streamCache[sorted[i]];
    }
    streamCache[videoUrl] = { ts: Date.now(), m3u8Url };
    saveStreamCache();
    // Pre-fetch the first .ts segment in background (fire-and-forget)
    prebufferSegment(m3u8Url).catch(() => {});
    res.json({ success: true, m3u8Url, prebuffered: true, cached: false });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

// Pre-fetch first HLS segment for instant playback
async function prebufferSegment(m3u8Url) {
  try {
    const proxied = "/api/stream?url=" + encodeURIComponent(m3u8Url);
    const upstream = await fetch(proxied, { headers: { Accept: "*/*" }, redirect: "follow" });
    if (!upstream.ok) return;
    const body = await upstream.text();
    // Extract first segment URL from playlist
    const lines = body.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!line.startsWith("#") && (line.endsWith(".ts") || line.includes(".ts?"))) {
        // Pre-fetch first .ts segment — this makes playback instant
        const segUrl = line.startsWith("http") ? line : new URL(line, m3u8Url).href;
        const proxiedSeg = "/api/stream?url=" + encodeURIComponent(segUrl);
        fetch(proxiedSeg, { headers: { Range: "bytes=0-1048575" } }).catch(() => {}); // 1MB prebuffer
        break;
      }
    }
  } catch (e) { /* ignore */ }
}

app.get("/api/stream-url", async (req, res) => {
  try {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: "url parameter required" });
    const cached = streamCache[videoUrl];
    if (cached && (Date.now() - cached.ts < STREAM_CACHE_MS)) return res.json({ success: true, m3u8Url: cached.m3u8Url, cached: true });
    const m3u8Url = await fetchVideoPageForStream(videoUrl);
    if (!m3u8Url) return res.json({ success: false, error: "No m3u8 stream found" });
    const keys = Object.keys(streamCache);
    if (keys.length >= STREAM_CACHE_MAX) { const sorted = keys.sort((a, b) => (streamCache[a].ts || 0) - (streamCache[b].ts || 0)); for (let i = 0; i < Math.ceil(STREAM_CACHE_MAX / 4); i++) delete streamCache[sorted[i]]; }
    streamCache[videoUrl] = { ts: Date.now(), m3u8Url };
    saveStreamCache();
    res.json({ success: true, m3u8Url, cached: false });
  } catch (e) { res.status(500).json({ success: false, error: String(e.message || e) }); }
});

/* ---------- Thumbnail proxy (fixes CORS/network in Electron) ---------- */
const THUMB_HOST = /^https:\/\/([\w-]+\.)*xhcdn\.com\//;
app.get("/api/thumb", async (req, res) => {
  const url = req.query.url;
  if (!url || !THUMB_HOST.test(url)) return res.status(400).json({ error: "invalid thumb url" });
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://xhamster.com/" },
      redirect: "follow",
    });
    if (!upstream.ok) return res.status(502).json({ error: "upstream " + upstream.status });
    const ctype = upstream.headers.get("content-type") || "image/webp";
    res.set("Content-Type", ctype);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Access-Control-Allow-Origin", "*");
    const cl = upstream.headers.get("content-length");
    if (cl) res.set("Content-Length", cl);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

const ALLOWED_HOST = /^https:\/\/([\w-]+\.)*(xhcdn|phncdn|xhamster)\.com\//;
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
    const isPlaylist = /mpegurl|m3u8/i.test(ctype) || /\.m3u8($|\?)/.test(url);
    if (isPlaylist) {
      const body = await upstream.text();
      return res.send(body.split("\n").map((line) => { const t = line.trim(); if (!t || t.startsWith("#")) return line; try { return "/api/stream?url=" + encodeURIComponent(new URL(t, url).href); } catch (e) { return line; } }).join("\n"));
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

/* ---------- Auto refresh (cron) ---------- */
const REFRESH_CRON = process.env.REFRESH_CRON || "*/30 * * * *";
async function autoRefresh() {
  console.log("[Cron] Auto-refreshing feed...");
  const CRON_CONCURRENCY = 8;
  for (let i = 0; i < Object.entries(CATEGORIES).length; i += CRON_CONCURRENCY) {
    const batch = Object.entries(CATEGORIES).slice(i, i + CRON_CONCURRENCY);
    await Promise.allSettled(batch.map(async ([catKey, catUrl]) => {
      try {
        const html = await fetchViaRelayUrl(catUrl);
        const cards = parseCards(html);
        feedCache.pages[catKey + ":1"] = { ts: Date.now(), cards };
        console.log("[Cron]", catKey + ":", cards.length, "videos");
      } catch (e) { console.warn("[Cron] Failed:", catKey, e.message); }
    }));
  }
  saveFeedCache();
  console.log("[Cron] Feed refreshed");
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
  saveFeedCache();
  saveStreamCache();
  cleanupBrowser().finally(() => process.exit(0));
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

/* ---------- Startup auto-seed + pre-seed streams ---------- */
async function preseedStreams(maxVideos) {
  // Pre-seed streams for ALL main feed pages (5 pages for paginated view)
  const allVideoUrls = [];
  const MAX = maxVideos || 500;
  const mainFeeds = ["newest", "popular", "top", "hd", "longest", "hot"];
  for (const feedKey of mainFeeds) {
    for (let p = 1; p <= 5; p++) {
      const cacheKey = feedKey + ":" + p;
      const entry = feedCache.pages[cacheKey];
      if (!entry || !entry.cards) continue;
      for (const card of entry.cards) {
        if (allVideoUrls.length >= MAX) break;
        const videoUrl = card.pageUrl ? (fullUrl(card.pageUrl) || card.pageUrl) : null;
        if (videoUrl && !streamCache[videoUrl]) {
          allVideoUrls.push(videoUrl);
        }
      }
      if (allVideoUrls.length >= MAX) break;
    }
    if (allVideoUrls.length >= MAX) break;
  }
  if (allVideoUrls.length === 0) {
    console.log("[Preseed] All streams already cached — nothing to do");
    return;
  }
  console.log("[Preseed] Pre-seeding streams for", allVideoUrls.length, "videos (max", MAX, ")...");
  let done = 0;
  const BATCH = 5; // small batches to keep event loop responsive
  for (let i = 0; i < allVideoUrls.length; i += BATCH) {
    const batch = allVideoUrls.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async (url) => {
      try {
        const html = await fetchViaRelayUrl(url);
        const m3u8 = extractM3u8FromHtml(html);
        if (m3u8) {
          streamCache[url] = { ts: Date.now(), m3u8Url: m3u8 };
          done++;
        }
      } catch (e) { /* skip */ }
    }));
    saveStreamCache();
    await new Promise(r => setTimeout(r, 300));
  }
  saveStreamCache();
  console.log("[Preseed] Pre-seeded", done, "of", allVideoUrls.length, "streams");
}

function fullUrl(pageUrl) {
  if (!pageUrl) return null;
  return /^https?:\/\//.test(pageUrl) ? pageUrl : "https://xhamster.com" + pageUrl;
}

async function startupSeed() {
  // DON'T AWAIT — everything runs as background tasks
  // Server already has feed-cache.json + stream-cache.json loaded from disk
  const cachedCount = Object.keys(feedCache.pages).filter(k => {
    const e = feedCache.pages[k];
    return e && e.cards && e.cards.length > 0;
  }).length;
  console.log("[Seed] Serving", cachedCount, "cached pages from disk — videos available immediately");

  // Background: fetch ONLY missing pages for main feeds (fire-and-forget)
  const mainFeeds = ["newest", "popular", "top", "hd", "longest", "hot"];
  for (const feedKey of mainFeeds) {
    for (let p = 1; p <= 5; p++) {
      const cacheKey = feedKey + ":" + p;
      const entry = feedCache.pages[cacheKey];
      if (!entry || !entry.cards || entry.cards.length === 0) {
        const url = p <= 1 ? CATEGORIES[feedKey] : CATEGORIES[feedKey] + "/" + p;
        backgroundFetchCategory(cacheKey, url).catch(() => {});
      }
    }
  }

  // Background: pre-seed streams (fire-and-forget, limited concurrency)
  preseedStreams().catch(() => {});
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

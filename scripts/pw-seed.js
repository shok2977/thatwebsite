#!/usr/bin/env node
/**
 * Playwright seed script — directly scrapes xhamster.com with a real browser
 * that solves Cloudflare challenges. No relay needed.
 *
 * Usage: node scripts/pw-seed.js [category]
 *   category: newest (default), popular, top, hd, longest, hot, or "all"
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const CACHE_FILE = path.join(__dirname, "..", "feed-cache.json");

const CATEGORIES = {
  newest:  "https://xhamster.com/newest",
  popular: "https://xhamster.com/best/weekly",
  top:     "https://xhamster.com/best/monthly",
  hd:      "https://xhamster.com/best/year",
  longest: "https://xhamster.com/best/longest",
  hot:     "https://xhamster.com/best/today",
};

function formatDuration(seconds) {
  if (!seconds || typeof seconds !== "number") return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}

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
    if (c === 92 && inStr) { esc = true; continue; }
    if (c === 34) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === 123) depth++;
    if (c === 125) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(html.substring(jsonStart, end + 1)); } catch (e) { return null; }
}

function parseCards(html) {
  const cards = [];
  // Try window.initials JSON first
  const obj = parseInitialsJson(html);
  if (obj && obj.layoutPage && obj.layoutPage.videoListProps && obj.layoutPage.videoListProps.videoThumbProps) {
    const vp = obj.layoutPage.videoListProps.videoThumbProps;
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
  // Fallback: HTML parsing for data-previewvideo
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

(async () => {
  const targetCat = (process.argv[2] || "all").toLowerCase();
  const cats = targetCat === "all" ? CATEGORIES : { [targetCat]: CATEGORIES[targetCat] };
  if (!cats[targetCat] && targetCat !== "all") {
    console.error("Unknown category:", targetCat, ". Available:", Object.keys(CATEGORIES).join(", "));
    process.exit(1);
  }

  let feedCache = { pages: {} };
  try {
    if (fs.existsSync(CACHE_FILE)) {
      feedCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (!feedCache.pages) feedCache.pages = {};
    }
  } catch (e) {}

  console.log("Launching headless Chromium...");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ userAgent: UA });

  let totalVideos = 0;
  let totalErrors = 0;

  for (const [catKey, catUrl] of Object.entries(cats)) {
    const cacheKey = catKey + ":1";
    if (feedCache.pages[cacheKey] && feedCache.pages[cacheKey].cards && feedCache.pages[cacheKey].cards.length > 0) {
      console.log("SKIP", catKey, "— already cached:", feedCache.pages[cacheKey].cards.length, "videos");
      totalVideos += feedCache.pages[cacheKey].cards.length;
      continue;
    }

    console.log("\n--- Fetching", catKey, ":", catUrl, "---");
    const page = await context.newPage();
    try {
      console.log("[PW] Navigating to", catUrl);
      await page.goto(catUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Wait for Cloudflare challenge to resolve
      console.log("[PW] Waiting for Cloudflare challenge...");
      try {
        await page.waitForFunction(
          () => !document.title.includes("Just a moment") && !document.title.includes("Checking") && !document.title.includes("attention"),
          { timeout: 20000 }
        );
        console.log("[PW] Cloudflare challenge resolved");
      } catch (e) {
        console.log("[PW] No Cloudflare challenge or timeout:", e.message);
      }

      // Wait for video content (window.initials OR data-previewvideo)
      console.log("[PW] Waiting for video content...");
      let foundInitials = false;
      try {
        await page.waitForFunction(
          () => document.documentElement.innerHTML.includes("window.initials"),
          { timeout: 20000, polling: 500 }
        );
        foundInitials = true;
        console.log("[PW] Found window.initials");
      } catch (e) {
        console.log("[PW] No window.initials found, trying data-previewvideo...");
        try {
          await page.waitForFunction(
            () => document.documentElement.innerHTML.includes("data-previewvideo"),
            { timeout: 10000, polling: 500 }
          );
          console.log("[PW] Found data-previewvideo");
        } catch (e2) {
          console.log("[PW] No video content found at all");
        }
      }

      await page.waitForTimeout(1000);
      const html = await page.content();
      console.log("[PW] Page size:", html.length, "bytes | title:", await page.title());

      const cards = parseCards(html);
      if (cards.length > 0) {
        feedCache.pages[cacheKey] = { ts: Date.now(), cards };
        totalVideos += cards.length;
        console.log("[OK]", catKey, ":", cards.length, "videos extracted");
        // Log first video title as sanity check
        console.log("[Sample]", cards[0].title, "| thumb:", cards[0].thumb ? "YES" : "NO", "| duration:", cards[0].duration);
      } else {
        totalErrors++;
        console.log("[FAIL]", catKey, ":", html.length, "bytes but 0 cards parsed");
        // Save the HTML for debugging
        const debugFile = path.join(__dirname, "..", "debug-" + catKey + ".html");
        fs.writeFileSync(debugFile, html);
        console.log("[Debug] Saved HTML to", debugFile);
      }
    } catch (e) {
      totalErrors++;
      console.log("[ERROR]", catKey, ":", e.message);
    } finally {
      await page.close().catch(() => {});
    }

    // Wait between categories to be polite
    if (Object.keys(cats).indexOf(catKey) < Object.keys(cats).length - 1) {
      console.log("[PW] Waiting 3s before next category...");
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  await browser.close();

  // Save cache
  fs.writeFileSync(CACHE_FILE, JSON.stringify(feedCache));
  console.log("\n========== SUMMARY ==========");
  console.log("Total videos:", totalVideos);
  console.log("Pages cached:", Object.keys(feedCache.pages).length);
  console.log("Errors:", totalErrors);
  console.log("Cache file:", CACHE_FILE);
  console.log("============================");
})();

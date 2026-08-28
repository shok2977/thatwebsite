#!/usr/bin/env node
/**
 * Seed script — uses curl via Jina relay to populate feed-cache.json.
 * Key insight: do NOT send X-No-Cache header (triggers Cloudflare).
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const CATEGORIES = {
  newest:  "https://xhamster.com/newest",
  popular: "https://xhamster.com/best/weekly",
  top:     "https://xhamster.com/best/monthly",
  hd:      "https://xhamster.com/best/year",
  longest: "https://xhamster.com/best/longest",
  hot:     "https://xhamster.com/best/today",
};
const RELAY_BASE = "https://r.jina.ai/";
const CACHE_FILE = path.join(__dirname, "..", "feed-cache.json");

function formatDuration(s) {
  if (!s || typeof s !== "number") return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0") : m + ":" + String(ss).padStart(2, "0");
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
  const obj = parseInitialsJson(html);
  if (obj) {
    // Try multiple JSON paths for videoThumbProps
    let vp = null;
    if (obj.layoutPage && obj.layoutPage.videoListProps && obj.layoutPage.videoListProps.videoThumbProps) {
      vp = obj.layoutPage.videoListProps.videoThumbProps;
    } else if (obj.popularVideoListComponent && obj.popularVideoListComponent.videoThumbProps) {
      vp = obj.popularVideoListComponent.videoThumbProps;
    }
    // Recursive search as final fallback
    if (!vp && typeof obj === "object") {
      function findVTP(node, depth) {
        if (!node || depth > 5) return null;
        if (Array.isArray(node.videoThumbProps)) return node.videoThumbProps;
        for (const key of Object.keys(node)) {
          if (typeof node[key] === "object" && node[key] !== null) {
            const found = findVTP(node[key], depth + 1);
            if (found) return found;
          }
        }
        return null;
      }
      vp = findVTP(obj, 0);
    }
    if (Array.isArray(vp)) {
      for (const v of vp) {
        const p = v.pageURL || "";
        if (!p) continue;
        cards.push({
          id: String(v.id || ""),
          title: (v.title || "").replace(/&amp;/g, "&").trim(),
          pageUrl: p,
          preview: "",
          fallback: "",
          stream: "",
          thumb: v.thumbURL || v.imageURL || "",
          duration: formatDuration(v.duration),
        });
      }
    }
  }
  return cards;
}

function fetchRelay(targetUrl) {
  const relayUrl = RELAY_BASE + targetUrl;
  // Build curl args as an array to avoid shell escaping issues
  const cmd = `curl -s --max-time 25 -H "X-Respond-With: html" "${relayUrl}"`;
  try {
    const buf = execSync(cmd, {
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return buf.toString();
  } catch (e) {
    return null;
  }
}

async function main() {
  const targetCat = (process.argv[2] || "all").toLowerCase();
  const cats = targetCat === "all" ? CATEGORIES : { [targetCat]: CATEGORIES[targetCat] };
  if (!cats[targetCat] && targetCat !== "all") {
    console.error("Unknown category:", targetCat);
    process.exit(1);
  }

  let feedCache = { pages: {} };
  try {
    if (fs.existsSync(CACHE_FILE)) {
      feedCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (!feedCache.pages) feedCache.pages = {};
    }
  } catch (e) {}

  let total = 0;
  let errors = 0;

  for (const [cat, url] of Object.entries(cats)) {
    const cacheKey = cat + ":1";
    if (feedCache.pages[cacheKey] && feedCache.pages[cacheKey].cards && feedCache.pages[cacheKey].cards.length > 0) {
      console.log("SKIP", cat, "— cached:", feedCache.pages[cacheKey].cards.length);
      total += feedCache.pages[cacheKey].cards.length;
      continue;
    }

    console.log("Fetching", cat, "...");
    const html = fetchRelay(url);
    if (!html) {
      console.log("  FAIL — relay returned nothing");
      errors++;
      continue;
    }
    console.log("  Got", html.length, "bytes");
    const cards = parseCards(html);
    if (cards.length > 0) {
      feedCache.pages[cacheKey] = { ts: Date.now(), cards };
      total += cards.length;
      console.log("  OK:", cards.length, "videos");
    } else {
      console.log("  PARSE FAIL — no videoThumbProps found");
      errors++;
    }

    // Delay between categories to avoid rate limiting
    const catKeys = Object.keys(cats);
    if (catKeys.indexOf(cat) < catKeys.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(feedCache));
  console.log("\n========== SUMMARY ==========");
  console.log("Total videos:", total);
  console.log("Pages cached:", Object.keys(feedCache.pages).length);
  console.log("Errors:", errors);
  console.log("Cache file:", CACHE_FILE);
  console.log("============================");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });

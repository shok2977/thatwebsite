// seed-cache.js — Parses cached HTML and populates feed-cache.json
const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "feed-cache.json");
const HTML_FILE = process.argv[2] || path.join(process.env.TEMP || process.env.TMP, "xh-test.html");

console.log("Reading:", HTML_FILE);
const html = fs.readFileSync(HTML_FILE, "utf8");
console.log("HTML size:", html.length, "bytes");

// CharCode parser
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
  try { return JSON.parse(html.substring(jsonStart, end + 1)); }
  catch (e) { return null; }
}

function formatDuration(seconds) {
  if (!seconds || typeof seconds !== "number") return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}

const obj = parseInitialsJson(html);
if (!obj) { console.log("ERROR: No window.initials found"); process.exit(1); }

const vp = obj.layoutPage && obj.layoutPage.videoListProps && obj.layoutPage.videoListProps.videoThumbProps;
if (!vp || !Array.isArray(vp)) { console.log("ERROR: No videoThumbProps found"); process.exit(1); }

const cards = [];
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

console.log("Parsed", cards.length, "videos");
if (cards.length > 0) {
  console.log("Sample:", JSON.stringify(cards[0]));
  console.log("Last:", JSON.stringify(cards[cards.length - 1]));
}

const cache = { pages: { "newest:1": { ts: Date.now(), cards } } };
fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
console.log("Saved to", CACHE_FILE);

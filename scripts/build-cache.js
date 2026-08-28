// Build feed-cache.json from a saved xHamster homepage HTML file.
// Usage: node scripts/build-cache.js <path-to-html>
const fs = require("fs");
const path = require("path");
const { parseCards } = require("../server");

const src = process.argv[2] || path.join(__dirname, "..", "xh_home.html");
const html = fs.readFileSync(src, "utf8");

const cards = parseCards(html).map((c) => ({
  ...c,
  thumb: c.thumb && c.thumb.startsWith("//") ? "https:" + c.thumb : c.thumb,
}));

const out = { ts: Date.now(), cards };
const outPath = path.join(__dirname, "..", "feed-cache.json");
fs.writeFileSync(outPath, JSON.stringify(out));
console.log("wrote", cards.length, "cards to", outPath);

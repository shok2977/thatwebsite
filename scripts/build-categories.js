#!/usr/bin/env node
/**
 * Build script: fetches ALL xhamster categories from their categories page
 * and generates categories-map.json with slug → URL mappings.
 *
 * Usage: node scripts/build-categories.js
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const OUT_FILE = path.join(__dirname, "..", "categories-map.json");

function fetchCategoriesPage() {
  const url = "https://r.jina.ai/https://xhamster.com/categories";
  const cmd = `curl -s --max-time 25 -H "X-Respond-With: html" "${url}"`;
  console.log("Fetching categories page from xhamster...");
  const html = execSync(cmd, { timeout: 30000, maxBuffer: 50 * 1024 * 1024 }).toString('utf8');
  console.log("Got", html.length, "bytes");
  return html;
}

function extractCategorySlugs(html) {
  // Extract all unique category slugs from any xhamster.com/categories/ reference
  const regex = /xhamster\.com\/categories\/([a-z0-9-]+)/g;
  const slugs = new Set();
  let match;
  while ((match = regex.exec(html)) !== null) {
    const slug = match[1];
    // Filter out language codes (2-3 chars) and very short ones
    if (slug.length > 2) slugs.add(slug);
  }
  return [...slugs].sort();
}

function buildCategoryMap(slugs) {
  const map = {};
  for (const slug of slugs) {
    // Convert slug to a JS-safe key (replace hyphens with nothing, lowercase)
    const key = slug.replace(/-/g, "");
    map[key] = {
      slug,
      url: `https://xhamster.com/categories/${slug}`,
      label: slug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase()),
    };
  }
  return map;
}

function main() {
  const html = fetchCategoriesPage();
  const slugs = extractCategorySlugs(html);
  console.log(`Found ${slugs.length} unique categories`);

  const categoryMap = buildCategoryMap(slugs);
  fs.writeFileSync(OUT_FILE, JSON.stringify(categoryMap, null, 2));
  console.log(`Saved to ${OUT_FILE}`);

  // Print summary
  const groups = {
    "Main Feeds": ["newest", "popular", "top", "hd", "longest", "hot"],
    "Types": [],
    "Actions": [],
    "Body": [],
    "Ethnicity": [],
    "Age": [],
    "Hair": [],
    "Fetish": [],
    "Clothing": [],
    "Scenarios": [],
    "Location": [],
    "Special": [],
    "Other": [],
  };

  // Simple heuristic grouping based on slug keywords
  for (const slug of slugs) {
    const s = slug.toLowerCase();
    if (
      ["amateur", "homemade", "hardcore", "softcore", "hentai", "cartoon", "retro", "vintage", "webcam", "animation", "3d", "gonzo", "pov", "compilation", "uncensored"].some((k) => s.includes(k))
    )
      groups["Types"].push(slug);
    else if (
      ["anal", "blowjob", "cumshot", "handjob", "massage", "masturbation", "threesome", "gangbang", "orgy", "group", "doggystyle", "cowgirl", "missionary", "riding", "facial", "deepthroat", "creampie", "squirting", "striptease", "footjob", "fingering", "cunnilingus", "blowbang", "cum", "pussy", "ass", "titty", "titfuck", "blow", "oral", "rimjob", "facesitting", "scissoring"].some((k) => s.includes(k))
    )
      groups["Actions"].push(slug);
    else if (
      ["big-ass", "big-tits", "big-cock", "small-tits", "hairy", "chubby", "petite", "bbw", "skinny", "muscular", "pregnant", "tattoo", "piercing", "body", "nipples", "cameltoe", "clit", "pussy", "tits", "ass", "legs", "nude", "beauty", "flexible", "giant", "monster"].some((k) => s.includes(k))
    )
      groups["Body"].push(slug);
    else if (
      ["asian", "latina", "black", "european", "arab", "desi", "japanese", "korean", "indian", "german", "french", "russian", "british", "spanish", "brazilian", "thai", "african", "american", "interracial", "amwf", "mexican", "colombian", "philipino", "filipina", "turkish", "chinese", "taiwanese", "vietnamese", "indonesian", "malay", "pakistani", "bangladeshi", "sri", "nepali", "persian", "iranian", "iraqi", "lebanese", "jewish", "mzansi"].some((k) => s.includes(k))
    )
      groups["Ethnicity"].push(slug);
    else if (
      ["milf", "teen", "mature", "granny", "gilf", "cougar", "old-young", "18-year", "old-man", "young"].some((k) => s.includes(k))
    )
      groups["Age"].push(slug);
    else if (
      ["blonde", "brunette", "redhead", "colored-hair", "long-hair", "short-hair"].some((k) => s.includes(k))
    )
      groups["Hair"].push(slug);
    else if (
      ["bdsm", "bondage", "domination", "femdom", "fetish", "humiliation", "oiled", "pissing", "shibari", "hogtied", "tied-up", "spanking", "whipping", "chastity", "cbt", "estim", "pet-play", "sissy", "submissive", "suspension", "tape", "wax", "ball", "blindfold", "gag"].some((k) => s.includes(k))
    )
      groups["Fetish"].push(slug);
    else if (
      ["lingerie", "stockings", "uniform", "bikini", "latex", "leather", "high-heels", "nylon", "fishnet", "pantyhose", "panties", "thong", "bra", "gloves", "jeans", "leggings", "socks", "spandex", "bodysocking", "school-uniform", "masked"].some((k) => s.includes(k))
    )
      groups["Clothing"].push(slug);
    else if (
      ["cosplay", "boss", "teacher", "nurse", "maid", "babysitter", "secretary", "plumber", "doctor", "police", "cheating", "cuckold", "taboo", "fantasy", "role-play", "casting", "celebrity", "parody", "step", "neighbor", "stranger", "stuck", "time-stop", "truth-or-dare", "twins", "maid", "nun", "princess", "superhero", "vampire", "horror", "comedy"].some((k) => s.includes(k))
    )
      groups["Scenarios"].push(slug);
    else if (
      ["outdoor", "public", "bathroom", "beach", "car", "hotel", "kitchen", "office", "pool", "shower", "gym", "forest", "jungle", "farm", "prison", "taxi", "bus", "train", "underwater", "village", "sauna", "hospital", "college", "camping"].some((k) => s.includes(k))
    )
      groups["Location"].push(slug);
    else groups["Other"].push(slug);
  }

  console.log("\n=== Category Groups ===");
  for (const [name, items] of Object.entries(groups)) {
    if (items.length > 0) console.log(`  ${name}: ${items.length} categories`);
  }
}

main();

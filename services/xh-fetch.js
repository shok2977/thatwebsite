/* xh-fetch.js — direct xHamster fetch via DoH-resolved Cloudflare IPs.
 *
 * In this environment the ISP (Jio) hijacks DNS for xhamster.com (→ 49.44.79.236
 * block page), but TLS/SNI routing to the real Cloudflare IPs still works. We
 * resolve real IPs over DoH (1.1.1.1, then 8.8.8.8 — both literal IPs, so no
 * DNS needed for the resolver itself) and pin them inside an https.Agent via a
 * custom `lookup`. SNI stays xhamster.com, connection goes to the real edge.
 *
 * Measured on this machine: 0.9–1.5s per page vs 3–9s+ via r.jina.ai relay.
 * Full evidence: xhamster-hidden-api-report.md §2–§3.
 *
 * Cloudflare rate-limit discipline (report §3/§6a): bursts of rapid hits can
 * trigger a ~2min cooldown. Background jobs are globally paced; user-facing
 * clicks (priority 0) are never delayed. Retries rotate to the other IP.
 */
const https = require("https");
const crypto = require("crypto");

const XH_HOST = "xhamster.com";
const XH_HOST_RE = /(^|\.)xhamster\.com$/;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const DOH_ENDPOINTS = [
  "https://1.1.1.1/dns-query?name=" + XH_HOST + "&type=A",   // Cloudflare dns-json
  "https://8.8.8.8/resolve?name=" + XH_HOST + "&type=A",     // Google DNS JSON fallback
];
const IP_TTL = 5 * 60 * 1000;

let ipCache = { ips: [], ts: 0, idx: 0 };
let resolving = null;

function dohQuery(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.get(endpoint, {
      headers: { Accept: "application/dns-json" },
      timeout: 4000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("doh http " + res.statusCode)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
          if (ips.length) resolve(ips); else reject(new Error("doh: no A records"));
        } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("doh timeout")));
    req.on("error", reject);
  });
}

async function resolveIps(force) {
  if (!force && ipCache.ips.length && Date.now() - ipCache.ts < IP_TTL) return ipCache.ips;
  if (resolving) return resolving;
  resolving = (async () => {
    let lastErr;
    for (const ep of DOH_ENDPOINTS) {
      try {
        const ips = await dohQuery(ep);
        if (force) ipCache.idx++;               // rotate away from a failing edge
        ipCache = { ips, ts: Date.now(), idx: ipCache.idx };
        console.log("[xhFetch] DoH IPs:", ips.join(", "));
        return ips;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("doh failed");
  })().finally(() => { resolving = null; });
  return resolving;
}

function prewarmIps() { resolveIps(false).catch(() => {}); }
prewarmIps();

/* Pinned lookup for the xhamster agent. Node 20+ also calls with
 * opts.all:true and expects [{address, family}] — both shapes handled
 * (the all:true miss caused "Invalid IP address: undefined" in testing). */
function pinnedLookup(opts, cb) {
  resolveIps(false).then((ips) => {
    const ip = ips[ipCache.idx % ips.length];
    if (opts && opts.all) cb(null, [{ address: ip, family: 4 }]);
    else cb(null, ip, 4);
  }).catch(cb);
}

const xhAgent = new https.Agent({ keepAlive: true, maxSockets: 10, lookup: (host, opts, cb) => pinnedLookup(opts, cb) });

/* ---------- Global soft pacing for background hits ---------- */
const BG_GAP_MS = 1200;           // ≥1 background hit / 1.2s — burst-safe
let bgChain = Promise.resolve();
let lastBgHit = 0;

function pace(priority) {
  if (priority === 0) return Promise.resolve();   // user clicks: never wait
  bgChain = bgChain.then(async () => {
    const gap = BG_GAP_MS + Math.floor(Math.random() * 400);
    const wait = Math.max(0, lastBgHit + gap - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastBgHit = Date.now();
  }).catch(() => {});
  return bgChain;
}

/* GET a text body from xhamster.com over the pinned connection.
 * Manual redirect-follow (≤3) because undici's fetch() ignores our agent. */
function xhFetchText(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 6500;
  const priority = (opts && opts.priority) === 0 ? 0 : 1;
  const headers = Object.assign({
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  }, (opts && opts.headers) || {});

  // Single-shot GET with manual redirect-follow (≤3). Retries below rotate
  // ipCache.idx so the next attempt dials the other edge IP.
  function attemptInner(u, redirects) {
    redirects = redirects || 0;
    return new Promise((resolve, reject) => {
      const req = https.request(u, { agent: xhAgent, method: "GET", headers, timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && redirects < 3) {
          res.resume();
          return resolve(attemptInner(new URL(res.headers.location, u).href, redirects + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error("xh direct http " + res.statusCode)); }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; if (body.length > 12 * 1024 * 1024) req.destroy(new Error("body too large")); });
        res.on("end", () => resolve(body));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("xh direct timeout")));
      req.on("error", reject);
      req.end();
    });
  }

  return pace(priority).then(() => attemptInner(url, 0)).catch((e1) => {
    // one retry on the other edge IP (ECONNRESET / 520 / timeout happen)
    ipCache.idx++;                                // rotate to the other edge
    return pace(priority).then(() => new Promise((r) => setTimeout(r, 300))).then(() => attemptInner(url, 0));
  }).catch((e2) => { e2.directFailed = true; throw e2; });
}

/* ---------- /api/front/search/suggest (CONFIRMED, report §6a) ---------- */
const SUGGEST_URL = "https://" + XH_HOST + "/api/front/search/suggest?searchValue=<q>&searchScope=common&orientation=0";
let suggestCsrf = crypto.randomBytes(16).toString("hex");

async function xhSuggest(q) {
  const clean = String(q || "").trim().slice(0, 50);
  if (clean.length < 2) return [];
  const url = SUGGEST_URL.replace("<q>", encodeURIComponent(clean));
  const body = await xhFetchText(url, {
    timeoutMs: 5000,
    priority: 0,                                  // user is typing — serve instantly
    headers: {
      "Cookie": "x_csrf_token=" + suggestCsrf,
      "x-csrf-token": suggestCsrf,                // double-submit: cookie + header same value
      "x-requested-with": "XMLHttpRequest",
      "Accept": "application/json",
    },
  });
  const arr = JSON.parse(body);
  if (!Array.isArray(arr)) throw new Error("suggest: unexpected shape");
  return arr.slice(0, 8).map((it) => ({
    text: it.plainText || (it.text || "").replace(/<\/?b>/g, ""),
    kind: it.type2 || "search",
    link: it.link || "",
    count: typeof it.count === "number" ? it.count : null,
    avatar: (it.avatar && it.avatar.url) || it.avatar || "",
  })).filter((s) => s.text);
}

module.exports = { xhFetchText, xhSuggest, prewarmIps, resolveIps, UA };

/* Live test of xh-fetch + xh-decrypt modules (spaced-safe: 4 sequential hits) */
const { xhFetchText, xhSuggest, resolveIps } = require("./services/xh-fetch");
const { unmask, looksHexMasked } = require("./services/xh-decrypt");

const t = (s) => ((Date.now() - s) / 1000).toFixed(2) + "s";

function parseInitials(html) {
  const m = "window.initials";
  const i = html.indexOf(m);
  if (i === -1) return null;
  const eq = html.indexOf("=", i + m.length);
  const start = html.indexOf("{", eq);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let j = start; j < html.length; j++) {
    const c = html.charCodeAt(j);
    if (esc) { esc = false; continue; }
    if (c === 92 && inStr) { esc = true; continue; }
    if (c === 34) inStr = !inStr;
    if (inStr) continue;
    if (c === 123) depth++;
    if (c === 125) { depth--; if (!depth) { end = j; break; } }
  }
  return end === -1 ? null : JSON.parse(html.slice(start, end + 1));
}

(async () => {
  const ips = await resolveIps(true);
  console.log("1) DoH IPs:", ips.join(", "));

  let s = Date.now();
  const html = await xhFetchText("https://xhamster.com/newest", { timeoutMs: 8000, priority: 0 });
  const initials = parseInitials(html);
  const cards = initials && initials.layoutPage && initials.layoutPage.videoListProps;
  console.log("2) direct /newest:", t(s), "| initials:", !!initials, "| cards:", cards ? cards.videoThumbProps.length : 0);

  s = Date.now();
  const sug = await xhSuggest("indian");
  console.log("3) suggest(indian):", t(s), "| items:", sug.length, "| first:", sug[0] && sug[0].text);

  s = Date.now();
  const vHtml = await xhFetchText("https://xhamster.com/videos/hot-ebony-babe-fingers-herself-while-her-ass-is-filled-up-with-a-butt-plug-xhZXVg7", { timeoutMs: 8000, priority: 0 });
  const vi = parseInitials(vHtml);
  const hlsSrc = vi && vi.xplayerSettings && vi.xplayerSettings.sources && vi.xplayerSettings.sources.hls;
  const h264g = hlsSrc && (Array.isArray(hlsSrc.h264) ? hlsSrc.h264[0] : hlsSrc.h264 || hlsSrc);
  const masked = h264g && h264g.url;
  const m3u8 = masked && looksHexMasked(masked) ? unmask(masked) : masked;
  console.log("4) video page:", t(s), "| masked:", !!masked, "| m3u8:", m3u8 ? m3u8.slice(0, 100) : "(FAIL)");
})().catch((e) => { console.error("TEST FAIL:", e.message); process.exit(1); });

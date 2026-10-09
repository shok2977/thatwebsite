# xHamster Hidden API & Fast Data-Path — Findings Report

> Investigation only. Kuch bhi implement/refactor nahi kiya gaya (user ka instruction).
> Date: 2026-10-05. Sabhi tests is machine/ISP se live kiye gaye, curl v8 + Node v24 se.
> Evidence files: `/tmp/xh_newest.html`, `/tmp/xh_video.html`, `/tmp/xh_embed.html`, `/tmp/video_initials.json`, `/tmp/initials.json`, `/tmp/xhjs/` (5 player bundles), `/tmp/seg_test.bin`.

---

## 0. TL;DR — chaar naye fast paths CONFIRMED hain

| # | Path | Status | Speed (measured) | Relay bypass? |
|---|------|--------|------------------|---------------|
| 1 | **DoH + IP-pinned direct fetch** of xhamster.com (block sirf DNS-level hai) | ✅ CONFIRMED | 0.9–1.5s per page | Relay ki zaroorat hi nahi |
| 2 | **Source-unmask decryptor** — xplayerSettings hex strings → m3u8/MP4 URLs | ✅ CONFIRMED (round-trip verified) | ~0ms (local) | — |
| 3 | **xhcdn.com HLS CDN** — playlists + segments **bina kisi header/Referer ke** open | ✅ CONFIRMED | segment Range 0.66s, master 1.0s | — |
| 4 | **`/api/front/search/suggest`** JSON API (`searchScope=common` + CSRF double-submit) | ✅ CONFIRMED | 200, ~1s, 13 suggestions | — |

Sabse bada finding: **`xhamster.com` is machine par DNS-hijacked hai (Jio ISP → 49.44.79.236), lekin Cloudflare ke real IPs (104.16.3.81 / 104.16.4.81) par SNI routing abhi kaam kar rahi hai.** DoH se real IP nikaal ke direct connect = poori site 1–1.5s me, relay (r.jina.ai, 3–9s+) ke bina.

---

## 1. Project abhi kaise kaam karta hai (slowness kahan se hai)

- **Feeds/search/categories**: [server.js:401](server.js#L401) `fetchPageHtml()` — 3 racers: `r.jina.ai` render (3–9s, [server.js:339](server.js#L339)), allorigins (blocked/000), direct curl (fail — DNS hijack). Relay limiter concurrency 4 ([server.js:105](server.js#L105) RELAY_BASE, tiered semaphore [server.js:348-385](server.js#L348), TIER_CAPS 3/2/1 [server.js:358](server.js#L358)).
- **Har video click**: poori video page HTML (280–300KB) relay se dobara → `<link rel=preload>` m3u8 → cache. `fetchVideoPageForStream` [server.js:599](server.js#L599), budgets 9s/10s.
- `parseInitialsJson` [server.js:441](server.js#L441) aur `extractM3u8WithSource` [server.js:469](server.js#L469) pehle se hi `window.initials` parse karte hain — naye path inhi ke aage judenge.
- Evidence: [server.log](server.log) me `[Playwright] Not available — using relay-only mode`, feeds sirf relay se aaye.

**Root cause: discovery + stream-resolve dono ke liye full-page relay renders. Neeche ke paths ye dono replace kar sakte hain.**

---

## 2. Environment ground truth (evidence-backed)

| Test | Result | Matlab |
|---|---|---|
| `nslookup xhamster.com` | `49.44.79.236` (Jio) | **ISP DNS hijack/block** — ye hi asli blocker hai |
| DoH `1.1.1.1/dns-query` | `104.16.3.81, 104.16.4.81` (Cloudflare) | Real IPs available |
| curl `--resolve xhamster.com:443:104.16.3.81` | **HTTP 200, 427KB, 1.4s** | TLS/SNI level pe koi block NAHI |
| Browser (Freebuff preview) | chrome-error | Browser DNS bhi hijacked; curl/Node ka `/etc/hosts`-style override chahiye |
| `xhcdn.com` (any sub) | direct reachable, 200 | Video CDN khula hai |
| `api.allorigins.win` | 000 | Dead environment me |
| `r.jina.ai` | 403 without headers, works with `X-Respond-With: html` | Backup ke liye theek |
| IP par plain hit (`https://104.16.3.81/`) | 403 (0.38s) | Cloudflare SNI-routing use karta hai — Host/SNI hona zaroori |

**Node proof** (DoH-pinned agent, `/tmp/node_doh_test3.js`): `xhamster.com/search/indian → 200, 1128ms, initials:true`; `best/weekly → 200, 970ms`; socket-reuse 893ms. Ek request `ECONNRESET` bhi aayi — **retry/2-IP-rotation implementation me zaroori hoga**.

---

## 3. ✅ CONFIRMED — Direct fast path (relay replacement #1)

**Method:** DoH se IP lo → TLS me SNI/Host = `xhamster.com`, connect IP par.

```
GET https://1.1.1.1/dns-query?name=xhamster.com&type=A     (Accept: application/dns-json)
→ {"Answer":[{"name":"xhamster.com","type":1,"data":"104.16.3.81"},{...,"data":"104.16.4.81"}]}

GET https://xhamster.com/newest   (TLS SNI: xhamster.com, connect 104.16.3.81)
Headers: User-Agent (Chrome desktop), Accept: text/html
→ HTTP 200, ~300–430KB, window.initials present
```

- curl: `--resolve xhamster.com:443:104.16.3.81`
- Node: `https.Agent({ lookup: (host, opts, cb) => cb(null, ip, 4) })` — dhyan rahe: **`opts.all` case bhi handle karo** (Node 20+ `all:true` ke saath call karta hai; `{address, family}` objects return karo — warna "Invalid IP address: undefined"). Evidence: hamare test #1/#2 fail hue, #3 (all:true handling) pass hua.
- Verified URLs: `/newest`, `/best/weekly`, `/search/indian`, `/categories/asian/2..7`, video page (`/videos/<slug>`), `/embed/<id>`.
- Cloudflare anuparv: 8 rapid category hits → 7×200 (1.0–1.6s) + 1×000(reset). Phir ~2 min tak sab requests 000. **Implementation: pacing + IP rotation + backoff.** 520 = "origin overloaded" (transient, retry with other IP).

**Evidence timings:** video page direct 1.32s vs relay 2.31s (aur relay me 8s timeouts + 3–9s queue lags common hain). Expected end-to-end click-resolve: **2–9s → ~1.5–2.5s**, aur discovery ~10× faster.

---

## 4. ✅ CONFIRMED — Source-unmask decryption (relay replacement #2)

Video page ke `window.initials` me player sources **hex-masked** hote hain. Player bundle `v24c90bce40.xplayer.js` (xhcdn se, module `95261`) ne decode kiya — **maine algorithm port karke live strings decrypt kiye aur unke URLs actual CDN se validate kiye (m3u8 master se match)**.

**Where:** `window.initials.xplayerSettings.sources` — shape:
```
sources.standard.h264 = [ {url: <hex>, fallback: <hex>}, {url: <hex>}, {url: <hex>} ]   // progressive MP4s
sources.hls.h264      = { url: <hex>, fallback: <hex> }                                  // HLS master m3u8
```

**Algorithm (verified twice — algo 1 aur algo 2 dono dekhe):**
1. hex string (even length ≥12) → bytes
2. `byte[0]` = algoId (1..7), `byte[1..4]` = 32-bit LE seed
3. PRNG(algoId, seed) se per-byte keystream, `payload[i] ^= ks()` (payload = bytes 5..end)
4. Result bytes → percent-encode → `decodeURIComponent` = plaintext URL

PRNG constants (exact port, `/tmp/xh_decrypt.js` me tested implementation):
- 1: LCG `i = (imul(i,1664525) + 0x3c6ef35f)|0`
- 2: xorshift32 `i^=i<<13; i^=i>>>17; i^=i<<5`
- 3: `i+=0x9e3779b9; i^=i>>>16; i=imul(i,0x85ebca77); i^=i>>>13; i=imul(i,0xc2b2ae3d)`
- 4: `i=(i+0x6d2b79f5)<<7|i>>>25; i+=0x9e3779b9; i^=i>>>11; i=imul(i,0x27d4eb2d)`
- 5: `i^=i<<7; i^=i>>>9; i^=i<<8`
- 6: `i=imul(i,0x2c9277b5)+0xac564b05; return ((i^(i>>>18))>>>(i>>>27&31))&255` (concat variant)
- 7: `e=((i+0x9e3779b9)^i)<<5; i^=i>>>15; i=imul(i,0x7feb352d); i^=i>>>15; return e&255`

**Live decrypt sample (video 31202284):**
```
$..sources.standard.h264[0].url  (algo 2, 145 bytes)
→ https://video-nss-h.xhcdn.com/WKW7xoHmTsqLVH5hMq_JWA==,1791237600/media=hls4/multi=256x144:144p,426x240:240p/031/202/284/_TPL_.h264.mp4.m3u8

$..sources.standard.h264[1].url  (algo 1, 136 bytes)
→ https://video-h.xhcdn.com/key=Slw9Zz8RC2oEfcp3FU8exg,end=1791237600,limit=3/data=34.96.52.102-dvp/speed=0/031/202/284/144p.h264.mp4
```
(Aur `sources.hls.h264.url` ne exactly wahi m3u8 diya jo page ke `<link rel=preload as=fetch>` me tha — **cross-proof**.)

**Yehi m3u8 direct fetch kiya (no headers): HTTP 200 `#EXTM3U` + 2 variants.** Decryption = 100% proven fast path.

---

## 5. ✅ CONFIRMED — HLS CDN behavior (headers ki zaroorat NAHI)

`video-nss.xhcdn.com` / `video-nss-h.xhcdn.com` — **no Referer, no UA, no cookie needed:**

```
GET https://video-nss-h.xhcdn.com/WKW7xoHmTsqLVH5hMq_JWA==,1791237600/media=hls4/multi=256x144:144p,426x240:240p/031/202/284/_TPL_.h264.mp4.m3u8
→ 200: #EXTM3U + 2 variant lines (144p, 240p), 1.0s

GET .../031/202/284/240p.h264.mp4.m3u8           → 200: VOD playlist, #EXTINF:4.000, seg-1-v1-a1.ts
GET .../240p.h264.mp4/seg-1-v1-a1.ts  (Range 0-2047) → 206, TS sync byte 0x47 ✓, 0.66s
```

- URL me expiry token epoch (`1791237600`) — `parseStreamExpiry()` [server.js:126](server.js#L126) pehle se isko handle karta hai ✓
- **Progressive MP4 `key=...` URLs IP-locked hain** (`data=34.96.52.102-dvp`) — "Wrong key" 403 alag IP se. Sirf HLS use karna. (Possible workaround: relay ke through MP4, ya skip.)
- SSR preload m3u8 host har render me alag ho sakta hai: `video-nss.xhcdn.com` vs `video-nss-h.xhcdn.com` vs `video-nss.xhpingcdn.com` — **sab aliases, interchangeable**. `ALLOWED_HOST` regex [server.js:1472](server.js#L1472) me `xhpingcdn` abhi nahi hai (note for later).
- `videoModel.downloadFile` field (`https://xhamster.com/movies/<slug>/download/144p`) bhi mila — suspected additional source (untested).

---

## 6. JSON endpoints — 1 CONFIRMED (🟢), 1 REFUTED, 1 skipped

### 6a. 🟢 CONFIRMED — `GET /api/front/search/suggest` (working JSON API, no auth)

**Working sample request (live-verified 2026-10-06, spaced single probe):**
```
GET https://xhamster.com/api/front/search/suggest?searchValue=indian&searchScope=common&orientation=0
Cookie: x_csrf_token=testtoken123456
x-csrf-token: testtoken123456
x-requested-with: XMLHttpRequest
Accept: application/json
(TLS via DoH IP-pinning: --resolve xhamster.com:443:104.16.3.81)
→ HTTP 200, 3345 bytes, ~1s
```

**Response shape (JSON array of suggestModel):**
```json
[{"modelName":"suggestModel","text":"<b>Indian</b>","orientation":null,"type":9,"type2":"search","plainText":"Indian","link":"https://xhamster.com/search/indian","iconNamePhp":null,"count":0,"weight":1700000,"source":null}, ...]
```
- 13 entries for "indian": mostly `type2:"search"` (type 9) with `link` + `weight` (popularity), plus channel entries (`type2:"channel"`, type 2) with `count` (videos) and `avatar` (thumb-v-nss.xhpingcdn.com)
- `text` contains `<b>` highlight markup; use `plainText` for display

**Param matrix (tested):**
| Params | Result |
|---|---|
| `searchValue=indian&searchScope=common&orientation=0` | ✅ 200, 13 suggestions |
| `searchValue=indian&searchScope=user&orientation=0` | ❌ 400 `{"error":""}` (user scope needs auth/session) |
| no `searchScope` (pichhli baar) | 200 `[]` (accepted but empty), aur ek probe throttle (000) ho gaya — inconclusive |
- `searchScope` enum bundle se: `User="user"`, `Common="common"` (v94c2c0b0ee.video-single.js, module 54884) — **`common` public scope hai**
- CSRF double-submit confirmed: cookie `x_csrf_token` + header `x-csrf-token` same value; server cookie SET nahi karta, client JS banata hai — hum dono side control karte hain, koi session nahi chahiye
- **Rate-limit discipline**: spaced 17s probes = sab clean; pichhle session ka 8-hit burst hi cooldown trigger karta tha. Implementation me suggest calls ko user-typed queries tak limit karna (debounce 500ms, jaise asli site karti hai)
- Use-case: search-as-you-type (fast, chhota JSON), aur `weight`-sorted trending queries

### 6b. ❌ REFUTED — Astro `isAstroJson` SPA-JSON pattern (tested, not available)
- **Lead tha**: `appContext.isAstroJson:true` (embed page) se lagta tha same URL JSON bhi serve karta ho
- **Bundle deconstruction**: `isAstroJson` sirf is liye hai ki client **HTML ke andar SSR'd `window.initials`** padhta hai aur JSON mode me chunk-preload skip karta hai (`isAstroJson?Promise.resolve():(0,l.A6)(e,n)` — v698db11021.start.js). Koi data-JSON fetch nahi hota
- **Live tests (spaced, direct access)**:
  - video page + `Accept: application/json` → **HTTP 200 poora HTML** (297KB, `window.initials` present) — content negotiation ignore hoti hai
  - `/videos/<slug>.json` → **404 nginx**
  - `/newest.json` → **404 nginx**
- **Verdict**: JSON render endpoint exist nahi karta. HTML+initials hi "API" hai — aur decryptor ke saath wahi kaafi hai

### 6c. SSR payload hi asli "API" hai — treat initials as JSON API
- `window.initials` (video page): `xplayerSettings`, `videoModel` (title, duration, views, rating, author, landing, resolution, downloadFile, spriteURL, trailerURL...), `relatedVideosComponent.videoThumbProps`, `hostMap`, `stats_tkn`...
- Listing pages: `layoutPage.videoListProps.videoThumbProps[]` — **46 cards**, har card me: `id, title, pageURL, thumbURL, previewThumbURL, spriteURL, trailerURL, duration, views, created, landing{name,logo,link}` — project abhi sirf 4 fields use karta hai; **preview/sprite/trailer free me milte hain**.
- `initials.paginationProps = {currentPageNumber, lastPageNumber, pageLinkTemplate:"https://xhamster.com/newest/{#}"}` — **canonical pagination**.
- Embed page (`/embed/<id>`, only ~45KB): initials me `xplayerSettings: null` — sources client-side render ke baad fetch hota hai. **Koi standalone JSON endpoint nahi mila** (embed me data laane wala XHR bundle me visible nahi tha). Embed = lightweight page but stream ke liye kaam nahi aayega.

### 6d. Other
- `POST /api/fid` — device fingerprint collector (bundle-confirmed). 400 without proper payload. **Koi use-case nahi**, skip.
- `xplayerPluginSettings.statistics.addFields.session_token` bhi masked hex me tha (algo 78 variant? — nahi, wo 0x4e seed wala decode hua) — analytics-only, skip.
- `Accept: application/json` + jina relay → JSON envelope {code:20000, data.html} — jina ka feature hai, xhamster ka nahi.

---

## 7. Naye implementation ka recommended blueprint (jab user bole)

1. **`xhFetch(url)`** — DoH-resolve (cache IPs ~5min) + `https.Agent` with pinned lookup + IP-rotation + 1 retry + jittered pacing (≈500ms between background hits). Fallback chain: direct → r.jina.ai → allorigins.
2. **Listing resolve**: direct page → `parseInitialsJson` (already exists) → cards (46/page, ab saare fields ke saath).
3. **Stream resolve (click)**: direct video page (1.3s) → `xplayerSettings.sources.hls.h264.url` hex → local decrypt (~0ms) → m3u8. Preload-link regex fallback ke roop me rakhna. Relay sirf agar dono fail.
4. **Warm pool**: token URLs ~3h valid hote hain (expiry epoch URL me) — 60-video pool ab direct hits se (relay pe 4x concurrency limit ke bina) bahut sasta ho jayega.
5. **Auth**: HLS CDN + SSR pages ke liye koi nahi chahiye. Search-suggest JSON API ke liye sirf self-made CSRF double-submit (cookie+header same value).
6. **HLS proxy**: allowlist me `xhpingcdn` bhi add karna ([server.js:1472](server.js#L1472)).
7. **Search suggest**: `/api/front/search/suggest?searchValue=<q>&searchScope=common&orientation=0` + CSRF combo — instant JSON suggestions (section 6a), search box ke liye.

Expected: feed page ~10× faster (1.2s vs 12–15s cold), click-resolve ~1.5–2.5s worst case (vs 3–9s+queue today), aur relay ki dependency sirf emergency fallback reh jayegi.

---

## 8. Evidence index

| Claim | Evidence |
|---|---|
| DNS hijack (49.44.79.236) | `nslookup xhamster.com` output (is report me) |
| Real IPs 104.16.3.81/4.81 | DoH JSON response (section 3) |
| Direct 200 (site) | curl output: HTTP 200, 427800 bytes, 1.40s |
| Node agent proof | node_doh_test3.js output (970–1128ms, initials:true) |
| Encrypted sources + decryptor | /tmp/video_initials.json + /tmp/xh_decrypt.js output (8/8 decoded strings) |
| m3u8 no-header access | curl 200 + variant + segment (0x47 sync byte, 206) |
| Progressive MP4 IP-lock | curl 403 "Wrong key" |
| /api/front/search/suggest **CONFIRMED** | live: 200, 3345B, 13 suggestModel entries (section 6a sample) |
| searchScope=user → 400; common → 200 | spaced probes (section 6a matrix) |
| Astro JSON endpoint REFUTED | Accept:application/json → HTML 200; .json suffix → 404 nginx (section 6b) |
| Rate-limit on burst | 8 rapid hits: 7×200 + 1×000, phir ~2min cool-off; 17s-spaced probes clean |
| Bundle endpoint list | /tmp/xhjs/*.js greps (section 6) |

---

## 9. IMPLEMENTED (2026-10-07) — fast paths ab server me live hain

Blueprint (section 7) implement ho gaya — user ne green signal diya. Naye files:
- `services/xh-fetch.js` — DoH resolver (1.1.1.1 → 8.8.8.8 fallback, 5min IP cache, rotation) + pinned `https.Agent` (opts.all handled) + background pacing (1.2s gap, user clicks never wait) + `xhSuggest()` client
- `services/xh-decrypt.js` — verified unmask port + `unmaskInitials()` (live shape: `sources.hls.h264 = {url, fallback}` dono masked)
- `server.js` wiring: direct racer ab pehla strategy `fetchPageHtml` me; `extractM3u8WithSource` hex-unmask fallback; `ALLOWED_HOST`/`THUMB_HOST` me `xhpingcdn`; naya `GET /api/suggest` (60/min, 10min cache); search `fetchSearchViaRelay` automatically fast (same racer path)
- `public/app.js` — live suggestions dropdown (debounce 300ms, stale-response guard, channel badges)

**Live measured numbers (e2e test, `test-e2e.js`):**
| Path | Pehle (relay) | Ab (measured) |
|---|---|---|
| Feed page (cold) | 3–9s+ queue | **~1.2s** direct, 46 cards |
| /api/videos page-1 | relay-bound | **205–467ms**, 45/46 cards warm |
| Click → stream (warm cache hit) | 3–9s | **12ms** |
| Click → stream (cold resolve) | 3–9s+ | **~1.05s** (direct + decrypt) |
| /api/suggest | — | **14ms cached / 322ms fresh**, 8 items |
| HLS chain (master→variant→segment, xhpingcdn) | — | 137ms / 89ms / 205ms, TS 0x47 ✓ |
| Warm pool 60/60 | relay se ghanto me | **~4 min, 0 cooldown events** |

Note: live render me masked host `video-nss-h.xhpingcdn.com` nikla — `xhpingcdn` allowlist add karna **zaroori** tha (section 5 ka note ab resolved). Test scripts: `test-xh-modules.js`, `test-e2e.js` (project root).

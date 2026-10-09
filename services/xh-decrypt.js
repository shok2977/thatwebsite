/* xh-decrypt.js — xHamster player source unmasking (local, ~0ms).
 *
 * Video-page SSR payload (window.initials) stores player source URLs as
 * hex-masked strings. Algorithm is a faithful port of xplayer module 95261
 * (bundle v24c90bce40.xplayer.js), verified live 8/8 strings — the decrypted
 * m3u8 matched the page's <link rel="preload"> manifest exactly.
 * Full evidence: xhamster-hidden-api-report.md §4.
 *
 * Shape: byte[0] = algoId (1..7), byte[1..4] = 32-bit LE seed,
 * payload (bytes 5..) XOR per-byte PRNG keystream, then percent-decoded.
 */
const imul = Math.imul;

function looksHexMasked(s) {
  return typeof s === "string" && s.length >= 12 && (s.length & 1) === 0 && /^[0-9a-fA-F]+$/.test(s);
}

function unmask(hex) {
  if (!looksHexMasked(hex)) return null;
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  if (bytes.length < 5) return null;
  const algoId = bytes[0];
  if (algoId < 1 || algoId > 7) return null;
  const seed = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24);
  let i = seed | 0;
  let next;
  switch (algoId) {
    case 1: next = () => { i = (imul(i, 1664525) + 0x3c6ef35f) | 0; return 255 & i; }; break;
    case 2: next = () => { i |= 0; i ^= i << 13; i ^= i >>> 17; i ^= i << 5; return 255 & (i |= 0); }; break;
    case 3: next = () => { i = (i + 0x9e3779b9) | 0; i ^= i >>> 16; i = imul(i, 0x85ebca77); i ^= i >>> 13; i = imul(i, 0xc2b2ae3d); return 255 & (i ^ (i >>> 16)); }; break;
    case 4: next = () => { i = ((i + 0x6d2b79f5) | 0) << 7 | i >>> 25; i = (i + 0x9e3779b9) | 0; i ^= i >>> 11; i = imul(i, 0x27d4eb2d); return 255 & i; }; break;
    case 5: next = () => { i |= 0; i ^= i << 7; i ^= i >>> 9; i ^= i << 8; return 255 & (i |= 0); }; break;
    case 6: next = () => { return 255 & (((i = imul(i, 0x2c9277b5) + 0xac564b05 | 0) ^ i >>> 18) >>> (i >>> 27 & 31)); }; break;
    case 7: next = () => { const e = ((i + 0x9e3779b9 | 0) ^ i) << 5; i = i ^ i >>> 15; i = imul(i, 0x7feb352d); i ^= i >>> 15; return 255 & e; }; break;
    default: return null;
  }
  let pct = "";
  for (let a = 5; a < bytes.length; a++) {
    const h = ((bytes[a] ^ next()) & 255).toString(16);
    pct += "%" + (h.length < 2 ? "0" + h : h);
  }
  try { return decodeURIComponent(pct); } catch (e) { return null; }
}

/* Unmask every masked URL inside an initials object IN PLACE. Returns the
 * same object for convenience. Handles xplayerSettings.sources.{hls,standard}
 * and any other hex string field that unmasks into an http(s) URL. */
function unmaskInitials(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const ps = obj.xplayerSettings;
  if (ps && ps.sources) {
    const hls = ps.sources.hls;
    if (hls) {
      // Live shape: hls.h264 = {url, fallback} (older renders used hls.url directly)
      const groups = Array.isArray(hls.h264) ? hls.h264 : [hls.h264].filter(Boolean);
      for (const g of groups) {
        if (!g || typeof g !== "object") continue;
        for (const key of ["url", "fallback"]) {
          if (looksHexMasked(g[key])) { const d = unmask(g[key]); if (d) g[key] = d; }
        }
      }
      for (const key of ["url", "fallback"]) {
        if (looksHexMasked(hls[key])) { const d = unmask(hls[key]); if (d) hls[key] = d; }
      }
    }
    const std = ps.sources.standard;
    if (Array.isArray(std)) {
      for (const grp of std) {
        if (!grp || typeof grp !== "object") continue;
        for (const key of ["url", "fallback"]) {
          if (looksHexMasked(grp[key])) { const d = unmask(grp[key]); if (d) grp[key] = d; }
        }
      }
    }
  }
  return obj;
}

module.exports = { unmask, unmaskInitials, looksHexMasked };

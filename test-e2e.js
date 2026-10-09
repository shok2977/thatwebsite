/* End-to-end zero-wait verification through the running server (localhost:3080) */
const BASE = "http://localhost:3080";
const VIDEO_URL = "https://xhamster.com/videos/hot-ebony-babe-fingers-herself-while-her-ass-is-filled-up-with-a-butt-plug-xhZXVg7";

(async () => {
  let s = Date.now();
  const j1 = await (await fetch(BASE + "/api/videos?category=newest&page=1")).json();
  const withStream = j1.videos.filter(v => v.stream).length;
  console.log("1) /api/videos newest:", Math.round((Date.now() - s)) + "ms | count:", j1.count, "| warm streams attached:", withStream);

  s = Date.now();
  const j2 = await (await fetch(BASE + "/api/suggest?q=indi")).json();
  console.log("2) /api/suggest q=indi:", Math.round((Date.now() - s)) + "ms | ok:", j2.success, "| items:", j2.suggestions.length, "| first:", j2.suggestions[0] && j2.suggestions[0].text, j2.suggestions[1] && ("| 2nd: " + j2.suggestions[1].text + " (" + j2.suggestions[1].kind + ")"));

  s = Date.now();
  const j3 = await (await fetch(BASE + "/api/stream-url?url=" + encodeURIComponent(VIDEO_URL))).json();
  const ms3 = Math.round((Date.now() - s));
  const m3u8 = j3.m3u8Url || (j3.stream && j3.stream.m3u8Url) || j3.url || "";
  console.log("3) /api/stream-url (click path):", ms3 + "ms | ok:", j3.success !== false, "| m3u8:", (m3u8 || "(none)").slice(0, 90));
  console.log("   full response keys:", Object.keys(j3).join(","), "| body snippet:", JSON.stringify(j3).slice(0, 200));

  if (m3u8) {
    s = Date.now();
    const r4 = await fetch(BASE + "/api/stream?url=" + encodeURIComponent(m3u8), { headers: { Range: "bytes=0-2047" } });
    const txt = await r4.text();
    const isPlaylist = txt.includes("#EXTM3U");
    const firstSeg = txt.split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#"));
    console.log("4) /api/stream master (xhpingcdn):", Math.round((Date.now() - s)) + "ms | status:", r4.status, "| playlist:", isPlaylist, "| first variant:", firstSeg ? firstSeg.slice(0, 80) : "(none)");

    if (firstSeg) {
      // The playlist is server-rewritten to /api/stream?url=... — unwrap it instead of double-wrapping
      const segUrl = firstSeg.startsWith("/api/stream?url=")
        ? decodeURIComponent(firstSeg.slice("/api/stream?url=".length))
        : new URL(firstSeg, m3u8).href;
      s = Date.now();
      const r5 = await fetch(BASE + "/api/stream?url=" + encodeURIComponent(segUrl));
      const body = await r5.text();
      const firstLine = body.split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#"));
      console.log("5) /api/stream variant:", Math.round((Date.now() - s)) + "ms | status:", r5.status, "| first segment line:", firstLine ? firstLine.slice(0, 80) : "(none)");
      if (firstLine) {
        const segMedia = firstLine.startsWith("/api/stream?url=")
          ? decodeURIComponent(firstLine.slice("/api/stream?url=".length))
          : new URL(firstLine, segUrl).href;
        s = Date.now();
        const r6 = await fetch(BASE + "/api/stream?url=" + encodeURIComponent(segMedia), { headers: { Range: "bytes=0-2047" } });
        const buf = Buffer.from(await r6.arrayBuffer());
        console.log("6) /api/stream segment:", Math.round((Date.now() - s)) + "ms | status:", r6.status, "| bytes:", buf.length, "| TS sync 0x47:", buf[0] === 0x47);
      }
    }
  }
})().catch((e) => { console.error("E2E FAIL:", e.message); process.exit(1); });

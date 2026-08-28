/* TubeStream — PAGINATED + PREFETCH ENGINE + TOOLTIP PREVIEW */
(function () {
  "use strict";

  /* ========== SERVICE WORKER ========== */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  /* ========== LOCALSTORAGE CACHE ========== */
  const LS_PREFIX = "ts-cache-";
  const LS_TTL = 30 * 60 * 1000;
  function lsGet(key) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > LS_TTL) { localStorage.removeItem(LS_PREFIX + key); return null; }
      return data;
    } catch (e) { return null; }
  }
  function lsSet(key, data) {
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
  }
  function lsEvict() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_PREFIX)) keys.push(k);
      }
      if (keys.length > 60) {
        keys.sort((a, b) => {
          const aTs = JSON.parse(localStorage.getItem(a) || '{}').ts || 0;
          const bTs = JSON.parse(localStorage.getItem(b) || '{}').ts || 0;
          return aTs - bTs;
        });
        for (let i = 0; i < keys.length - 50; i++) localStorage.removeItem(keys[i]);
      }
    } catch (e) {}
  }

  /* ========== DOM ELEMENTS ========== */
  const grid = document.getElementById("grid");
  const statusEl = document.getElementById("status");
  const countBadge = document.getElementById("countBadge");
  const refreshBtn = document.getElementById("refreshBtn");
  const loadMoreBtn = document.getElementById("loadMoreBtn");
  const loadMoreWrap = document.getElementById("loadMoreWrap");
  const prefetchBar = document.getElementById("prefetchBar");
  const prefetchText = document.getElementById("prefetchText");
  const searchInput = document.getElementById("searchInput");
  const searchClear = document.getElementById("searchClear");
  const categoryTabs = document.getElementById("categoryTabs");
  const paginationWrap = document.getElementById("paginationWrap");
  const pageNumbers = document.getElementById("pageNumbers");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modalTitle");
  const player = document.getElementById("player");
  const playerLoading = document.getElementById("playerLoading");
  const playerError = document.getElementById("playerError");
  const playerErrorText = document.getElementById("playerErrorText");
  const videoMeta = document.getElementById("videoMeta");
  const openOnSite = document.getElementById("openOnSite");
  const sidebarContent = document.getElementById("sidebarContent");
  const sidebarToggle = document.getElementById("sidebarToggle");
  const themeToggleBtn = document.getElementById("themeToggle");
  const backToTopBtn = document.getElementById("backToTop");
  const searchDropdown = document.getElementById("searchDropdown");
  const cardTooltip = document.getElementById("cardTooltip");
  const tooltipVideo = document.getElementById("tooltipVideo");
  const tooltipTitle = document.getElementById("tooltipTitle");
  const tooltipDuration = document.getElementById("tooltipDuration");
  const tooltipStatus = document.getElementById("tooltipStatus");

  let tooltipHls = null;
  let tooltipTimer = null;
  let tooltipTarget = null;
  let prebufferObserver = null;

  let hls = null;
  let allVideos = []; // current page videos
  let loadGeneration = 0;

  /* ========== PAGINATION STATE ========== */
  let currentCategory = "all";
  let currentPage = 1;
  const PAGES_TO_KEEP = 5;  // always keep 5 pages loaded
  const PAGE_PREFETCH_AHEAD = 1; // prefetch 1 page ahead of window
  // Map of page -> video[] (the sliding window cache)
  const pageCache = new Map();
  const pageLoading = new Set();
  const totalPagesApprox = 999; // we don't know total; use a large number

  /* ========== SEARCH STATE ========== */
  let searchMode = false;
  let searchKeyword = "";
  let searchDebounceTimer = null;
  const SEARCH_HISTORY_KEY = "ts-search-history";
  const SEARCH_HISTORY_MAX = 8;

  /* ========== PREFETCH SYSTEM ========== */
  const prefetchCache = new Map();
  let prefetchGeneration = 0;
  let prefetchTotalEver = 0;
  let prefetchDoneEver = 0;
  const PREFETCH_BATCH_SIZE = 40;
  const PREFETCH_MAX_IN_FLIGHT = 20;
  let prefetchInFlightCount = 0;

  /* ========== HELPERS ========== */
  let statusDismissTimer = null;
  function showStatus(msg, isError, autoDismissMs, retryFn) {
    if (statusDismissTimer) { clearTimeout(statusDismissTimer); statusDismissTimer = null; }
    statusEl.textContent = msg;
    statusEl.classList.toggle("hidden", !msg);
    statusEl.classList.remove("fade-out");
    statusEl.style.borderColor = isError ? "rgba(232,54,78,0.3)" : "";
    const oldRetry = statusEl.querySelector(".status-retry");
    if (oldRetry) oldRetry.remove();
    if (retryFn && isError) {
      const retryBtn = document.createElement("button");
      retryBtn.className = "status-retry";
      retryBtn.textContent = "⟳ Retry";
      retryBtn.addEventListener("click", (e) => { e.stopPropagation(); retryFn(); });
      statusEl.appendChild(retryBtn);
    }
    if (autoDismissMs && msg && !isError) {
      statusDismissTimer = setTimeout(() => {
        statusEl.classList.add("fade-out");
        setTimeout(() => { statusEl.classList.add("hidden"); statusEl.classList.remove("fade-out"); }, 300);
      }, autoDismissMs);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fullUrl(pageUrl) {
    if (!pageUrl) return "#";
    return /^https?:\/\//.test(pageUrl) ? pageUrl : "https://xhamster.com" + pageUrl;
  }

  function findCardByUrl(url) {
    const cards = grid.children;
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute("data-page-url") === url) return cards[i];
    }
    return null;
  }

  /* ========== PREFETCH ENGINE ========== */
  function enqueuePrefetch(videoUrl) {
    if (prefetchCache.has(videoUrl)) return;
    prefetchCache.set(videoUrl, { status: "pending", m3u8Url: null });
    prefetchTotalEver++;
    schedulePrefetchBatch();
  }

  function getPrefetchedM3u8(videoUrl) {
    const entry = prefetchCache.get(videoUrl);
    if (entry && entry.status === "ready" && entry.m3u8Url) return entry.m3u8Url;
    return null;
  }

  let prefetchTimer = null;
  function schedulePrefetchBatch() {
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      prefetchTimer = null;
      while (prefetchInFlightCount < PREFETCH_MAX_IN_FLIGHT) {
        let hasPending = false;
        for (const e of prefetchCache.values()) {
          if (e.status === "pending") { hasPending = true; break; }
        }
        if (!hasPending) break;
        prefetchInFlightCount++;
        drainPrefetchQueue().finally(() => {
          prefetchInFlightCount = Math.max(0, prefetchInFlightCount - 1);
        });
      }
    }, 10);
  }

  async function drainPrefetchQueue() {
    const myGen = prefetchGeneration;
    const pendingUrls = [];
    for (const [url, entry] of prefetchCache) {
      if (entry.status === "pending") {
        prefetchCache.set(url, { status: "fetching", m3u8Url: null });
        pendingUrls.push(url);
      }
      if (pendingUrls.length >= PREFETCH_BATCH_SIZE) break;
    }
    if (pendingUrls.length === 0) return;

    try {
      const res = await fetch("/api/prefetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: pendingUrls }),
      });
      const data = await res.json();
      if (myGen !== prefetchGeneration) {
        for (const url of pendingUrls) {
          const entry = prefetchCache.get(url);
          if (entry && (entry.status === "fetching" || entry.status === "pending")) {
            prefetchCache.delete(url);
            prefetchDoneEver++;
          }
        }
        updatePrefetchProgress();
        return;
      }
      if (data.success && data.results) {
        for (const url of pendingUrls) {
          const result = data.results[url];
          if (result && result.m3u8Url) {
            prefetchCache.set(url, { status: "ready", m3u8Url: result.m3u8Url });
          } else {
            prefetchCache.set(url, { status: "failed", m3u8Url: null });
          }
          prefetchDoneEver++;
          updateCardBadge(url);
        }
      } else {
        for (const url of pendingUrls) {
          prefetchCache.set(url, { status: "failed", m3u8Url: null });
          prefetchDoneEver++;
          updateCardBadge(url);
        }
      }
      updatePrefetchProgress();
    } catch (e) {
      if (myGen !== prefetchGeneration) {
        for (const url of pendingUrls) {
          const entry = prefetchCache.get(url);
          if (entry && (entry.status === "fetching" || entry.status === "pending")) {
            prefetchCache.delete(url);
            prefetchDoneEver++;
          }
        }
        updatePrefetchProgress();
        return;
      }
      for (const url of pendingUrls) {
        prefetchCache.set(url, { status: "failed", m3u8Url: null });
        prefetchDoneEver++;
        updateCardBadge(url);
      }
      updatePrefetchProgress();
    } finally {
      if (myGen === prefetchGeneration) {
        let hasPending = false;
        for (const [url, entry] of prefetchCache) {
          if (entry.status === "pending") { hasPending = true; break; }
        }
        if (hasPending) schedulePrefetchBatch();
      }
    }
  }

  function updateCardBadge(videoUrl) {
    const card = findCardByUrl(videoUrl);
    if (!card) return;
    const badge = card.querySelector(".prefetch-badge");
    if (!badge) return;
    const entry = prefetchCache.get(videoUrl);
    if (!entry) return;
    if (entry.status === "ready") {
      badge.textContent = "✓";
      badge.className = "prefetch-badge ready";
      badge.title = "HD stream ready — instant play";
    } else if (entry.status === "failed") {
      badge.textContent = "✗";
      badge.className = "prefetch-badge failed";
      badge.title = "Will use preview clip";
    } else if (entry.status === "fetching") {
      badge.textContent = "⟳";
      badge.className = "prefetch-badge fetching";
      badge.title = "Extracting stream…";
    }
  }

  function updatePrefetchProgress() {
    const total = prefetchTotalEver;
    const done = prefetchDoneEver;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (total === 0) {
      prefetchText.textContent = "⚡ Instant Play Ready";
      prefetchBar.style.width = "100%";
      prefetchBar.style.background = "linear-gradient(90deg, #22c55e, #16a34a)";
      return;
    }
    if (done >= total) {
      prefetchText.textContent = "⚡ " + total + " videos ready";
      prefetchBar.style.width = "100%";
      prefetchBar.style.background = "linear-gradient(90deg, #22c55e, #16a34a)";
    } else {
      prefetchText.textContent = "⚡ " + done + "/" + total + " streams cached";
      prefetchBar.style.width = pct + "%";
      prefetchBar.style.background = "linear-gradient(90deg, var(--accent), var(--accent-2))";
    }
  }

  function evictPrefetchCache() {
    if (prefetchCache.size <= 800) return;
    const toDelete = prefetchCache.size - 600;
    let deleted = 0;
    for (const key of prefetchCache.keys()) {
      if (deleted >= toDelete) break;
      prefetchCache.delete(key);
      deleted++;
    }
  }

  /* ========== PAGINATION: RENDER PAGE NUMBERS ========== */
  function renderPagination() {
    if (!pageNumbers) return;
    const windowStart = Math.max(1, currentPage - 2);
    const windowEnd = windowStart + 4;
    let html = "";

    // First page button
    if (windowStart > 1) {
      html += '<button class="page-num" data-page="1">1</button>';
      if (windowStart > 2) html += '<span class="page-dots">…</span>';
    }

    for (let p = windowStart; p <= windowEnd; p++) {
      const isActive = p === currentPage;
      html += '<button class="page-num' + (isActive ? " active" : "") + '" data-page="' + p + '">' + p + '</button>';
    }

    html += '<span class="page-dots">…</span>';

    pageNumbers.innerHTML = html;

    // Wire up clicks
    pageNumbers.querySelectorAll(".page-num").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = parseInt(btn.dataset.page);
        if (p && p !== currentPage) goToPage(p);
      });
    });

    // Update prev/next buttons
    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = false;
  }

  /* ========== PAGINATION: LOAD A SINGLE PAGE ========== */
  async function loadPageData(page) {
    if (pageCache.has(page)) return pageCache.get(page);
    if (pageLoading.has(page)) return [];
    pageLoading.add(page);

    try {
      if (searchMode) {
        const res = await fetch("/api/search?q=" + encodeURIComponent(searchKeyword) + "&page=" + page);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Search failed");
        const videos = data.videos || [];
        pageCache.set(page, videos);
        if (videos.length > 0) lsSet("search:" + searchKeyword + ":" + page, videos);
        return videos;
      } else {
        const res = await fetch("/api/videos?page=" + page + "&category=" + encodeURIComponent(currentCategory));
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "API error");
        const videos = data.videos || [];
        pageCache.set(page, videos);
        if (videos.length > 0) lsSet(currentCategory + ":" + page, videos);
        return videos;
      }
    } catch (e) {
      console.warn("[PageLoad] Failed:", page, e.message);
      // Try localStorage
      const lsKey = searchMode ? ("search:" + searchKeyword + ":" + page) : (currentCategory + ":" + page);
      const cached = lsGet(lsKey);
      if (cached && cached.length > 0) {
        pageCache.set(page, cached);
        return cached;
      }
      return [];
    } finally {
      pageLoading.delete(page);
    }
  }

  /* ========== PAGINATION: PREFETCH WINDOW ========== */
  async function prefetchWindow(centerPage) {
    const gen = loadGeneration;
    // Prefetch pages in the window [centerPage, centerPage + PAGES_TO_KEEP]
    const pagesToFetch = [];
    for (let p = centerPage; p < centerPage + PAGES_TO_KEEP; p++) {
      if (!pageCache.has(p) && !pageLoading.has(p)) {
        pagesToFetch.push(p);
      }
    }

    // Also prefetch 1 page ahead
    const aheadPage = centerPage + PAGES_TO_KEEP;
    if (!pageCache.has(aheadPage) && !pageLoading.has(aheadPage)) {
      pagesToFetch.push(aheadPage);
    }

    if (pagesToFetch.length === 0) return;

    // Fire all page loads in parallel
    await Promise.allSettled(pagesToFetch.map(p => loadPageData(p)));

    if (gen !== loadGeneration) return;

    // Enqueue prefetch for all new videos
    for (const p of pagesToFetch) {
      const videos = pageCache.get(p);
      if (videos) {
        for (const v of videos) {
          const url = fullUrl(v.pageUrl);
          if (url && url !== "#") enqueuePrefetch(url);
        }
      }
    }
    evictPrefetchCache();
  }

  /* ========== PAGINATION: GO TO PAGE (INSTANT CACHED) ========== */
  async function goToPage(page) {
    if (page < 1) return;
    const gen = loadGeneration;
    currentPage = page;
    renderPagination();

    // INSTANT: Show cached videos immediately (zero wait)
    const lsKey = searchMode ? ("search:" + searchKeyword + ":" + page) : (currentCategory + ":" + page);
    const lsCached = lsGet(lsKey);
    const serverCached = pageCache.get(page);
    const instantVideos = serverCached || lsCached;

    if (instantVideos && instantVideos.length > 0) {
      allVideos = instantVideos;
      renderNewCards(instantVideos);
      countBadge.textContent = instantVideos.length + " videos (page " + page + ")";
      showStatus("");
    } else {
      // No cache — show skeletons briefly
      grid.innerHTML = "";
      showSkeletons(18);
      showStatus("Loading page " + page + "…");
    }

    // Background: fetch fresh data from server (non-blocking)
    loadPageData(page).then((videos) => {
      if (gen !== loadGeneration) return;
      if (videos && videos.length > 0 && (!instantVideos || videos.length !== instantVideos.length || videos[0]?.id !== instantVideos[0]?.id)) {
        allVideos = videos;
        renderNewCards(videos);
        countBadge.textContent = videos.length + " videos (page " + page + ")";
      }
      showStatus("");
    }).catch(() => {
      if (gen !== loadGeneration) return;
      if (!instantVideos) {
        showStatus("Failed to load page " + page, true, 0, () => goToPage(page));
      }
    });

    // Prefetch next 5 pages + 1 ahead in background
    prefetchWindow(page).catch(() => {});

    // Scroll to top
    if (instantVideos) {
      grid.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ========== SKELETONS ========== */
  function showSkeletons(count) {
    let html = "";
    for (let i = 0; i < count; i++) {
      html += '<div class="skeleton-card"><div class="thumb-wrap"><div class="skeleton-thumb"></div></div><div class="skeleton-title"></div></div>';
    }
    grid.innerHTML = html;
  }

  /* ========== RENDER CARDS ========== */
  function renderNewCards(videos) {
    grid.innerHTML = "";
    videos.forEach((v, i) => {
      const card = document.createElement("div");
      card.className = "card card-animate";
      card.style.animationDelay = Math.min(i * 20, 500) + "ms";
      card.setAttribute("data-page-url", fullUrl(v.pageUrl));

      const videoUrl = fullUrl(v.pageUrl);
      const streamReady = v.stream && /^https?:\/\//.test(v.stream);
      const streamCached = !streamReady && getPrefetchedM3u8(videoUrl);
      const hasStream = streamReady || streamCached;

      card.innerHTML =
        '<div class="thumb-wrap">' +
          '<div class="shimmer-overlay"></div>' +
          (v.thumb
            ? '<img data-loading="true" src="/api/thumb?url=' + encodeURIComponent(v.thumb) + '" alt="" onload="this.removeAttribute(\'data-loading\');this.closest(\'.thumb-wrap\')?.querySelector(\'.shimmer-overlay\')?.classList.add(\'loaded\')" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';this.closest(\'.thumb-wrap\')?.querySelector(\'.shimmer-overlay\')?.classList.add(\'loaded\')" loading="lazy">'
            : '') +
          '<span class="img-placeholder" style="display:none">▶</span>' +
          (v.duration ? '<span class="card-duration">' + escapeHtml(v.duration) + "</span>" : "") +
          (hasStream
            ? '<div class="prefetch-badge ready" title="HD stream ready — instant play">⚡</div>'
            : '<div class="prefetch-badge pending" title="Queued…">⟳</div>') +
          '<div class="card-play"><span class="play-ic">▶</span></div>' +
        "</div>" +
        '<div class="card-title">' + escapeHtml(v.title || v.id) + "</div>";
      card.addEventListener("click", () => openPlayer(v));
      grid.appendChild(card);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          card.classList.add("visible");
        });
      });

      enqueuePrefetch(fullUrl(v.pageUrl));
    });
    evictPrefetchCache();
    updatePrefetchProgress();
    // Kick off prefetch batches immediately
    for (let i = 0; i < PREFETCH_MAX_IN_FLIGHT; i++) {
      if (prefetchInFlightCount >= PREFETCH_MAX_IN_FLIGHT) break;
      let hasPending = false;
      for (const e of prefetchCache.values()) {
        if (e.status === "pending") { hasPending = true; break; }
      }
      if (!hasPending) break;
      prefetchInFlightCount++;
      drainPrefetchQueue().finally(() => {
        prefetchInFlightCount = Math.max(0, prefetchInFlightCount - 1);
      });
    }
  }

  /* ========== TOOLTIP PREVIEW (YouTube-style) ========== */
  function setupTooltipPreview() {
    grid.addEventListener("mouseover", (e) => {
      const card = e.target.closest(".card");
      if (!card || card === tooltipTarget) return;
      clearTimeout(tooltipTimer);
      stopTooltipPreview();
      tooltipTarget = card;
      const videoUrl = card.getAttribute("data-page-url");
      if (!videoUrl) return;

      // Delay 800ms before showing tooltip
      tooltipTimer = setTimeout(() => showTooltipPreview(card, videoUrl), 800);
    });

    grid.addEventListener("mouseout", (e) => {
      const card = e.target.closest(".card");
      if (card && !card.contains(e.relatedTarget)) {
        clearTimeout(tooltipTimer);
        stopTooltipPreview();
        tooltipTarget = null;
      }
    });

    // Move tooltip with mouse
    grid.addEventListener("mousemove", (e) => {
      if (!cardTooltip.classList.contains("visible")) return;
      const x = e.clientX;
      const y = e.clientY;
      const tipW = 320;
      const tipH = 240;
      let left = x - tipW / 2;
      let top = y - tipH - 20;
      // Keep within viewport
      if (left < 8) left = 8;
      if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
      if (top < 8) top = y + 20; // show below cursor if no room above
      cardTooltip.style.left = left + "px";
      cardTooltip.style.top = top + "px";
    });
  }

  function showTooltipPreview(card, videoUrl) {
    // Find the video data
    const videoData = findVideoByPageUrl(videoUrl);
    if (!videoData) return;

    // Set title
    tooltipTitle.textContent = videoData.title || "Untitled";
    tooltipDuration.textContent = videoData.duration || "";

    // Set stream status
    const cachedM3u8 = getPrefetchedM3u8(videoUrl);
    const serverStream = videoData.stream && /^https?:\/\//.test(videoData.stream);

    if (serverStream || cachedM3u8) {
      tooltipStatus.innerHTML =
        '<span class="tooltip-status-icon ready">✓</span>' +
        '<span class="tooltip-status-text ready">HD Ready — Instant Play</span>';
    } else {
      const entry = prefetchCache.get(videoUrl);
      if (entry && entry.status === "fetching") {
        tooltipStatus.innerHTML =
          '<span class="tooltip-status-icon loading">⟳</span>' +
          '<span class="tooltip-status-text">Extracting stream…</span>';
      } else {
        tooltipStatus.innerHTML =
          '<span class="tooltip-status-icon pending">○</span>' +
          '<span class="tooltip-status-text">Queued for prefetch</span>';
      }
    }

    // Show tooltip
    cardTooltip.classList.remove("hidden");
    requestAnimationFrame(() => cardTooltip.classList.add("visible"));

    // Try to play preview video if stream ready
    const streamUrl = serverStream ? videoData.stream : cachedM3u8;
    if (streamUrl) {
      destroyTooltipHls();
      const proxied = "/api/stream?url=" + encodeURIComponent(streamUrl);
      if (typeof Hls !== "undefined" && Hls.isSupported()) {
        tooltipHls = new Hls({ maxBufferLength: 3, maxMaxBufferLength: 5 });
        tooltipHls.loadSource(proxied);
        tooltipHls.attachMedia(tooltipVideo);
        tooltipHls.on(Hls.Events.MANIFEST_PARSED, () => {
          tooltipVideo.play().catch(() => {});
        });
      } else if (tooltipVideo.canPlayType("application/vnd.apple.mpegurl")) {
        tooltipVideo.src = proxied;
        tooltipVideo.play().catch(() => {});
      }
    }
  }

  function stopTooltipPreview() {
    destroyTooltipHls();
    cardTooltip.classList.remove("visible");
    setTimeout(() => {
      if (!cardTooltip.classList.contains("visible")) {
        cardTooltip.classList.add("hidden");
      }
    }, 200);
    tooltipVideo.removeAttribute("src");
    try { tooltipVideo.load(); } catch(e) {}
  }

  function destroyTooltipHls() {
    if (tooltipHls) { try { tooltipHls.destroy(); } catch(e) {} tooltipHls = null; }
  }

  function findVideoByPageUrl(pageUrl) {
    // Search all videos in cache
    for (const [, videos] of pageCache) {
      for (const v of videos) {
        if (fullUrl(v.pageUrl) === pageUrl) return v;
      }
    }
    // Also search allVideos
    for (const v of allVideos) {
      if (fullUrl(v.pageUrl) === pageUrl) return v;
    }
    return null;
  }

  /* ========== CATEGORY SWITCH ========== */
  function switchCategory(catKey) {
    if (catKey === currentCategory && !searchMode) return;
    currentCategory = catKey;
    searchMode = false;
    searchKeyword = "";
    searchInput.value = "";
    searchClear.classList.add("hidden");
    const tabs = categoryTabs.querySelectorAll(".cat-tab");
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.cat === catKey));
    loadGeneration++;
    prefetchGeneration++;
    prefetchInFlightCount = 0;
    if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
    prefetchCache.clear();
    prefetchTotalEver = 0;
    prefetchDoneEver = 0;
    pageCache.clear();
    allVideos = [];
    currentPage = 1;
    updatePrefetchProgress();
    goToPage(1);
  }

  if (categoryTabs) {
    categoryTabs.addEventListener("click", (e) => {
      const tab = e.target.closest(".cat-tab");
      if (tab) switchCategory(tab.dataset.cat);
    });
  }

  /* ========== PAGINATION EVENT LISTENERS ========== */
  prevPageBtn.addEventListener("click", () => {
    if (currentPage > 1) goToPage(currentPage - 1);
  });

  nextPageBtn.addEventListener("click", () => {
    goToPage(currentPage + 1);
  });

  /* ========== SEARCH ========== */
  function enterSearchMode(keyword) {
    searchMode = true;
    searchKeyword = keyword;
    loadGeneration++;
    prefetchGeneration++;
    prefetchInFlightCount = 0;
    if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
    prefetchCache.clear();
    prefetchTotalEver = 0;
    prefetchDoneEver = 0;
    allVideos = [];
    pageCache.clear();
    currentPage = 1;
    updatePrefetchProgress();
    searchClear.classList.remove("hidden");
    goToPage(1);
  }

  function exitSearchMode() {
    searchMode = false;
    searchKeyword = "";
    searchInput.value = "";
    searchClear.classList.add("hidden");
    loadGeneration++;
    prefetchGeneration++;
    prefetchInFlightCount = 0;
    if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
    prefetchCache.clear();
    prefetchTotalEver = 0;
    prefetchDoneEver = 0;
    allVideos = [];
    pageCache.clear();
    currentPage = 1;
    updatePrefetchProgress();
    goToPage(1);
  }

  searchInput.addEventListener("input", () => {
    const val = searchInput.value.trim();
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    if (!val) { searchClear.classList.add("hidden"); renderSearchDropdown(); return; }
    searchClear.classList.remove("hidden");
    searchDropdown && searchDropdown.classList.add("hidden");
    searchDebounceTimer = setTimeout(() => { enterSearchMode(val); }, 400);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const val = searchInput.value.trim();
      if (val) {
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        addSearchHistory(val);
        searchDropdown && searchDropdown.classList.add("hidden");
        enterSearchMode(val);
      }
    }
    if (e.key === "Escape") { searchInput.blur(); if (searchMode) exitSearchMode(); searchDropdown && searchDropdown.classList.add("hidden"); }
  });

  searchInput.addEventListener("focus", () => { renderSearchDropdown(); });
  document.addEventListener("click", (e) => {
    if (searchDropdown && !searchDropdown.contains(e.target) && e.target !== searchInput) {
      searchDropdown.classList.add("hidden");
    }
  });

  searchClear.addEventListener("click", () => { exitSearchMode(); searchDropdown && searchDropdown.classList.add("hidden"); });

  /* ========== SEARCH HISTORY ========== */
  function getSearchHistory() {
    try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]"); } catch (e) { return []; }
  }
  function addSearchHistory(keyword) {
    const hist = getSearchHistory().filter(k => k !== keyword);
    hist.unshift(keyword);
    if (hist.length > SEARCH_HISTORY_MAX) hist.length = SEARCH_HISTORY_MAX;
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(hist));
  }
  function clearSearchHistory() {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
  }
  function renderSearchDropdown() {
    if (!searchDropdown) return;
    const hist = getSearchHistory();
    if (searchInput !== document.activeElement && hist.length === 0) {
      searchDropdown.classList.add("hidden");
      return;
    }
    let html = "";
    if (hist.length > 0) {
      html += '<div class="search-dropdown-header">Recent Searches</div>';
      for (const kw of hist) {
        html += '<button class="search-dropdown-item" data-kw="' + escapeHtml(kw) + '">';
        html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
        html += escapeHtml(kw) + '</button>';
      }
      html += '<button class="search-dropdown-clear" id="clearSearchHistory">Clear history</button>';
    }
    searchDropdown.innerHTML = html;
    searchDropdown.classList.remove("hidden");
    searchDropdown.querySelectorAll(".search-dropdown-item").forEach(btn => {
      btn.addEventListener("click", () => {
        searchInput.value = btn.dataset.kw;
        searchDropdown.classList.add("hidden");
        enterSearchMode(btn.dataset.kw);
      });
    });
    const clearBtn = document.getElementById("clearSearchHistory");
    if (clearBtn) clearBtn.addEventListener("click", (e) => { e.stopPropagation(); clearSearchHistory(); renderSearchDropdown(); });
  }

  /* ========== PLAYER ========== */
  let currentVideo = null;
  let currentVideoIndex = -1;
  let fallbackAttempted = false;

  async function openPlayer(v) {
    currentVideo = v;
    fallbackAttempted = false;
    modalTitle.textContent = v.title || "Video";
    videoMeta.textContent = v.id ? "ID: " + v.id : "";
    openOnSite.href = fullUrl(v.pageUrl);
    playerError.classList.add("hidden");
    playerLoading.classList.remove("hidden");
    playerLoading.querySelector("span").textContent = "Loading…";
    player.controls = true;
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    currentVideoIndex = allVideos.findIndex(vv => vv.id === v.id);
    const videoUrl = fullUrl(v.pageUrl);

    // INSTANT PATH 1: embedded stream
    if (v.stream && /^https?:\/\//.test(v.stream)) {
      playerLoading.querySelector("span").textContent = "Playing…";
      prefetchCache.set(videoUrl, { status: "ready", m3u8Url: v.stream });
      updateCardBadge(videoUrl);
      playStream(v.stream, true);
      return;
    }

    // INSTANT PATH 2: client prefetch
    const cachedM3u8 = getPrefetchedM3u8(videoUrl);
    if (cachedM3u8) {
      playerLoading.querySelector("span").textContent = "Playing…";
      playStream(cachedM3u8, true);
      return;
    }

    // INSTANT PATH 3: server cache
    try {
      const res = await fetch("/api/stream-url?url=" + encodeURIComponent(videoUrl));
      const data = await res.json();
      if (data.success && data.m3u8Url) {
        prefetchCache.set(videoUrl, { status: "ready", m3u8Url: data.m3u8Url });
        updateCardBadge(videoUrl);
        playerLoading.querySelector("span").textContent = "Playing…";
        playStream(data.m3u8Url, true);
        return;
      }
    } catch (e) { /* fall through */ }

    // SLOW PATH
    try {
      playerLoading.querySelector("span").textContent = "Extracting…";
      const res2 = await fetch("/api/stream-url?url=" + encodeURIComponent(videoUrl));
      const data2 = await res2.json();
      if (data2.success && data2.m3u8Url) {
        prefetchCache.set(videoUrl, { status: "ready", m3u8Url: data2.m3u8Url });
        updateCardBadge(videoUrl);
        playStream(data2.m3u8Url, true);
      } else {
        playStream(v.stream || v.preview || v.fallback, false);
      }
    } catch (e) {
      playStream(v.stream || v.preview || v.fallback, false);
    }
  }

  function playStream(url, isHls) {
    destroyHls();
    const proxied = "/api/stream?url=" + encodeURIComponent(url);
    if (isHls || /\.m3u8/i.test(url)) {
      if (typeof Hls !== "undefined" && Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 30 });
        hls.loadSource(proxied);
        hls.attachMedia(player);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          playerLoading.classList.add("hidden");
          player.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (e, data) => {
          if (data && data.fatal) {
            if (!fallbackAttempted && currentVideo && currentVideo.stream) {
              fallbackAttempted = true;
              playStream(currentVideo.stream, false);
            } else {
              showPlayerError("Playback error");
            }
          }
        });
      } else if (player.canPlayType("application/vnd.apple.mpegurl")) {
        player.src = proxied;
        player.onloadeddata = () => {
          playerLoading.classList.add("hidden");
          player.play().catch(() => {});
        };
        player.onerror = () => showPlayerError("Could not load stream");
      } else {
        showPlayerError("HLS not supported");
      }
    } else {
      player.src = proxied;
      player.onloadeddata = () => {
        playerLoading.classList.add("hidden");
        player.play().catch(() => {});
      };
      player.onerror = () => showPlayerError("Could not load stream");
    }
  }

  function showPlayerError(msg) {
    playerLoading.classList.add("hidden");
    playerErrorText.textContent = msg;
    playerError.classList.remove("hidden");
  }

  function destroyHls() {
    if (hls) { try { hls.destroy(); } catch(e) {} hls = null; }
    player.removeAttribute("src");
    player.load();
  }

  function closePlayer() {
    destroyHls();
    modal.classList.add("hidden");
    document.body.style.overflow = "";
  }

  /* ========== NAVIGATION ========== */
  function navigateVideo(direction) {
    if (modal.classList.contains("hidden") || allVideos.length === 0) return;
    const nextIdx = currentVideoIndex + direction;
    if (nextIdx >= 0 && nextIdx < allVideos.length) {
      openPlayer(allVideos[nextIdx]);
    }
  }

  document.addEventListener("keydown", (e) => {
    if (!modal.classList.contains("hidden")) {
      if (e.key === "Escape") closePlayer();
      if (e.key === "ArrowRight" || e.key === "j") navigateVideo(1);
      if (e.key === "ArrowLeft" || e.key === "k") navigateVideo(-1);
      return;
    }
    if (e.key === "/" && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  document.getElementById("closeBtn").addEventListener("click", closePlayer);
  document.getElementById("modalBackdrop").addEventListener("click", closePlayer);

  /* ========== REFRESH ========== */
  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    refreshBtn.classList.add("spinning");
    searchMode = false;
    searchKeyword = "";
    searchInput.value = "";
    searchClear.classList.add("hidden");
    currentCategory = "all";
    const tabs = categoryTabs ? categoryTabs.querySelectorAll(".cat-tab") : [];
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.cat === "all"));
    loadGeneration++;
    prefetchGeneration++;
    prefetchInFlightCount = 0;
    if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
    prefetchCache.clear();
    prefetchTotalEver = 0;
    prefetchDoneEver = 0;
    allVideos = [];
    pageCache.clear();
    currentPage = 1;
    updatePrefetchProgress();
    try {
      showStatus("Refreshing…");
      await fetch("/api/refresh");
      goToPage(1);
    } catch (e) {
      showStatus("Refresh failed: " + e.message, true);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("spinning");
    }
  });

  /* ========== BACK TO TOP ========== */
  if (backToTopBtn) {
    window.addEventListener("scroll", () => {
      if (window.scrollY > 600) backToTopBtn.classList.add("show");
      else backToTopBtn.classList.remove("show");
    }, { passive: true });
    backToTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* ========== THEME ========== */
  function initTheme() {
    const saved = localStorage.getItem("ts-theme");
    if (saved === "light") document.body.classList.add("light");
    else document.body.classList.remove("light");
  }
  initTheme();
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      document.body.classList.toggle("light");
      localStorage.setItem("ts-theme", document.body.classList.contains("light") ? "light" : "dark");
    });
  }

  /* ========== SIDEBAR ========== */
  async function loadSidebar() {
    try {
      const res = await fetch("/api/categories/full");
      const data = await res.json();
      if (!data.success || !data.groups) return;
      let html = "";
      for (const group of data.groups) {
        html += '<div class="sidebar-group open">';
        html += '<div class="sidebar-group-header" onclick="this.parentElement.classList.toggle(\'open\')">';
        html += '<span>' + escapeHtml(group.name) + '</span><span class="arrow">›</span>';
        html += '</div>';
        html += '<div class="sidebar-group-items">';
        for (const item of group.items) {
          html += '<button class="sidebar-item" data-cat="' + escapeHtml(item.key) + '" title="' + escapeHtml(item.label) + '">';
          html += escapeHtml(item.label);
          html += '</button>';
        }
        html += '</div></div>';
      }
      sidebarContent.innerHTML = html;
      sidebarContent.querySelectorAll(".sidebar-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          switchCategory(btn.dataset.cat);
          sidebarContent.querySelectorAll(".sidebar-item").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          const tabs = categoryTabs.querySelectorAll(".cat-tab");
          tabs.forEach((t) => t.classList.toggle("active", t.dataset.cat === btn.dataset.cat));
        });
      });
    } catch (e) { /* ignore */ }
  }
  loadSidebar();

  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => {
      const sidebar = document.getElementById("sidebar");
      if (!sidebar) return;
      if (window.innerWidth <= 900) {
        sidebar.classList.toggle("mobile-collapsed");
      } else {
        sidebar.classList.toggle("collapsed");
      }
    });
  }

  function checkSidebarMobile() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    if (window.innerWidth <= 900) {
      sidebar.classList.add("mobile-collapsed");
    } else {
      sidebar.classList.remove("mobile-collapsed");
      sidebar.classList.remove("collapsed");
    }
  }
  checkSidebarMobile();
  window.addEventListener("resize", checkSidebarMobile);

  /* ========== PREBUFFERING ========== */
  function setupPrebuffering() {
    prebufferObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const card = entry.target;
          const videoUrl = card.getAttribute("data-page-url");
          if (videoUrl && !prefetchCache.has(videoUrl)) {
            fetch("/api/prebuffer?url=" + encodeURIComponent(videoUrl)).catch(() => {});
            enqueuePrefetch(videoUrl);
          }
          prebufferObserver.unobserve(card);
        }
      }
    }, { rootMargin: "400px" });
    const observeNewCards = () => {
      grid.querySelectorAll(".card:not([data-prebuffered])").forEach((card) => {
        card.setAttribute("data-prebuffered", "1");
        prebufferObserver.observe(card);
      });
    };
    const mutObs = new MutationObserver(observeNewCards);
    mutObs.observe(grid, { childList: true });
    observeNewCards();
  }

  /* ========== INIT ========== */
  async function loadStreamMap() {
    try {
      const res = await fetch("/api/stream-map");
      const data = await res.json();
      if (data.success && data.streams) {
        const count = Object.keys(data.streams).length;
        for (const [url, m3u8] of Object.entries(data.streams)) {
          prefetchCache.set(url, { status: "ready", m3u8Url: m3u8 });
        }
        prefetchTotalEver = count;
        prefetchDoneEver = count;
        updatePrefetchProgress();
        console.log("[StreamMap] Loaded", count, "streams for instant play");
      }
    } catch (e) { console.warn("[StreamMap] Failed:", e.message); }
  }

  (async () => {
    // STEP 1: Fire stream-map load in background (non-blocking)
    loadStreamMap().catch(() => {});

    // STEP 2: Setup UI + show cached page INSTANTLY (zero wait)
    setupPrebuffering();
    setupTooltipPreview();
    goToPage(1);

    // Auto-refresh stream map every 5s
    setInterval(async () => {
      try {
        const res = await fetch("/api/stream-map");
        const data = await res.json();
        if (data.success && data.streams) {
          let newCount = 0;
          for (const [url, m3u8] of Object.entries(data.streams)) {
            if (!prefetchCache.has(url)) {
              prefetchCache.set(url, { status: "ready", m3u8Url: m3u8 });
              newCount++;
              updateCardBadge(url);
            }
          }
          if (newCount > 0) {
            prefetchDoneEver += newCount;
            prefetchTotalEver += newCount;
            updatePrefetchProgress();
          }
        }
      } catch (e) { /* ignore */ }
    }, 5000);
  })();

  window.addEventListener("beforeunload", () => {
    if (prefetchTimer) clearTimeout(prefetchTimer);
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  });
})();

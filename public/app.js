/* TubeStream — ZERO-WAIT PLAYER + RANDOM FEED (no prefetch engine) */
(function () {
  "use strict";

  /* ========== SERVICE WORKER ========== */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  /* ========== DOM ELEMENTS ========== */
  const grid = document.getElementById("grid");
  const statusEl = document.getElementById("status");
  const countBadge = document.getElementById("countBadge");
  const refreshBtn = document.getElementById("refreshBtn");
  const searchInput = document.getElementById("searchInput");
  const searchClear = document.getElementById("searchClear");
  const categoryTabs = document.getElementById("categoryTabs");
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

  let hls = null;
  let tooltipHls = null;
  let tooltipTimer = null;
  let tooltipTarget = null;
  let allVideos = [];
  let loadGeneration = 0;

  /* ========== STATE ========== */
  let currentCategory = "all";
  let currentPage = 1;
  const pageCache = new Map();   // page -> video[] (session memory only)
  const pageLoading = new Map(); // page -> in-flight promise

  // Session memo of resolved m3u8 URLs — re-clicks play instantly.
  // This is memoization of URLs already clicked, NOT prefetching.
  const resolvedStreams = new Map();

  // Gentle warmer: URLs already sent to /api/warm this session (dedupe)
  const warmSent = new Set();

  /* ========== SEARCH STATE ========== */
  let searchMode = false;
  let searchKeyword = "";
  let searchDebounceTimer = null;
  const SEARCH_HISTORY_KEY = "ts-search-history";
  const SEARCH_HISTORY_MAX = 8;

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

  function thumbProxy(url) {
    return "/api/thumb?url=" + encodeURIComponent(url);
  }

  /* ========== DATA LOADING ========== */
  async function loadPageData(page) {
    if (pageCache.has(page)) return pageCache.get(page);
    if (pageLoading.has(page)) return pageLoading.get(page); // join the in-flight load
    const load = (async () => {
      let url;
      if (searchMode) {
        url = "/api/search?q=" + encodeURIComponent(searchKeyword) + "&page=" + page;
      } else {
        url = "/api/videos?page=" + page + "&category=" + encodeURIComponent(currentCategory);
      }
      const res = await fetch(url);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "API error");
      const videos = data.videos || [];
      pageCache.set(page, videos);
      return videos;
    })()
      .finally(() => pageLoading.delete(page));
    pageLoading.set(page, load);
    return load;
  }

  /* ========== PAGINATION: RENDER PAGE NUMBERS ========== */
  function renderPagination() {
    if (!pageNumbers) return;
    const windowStart = Math.max(1, currentPage - 2);
    const windowEnd = windowStart + 4;
    let html = "";

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

    pageNumbers.querySelectorAll(".page-num").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = parseInt(btn.dataset.page);
        if (p && p !== currentPage) goToPage(p);
      });
    });

    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = false;
  }

  /* ========== PAGINATION: GO TO PAGE (instant from session cache) ========== */
  async function goToPage(page) {
    if (page < 1) return;
    const gen = loadGeneration;
    currentPage = page;
    renderPagination();

    const cachedVids = pageCache.get(page);
    if (cachedVids && cachedVids.length > 0) {
      allVideos = cachedVids;
      renderNewCards(cachedVids);
      countBadge.textContent = cachedVids.length + " videos (page " + page + ")";
      showStatus("");
    } else {
      grid.innerHTML = "";
      showSkeletons(18);
      showStatus("Loading page " + page + "…");
    }

    try {
      const videos = await loadPageData(page);
      if (gen !== loadGeneration) return;
      // If cached content is already on screen, don't reshuffle it under the user.
      // Fresh data only fills in the skeleton path.
      if (!cachedVids || cachedVids.length === 0) {
        if (videos && videos.length > 0) {
          allVideos = videos;
          renderNewCards(videos);
          countBadge.textContent = videos.length + " videos (page " + page + ")";
          showStatus("");
        } else {
          // Empty category page — server may still be fetching it; auto-retry once
          showStatus("Loading " + (searchMode ? "results" : currentCategory) + " videos…", false);
          setTimeout(() => {
            if (gen !== loadGeneration) return;
            if (!pageCache.get(page) || pageCache.get(page).length === 0) {
              pageCache.delete(page);
              goToPage(page);
            }
          }, 4500);
        }
      }
    } catch (e) {
      if (gen !== loadGeneration) return;
      if (!cachedVids || cachedVids.length === 0) {
        showStatus("Failed to load page " + page + ": " + e.message, true, 0, () => goToPage(page));
      }
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

      card.innerHTML =
        '<div class="thumb-wrap">' +
          '<div class="shimmer-overlay"></div>' +
          (v.thumb
            ? '<img data-loading="true" src="' + thumbProxy(v.thumb) + '" alt="" loading="lazy" onload="this.removeAttribute(\'data-loading\');this.closest(\'.thumb-wrap\')?.querySelector(\'.shimmer-overlay\')?.classList.add(\'loaded\')" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';this.closest(\'.thumb-wrap\')?.querySelector(\'.shimmer-overlay\')?.classList.add(\'loaded\')">'
            : '') +
          '<span class="img-placeholder" style="display:none">▶</span>' +
          (v.duration ? '<span class="card-duration">' + escapeHtml(v.duration) + "</span>" : "") +
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
    });

    // Gentle warmer: hand the current viewport's videos to the server's paced queue
    // (1-at-a-time on the server) so clicking a visible video is a cache-hit.
    const warmUrls = videos.slice(0, 12)
      .map(v => fullUrl(v.pageUrl))
      .filter(u => u && u !== "#" && !warmSent.has(u));
    if (warmUrls.length > 0) {
      warmUrls.forEach(u => warmSent.add(u));
      fetch("/api/warm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: warmUrls }),
      }).catch(() => {});
    }
  }

  /* ========== TOOLTIP PREVIEW (only for cards with a fresh server stream) ========== */
  function setupTooltipPreview() {
    grid.addEventListener("mouseover", (e) => {
      const card = e.target.closest(".card");
      if (!card || card === tooltipTarget) return;
      clearTimeout(tooltipTimer);
      stopTooltipPreview();
      tooltipTarget = card;
      const videoUrl = card.getAttribute("data-page-url");
      if (!videoUrl) return;
      tooltipTimer = setTimeout(() => showTooltipPreview(card, videoUrl), 700);
    });

    grid.addEventListener("mouseout", (e) => {
      const card = e.target.closest(".card");
      if (card && !card.contains(e.relatedTarget)) {
        clearTimeout(tooltipTimer);
        stopTooltipPreview();
        tooltipTarget = null;
      }
    });

    grid.addEventListener("mousemove", (e) => {
      if (!cardTooltip.classList.contains("visible")) return;
      const x = e.clientX;
      const y = e.clientY;
      const tipW = 320;
      const tipH = 240;
      let left = x - tipW / 2;
      let top = y - tipH - 20;
      if (left < 8) left = 8;
      if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
      if (top < 8) top = y + 20;
      cardTooltip.style.left = left + "px";
      cardTooltip.style.top = top + "px";
    });
  }

  function showTooltipPreview(card, videoUrl) {
    const videoData = findVideoByPageUrl(videoUrl);
    if (!videoData) return;

    tooltipTitle.textContent = videoData.title || "Untitled";
    tooltipDuration.textContent = videoData.duration || "";
    tooltipStatus.innerHTML =
      '<span class="tooltip-status-icon ready">▶</span>' +
      '<span class="tooltip-status-text ready">Click to play instantly</span>';

    cardTooltip.classList.remove("hidden");
    requestAnimationFrame(() => cardTooltip.classList.add("visible"));

    // Only auto-preview when a FRESH stream is already known — zero extra fetching
    const streamUrl = videoData.stream || resolvedStreams.get(videoUrl);
    if (streamUrl && /^https?:\/\//.test(streamUrl)) {
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
    try { tooltipVideo.load(); } catch (e) {}
  }

  function destroyTooltipHls() {
    if (tooltipHls) { try { tooltipHls.destroy(); } catch (e) {} tooltipHls = null; }
  }

  function findVideoByPageUrl(pageUrl) {
    const cached = pageCache.get(currentPage);
    if (cached) {
      for (const v of cached) if (fullUrl(v.pageUrl) === pageUrl) return v;
    }
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
    pageCache.clear();
    allVideos = [];
    currentPage = 1;
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
    allVideos = [];
    pageCache.clear();
    currentPage = 1;
    searchClear.classList.remove("hidden");
    goToPage(1);
  }

  function exitSearchMode() {
    searchMode = false;
    searchKeyword = "";
    searchInput.value = "";
    searchClear.classList.add("hidden");
    loadGeneration++;
    allVideos = [];
    pageCache.clear();
    currentPage = 1;
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

  /* ========== PLAYER — ZERO WAIT ========== */
  let currentVideo = null;
  let currentVideoIndex = -1;
  let recoveryAttempted = false;

  // Hide the spinner the moment real frames hit the screen
  player.addEventListener("playing", () => {
    playerLoading.classList.add("hidden");
  });
  player.addEventListener("error", () => {
    // Native-path failure — try fresh-URL recovery once (ignore spurious events
    // from destroy/load resets and events after the modal is closed)
    if (modal.classList.contains("hidden")) return;
    if (!player.error || !player.error.code) return;
    if (!recoveryAttempted && currentVideo) handlePlaybackFailure();
  });

  async function openPlayer(v) {
    currentVideo = v;
    recoveryAttempted = false;
    modalTitle.textContent = v.title || "Video";
    videoMeta.textContent = v.id ? "ID: " + v.id : "";
    openOnSite.href = fullUrl(v.pageUrl);
    playerError.classList.add("hidden");
    playerLoading.classList.remove("hidden");
    playerLoading.querySelector("span").textContent = "Starting…";
    player.controls = true;
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    currentVideoIndex = allVideos.findIndex(vv => vv.id === v.id);

    const videoUrl = fullUrl(v.pageUrl);

    // ZERO-WAIT PATH 1: server attached a fresh m3u8 to the card → play NOW
    if (v.stream && /^https?:\/\//.test(v.stream)) {
      resolvedStreams.set(videoUrl, v.stream);
      playStream(v.stream);
      return;
    }

    // ZERO-WAIT PATH 2: already resolved in this session → play NOW
    const memo = resolvedStreams.get(videoUrl);
    if (memo) {
      playStream(memo);
      return;
    }

    // RESOLVE PATH: server answers from its fresh cache (<50ms) or race-resolves (<2s)
    await resolveAndPlay(v, false);
  }

  async function resolveAndPlay(v, forceRefresh) {
    const videoUrl = fullUrl(v.pageUrl);
    try {
      playerLoading.querySelector("span").textContent = forceRefresh ? "Getting fresh stream…" : "Starting…";
      const res = await fetch("/api/stream-url?url=" + encodeURIComponent(videoUrl) + (forceRefresh ? "&refresh=1" : ""));
      const data = await res.json();
      if (data.success && data.m3u8Url) {
        resolvedStreams.set(videoUrl, data.m3u8Url);
        // User may have closed the modal or moved on while we resolved
        if (currentVideo && fullUrl(currentVideo.pageUrl) === videoUrl && !modal.classList.contains("hidden")) {
          playStream(data.m3u8Url);
        }
        return true;
      }
    } catch (e) { /* fall through */ }
    if (!forceRefresh) return resolveAndPlay(v, true);
    showPlayerError("Could not load this stream — try another video.");
    return false;
  }

  function handlePlaybackFailure() {
    if (recoveryAttempted) { showPlayerError("Could not load this stream — try another video."); return; }
    recoveryAttempted = true;
    if (currentVideo) resolveAndPlay(currentVideo, true);
  }

  let playWatchdog = null;

  function startPlayWatchdog() {
    stopPlayWatchdog();
    let ticks = 0;
    playWatchdog = setInterval(() => {
      if (modal.classList.contains("hidden")) { stopPlayWatchdog(); return; }
      if (!player.paused && player.currentTime > 0.05) { stopPlayWatchdog(); return; }
      if (++ticks > 30) { stopPlayWatchdog(); return; } // ~9s max
      // Chrome sometimes leaves play() pending forever even with data buffered — nudge it
      const p = player.play();
      if (p && p.then) {
        p.then(() => { if (player.muted) player.muted = false; })
         .catch(() => {
           // autoplay policy fallback: start muted, restore sound on first frame
           player.muted = true;
           player.play().then(() => { player.muted = false; }).catch(() => {});
         });
      }
    }, 300);
  }

  function stopPlayWatchdog() {
    if (playWatchdog) { clearInterval(playWatchdog); playWatchdog = null; }
  }

  function playStream(url) {
    destroyHls();
    const proxied = "/api/stream?url=" + encodeURIComponent(url);
    const isHlsUrl = /\.m3u8($|\?)/i.test(url) || /mpegurl/i.test(url);

    if (isHlsUrl) {
      if (typeof Hls !== "undefined" && Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          startLevel: 0, // start at the smallest rendition — first frame in ~0.3s, ABR ramps up
          maxBufferLength: 15,
          maxMaxBufferLength: 60,
        });
        hls.loadSource(proxied);
        hls.attachMedia(player);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          const pp = player.play();
          if (pp && pp.catch) pp.catch(() => {});
          startPlayWatchdog();
        });
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          // First data in buffer → nudge play() immediately (don't wait for watchdog ticks)
          if (player.paused && !modal.classList.contains("hidden")) {
            const p = player.play();
            if (p && p.catch) p.catch(() => {});
          }
        });
        hls.on(Hls.Events.ERROR, (e, data) => {
          if (data && data.fatal) {
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              try { hls.recoverMediaError(); } catch (err) { handlePlaybackFailure(); }
            } else {
              handlePlaybackFailure();
            }
          }
        });
      } else if (player.canPlayType("application/vnd.apple.mpegurl")) {
        player.src = proxied;
        player.play().catch(() => {});
        startPlayWatchdog();
      } else {
        showPlayerError("HLS not supported in this browser");
      }
    } else {
      player.src = proxied;
      player.play().catch(() => {});
      startPlayWatchdog();
    }
  }

  function showPlayerError(msg) {
    playerLoading.classList.add("hidden");
    playerErrorText.textContent = msg;
    playerError.classList.remove("hidden");
  }

  function destroyHls() {
    stopPlayWatchdog();
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    player.removeAttribute("src");
    try { player.load(); } catch (e) {}
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

  /* ========== REFRESH (server queues a paced feed refresh) ========== */
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
    allVideos = [];
    pageCache.clear();
    currentPage = 1;
    try {
      showStatus("Refreshing…");
      await fetch("/api/refresh");
      goToPage(1);
      // Feed refresh completes server-side within ~10-20s — pull fresh page 1 once more
      const gen = loadGeneration;
      setTimeout(() => {
        if (gen !== loadGeneration) return;
        pageCache.delete(1);
        if (currentPage === 1 && !searchMode && currentCategory === "all") goToPage(1);
      }, 12000);
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

  /* ========== INIT — instant first paint from server cache ========== */
  setupTooltipPreview();
  goToPage(1);

  window.addEventListener("beforeunload", () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  });
})();

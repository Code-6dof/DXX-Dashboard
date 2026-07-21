/**
 * DXX Dashboard — Main Application
 *
 * Loads data from Firestore, renders all views (All, 1v1, FFA, Leaderboard),
 * handles navigation, pagination, and real-time updates.
 */
(async function DXXApp() {
  "use strict";

  // ── State ──────────────────────────────────────────────────────
  let games = []; // Currently displayed games
  let players = [];
  let gameMeta = null; // { totalGames, totalPlayers, duels, ffa }
  let currentMode = "all";
  let currentPage = 1;
  let duelPage = 1;
  let ffaPage = 1;
  const PAGE_SIZE = 100;
  const CARD_PAGE_SIZE = 50;
  let isLoading = false;
  let renderDebounceTimer = null;

  const ARCHIVE_BASE = "https://retro-tracker.game-server.cc/archive";
  // Use relative URLs so it works on both local and production
  const API_BASE = "";

  // ── Generate unique game ID ────────────────────────────────────
  function generateGameId(game, index) {
    // Return existing ID if present
    if (game.id) return game.id;
    
    // Generate from timestamp + first player name
    const ts = new Date(game.timestamp).getTime();
    const player = game.players && game.players[0] ? game.players[0].name : 'unknown';
    const hash = (ts + player).split('').reduce((a, c) => ((a << 5) - a) + c.charCodeAt(0) | 0, 0);
    const base62 = Math.abs(hash).toString(36);
    return `g${base62}${index.toString(36)}`;
  }

  // Ensure all games have IDs
  function ensureGameIds() {
    games.forEach((g, i) => {
      if (!g.id) g.id = generateGameId(g, i);
    });
  }

  // ── State: Firebase games ──
  let firebaseGames = []; // Games from Firestore (post Feb 10 2026)
  let firebaseLoaded = false;

  // ── Load Metadata (counts only) ───────────────────────────────
  async function loadMetadata() {
    const progressText = document.getElementById('loadingProgress');
    const loadingTextEl = document.getElementById('loadingText');
    
    try {
      loadingTextEl.textContent = 'Loading game statistics...';
      progressText.textContent = 'Fetching metadata';
      
      // Fetch both archive meta and Firebase count in parallel
      const [metaResp, fbResp] = await Promise.all([
        fetch(`${API_BASE}/api/games/meta`),
        fetch(`${API_BASE}/api/firebase/count`).catch(() => null),
      ]);

      if (!metaResp.ok) throw new Error(`HTTP ${metaResp.status}`);
      gameMeta = await metaResp.json();

      // Add Firebase count to total
      let fbCount = 0;
      if (fbResp && fbResp.ok) {
        const fbData = await fbResp.json();
        fbCount = fbData.count || 0;
      }
      gameMeta.firebaseGames = fbCount;
      gameMeta.totalGames += fbCount;

      progressText.textContent = `Found ${gameMeta.totalGames.toLocaleString()} games in archive`;
      console.log('Metadata loaded:', gameMeta);
      return gameMeta;
    } catch (err) {
      console.error('Error loading metadata:', err);
      throw err;
    }
  }

  // ── Load Firebase Games (all recent games) ─────────────────────
  async function loadFirebaseGames() {
    try {
      const resp = await fetch(`${API_BASE}/api/firebase/games?limit=200`);
      if (!resp.ok) return [];
      const data = await resp.json();
      firebaseGames = data.games || [];
      firebaseLoaded = true;
      console.log(`Firebase: loaded ${firebaseGames.length} recent games`);
      return firebaseGames;
    } catch (err) {
      console.warn('Firebase games fetch failed:', err.message);
      return [];
    }
  }

  // ── Load Paginated Games ───────────────────────────────────────
  async function loadGames(page = 1, limit = PAGE_SIZE) {
    const progressText = document.getElementById('loadingProgress');
    const loadingTextEl = document.getElementById('loadingText');
    
    try {
      loadingTextEl.textContent = `Loading page ${page}...`;
      progressText.textContent = `Fetching ${limit} games`;
      
      // On first page, also fetch Firebase games (they're all newer)
      if (page === 1 && !firebaseLoaded) {
        await loadFirebaseGames();
      }

      const response = await fetch(`${API_BASE}/api/games?page=${page}&limit=${limit}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const data = await response.json();

      // First page: prepend Firebase games (newest) before archive games
      if (page === 1 && firebaseGames.length > 0) {
        games = [...firebaseGames, ...data.games];
      } else {
        games = data.games;
      }
      players = data.players;
      
      const totalArchivePages = data.pagination ? data.pagination.totalPages : 1;
      progressText.textContent = `Loaded ${games.length} games (page ${page})`;
      console.log(`Loaded page ${page}: ${games.length} games (${firebaseGames.length} firebase + ${data.games.length} archive)`);
      return data;
    } catch (err) {
      console.error('Error loading games:', err);
      throw err;
    }
  }

  // ── Load More Games (next page) ────────────────────────────────
  async function loadMoreGames() {
    if (isLoading || !gameMeta) return false;
    
    // Archive pages only — Firebase games are all loaded on page 1
    const archiveGamesLoaded = games.length - firebaseGames.length;
    const archiveTotal = gameMeta.totalGames - (gameMeta.firebaseGames || 0);
    const nextPage = Math.floor(archiveGamesLoaded / PAGE_SIZE) + 1;
    const totalPages = Math.ceil(archiveTotal / PAGE_SIZE);
    
    if (nextPage > totalPages) return false;
    
    isLoading = true;
    try {
      const response = await fetch(`${API_BASE}/api/games?page=${nextPage}&limit=${PAGE_SIZE}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      
      // Only append archive games (Firebase already prepended)
      games = games.concat(data.games);
      players = data.players;
      DXXFilters.setData(games, players, gameMeta);
      console.log(`Loaded archive page ${nextPage}: now have ${games.length} games total`);
      return true;
    } catch (err) {
      console.error('Error loading more games:', err);
      return false;
    } finally {
      isLoading = false;
    }
  }

  async function loadPlayers() {
    // Players are loaded together with games
    return players;
  }

  // ── Utility: HTML escape ───────────────────────────────────────
  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  function formatDate(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function formatDateTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function getWinner(playersList) {
    if (!playersList || playersList.length === 0) return null;
    return playersList.reduce((best, p) => (p.kills > best.kills ? p : best), playersList[0]);
  }

  // ── Render Stats Bar ───────────────────────────────────────────
  function renderStatsBar(filtered) {
    const totalGamesEl = document.getElementById("totalGames");
    if (!totalGamesEl) return; // Stats bar not present on this page

    // Show total from metadata and current loaded
    const displayText = gameMeta 
      ? `${filtered.length.toLocaleString()} / ${gameMeta.totalGames.toLocaleString()}`
      : filtered.length.toLocaleString();
    totalGamesEl.textContent = displayText;
    
    // Check if filters are active
    const searchEl = document.getElementById("searchInput");
    const yearEl = document.getElementById("yearFilter");
    const monthEl = document.getElementById("monthFilter");
    const mapEl = document.getElementById("mapFilter");
    const versionEl = document.getElementById("versionFilter");
    
    const hasActiveFilters = 
      (searchEl && searchEl.value) ||
      (yearEl && yearEl.value) ||
      (monthEl && monthEl.value) ||
      (mapEl && mapEl.value) ||
      (versionEl && versionEl.value);
    
    const notAllLoaded = gameMeta && games.length < gameMeta.totalGames;
    
    totalGamesEl.title = gameMeta 
      ? `Showing ${filtered.length} of ${gameMeta.totalGames} total games${notAllLoaded ? ` (${games.length.toLocaleString()} loaded)` : ''}`
      : `${filtered.length} games`;
    
    // Add warning indicator if filtering with incomplete data
    if (hasActiveFilters && notAllLoaded) {
      totalGamesEl.style.color = 'var(--orange, #ff9800)';
      totalGamesEl.title += '\n⚠️ Filters apply to loaded games only. Click "Apply" to load more.';
    } else {
      totalGamesEl.style.color = '';
    }

    const uniquePlayers = new Set();
    let totalKills = 0;
    filtered.forEach((g) => {
      if (g.players) {
        g.players.forEach((p) => {
          uniquePlayers.add(p.name);
          totalKills += p.kills || 0;
        });
      }
    });
    
    const totalPlayersEl = document.getElementById("totalPlayers");
    const total1v1El = document.getElementById("total1v1");
    const totalFFAEl = document.getElementById("totalFFA");
    const totalKillsEl = document.getElementById("totalKills");
    
    if (totalPlayersEl) totalPlayersEl.textContent = uniquePlayers.size.toLocaleString();
    if (total1v1El) total1v1El.textContent = filtered.filter((g) => g.gameType === "1v1").length.toLocaleString();
    if (totalFFAEl) totalFFAEl.textContent = filtered.filter((g) => g.gameType === "ffa").length.toLocaleString();
    if (totalKillsEl) totalKillsEl.textContent = totalKills.toLocaleString();
  }

  // ── Render Charts ──────────────────────────────────────────────
  function renderCharts(filtered) {
    // Games over time by month
    const monthCounts = {};
    filtered.forEach((g) => {
      if (g.timestamp) {
        const m = g.timestamp.slice(0, 7);
        if (m !== "1970-01") monthCounts[m] = (monthCounts[m] || 0) + 1;
      }
    });
    DXXCharts.renderGamesOverTime(monthCounts);

    // Mode distribution
    const modeCounts = { "1v1": 0, ffa: 0 };
    filtered.forEach((g) => {
      if (g.gameType === "1v1") modeCounts["1v1"]++;
      else modeCounts["ffa"]++;
    });
    DXXCharts.renderModeDist(modeCounts);

    // Top players - recalculate from filtered games
    const playerStatsMap = new Map();
    filtered.forEach((g) => {
      if (!g.players) return;
      g.players.forEach((p) => {
        if (!playerStatsMap.has(p.name)) {
          playerStatsMap.set(p.name, {
            name: p.name,
            totalKills: 0,
            totalDeaths: 0,
            totalSuicides: 0,
            gamesPlayed: 0,
          });
        }
        const stats = playerStatsMap.get(p.name);
        stats.totalKills += p.kills || 0;
        stats.totalDeaths += p.deaths || 0;
        stats.totalSuicides += p.suicides || 0;
        stats.gamesPlayed++;
      });
    });
    const filteredPlayers = Array.from(playerStatsMap.values())
      .sort((a, b) => b.totalKills - a.totalKills);
    DXXCharts.renderTopPlayers(filteredPlayers);

    // Top maps
    const mapCounts = {};
    filtered.forEach((g) => {
      if (g.map && g.map !== "Unknown") {
        mapCounts[g.map] = (mapCounts[g.map] || 0) + 1;
      }
    });
    DXXCharts.renderTopMaps(mapCounts);

    // Day of week distribution
    const dayCounts = {};
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    filtered.forEach((g) => {
      if (g.timestamp) {
        const date = new Date(g.timestamp);
        const dayName = dayNames[date.getDay()];
        dayCounts[dayName] = (dayCounts[dayName] || 0) + 1;
      }
    });
    DXXCharts.renderDayOfWeek(dayCounts);
  }

  // ── Render All Games Table ─────────────────────────────────────
  function renderGamesTable(filtered) {
    const start = (currentPage - 1) * PAGE_SIZE;
    const page = filtered.slice(start, start + PAGE_SIZE);
    const tbody = document.getElementById("gamesBody");
    tbody.innerHTML = "";

    if (page.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-dim);padding:2rem">No games match your filters.</td></tr>';
      document.getElementById("pagination").innerHTML = "";
      return;
    }

    // Use DocumentFragment for faster DOM building
    const fragment = document.createDocumentFragment();
    page.forEach((g, idx) => {
      const winner = getWinner(g.players);
      const modeClass = g.gameType === "1v1" ? "mode-1v1" : "mode-ffa";
      const modeLabel = g.gameType === "1v1" ? "1v1" : "FFA";
      const versionClass = (g.version || "").includes("D2") ? "version-d2" : "version-d1";
      const versionLabel = g.version || "—";
      const playerNames = g.players ? g.players.map((p) => p.name).join(", ") : "";
      const truncatedPlayers = playerNames.length > 45 ? playerNames.slice(0, 45) + "…" : playerNames;
      
      // Determine if this is a local match or has retro tracker link
      const hasRetroLink = !!g.filename;
      const archiveLink = hasRetroLink ? `${ARCHIVE_BASE}/${g.filename}` : null;
      const gameUrl = `game.html?id=${encodeURIComponent(g.id)}`;

      const tr = document.createElement('tr');
      tr.className = 'game-row';
      tr.dataset.gameIdx = start + idx;
      tr.style.cursor = 'pointer';
      tr.title = hasRetroLink ? 'Click to view match details' : 'Click to view match details (locally tracked)';
      tr.innerHTML = `
          <td>${formatDateTime(g.timestamp)}</td>
          <td><strong>${esc(g.map)}</strong></td>
          <td><span class="mode-badge ${modeClass}">${modeLabel}</span></td>
          <td><span class="version-badge ${versionClass}">${esc(versionLabel)}</span></td>
          <td title="${esc(playerNames)}">${esc(truncatedPlayers)}</td>
          <td>${esc(g.timeElapsed || "—")}</td>
          <td>${winner ? esc(winner.name) + " <span style='color:var(--green)'>" + winner.kills + "K</span>" : "—"}</td>
          <td>
            ${hasRetroLink 
              ? `<a href="${archiveLink}" target="_blank" class="ext-link" title="View on Retro Tracker" onclick="event.stopPropagation()">↗</a>` 
              : `<span style="color:var(--text-muted);font-size:0.75rem" title="Locally tracked match">Local</span>`}
          </td>`;
      tr.addEventListener("click", () => {
        window.location.href = gameUrl;
      });
      fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);

    renderPagination("pagination", filtered.length, currentPage, PAGE_SIZE, (p) => {
      currentPage = p;
      renderGamesTable(filtered);
    });
  }

  // ── Render 1v1 Duel Cards ──────────────────────────────────────
  function renderDuels(filtered) {
    const duels = filtered.filter((g) => g.gameType === "1v1");
    const start = (duelPage - 1) * CARD_PAGE_SIZE;
    const page = duels.slice(start, start + CARD_PAGE_SIZE);
    const container = document.getElementById("duelList");
    container.innerHTML = "";

    if (page.length === 0) {
      container.innerHTML = '<p style="color:var(--text-dim)">No 1v1 duels found with current filters.</p>';
      document.getElementById("duelPagination").innerHTML = "";
      return;
    }

    const fragment = document.createDocumentFragment();
    page.forEach((g, idx) => {
      const p1 = (g.players && g.players[0]) || { name: "?", kills: 0, deaths: 0, suicides: 0 };
      const p2 = (g.players && g.players[1]) || { name: "?", kills: 0, deaths: 0, suicides: 0 };
      const p1Wins = p1.kills > p2.kills;
      const tied = p1.kills === p2.kills;
      const hasRetroLink = !!g.filename;
      const archiveLink = hasRetroLink ? `${ARCHIVE_BASE}/${g.filename}` : null;
      const gameUrl = `game.html?id=${encodeURIComponent(g.id)}`;

      const div = document.createElement('div');
      div.className = 'duel-card clickable-card';
      div.dataset.duelIdx = start + idx;
      div.title = hasRetroLink ? 'Click to view match' : 'Click to view match (locally tracked)';
      div.innerHTML = `
          <div class="duel-header">
            <span>${formatDate(g.timestamp)}</span>
            <span class="map-name">${esc(g.map)}</span>
            <span>${esc(g.version || "")}</span>
            <span>${esc(g.timeElapsed || "")}</span>
            ${hasRetroLink 
              ? `<a href="${archiveLink}" target="_blank" class="ext-link" title="View on Retro Tracker" onclick="event.stopPropagation()">↗</a>`
              : `<span style="color:var(--text-muted);font-size:0.7rem">Local</span>`}
          </div>
          <div class="duel-versus">
            <div class="duel-player ${tied ? "" : p1Wins ? "winner" : "loser"}">
              <div class="name">${esc(p1.name)}</div>
              <div class="score">${p1.kills}</div>
              <div class="sub-stats">${p1.deaths}D · ${p1.suicides || 0}S</div>
            </div>
            <div class="duel-vs">VS</div>
            <div class="duel-player ${tied ? "" : !p1Wins ? "winner" : "loser"}">
              <div class="name">${esc(p2.name)}</div>
              <div class="score">${p2.kills}</div>
              <div class="sub-stats">${p2.deaths}D · ${p2.suicides || 0}S</div>
            </div>
          </div>`;
      div.addEventListener("click", () => {
        window.location.href = gameUrl;
      });
      fragment.appendChild(div);
    });
    container.appendChild(fragment);

    renderPagination("duelPagination", duels.length, duelPage, CARD_PAGE_SIZE, (p) => {
      duelPage = p;
      renderDuels(filtered);
      document.getElementById("duelView").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ── Render FFA Cards ───────────────────────────────────────────
  function renderFFA(filtered) {
    const ffaGames = filtered.filter((g) => g.gameType === "ffa");
    const start = (ffaPage - 1) * CARD_PAGE_SIZE;
    const page = ffaGames.slice(start, start + CARD_PAGE_SIZE);
    const container = document.getElementById("ffaList");
    container.innerHTML = "";

    if (page.length === 0) {
      container.innerHTML = '<p style="color:var(--text-dim)">No FFA matches found with current filters.</p>';
      document.getElementById("ffaPagination").innerHTML = "";
      return;
    }

    const medals = ["#1", "#2", "#3"];
    const fragment = document.createDocumentFragment();

    page.forEach((g, idx) => {
      const sorted = [...(g.players || [])].sort((a, b) => b.kills - a.kills);
      const hasRetroLink = !!g.filename;
      const archiveLink = hasRetroLink ? `${ARCHIVE_BASE}/${g.filename}` : null;
      const gameUrl = `game.html?id=${encodeURIComponent(g.id)}`;

      let standingsHtml = "";
      sorted.forEach((p, i) => {
        const medal = medals[i] || `<span class="rank">${i + 1}.</span>`;
        standingsHtml += `
          <li>
            <span>${medal} ${esc(p.name)}</span>
            <span>
              <span class="kills">${p.kills}K</span>
              <span class="deaths"> / ${p.deaths}D</span>
            </span>
          </li>`;
      });

      const div = document.createElement('div');
      div.className = 'ffa-card clickable-ffa';
      div.dataset.ffaIdx = start + idx;
      div.title = hasRetroLink ? 'Click to view match' : 'Click to view match (locally tracked)';
      div.innerHTML = `
          <div class="ffa-header">
            <span>${formatDate(g.timestamp)}</span>
            <span class="map-name">${esc(g.map)}</span>
            <span>${g.playerCount || sorted.length} players</span>
            <span>${esc(g.version || "")}</span>
            <span>${esc(g.timeElapsed || "")}</span>
            ${hasRetroLink
              ? `<a href="${archiveLink}" target="_blank" class="ext-link" title="View on Retro Tracker" onclick="event.stopPropagation()">↗</a>`
              : `<span style="color:var(--text-muted);font-size:0.7rem">Local</span>`}
          </div>
          <ol class="ffa-standings">${standingsHtml}</ol>`;
      div.addEventListener("click", () => {
        window.location.href = gameUrl;
      });
      fragment.appendChild(div);
    });
    container.appendChild(fragment);

    renderPagination("ffaPagination", ffaGames.length, ffaPage, CARD_PAGE_SIZE, (p) => {
      ffaPage = p;
      renderFFA(filtered);
      document.getElementById("ffaView").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ── Render Player Leaderboard ──────────────────────────────────
  function renderPlayerStats() {
    const search = (document.getElementById("playerSearch").value || "").toLowerCase().trim();
    const filtered = search
      ? players.filter((p) => p.name.toLowerCase().includes(search))
      : players;

    const tbody = document.getElementById("playersBody");
    tbody.innerHTML = "";

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-dim);padding:2rem">No players found.</td></tr>';
      return;
    }

    filtered.forEach((p, i) => {
      const kills = p.totalKills || 0;
      const deaths = p.totalDeaths || 0;
      const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills > 0 ? kills.toFixed(0) : "0";
      const lastSeen = p.lastSeen ? formatDate(p.lastSeen) : "—";
      const rank = search ? "—" : i + 1;

      tbody.innerHTML += `
        <tr>
          <td><strong>${rank}</strong></td>
          <td><strong>${esc(p.name)}</strong></td>
          <td>${(p.gamesPlayed || 0).toLocaleString()}</td>
          <td style="color:var(--green)">${kills.toLocaleString()}</td>
          <td style="color:var(--red)">${deaths.toLocaleString()}</td>
          <td style="font-family:var(--mono)">${kd}</td>
          <td>${(p["1v1Games"] || 0).toLocaleString()}</td>
          <td>${(p.ffaGames || 0).toLocaleString()}</td>
          <td>${lastSeen}</td>
        </tr>`;
    });
  }

  // ── Generic Pagination Renderer ────────────────────────────────
  function renderPagination(containerId, total, currentPg, pageSize, onPageChange) {
    const totalPages = Math.ceil(total / pageSize);
    const container = document.getElementById(containerId);
    container.innerHTML = "";
    if (totalPages <= 1) return;

    const maxButtons = 9;
    let startP = Math.max(1, currentPg - Math.floor(maxButtons / 2));
    let endP = Math.min(totalPages, startP + maxButtons - 1);
    if (endP - startP < maxButtons - 1) startP = Math.max(1, endP - maxButtons + 1);

    // Previous button
    if (currentPg > 1) {
      const prev = document.createElement("button");
      prev.textContent = "← Prev";
      prev.addEventListener("click", () => onPageChange(currentPg - 1));
      container.appendChild(prev);
    }

    if (startP > 1) {
      const btn = document.createElement("button");
      btn.textContent = "1";
      btn.addEventListener("click", () => onPageChange(1));
      container.appendChild(btn);
      if (startP > 2) {
        const dots = document.createElement("button");
        dots.textContent = "…";
        dots.disabled = true;
        container.appendChild(dots);
      }
    }

    for (let p = startP; p <= endP; p++) {
      const btn = document.createElement("button");
      btn.textContent = p;
      if (p === currentPg) btn.classList.add("active");
      btn.addEventListener("click", () => onPageChange(p));
      container.appendChild(btn);
    }

    if (endP < totalPages) {
      if (endP < totalPages - 1) {
        const dots = document.createElement("button");
        dots.textContent = "…";
        dots.disabled = true;
        container.appendChild(dots);
      }
      const btn = document.createElement("button");
      btn.textContent = totalPages;
      btn.addEventListener("click", () => onPageChange(totalPages));
      container.appendChild(btn);
    }

    // Next button
    if (currentPg < totalPages) {
      const next = document.createElement("button");
      next.textContent = "Next →";
      next.addEventListener("click", () => onPageChange(currentPg + 1));
      container.appendChild(next);
    }
  }

  // ── View Switching ─────────────────────────────────────────────
  function switchView(mode) {
    currentMode = mode;
    currentPage = 1;
    duelPage = 1;
    ffaPage = 1;

    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.mode === mode);
    });

    document.getElementById("allView").style.display = mode === "all" ? "" : "none";
    document.getElementById("duelView").style.display = mode === "1v1" ? "" : "none";
    document.getElementById("ffaView").style.display = mode === "ffa" ? "" : "none";

    refresh();
  }

  // ── Refresh Everything ─────────────────────────────────────────
  function refresh() {
    const filtered = DXXFilters.getFiltered();
    renderStatsBar(filtered);
    renderCharts(filtered);
    
    if (currentMode === "all") renderGamesTable(filtered);
    if (currentMode === "1v1") renderDuels(filtered);
    if (currentMode === "ffa") renderFFA(filtered);
  }

  // ── Debounced Refresh ──────────────────────────────────────────
  function debouncedRefresh(delay = 300) {
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(refresh, delay);
  }

  // ── Load More Games Until Filter Results ──────────────────────
  async function loadUntilFilteredResults(minResults = 100, maxPages = 30) {
    if (!gameMeta) return;
    
    let pagesLoaded = 0;
    let filtered = DXXFilters.getFiltered();
    
    // Keep loading until we have enough filtered results or hit limits
    while (filtered.length < minResults && 
           games.length < gameMeta.totalGames && 
           pagesLoaded < maxPages) {
      const loaded = await loadMoreGames();
      if (!loaded) break;
      pagesLoaded++;
      filtered = DXXFilters.getFiltered();
      
      // Update progress indicator
      const applyBtn = document.getElementById("applyFilters");
      if (applyBtn && pagesLoaded > 0) {
        applyBtn.textContent = `Loading... (${filtered.length} found, ${games.length.toLocaleString()} scanned)`;
      }
    }
    
    return filtered;
  }

  // ── Event Listeners ────────────────────────────────────────────
  document.getElementById("modeTabs").addEventListener("click", (e) => {
    if (e.target.classList.contains("tab")) {
      switchView(e.target.dataset.mode);
    }
  });

  document.getElementById("applyFilters").addEventListener("click", async () => {
    currentPage = 1;
    duelPage = 1;
    ffaPage = 1;
    
    // If all games are loaded, just refresh (instant filtering)
    if (allGamesLoaded) {
      refresh();
      return;
    }
    
    // Otherwise, use the old smart loading logic
    const applyBtn = document.getElementById("applyFilters");
    const originalText = applyBtn.textContent;
    applyBtn.textContent = "Loading...";
    applyBtn.disabled = true;
    
    const filtered = DXXFilters.getFiltered();
    console.log(`Apply Filters: ${filtered.length} matches in ${games.length} loaded games`);
    
    if (gameMeta && filtered.length < 100 && games.length < gameMeta.totalGames) {
      console.log(`Loading more games (target: 200 matches, max: 30 pages)...`);
      await loadUntilFilteredResults(200, 30);
      console.log(`Loading complete: ${DXXFilters.getFiltered().length} matches in ${games.length} games`);
    }
    
    refresh();
    
    applyBtn.textContent = originalText;
    applyBtn.disabled = false;
  });

  document.getElementById("clearFilters").addEventListener("click", () => {
    DXXFilters.clearAll();
    currentPage = 1;
    duelPage = 1;
    ffaPage = 1;
    refresh();
    // Scroll to top to show cleared results
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  document.getElementById("searchInput").addEventListener("input", () => {
    // Only auto-refresh if all games are loaded (for instant filtering)
    if (allGamesLoaded) {
      currentPage = 1;
      duelPage = 1;
      ffaPage = 1;
      debouncedRefresh(300);
    }
  });

  // Auto-apply filters when dropdowns change (only if all games loaded)
  const filterDropdowns = ['yearFilter', 'monthFilter', 'mapFilter', 'versionFilter'];
  filterDropdowns.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        // Only auto-apply if all games are loaded (for instant filtering)
        if (allGamesLoaded) {
          currentPage = 1;
          duelPage = 1;
          ffaPage = 1;
          refresh();
        }
      });
    }
  });

  // Load more button (only shown if games are partially loaded)
  const loadMoreBtn = document.createElement('button');
  loadMoreBtn.id = 'loadMoreBtn';
  loadMoreBtn.style.display = 'none'; // Hidden by default with new Load All approach
  const updateLoadMoreText = () => {
    const total = gameMeta ? gameMeta.totalGames : '?';
    loadMoreBtn.textContent = `Load More Games (${games.length.toLocaleString()}/${typeof total === 'number' ? total.toLocaleString() : total} loaded)`;
  };
  updateLoadMoreText();
  loadMoreBtn.style.cssText = 'margin: 2rem auto; display: none; padding: 1rem 2rem; background: var(--accent); color: white; border: none; cursor: pointer; font-size: 1rem; border-radius: 4px;';
  loadMoreBtn.addEventListener('click', async () => {
    const loaded = await loadMoreGames();
    if (loaded) {
      updateLoadMoreText();
      refresh();
      if (gameMeta && games.length >= gameMeta.totalGames) {
        loadMoreBtn.textContent = 'All games loaded';
        loadMoreBtn.disabled = true;
        loadMoreBtn.style.opacity = '0.5';
      }
    }
  });
  
  // Insert button after stats bar (but it's hidden by default)
  const statsBar = document.querySelector('.stats-bar');
  if (statsBar) {
    statsBar.parentNode.insertBefore(loadMoreBtn, statsBar.nextSibling);
  }

  // Auto-load more games when scrolling near bottom (disabled with Load All approach)
  let autoLoadInProgress = false;
  window.addEventListener('scroll', async () => {
    if (allGamesLoaded) return; // Skip if all games already loaded
    if (autoLoadInProgress || !loadMoreBtn || loadMoreBtn.disabled) return;
    if (!gameMeta || games.length >= gameMeta.totalGames) return;
    
    const scrollHeight = document.documentElement.scrollHeight;
    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
    const clientHeight = document.documentElement.clientHeight;
    
    // Trigger when 80% scrolled
    if ((scrollTop + clientHeight) / scrollHeight > 0.8) {
      autoLoadInProgress = true;
      const loaded = await loadMoreGames();
      if (loaded) {
        updateLoadMoreText();
        refresh();
      }
      if (!loaded || (gameMeta && games.length >= gameMeta.totalGames)) {
        loadMoreBtn.textContent = 'All games loaded';
        loadMoreBtn.disabled = true;
        loadMoreBtn.style.opacity = '0.5';
      }
      setTimeout(() => autoLoadInProgress = false, 1000);
    }
  });

  // Chart toggle functionality
  const toggleChartsBtn = document.getElementById("toggleCharts");
  const chartsContainer = document.getElementById("chartsContainer");
  if (toggleChartsBtn && chartsContainer) {
    toggleChartsBtn.addEventListener("click", () => {
      const isHidden = chartsContainer.style.display === "none";
      chartsContainer.style.display = isHidden ? "" : "none";
      toggleChartsBtn.textContent = isHidden ? "Hide Charts" : "Show Charts";
    });
  }

  // ── Initialize ────────────────────────────────────────────
  const overlay = document.getElementById("loadingOverlay");
  let allGamesLoaded = false;

  try {
    // Load metadata first (just counts, fast)
    await loadMetadata();
    
    // Load first page of games
    await loadGames(1, PAGE_SIZE);
    ensureGameIds();
    DXXFilters.setData(games, players, gameMeta);
    
    // Set placeholder text for hidden filter buttons
    const placeholderText = document.getElementById('filterPlaceholderText');
    if (placeholderText) {
      placeholderText.textContent = 'Load all games below to enable filtering';
    }
    
    // Render the initial page
    switchView("all");
    
    console.log(`DXX Dashboard initialized: Showing ${games.length} of ${gameMeta.totalGames} games`);
  } catch (err) {
    console.error("Failed to load data:", err);
    document.getElementById("gamesBody").innerHTML =
      '<tr><td colspan="8" style="text-align:center;color:var(--red);padding:2rem">Failed to load data. Check API connection.</td></tr>';
  } finally {
    overlay.classList.add("hidden");
  }

  // ── Load All Modal Handlers ──────────────────────────────────
  const loadAllModal = document.getElementById('loadAllModal');
  const loadAllBtn = document.getElementById('loadAllBtn');
  const confirmLoadBtn = document.getElementById('confirmLoadAll');
  const cancelLoadBtn = document.getElementById('cancelLoadAll');
  const modalBackdrop = loadAllModal.querySelector('.modal-backdrop');

  function openLoadAllModal() {
    loadAllModal.classList.add('active');
  }

  function closeLoadAllModal() {
    loadAllModal.classList.remove('active');
  }

  loadAllBtn.addEventListener('click', openLoadAllModal);
  cancelLoadBtn.addEventListener('click', closeLoadAllModal);
  modalBackdrop.addEventListener('click', closeLoadAllModal);

  confirmLoadBtn.addEventListener('click', async () => {
    closeLoadAllModal();
    overlay.classList.remove('hidden');
    const loadingText = document.getElementById('loadingText');
    const progressText = document.getElementById('loadingProgress');
    
    try {
      loadingText.textContent = 'Loading all games...';
      progressText.textContent = 'Downloading 44 MB of game data...';
      
      // Load Firebase games
      await loadFirebaseGames();
      
      // Load all archive games at once
      const response = await fetch(`${API_BASE}/api/games?all=true`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const data = await response.json();
      
      // Combine Firebase + all archive games
      games = [...firebaseGames, ...data.games];
      players = data.players;
      
      ensureGameIds();
      DXXFilters.setData(games, players, gameMeta);
      allGamesLoaded = true;
      
      progressText.textContent = `Loaded ${games.length.toLocaleString()} games`;
      
      // Hide Load All button and placeholder text
      loadAllBtn.parentElement.style.display = 'none';
      
      // Hide placeholder text and show filter buttons
      const placeholderText = document.getElementById('filterPlaceholderText');
      if (placeholderText) placeholderText.style.display = 'none';
      
      // Show Apply/Clear/Charts buttons (they were hidden initially)
      document.getElementById('applyFilters').style.display = 'inline-block';
      document.getElementById('clearFilters').style.display = 'inline-block';
      document.getElementById('toggleCharts').style.display = 'inline-block';
      
      // Show mode tabs now that data is loaded
      document.getElementById('modeTabs').style.display = 'flex';
      
      // Render the data
      switchView("all");
      
      console.log(`All games loaded: ${games.length} total games, ${players.length} players`);
    } catch (err) {
      console.error('Error loading all games:', err);
      alert('Failed to load games. Please check your connection and try again.');
    } finally {
      overlay.classList.add('hidden');
    }
  });

  // Note: Real-time updates disabled when using JSON file.
  // Re-run scraper/scrape-to-json.js to update data.
})();

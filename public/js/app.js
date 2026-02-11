/**
 * DXX Dashboard — Main Application
 *
 * Loads data from Firestore, renders all views (All, 1v1, FFA, Leaderboard),
 * handles navigation, pagination, and real-time updates.
 */
(async function DXXApp() {
  "use strict";

  // ── State ──────────────────────────────────────────────────────
  let allGames = []; // Full dataset
  let games = []; // Currently loaded games (initially half)
  let players = [];
  let currentMode = "all";
  let currentPage = 1;
  let duelPage = 1;
  let ffaPage = 1;
  const PAGE_SIZE = 100;
  const CARD_PAGE_SIZE = 50;

  const ARCHIVE_BASE = "https://retro-tracker.game-server.cc/archive";

  // ── Load Data from JSON file ───────────────────────────────────
  async function loadGames() {
    const response = await fetch("./data/games.json");
    const data = await response.json();
    allGames = data.games; // Store full dataset
    games = data.games.slice(0, Math.ceil(data.games.length / 2)); // Load half initially
    players = data.players;
    console.log(`Loaded ${games.length} of ${allGames.length} games initially`);
    return games;
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

    totalGamesEl.textContent = filtered.length.toLocaleString();
    totalGamesEl.title = `${filtered.length} games`;

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

    page.forEach((g, idx) => {
      const winner = getWinner(g.players);
      const modeClass = g.gameType === "1v1" ? "mode-1v1" : "mode-ffa";
      const modeLabel = g.gameType === "1v1" ? "1v1" : "FFA";
      const versionClass = (g.version || "").includes("D2") ? "version-d2" : "version-d1";
      const versionLabel = g.version || "—";
      const playerNames = g.players ? g.players.map((p) => p.name).join(", ") : "";
      const truncatedPlayers = playerNames.length > 45 ? playerNames.slice(0, 45) + "…" : playerNames;
      const archiveLink = g.filename ? `${ARCHIVE_BASE}/${g.filename}` : "#";

      tbody.innerHTML += `
        <tr class="game-row" data-game-idx="${start + idx}" style="cursor:pointer" title="Click for details">
          <td>${formatDateTime(g.timestamp)}</td>
          <td><strong>${esc(g.map)}</strong></td>
          <td><span class="mode-badge ${modeClass}">${modeLabel}</span></td>
          <td><span class="version-badge ${versionClass}">${esc(versionLabel)}</span></td>
          <td title="${esc(playerNames)}">${esc(truncatedPlayers)}</td>
          <td>${esc(g.timeElapsed || "—")}</td>
          <td>${winner ? esc(winner.name) + " <span style='color:var(--green)'>" + winner.kills + "K</span>" : "—"}</td>
          <td><a href="${archiveLink}" target="_blank" class="ext-link" title="View on Retro Tracker" onclick="event.stopPropagation()">↗</a></td>
        </tr>`;
    });

    // Add click handlers for game rows
    tbody.querySelectorAll(".game-row").forEach((row) => {
      row.addEventListener("click", () => {
        const gameIdx = parseInt(row.dataset.gameIdx);
        const game = filtered[gameIdx];
        if (game && typeof GameDetail !== "undefined") GameDetail.open(game);
      });
    });

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

    page.forEach((g, idx) => {
      const p1 = (g.players && g.players[0]) || { name: "?", kills: 0, deaths: 0, suicides: 0 };
      const p2 = (g.players && g.players[1]) || { name: "?", kills: 0, deaths: 0, suicides: 0 };
      const p1Wins = p1.kills > p2.kills;
      const tied = p1.kills === p2.kills;
      const archiveLink = g.filename ? `${ARCHIVE_BASE}/${g.filename}` : "#";

      container.innerHTML += `
        <div class="duel-card clickable-card" data-duel-idx="${start + idx}" title="Click for details">
          <div class="duel-header">
            <span>${formatDate(g.timestamp)}</span>
            <span class="map-name">${esc(g.map)}</span>
            <span>${esc(g.version || "")}</span>
            <span>${esc(g.timeElapsed || "")}</span>
            <a href="${archiveLink}" target="_blank" class="ext-link" title="View on Retro Tracker" onclick="event.stopPropagation()">↗</a>
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
          </div>
        </div>`;
    });

    // Add click handlers for duel cards
    container.querySelectorAll(".clickable-card").forEach((card) => {
      card.addEventListener("click", () => {
        const gameIdx = parseInt(card.dataset.duelIdx);
        const game = duels[gameIdx];
        if (game && typeof GameDetail !== "undefined") GameDetail.open(game);
      });
    });

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

    page.forEach((g, idx) => {
      const sorted = [...(g.players || [])].sort((a, b) => b.kills - a.kills);
      const archiveLink = g.filename ? `${ARCHIVE_BASE}/${g.filename}` : "#";

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

      container.innerHTML += `
        <div class="ffa-card clickable-ffa" data-ffa-idx="${start + idx}" title="Click for details">
          <div class="ffa-header">
            <span>${formatDate(g.timestamp)}</span>
            <span class="map-name">${esc(g.map)}</span>
            <span>${g.playerCount || sorted.length} players</span>
            <span>${esc(g.version || "")}</span>
            <span>${esc(g.timeElapsed || "")}</span>
            <a href="${archiveLink}" target="_blank" class="ext-link" title="View on Retro Tracker" onclick="event.stopPropagation()">↗</a>
          </div>
          <ol class="ffa-standings">${standingsHtml}</ol>
        </div>`;
    });

    // Add click handlers for FFA cards
    container.querySelectorAll(".clickable-ffa").forEach((card) => {
      card.addEventListener("click", () => {
        const gameIdx = parseInt(card.dataset.ffaIdx);
        const game = ffaGames[gameIdx];
        if (game && typeof GameDetail !== "undefined") GameDetail.open(game);
      });
    });

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

  // ── Event Listeners ────────────────────────────────────────────
  document.getElementById("modeTabs").addEventListener("click", (e) => {
    if (e.target.classList.contains("tab")) {
      switchView(e.target.dataset.mode);
    }
  });

  document.getElementById("applyFilters").addEventListener("click", () => {
    currentPage = 1;
    duelPage = 1;
    ffaPage = 1;
    refresh();
  });

  document.getElementById("clearFilters").addEventListener("click", () => {
    DXXFilters.clearAll();
    currentPage = 1;
    duelPage = 1;
    ffaPage = 1;
    refresh();
  });

  document.getElementById("searchInput").addEventListener("keyup", (e) => {
    if (e.key === "Enter") {
      currentPage = 1;
      duelPage = 1;
      ffaPage = 1;
      refresh();
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

  // ── Initialize ─────────────────────────────────────────────────
  const overlay = document.getElementById("loadingOverlay");

  try {
    await Promise.all([loadGames(), loadPlayers()]);
    DXXFilters.setData(games, players);
    
    // Display dataset info
    if (games.length > 0) {
      const oldest = games[games.length - 1];
      const newest = games[0];
      const startDate = formatDate(oldest.timestamp);
      const endDate = formatDate(newest.timestamp);
      console.log(`DXX Dashboard: Showing ${games.length} of ${allGames.length} games (${startDate} to ${endDate})`);
    }
    
    switchView("all");

    console.log(`DXX Dashboard loaded: ${games.length} games shown, ${allGames.length} total, ${players.length} players.`);
  } catch (err) {
    console.error("Failed to load data:", err);
    document.getElementById("gamesBody").innerHTML =
      '<tr><td colspan="8" style="text-align:center;color:var(--red);padding:2rem">Failed to load data. Check that /data/games.json exists.</td></tr>';
  } finally {
    overlay.classList.add("hidden");
  }

  // Note: Real-time updates disabled when using JSON file.
  // Re-run scraper/scrape-to-json.js to update data.
})();

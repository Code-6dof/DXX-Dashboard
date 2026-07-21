/**
 * DXX Dashboard — Game Detail Modal
 *
 * Shows detailed game information when clicking on a game row, duel card,
 * or FFA card. If event data from the gamelog watcher is available
 * (public/data/events/<id>.json), it shows the full kill feed, damage
 * breakdown, kill matrix, and event timeline.
 *
 * Otherwise it shows the basic info from games.json (players, scores, map).
 */
const GameDetail = (function () {
  "use strict";

  // ── Cache for loaded event data ──────────────────────────────
  const eventCache = new Map();
  let eventIndex = null;
  let eventIndexLoaded = false;

  // ── Utility ──────────────────────────────────────────────────
  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  function formatDateTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString("en-US", {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  // ── Load event index (once) ──────────────────────────────────
  async function loadEventIndex() {
    if (eventIndexLoaded) return eventIndex;
    try {
      const res = await fetch("./data/events/index.json");
      if (res.ok) {
        eventIndex = await res.json();
      }
    } catch (e) {
      // No event data available — that's fine
    }
    eventIndexLoaded = true;
    return eventIndex;
  }

  // ── Load event data for a specific game ──────────────────────
  async function loadEventData(gameId) {
    if (eventCache.has(gameId)) return eventCache.get(gameId);
    try {
      const res = await fetch(`./data/events/${gameId}.json`);
      if (res.ok) {
        const data = await res.json();
        eventCache.set(gameId, data);
        return data;
      }
    } catch (e) {
      // No event data
    }
    return null;
  }

  // ── Try to match a game to event data ────────────────────────
  async function findEventData(game) {
    await loadEventIndex();

    // Direct ID match
    if (game.id) {
      const data = await loadEventData(game.id);
      if (data) return data;
    }

    // Try filename match
    if (game.filename && eventIndex) {
      const match = eventIndex.games?.find((g) =>
        g.id === game.filename.replace('.txt', '')
      );
      if (match) return loadEventData(match.id);
    }

    // Try timestamp + player match
    if (eventIndex && game.timestamp && game.players) {
      const gameTime = new Date(game.timestamp).getTime();
      const playerNames = new Set(game.players.map((p) => p.name));

      const match = eventIndex.games?.find((g) => {
        const eventTime = new Date(g.timestamp).getTime();
        const timeDiff = Math.abs(eventTime - gameTime);
        if (timeDiff > 300000) return false; // within 5 minutes

        const nameOverlap = g.playerNames?.filter((n) => playerNames.has(n));
        return nameOverlap && nameOverlap.length >= Math.min(2, playerNames.size);
      });

      if (match) return loadEventData(match.id);
    }

    return null;
  }

  // ── Open modal ───────────────────────────────────────────────
  async function open(game) {
    const modal = document.getElementById("gameDetailModal");
    const content = document.getElementById("gameDetailContent");

    // Show modal immediately with loading state
    modal.classList.add("active");
    document.body.style.overflow = "hidden";
    content.innerHTML = `
      <div class="gdm-loading">
        <div class="spinner"></div>
        <p>Loading game details…</p>
      </div>`;

    // Try to load event data
    const eventData = await findEventData(game);

    // Render
    content.innerHTML = renderModal(game, eventData);

    // Set up tabs within the modal
    setupModalTabs(content);
  }

  // ── Close modal ──────────────────────────────────────────────
  function close() {
    const modal = document.getElementById("gameDetailModal");
    modal.classList.remove("active");
    document.body.style.overflow = "";
  }

  // ── Render the full modal content ────────────────────────────
  function renderModal(game, eventData) {
    const modeClass = game.gameType === "1v1" ? "mode-1v1" : "mode-ffa";
    const modeLabel = game.gameType === "1v1" ? "1v1 Duel" : "Free-For-All";
    const versionClass = (game.version || "").includes("D2") ? "version-d2" : "version-d1";
    const hasEvents = !!eventData && !eventData._sample;
    const hasSample = eventData && eventData._sample;

    const archiveLink = game.filename
      ? `https://retro-tracker.game-server.cc/archive/${game.filename}`
      : null;

    // Sort players by kills
    const players = [...(game.players || [])].sort((a, b) => b.kills - a.kills);

    let html = `
      <!-- Header -->
      <div class="gdm-header">
        <div class="gdm-header-top">
          <div class="gdm-title">
            <h2>${esc(game.map || "Unknown Map")}</h2>
            <div class="gdm-meta">
              <span class="mode-badge ${modeClass}">${modeLabel}</span>
              <span class="version-badge ${versionClass}">${esc(game.version || "—")}</span>
              <span class="gdm-date">${formatDateTime(game.timestamp)}</span>
              ${game.timeElapsed ? `<span class="gdm-duration">${esc(game.timeElapsed)}</span>` : ""}
              ${game.gameName ? `<span class="gdm-gamename">${esc(game.gameName)}</span>` : ""}
            </div>
          </div>
          <button class="gdm-close" id="gdmClose" title="Close">✕</button>
        </div>
        ${archiveLink ? `<a href="${archiveLink}" target="_blank" class="gdm-archive-link">View on Retro Tracker ↗</a>` : ""}
      </div>

      <!-- Scoreboard -->
      <div class="gdm-section">
        <h3> Scoreboard</h3>
        ${renderScoreboard(players, game.gameType)}
      </div>`;

    // Modal tabs for event data sections
    if (eventData) {
      html += `
      <div class="gdm-tabs" id="gdmTabs">
        <button class="gdm-tab active" data-panel="killFeed">Kill Feed</button>
        <button class="gdm-tab" data-panel="killMatrix">Kill Matrix</button>
        ${eventData.damageBreakdown && eventData.damageBreakdown.length > 0 ? `<button class="gdm-tab" data-panel="damage">Damage</button>` : ""}
        <button class="gdm-tab" data-panel="timeline">Timeline</button>
        ${eventData.chatLog && eventData.chatLog.length > 0 ? `<button class="gdm-tab" data-panel="chat">Chat</button>` : ""}
      </div>

      <!-- Kill Feed -->
      <div class="gdm-panel active" id="panel-killFeed">
        <div class="gdm-section">
          ${renderKillFeed(eventData.killFeed || [])}
        </div>
      </div>

      <!-- Kill Matrix -->
      <div class="gdm-panel" id="panel-killMatrix">
        <div class="gdm-section">
          ${renderKillMatrix(eventData.killMatrix || {}, players)}
        </div>
      </div>`;

      if (eventData.damageBreakdown && eventData.damageBreakdown.length > 0) {
        html += `
      <!-- Damage Breakdown -->
      <div class="gdm-panel" id="panel-damage">
        <div class="gdm-section">
          ${renderDamageBreakdown(eventData.damageBreakdown, eventData.players || players)}
        </div>
      </div>`;
      }

      html += `
      <!-- Timeline -->
      <div class="gdm-panel" id="panel-timeline">
        <div class="gdm-section">
          ${renderTimeline(eventData.timeline || [])}
        </div>
      </div>`;

      if (eventData.chatLog && eventData.chatLog.length > 0) {
        html += `
      <!-- Chat Log -->
      <div class="gdm-panel" id="panel-chat">
        <div class="gdm-section">
          ${renderChatLog(eventData.chatLog)}
        </div>
      </div>`;
      }

      if (hasSample) {
        html += `
      <div class="gdm-notice">
        <p>ℹ This is <strong>sample data</strong> for demonstration. Run the gamelog watcher to capture real game events.</p>
      </div>`;
      }
    } else {
      html += `
      <div class="gdm-notice">
        <p>Detailed event data (kill feed, damage, timeline) is not available for this game.</p>
        <p>To capture events for new games, run <code>node scraper/gamelog-watcher.js</code> while DXX-Redux is running with <code>-gamelog_split -gamelog_timestamp</code> flags.</p>
      </div>`;
    }

    return html;
  }

  // ── Render: Scoreboard ───────────────────────────────────────
  function renderScoreboard(players, gameType) {
    if (!players || players.length === 0) {
      return '<p class="gdm-empty">No player data.</p>';
    }

    const medals = ["#1", "#2", "#3"];

    if (gameType === "1v1" && players.length === 2) {
      const p1 = players[0];
      const p2 = players[1];
      const p1Wins = p1.kills > p2.kills;
      const tied = p1.kills === p2.kills;

      return `
        <div class="gdm-duel-scoreboard">
          <div class="gdm-duel-player ${tied ? "" : p1Wins ? "winner" : "loser"}">
            <div class="gdm-duel-name">${esc(p1.name)}</div>
            <div class="gdm-duel-score">${p1.kills}</div>
            <div class="gdm-duel-sub">${p1.deaths}D / ${p1.suicides || 0}S</div>
            ${p1.kdRatio ? `<div class="gdm-duel-kd">${p1.kdRatio} K/D</div>` : ""}
          </div>
          <div class="gdm-duel-divider">VS</div>
          <div class="gdm-duel-player ${tied ? "" : !p1Wins ? "winner" : "loser"}">
            <div class="gdm-duel-name">${esc(p2.name)}</div>
            <div class="gdm-duel-score">${p2.kills}</div>
            <div class="gdm-duel-sub">${p2.deaths}D / ${p2.suicides || 0}S</div>
            ${p2.kdRatio ? `<div class="gdm-duel-kd">${p2.kdRatio} K/D</div>` : ""}
          </div>
        </div>`;
    }

    // FFA scoreboard table
    let rows = "";
    players.forEach((p, i) => {
      const medal = medals[i] || `<span class="gdm-rank">${i + 1}</span>`;
      const kd = p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills > 0 ? p.kills.toFixed(0) : "0";
      rows += `
        <tr class="${i === 0 ? "gdm-top-player" : ""}">
          <td class="gdm-medal">${medal}</td>
          <td><strong>${esc(p.name)}</strong></td>
          <td class="gdm-kills">${p.kills}</td>
          <td class="gdm-deaths">${p.deaths}</td>
          <td class="gdm-suicides">${p.suicides || 0}</td>
          <td class="gdm-kd">${kd}</td>
          ${p.timeInGame ? `<td class="gdm-time">${esc(p.timeInGame)}</td>` : ""}
        </tr>`;
    });

    return `
      <table class="gdm-scoreboard-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Kills</th>
            <th>Deaths</th>
            <th>Suicides</th>
            <th>K/D</th>
            ${players[0]?.timeInGame ? "<th>Time</th>" : ""}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // ── Render: Kill Feed ────────────────────────────────────────
  function renderKillFeed(killFeed) {
    if (!killFeed || killFeed.length === 0) {
      return '<p class="gdm-empty">No kills recorded.</p>';
    }

    const items = killFeed.map((k) => {
      const timeStr = k.time ? `<span class="kf-time">${esc(k.time)}</span>` : "";
      let icon = "";
      if (k.method && k.method.toLowerCase().includes("mine")) icon = "";
      if (k.method && k.method.toLowerCase().includes("missile")) icon = "";
      if (k.method && k.method.toLowerCase().includes("fusion")) icon = "";
      if (k.method && k.method.toLowerCase().includes("laser")) icon = "";
      if (k.killer === k.victim || !k.killer) icon = "";

      return `
        <div class="kf-entry">
          ${timeStr}
          <span class="kf-icon">${icon}</span>
          <span class="kf-msg">${esc(k.message || `${k.killer} killed ${k.victim}`)}</span>
          ${k.method ? `<span class="kf-method">${esc(k.method)}</span>` : ""}
        </div>`;
    }).join("");

    return `
      <div class="gdm-kill-feed-header">
        <span>Kill Feed</span>
        <span class="kf-count">${killFeed.length} kills</span>
      </div>
      <div class="gdm-kill-feed">${items}</div>`;
  }

  // ── Render: Kill Matrix ──────────────────────────────────────
  function renderKillMatrix(matrix, players) {
    const names = players.map((p) => p.name);
    if (names.length === 0 || Object.keys(matrix).length === 0) {
      return '<p class="gdm-empty">No kill matrix data.</p>';
    }

    let headerCells = '<th class="km-corner">Killer \\ Victim</th>';
    names.forEach((n) => {
      headerCells += `<th class="km-name">${esc(n)}</th>`;
    });

    let rows = "";
    names.forEach((killer) => {
      let cells = `<td class="km-row-name"><strong>${esc(killer)}</strong></td>`;
      names.forEach((victim) => {
        const count = (matrix[killer] && matrix[killer][victim]) || 0;
        const cls = killer === victim ? "km-self" : count > 0 ? "km-has-kills" : "km-zero";
        const intensity = Math.min(count / 10, 1); // for coloring
        cells += `<td class="km-cell ${cls}" style="--intensity: ${intensity}">${count || "·"}</td>`;
      });
      rows += `<tr>${cells}</tr>`;
    });

    return `
      <div class="gdm-kill-matrix-wrap">
        <table class="gdm-kill-matrix">
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="gdm-matrix-hint">Read rows as "Killer → Victim". Row totals = kills, column totals = deaths.</p>`;
  }

  // ── Render: Damage Breakdown ─────────────────────────────────
  function renderDamageBreakdown(breakdown, players) {
    if (!breakdown || breakdown.length === 0) {
      return '<p class="gdm-empty">No damage data available. (Requires observer mode)</p>';
    }

    // Group by attacker
    const byAttacker = {};
    breakdown.forEach((d) => {
      if (!byAttacker[d.attacker]) byAttacker[d.attacker] = [];
      byAttacker[d.attacker].push(d);
    });

    // Also show per-player damage stats if available
    let playerDmg = "";
    if (players && players.length > 0) {
      const hasDamageStats = players.some((p) => p.damageTaken || p.damageDealt);
      if (hasDamageStats) {
        let rows = "";
        players.forEach((p) => {
          if (p.damageTaken || p.damageDealt) {
            rows += `
              <tr>
                <td><strong>${esc(p.name)}</strong></td>
                <td class="gdm-dmg-dealt">${(p.damageDealt || 0).toFixed(1)}</td>
                <td class="gdm-dmg-taken">${(p.damageTaken || 0).toFixed(1)}</td>
                <td class="gdm-dmg-ratio">${p.damageTaken > 0 ? ((p.damageDealt || 0) / p.damageTaken).toFixed(2) : "—"}</td>
              </tr>`;
          }
        });

        if (rows) {
          playerDmg = `
            <h4>Player Damage Summary</h4>
            <table class="gdm-damage-table">
              <thead><tr><th>Player</th><th>Dealt</th><th>Taken</th><th>Ratio</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`;
        }
      }
    }

    // Weapon breakdown
    const maxDmg = Math.max(...breakdown.map((d) => d.totalDamage));
    let weaponRows = "";
    breakdown
      .sort((a, b) => b.totalDamage - a.totalDamage)
      .forEach((d) => {
        const pct = maxDmg > 0 ? ((d.totalDamage / maxDmg) * 100).toFixed(0) : 0;
        weaponRows += `
          <div class="gdm-dmg-bar-row">
            <span class="gdm-dmg-player">${esc(d.attacker)}</span>
            <span class="gdm-dmg-weapon">${esc(d.weapon)}</span>
            <div class="gdm-dmg-bar-track">
              <div class="gdm-dmg-bar-fill" style="width: ${pct}%"></div>
            </div>
            <span class="gdm-dmg-value">${d.totalDamage.toFixed(1)}</span>
            <span class="gdm-dmg-hits">${d.hits} hits</span>
          </div>`;
      });

    return `
      ${playerDmg}
      <h4>Weapon Damage Breakdown</h4>
      <div class="gdm-damage-bars">${weaponRows}</div>`;
  }

  // ── Render: Timeline ─────────────────────────────────────────
  function renderTimeline(timeline) {
    if (!timeline || timeline.length === 0) {
      return '<p class="gdm-empty">No timeline data.</p>';
    }

    const typeIcons = {
      kill: "",
      death: "",
      suicide: "",
      join: "+",
      leave: "-",
      disconnect: "x",
      reactor: "!",
      escape: ">",
      chat: "",
      flag: "",
      orb: "",
      damage: "",
      promotion: "",
      demotion: "",
      start: "",
      end: "",
    };

    const items = timeline.map((ev) => {
      const icon = typeIcons[ev.type] || "•";
      const timeStr = ev.time ? `<span class="tl-time">${esc(ev.time)}</span>` : "";
      return `
        <div class="tl-entry tl-${esc(ev.type)}">
          ${timeStr}
          <span class="tl-icon">${icon}</span>
          <span class="tl-desc">${esc(ev.description)}</span>
        </div>`;
    }).join("");

    return `
      <div class="gdm-timeline-header">
        <span>Event Timeline</span>
        <span class="tl-count">${timeline.length} events</span>
      </div>
      <div class="gdm-timeline">${items}</div>`;
  }

  // ── Render: Chat Log ─────────────────────────────────────────
  function renderChatLog(chatLog) {
    if (!chatLog || chatLog.length === 0) {
      return '<p class="gdm-empty">No chat messages.</p>';
    }

    const items = chatLog.map((msg) => `
      <div class="chat-entry">
        ${msg.time ? `<span class="chat-time">${esc(msg.time)}</span>` : ""}
        <span class="chat-player">${esc(msg.player)}:</span>
        <span class="chat-msg">${esc(msg.message)}</span>
      </div>
    `).join("");

    return `
      <div class="gdm-chat-header">
        <span>Chat Log</span>
        <span class="chat-count">${chatLog.length} messages</span>
      </div>
      <div class="gdm-chat-log">${items}</div>`;
  }

  // ── Tab switching within modal ───────────────────────────────
  function setupModalTabs(container) {
    const tabs = container.querySelectorAll(".gdm-tab");
    const panels = container.querySelectorAll(".gdm-panel");

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        panels.forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        const panel = container.querySelector(`#panel-${tab.dataset.panel}`);
        if (panel) panel.classList.add("active");
      });
    });

    // Close button
    const closeBtn = container.querySelector("#gdmClose");
    if (closeBtn) closeBtn.addEventListener("click", close);
  }

  // ── Initialize ───────────────────────────────────────────────
  function init() {
    // Close on backdrop click
    const modal = document.getElementById("gameDetailModal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
    }

    // Close on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });

    // Preload event index
    loadEventIndex();
  }

  // Init on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { open, close };
})();

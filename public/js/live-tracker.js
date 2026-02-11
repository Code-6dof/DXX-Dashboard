/**
 * DXX Live Tracker v3.0 — HTTP Polling
 *
 * Polls /data/live-games.json every 5 seconds, just like PyTracker
 * writes gamelist.txt and the web_interface reads it.
 *
 * No WebSocket. No reconnection issues. No flicker.
 */
(function LiveTracker() {
  'use strict';

  // ── Configuration ──
  const POLL_URL = 'https://turns-extension-neighbor-front.trycloudflare.com/data/live-games.json';
  const POLL_INTERVAL = 5000; // 5 seconds, same as PyTracker
  const MAX_RECENT_GAMES = 10;

  // ── State ──
  let activeGames = new Map();  // id → game
  let recentGames = [];
  let lastUpdated = null;
  let pollTimer = null;
  let knownGameIds = new Set(); // track games we've seen, to detect removals

  // ── DOM Elements ──
  const statusEl      = document.getElementById('connectionStatus');
  const activeListEl  = document.getElementById('activeGamesList');
  const recentListEl  = document.getElementById('recentGamesList');
  const noGamesEl     = document.getElementById('noGamesMessage');
  const activeCountEl = document.getElementById('activeGameCount');
  const recentCountEl = document.getElementById('recentGameCount');

  // ── Utility ──
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function timeAgo(timestamp) {
    const diff = Date.now() - new Date(timestamp).getTime();
    const m = Math.floor(diff / 60000);
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(diff / 86400000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    if (d < 7)  return `${d}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  // ── Poll Loop ──
  async function poll() {
    try {
      const resp = await fetch(POLL_URL + '?t=' + Date.now()); // bust cache
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();

      // Mark connected
      statusEl.className = 'connection-status connected';
      statusEl.querySelector('.status-text').textContent = 'Connected';

      // Track which games are in this update
      const incomingIds = new Set();

      if (data.games && data.games.length > 0) {
        for (const g of data.games) {
          if (!g.id) continue;
          incomingIds.add(g.id);

          // Merge gamelog stats into player data
          if (data.gamelog && data.gamelog.players) {
            for (const p of (g.players || [])) {
              const lp = data.gamelog.players.find(
                x => x.name.toLowerCase() === (p.name || '').toLowerCase()
              );
              if (lp) {
                p.kills    = Math.max(p.kills    || 0, lp.kills    || 0);
                p.deaths   = Math.max(p.deaths   || 0, lp.deaths   || 0);
                p.suicides = Math.max(p.suicides || 0, lp.suicides || 0);
              }
            }
            g.totalKills = data.gamelog.totalKills || 0;
            g.killFeed   = data.gamelog.killFeed   || [];
          }

          activeGames.set(g.id, g);
        }
      }

      // Games that disappeared → move to recent
      for (const oldId of knownGameIds) {
        if (!incomingIds.has(oldId)) {
          const removed = activeGames.get(oldId);
          activeGames.delete(oldId);
          if (removed) {
            recentGames.unshift(removed);
            if (recentGames.length > MAX_RECENT_GAMES) recentGames.length = MAX_RECENT_GAMES;
          }
        }
      }

      // If incoming has zero games, clear all active
      if (!data.games || data.games.length === 0) {
        for (const [id, g] of activeGames) {
          recentGames.unshift(g);
        }
        activeGames.clear();
        if (recentGames.length > MAX_RECENT_GAMES) recentGames.length = MAX_RECENT_GAMES;
      }

      knownGameIds = incomingIds;
      lastUpdated = data.updated || new Date().toISOString();

      renderActiveGames();
      renderRecentGames();

    } catch (e) {
      // File doesn't exist yet or server is down
      statusEl.className = 'connection-status disconnected';
      statusEl.querySelector('.status-text').textContent = 'Disconnected';
    }
  }

  // ── Render Active Games (in-place DOM updates) ──
  function renderActiveGames() {
    activeCountEl.textContent = `${activeGames.size} ${activeGames.size === 1 ? 'game' : 'games'}`;

    if (activeGames.size === 0) {
      activeListEl.innerHTML = '';
      noGamesEl.style.display = 'block';
      return;
    }

    noGamesEl.style.display = 'none';

    const sorted = Array.from(activeGames.values());

    // Remove stale cards
    const currentIds = new Set(sorted.map(g => g.id));
    activeListEl.querySelectorAll('.active-game-card').forEach(card => {
      if (!currentIds.has(card.dataset.gameId)) card.remove();
    });

    // Update or create cards
    for (const game of sorted) {
      const sel = `.active-game-card[data-game-id="${CSS.escape(game.id)}"]`;
      const existing = activeListEl.querySelector(sel);
      if (existing) {
        updateCardInPlace(existing, game);
      } else {
        const div = document.createElement('div');
        div.innerHTML = buildCardHTML(game);
        const card = div.firstElementChild;
        card.addEventListener('click', () => {
          window.location.href = 'game.html?id=' + encodeURIComponent(game.id);
        });
        activeListEl.appendChild(card);
      }
    }
  }

  /** Patch existing card DOM without replacing it */
  function updateCardInPlace(card, game) {
    const players = game.players || [];
    const sorted  = [...players].sort((a, b) => (b.kills || 0) - (a.kills || 0));

    const title = card.querySelector('.game-card-title');
    if (title) title.textContent = game.gameName || game.mission || 'Unknown Map';

    const meta = card.querySelector('.game-card-meta');
    if (meta) {
      const mode = game.gameMode || 'Anarchy';
      const duration = game.timeElapsed || '';
      const metaItems = [
        `<span class="game-card-meta-item">${esc(game.mission || 'Unknown Map')}</span>`,
        `<span class="game-card-meta-item">${game.playerCount || players.length}/${game.maxPlayers || 8}</span>`,
        `<span class="game-card-meta-item">${esc(mode)}</span>`,
        duration ? `<span class="game-card-meta-item">${esc(duration)}</span>` : '',
        game.host ? `<span class="game-card-meta-item">${esc(game.host)}:${game.port}</span>` : ''
      ].filter(Boolean);
      meta.innerHTML = metaItems.join('');
    }

    // Players
    const playersEl = card.querySelector('.game-card-players');
    if (playersEl) {
      const rows = playersEl.querySelectorAll('.player-row');
      if (rows.length !== sorted.length || sorted.length === 0) {
        // Rebuild rows
        playersEl.innerHTML = sorted.length > 0
          ? sorted.map(p => `
              <div class="player-row">
                <span class="player-name">${esc(p.name)}</span>
                <span class="player-stats">
                  <span class="stat-kills">${p.kills || 0}K</span>
                  <span class="stat-deaths">${p.deaths || 0}D</span>
                  <span class="stat-suicides">${p.suicides || 0}S</span>
                </span>
              </div>`).join('')
          : '<div class="player-row"><span class="player-name">Waiting for players…</span></div>';
      } else {
        rows.forEach((row, i) => {
          const p = sorted[i];
          if (!p) return;
          const n = row.querySelector('.player-name');
          if (n) n.textContent = p.name || '';
          const k = row.querySelector('.stat-kills');
          if (k) k.textContent = `${p.kills || 0}K`;
          const d = row.querySelector('.stat-deaths');
          if (d) d.textContent = `${p.deaths || 0}D`;
          const s = row.querySelector('.stat-suicides');
          if (s) s.textContent = `${p.suicides || 0}S`;
        });
      }
    }

    // Footer
    const footer = card.querySelector('.game-card-footer');
    if (footer) {
      const kp = footer.querySelector('.kill-feed-preview');
      if (kp) {
        const lastKill = game.killFeed && game.killFeed.length > 0
          ? game.killFeed[game.killFeed.length - 1].message || 'No kills yet'
          : 'Game in progress';
        kp.textContent = lastKill;
      }
      const summary = footer.querySelector('.game-stats-summary');
      if (summary) {
        summary.innerHTML = `
          <span>💀 ${game.totalKills || 0}</span>
          ${game.totalDeaths ? `<span>☠️ ${game.totalDeaths}</span>` : ''}`;
      }
    }
  }

  function buildCardHTML(game) {
    const players = game.players || [];
    const sorted  = [...players].sort((a, b) => (b.kills || 0) - (a.kills || 0));

    const playerRows = sorted.length > 0
      ? sorted.map(p => `
          <div class="player-row">
            <span class="player-name">${esc(p.name)}</span>
            <span class="player-stats">
              <span class="stat-kills">${p.kills || 0}K</span>
              <span class="stat-deaths">${p.deaths || 0}D</span>
              <span class="stat-suicides">${p.suicides || 0}S</span>
            </span>
          </div>`).join('')
      : '<div class="player-row"><span class="player-name">Waiting for players…</span></div>';

    const lastKill = game.killFeed && game.killFeed.length > 0
      ? game.killFeed[game.killFeed.length - 1].message || 'No kills yet'
      : 'Game in progress';

    const gameName = game.gameName || game.mission || 'Unknown Map';
    const mode = game.gameMode || 'Anarchy';
    const duration = game.timeElapsed || '';

    return `
      <div class="active-game-card" data-game-id="${esc(game.id)}">
        <div class="game-card-header">
          <div class="game-card-title">${esc(gameName)}</div>
          <span class="live-badge">● LIVE</span>
        </div>
        <div class="game-card-meta">
          <span class="game-card-meta-item">${esc(game.mission || 'Unknown Map')}</span>
          <span class="game-card-meta-item">${game.playerCount || players.length}/${game.maxPlayers || 8}</span>
          <span class="game-card-meta-item">${esc(mode)}</span>
          ${duration ? `<span class="game-card-meta-item">${esc(duration)}</span>` : ''}
          ${game.host ? `<span class="game-card-meta-item">${esc(game.host)}:${game.port}</span>` : ''}
        </div>
        <div class="game-card-players">
          ${playerRows}
        </div>
        <div class="game-card-footer">
          <span class="kill-feed-preview">${esc(lastKill)}</span>
          <span class="game-stats-summary">
            <span>💀 ${game.totalKills || 0}</span>
            ${game.totalDeaths ? `<span>☠️ ${game.totalDeaths}</span>` : ''}
          </span>
        </div>
      </div>`;
  }

  // ── Render Recent Games ──
  function renderRecentGames() {
    recentCountEl.textContent = `${recentGames.length} ${recentGames.length === 1 ? 'game' : 'games'}`;

    if (recentGames.length === 0) {
      recentListEl.innerHTML = '<p style="text-align:center;color:var(--text-dim);padding:2rem">No recent games yet.</p>';
      return;
    }

    recentListEl.innerHTML = recentGames.map(g => {
      const players = g.players || [];
      const names = players.map(p => p.name).join(', ');
      const trunc = names.length > 40 ? names.slice(0, 40) + '…' : names;
      return `
        <div class="recent-game-card" data-game-id="${esc(g.id)}" onclick="window.location.href='game.html?id=${encodeURIComponent(g.id)}'">
          <div class="recent-game-time">${timeAgo(g.timestamp)}</div>
          <div class="recent-game-info">
            <div class="recent-game-map">${esc(g.mission || 'Unknown Map')}</div>
            <div class="recent-game-players">${esc(trunc)}</div>
          </div>
          <div class="recent-game-stats">
            ${g.totalKills || 0} kills • ${players.length} players
          </div>
        </div>`;
    }).join('');
  }

  // ── Start ──
  function init() {
    console.log('DXX Live Tracker v3.0 (HTTP polling)');
    poll(); // First poll immediately
    pollTimer = setInterval(poll, POLL_INTERVAL);

    // Update "time ago" labels periodically
    setInterval(() => {
      if (recentGames.length > 0) renderRecentGames();
    }, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

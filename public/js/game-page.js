/**
 * DXX Dashboard — Game Page v2.1
 *
 * Standalone game detail page. Can show:
 * 1. Live games (polls /data/live-games.json)
 * 2. Archive games (loads from /data/games.json by ID)
 *
 * URL: game.html?id=GAME_ID
 */
(function GamePage() {
  'use strict';

  // ── Configuration ──
  const POLL_URL = 'data/live-games.json';
  const ARCHIVE_URL = 'data/games.json';
  const POLL_INTERVAL = 15000; // 15s idle refresh

  // ── State ──
  const gameId = new URLSearchParams(window.location.search).get('id');
  let currentGame = null;
  let pollTimer = null;
  let missedPolls = 0; // track how many polls without finding the game
  const MAX_MISSED = 12; // 12 × 3s = 36s before showing "not found"
  let isArchiveGame = false; // flag to distinguish archive vs live

  // ── DOM Elements ──
  const loadingEl   = document.getElementById('gameLoading');
  const notFoundEl  = document.getElementById('gameNotFound');
  const contentEl   = document.getElementById('gameContent');
  const headerEl    = document.getElementById('gameHeader');
  const scoreboardEl = document.getElementById('scoreboardContent');
  const killFeedEl  = document.getElementById('killFeedContent');
  const killMatrixEl = document.getElementById('killMatrixContent');
  const timelineEl  = document.getElementById('timelineContent');
  const damageEl    = document.getElementById('damageContent');
  const chatEl      = document.getElementById('chatContent');
  const tabsEl      = document.getElementById('gameTabs');

  // ── Utility ──
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function formatDateTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  // ── Validate ──
  if (!gameId) {
    loadingEl.style.display = 'none';
    notFoundEl.style.display = 'block';
    return;
  }

  document.title = `Game — DXX Tracker`;

  // ── Load Archive Game ──
  async function loadArchiveGame() {
    try {
      const resp = await fetch(ARCHIVE_URL + '?t=' + Date.now());
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      
      // Try multiple matching strategies
      let game = data.games.find(g => g.id === gameId);
      
      // If not found by ID, try matching by old filename-based ID
      if (!game && gameId.includes('-')) {
        game = data.games.find(g => {
          // Match by timestamp pattern in ID
          const tsMatch = gameId.match(/(\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{2})/);
          if (tsMatch && g.timestamp) {
            const gameTs = new Date(g.timestamp).toISOString();
            return gameTs.includes(tsMatch[1].replace(/-/g, ''));
          }
          return false;
        });
      }
      
      if (!game) {
        console.warn(`Game not found in archive: ${gameId}`);
        loadingEl.style.display = 'none';
        notFoundEl.style.display = 'block';
        return;
      }

      isArchiveGame = true;
      currentGame = game;
      console.log('Loaded archive game:', game.id || gameId);
      render(game);
    } catch (e) {
      console.error('Failed to load archive game:', e);
      loadingEl.style.display = 'none';
      notFoundEl.style.display = 'block';
    }
  }

  // ── Poll Loop ──
  async function poll() {
    try {
      const resp = await fetch(POLL_URL + '?t=' + Date.now());
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();

      // Find our game
      let game = null;
      if (data.games && data.games.length > 0) {
        game = data.games.find(g => g.id === gameId);
      }

      if (!game) {
        missedPolls++;
        // Try archive immediately on first miss if we haven't loaded currentGame yet
        if (missedPolls === 1 && !currentGame) {
          console.log('Game not in live-games, trying archive...');
          clearInterval(pollTimer);
          await loadArchiveGame();
        } else if (missedPolls >= MAX_MISSED && !currentGame) {
          // Fallback: if archive also failed after multiple attempts
          console.warn('Game not found in live-games or archive');
          loadingEl.style.display = 'none';
          notFoundEl.style.display = 'block';
          contentEl.style.display = 'none';
          clearInterval(pollTimer);
        }
        return;
      }

      missedPolls = 0;
      isArchiveGame = false;

      // Merge gamelog stats into player data
      if (data.gamelog && data.gamelog.players) {
        for (const p of (game.players || [])) {
          const lp = data.gamelog.players.find(
            x => x.name.toLowerCase() === (p.name || '').toLowerCase()
          );
          if (lp) {
            p.kills    = Math.max(p.kills    || 0, lp.kills    || 0);
            p.deaths   = Math.max(p.deaths   || 0, lp.deaths   || 0);
            p.suicides = Math.max(p.suicides || 0, lp.suicides || 0);
          }
        }
        game.totalKills = data.gamelog.totalKills || 0;
        game.killFeed   = data.gamelog.killFeed   || [];
        game.timeline   = data.gamelog.timeline || [];
        game.chatLog    = data.gamelog.chatLog || [];
        game.killMatrix = data.gamelog.killMatrix || {};
        game.damageBreakdown = data.gamelog.damageBreakdown || [];
      }

      currentGame = game;
      render(game);

    } catch (e) {
      console.warn('Poll error:', e.message);
    }
  }

  // ── Main Render ──
  function render(game) {
    // Show content, hide loading
    loadingEl.style.display = 'none';
    notFoundEl.style.display = 'none';
    contentEl.style.display = 'block';

    // Update page title
    const title = game.gameName || game.mission || 'Unknown Map';
    document.title = `${title} — DXX Tracker`;

    // Sort players by kills
    const players = [...(game.players || [])].sort((a, b) => (b.kills || 0) - (a.kills || 0));
    const gameType = players.length === 2 ? '1v1' : 'ffa';

    // Header
    renderHeader(game);

    // Scoreboard
    scoreboardEl.innerHTML = renderScoreboard(players, gameType);

    // Event data panels
    const hasKillFeed = game.killFeed && game.killFeed.length > 0;
    const hasMatrix = game.killMatrix && Object.keys(game.killMatrix).length > 0;
    const hasDamage = game.damageBreakdown && game.damageBreakdown.length > 0;
    const hasChat = game.chatLog && game.chatLog.length > 0;
    const hasAnyEvents = hasKillFeed || hasMatrix || hasDamage || hasChat;

    if (hasAnyEvents) {
      tabsEl.style.display = 'flex';

      // Show/hide tab buttons based on available data
      tabsEl.querySelectorAll('.gdm-tab').forEach(tab => {
        const panel = tab.dataset.panel;
        if (panel === 'killFeed' && !hasKillFeed) tab.style.display = 'none';
        else if (panel === 'killMatrix' && !hasMatrix) tab.style.display = 'none';
        else if (panel === 'timeline' && !hasKillFeed) tab.style.display = 'none';
        else if (panel === 'damage' && !hasDamage) tab.style.display = 'none';
        else if (panel === 'chat' && !hasChat) tab.style.display = 'none';
        else tab.style.display = '';
      });

      killFeedEl.innerHTML = renderKillFeed(game.killFeed || []);
      killMatrixEl.innerHTML = renderKillMatrix(game.killMatrix || {}, players);
      timelineEl.innerHTML = renderTimeline(game.killFeed || []);
      damageEl.innerHTML = renderDamageBreakdown(game.damageBreakdown || [], players);
      chatEl.innerHTML = renderChatLog(game.chatLog || []);
    } else {
      tabsEl.style.display = 'none';
      const noEventMessage = isArchiveGame 
        ? `<div class="gamelog-status-notice">
             <h4>No Event Data</h4>
             <p>This archived match doesn't have detailed event data (kill feed, timeline, chat).</p>
             <p>Only matches tracked with the local gamelog watcher have full event details.</p>
           </div>`
        : `<div class="gamelog-status-notice">
             <h4>Live Event Feed</h4>
             <p>No gamelog events yet. Events (kills, deaths, chat) appear here <strong>in real-time</strong> as they happen during the game.</p>
             <details>
               <summary>Not seeing events?</summary>
               <ul>
                 <li>The tracker watches <code>~/.d1x-redux/gamelog.txt</code> and <code>~/.d2x-redux/gamelog.txt</code></li>
                 <li>DXX-Redux writes to gamelog.txt as you play</li>
                 <li>Make sure the tracker (<code>node scraper/udp-tracker.js</code>) is running</li>
               </ul>
             </details>
           </div>`;
      killFeedEl.innerHTML = noEventMessage;
    }
  }

  // ── Render: Header ──
  function renderHeader(game) {
    const modeClass = (game.players || []).length === 2 ? 'mode-1v1' : 'mode-ffa';
    const modeLabel = (game.players || []).length === 2 ? '1v1 Duel' : 'Free-For-All';
    const statusBadge = isArchiveGame 
      ? '<span class="archive-badge" style="background:var(--text-muted);color:var(--bg);padding:0.3rem 0.6rem;border-radius:4px;font-size:0.8rem;font-weight:700">ARCHIVE</span>'
      : '<span class="live-badge">LIVE</span>';

    headerEl.innerHTML = `
      <div class="game-page-title-row">
        <div>
          <h1>${esc(game.gameName || game.mission || 'Unknown Map')}</h1>
          <div class="game-page-meta">
            <span class="mode-badge ${modeClass}">${modeLabel}</span>
            <span class="game-page-meta-item">${esc(game.mission || '')}</span>
            <span class="game-page-meta-item">${game.playerCount || (game.players || []).length}/${game.maxPlayers || 8} players</span>
            <span class="game-page-meta-item">${esc(game.gameMode || 'Anarchy')}</span>
            ${game.host ? `<span class="game-page-meta-item">${esc(game.host)}:${game.port}</span>` : ''}
          </div>
        </div>
        ${statusBadge}
      </div>`;
  }

  // ── Render: Scoreboard ──
  function renderScoreboard(players, gameType) {
    if (!players || players.length === 0) {
      return '<p class="gdm-empty">Waiting for players…</p>';
    }

    const medals = ['#1', '#2', '#3'];

    if (gameType === '1v1' && players.length === 2) {
      const p1 = players[0];
      const p2 = players[1];
      const p1Wins = (p1.kills || 0) > (p2.kills || 0);
      const tied = (p1.kills || 0) === (p2.kills || 0);

      return `
        <div class="gdm-duel-scoreboard">
          <div class="gdm-duel-player ${tied ? '' : p1Wins ? 'winner' : 'loser'}">
            <div class="gdm-duel-name">${esc(p1.name)}</div>
            <div class="gdm-duel-score">${p1.kills || 0}</div>
            <div class="gdm-duel-sub">${p1.deaths || 0}D / ${p1.suicides || 0}S</div>
          </div>
          <div class="gdm-duel-divider">VS</div>
          <div class="gdm-duel-player ${tied ? '' : !p1Wins ? 'winner' : 'loser'}">
            <div class="gdm-duel-name">${esc(p2.name)}</div>
            <div class="gdm-duel-score">${p2.kills || 0}</div>
            <div class="gdm-duel-sub">${p2.deaths || 0}D / ${p2.suicides || 0}S</div>
          </div>
        </div>`;
    }

    // FFA scoreboard table
    let rows = '';
    players.forEach((p, i) => {
      const medal = medals[i] || `<span class="gdm-rank">${i + 1}</span>`;
      const kd = (p.deaths || 0) > 0
        ? ((p.kills || 0) / p.deaths).toFixed(2)
        : (p.kills || 0) > 0 ? (p.kills || 0).toFixed(0) : '0';
      rows += `
        <tr class="${i === 0 ? 'gdm-top-player' : ''}">
          <td class="gdm-medal">${medal}</td>
          <td><strong>${esc(p.name)}</strong></td>
          <td class="gdm-kills">${p.kills || 0}</td>
          <td class="gdm-deaths">${p.deaths || 0}</td>
          <td class="gdm-suicides">${p.suicides || 0}</td>
          <td class="gdm-kd">${kd}</td>
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
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // ── Render: Kill Feed ──
  function renderKillFeed(killFeed) {
    if (!killFeed || killFeed.length === 0) {
      return '<p class="gdm-empty">No kills recorded.</p>';
    }

    const items = killFeed.map((k, idx) => {
      const timeStr = k.time
        ? `<span class="kf-time">${esc(typeof k.time === 'string' ? k.time : '')}</span>`
        : `<span class="kf-time">#${idx + 1}</span>`;
      const isSuicide = k.killer === k.victim || !k.killer;
      const killClass = isSuicide ? 'kf-suicide' : 'kf-kill';
      return `
        <div class="kf-entry ${killClass}">
          ${timeStr}
          <span class="kf-msg">${esc(k.message || `${k.killer || ''} killed ${k.victim || ''}`)}</span>
          ${k.method ? `<span class="kf-method">${esc(k.method)}</span>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="gdm-kill-feed-header">
        <span>Kill Feed</span>
        <span class="kf-count">${killFeed.length} kills</span>
      </div>
      <div class="gdm-kill-feed">${items}</div>`;
  }

  // ── Render: Kill Matrix ──
  function renderKillMatrix(killMatrix, players) {
    if (!killMatrix || Object.keys(killMatrix).length === 0 || !players || players.length === 0) {
      return '<p class="gdm-empty">No kill matrix data.</p>';
    }

    const names = players.map(p => p.name);
    let headerCells = '<th class="km-corner">Killer / Victim</th>';
    names.forEach(n => {
      headerCells += `<th class="km-name">${esc(n.length > 12 ? n.slice(0, 10) + '...' : n)}</th>`;
    });

    let rows = '';
    names.forEach(killer => {
      let cells = `<td class="km-row-name"><strong>${esc(killer)}</strong></td>`;
      names.forEach(victim => {
        const count = (killMatrix[killer] && killMatrix[killer][victim]) || 0;
        const isSelf = killer === victim;
        const cls = isSelf ? 'km-self' : count > 0 ? 'km-has-kills' : 'km-zero';
        cells += `<td class="km-cell ${cls}">${count || '-'}</td>`;
      });
      rows += `<tr>${cells}</tr>`;
    });

    return `
      <div class="gdm-kill-feed-header">
        <span>Kill Matrix</span>
        <span class="kf-count">Head-to-head breakdown</span>
      </div>
      <div class="gdm-kill-matrix-wrap">
        <table class="gdm-kill-matrix">
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="gdm-matrix-hint">Rows = kills by player, columns = deaths. Diagonal = suicides.</p>`;
  }

  // ── Render: Timeline (derived from kill feed sequence) ──
  function renderTimeline(killFeed) {
    if (!killFeed || killFeed.length === 0) {
      return '<p class="gdm-empty">No timeline events.</p>';
    }

    const items = killFeed.map((k, idx) => {
      const timeStr = k.time || `#${idx + 1}`;
      const isSuicide = k.killer === k.victim || !k.killer;
      const typeClass = isSuicide ? 'tl-kill tl-suicide' : 'tl-kill';
      const desc = k.message || (isSuicide
        ? `${k.victim || 'Unknown'} died`
        : `${k.killer || '?'} killed ${k.victim || '?'}`);

      return `
        <div class="tl-entry ${typeClass}">
          <span class="tl-time">${esc(timeStr)}</span>
          <span class="tl-desc">${esc(desc)}${k.method ? ` [${esc(k.method)}]` : ''}</span>
        </div>`;
    }).join('');

    return `
      <div class="gdm-timeline-header">
        <span>Timeline</span>
        <span class="tl-count">${killFeed.length} events</span>
      </div>
      <div class="gdm-timeline">${items}</div>`;
  }

  // ── Render: Damage Breakdown ──
  function renderDamageBreakdown(breakdown, players) {
    if (!breakdown || breakdown.length === 0) {
      return '<p class="gdm-empty">No damage data available.</p>';
    }

    const maxDmg = Math.max(...breakdown.map(d => d.totalDamage));
    let weaponRows = '';
    breakdown
      .sort((a, b) => b.totalDamage - a.totalDamage)
      .forEach(d => {
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
      <h4>Weapon Damage Breakdown</h4>
      <div class="gdm-damage-bars">${weaponRows}</div>`;
  }

  // ── Render: Chat Log ──
  function renderChatLog(chatLog) {
    if (!chatLog || chatLog.length === 0) {
      return '<p class="gdm-empty">No chat messages.</p>';
    }

    const items = chatLog.map(msg => `
      <div class="chat-entry">
        ${msg.time ? `<span class="chat-time">${esc(typeof msg.time === 'string' ? msg.time : '')}</span>` : ''}
        <span class="chat-player">${esc(msg.player)}:</span>
        <span class="chat-msg">${esc(msg.message)}</span>
      </div>
    `).join('');

    return `
      <div class="gdm-chat-header">
        <span>Chat Log</span>
        <span class="chat-count">${chatLog.length} messages</span>
      </div>
      <div class="gdm-chat-log">${items}</div>`;
  }

  // ── Tab switching ──
  function setupTabs() {
    const tabs = document.querySelectorAll('.gdm-tab');
    const panels = document.querySelectorAll('.gdm-panel');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = document.getElementById(`panel-${tab.dataset.panel}`);
        if (panel) panel.classList.add('active');
      });
    });
  }

  // ── Start ──
  function init() {
    console.log(`DXX Game Page v2.1 — Game ID: ${gameId}`);
    setupTabs();
    poll(); // First poll immediately
    pollTimer = setInterval(poll, POLL_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

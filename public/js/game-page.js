/**
 * DXX Dashboard — Game Page v1.0
 *
 * Standalone game detail page. Polls /data/live-games.json every 5s
 * to get live game data. Updates the scoreboard and event panels
 * in-place without page reloads.
 *
 * URL: game.html?id=GAME_ID
 */
(function GamePage() {
  'use strict';

  // ── Configuration ──
  const POLL_URL = 'data/live-games.json';
  const POLL_INTERVAL = 15000; // 15s idle refresh

  // ── State ──
  const gameId = new URLSearchParams(window.location.search).get('id');
  let currentGame = null;
  let pollTimer = null;
  let missedPolls = 0; // track how many polls without finding the game
  const MAX_MISSED = 12; // 12 × 3s = 36s before showing "not found"

  // ── DOM Elements ──
  const loadingEl   = document.getElementById('gameLoading');
  const notFoundEl  = document.getElementById('gameNotFound');
  const contentEl   = document.getElementById('gameContent');
  const headerEl    = document.getElementById('gameHeader');
  const scoreboardEl = document.getElementById('scoreboardContent');
  const killFeedEl  = document.getElementById('killFeedContent');
  const killMatrixEl = document.getElementById('killMatrixContent');
  const damageEl    = document.getElementById('damageContent');
  const timelineEl  = document.getElementById('timelineContent');
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
        if (missedPolls >= MAX_MISSED && !currentGame) {
          // Never found this game
          loadingEl.style.display = 'none';
          notFoundEl.style.display = 'block';
          contentEl.style.display = 'none';
          clearInterval(pollTimer);
        }
        return;
      }

      missedPolls = 0;

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
    const hasKillMatrix = game.killMatrix && Object.keys(game.killMatrix).length > 0;
    const hasDamage = game.damageBreakdown && game.damageBreakdown.length > 0;
    const hasTimeline = game.timeline && game.timeline.length > 0;
    const hasChat = game.chatLog && game.chatLog.length > 0;
    const hasAnyEvents = hasKillFeed || hasKillMatrix || hasDamage || hasTimeline || hasChat;

    if (hasAnyEvents) {
      tabsEl.style.display = 'flex';

      // Show/hide tab buttons based on available data
      tabsEl.querySelectorAll('.gdm-tab').forEach(tab => {
        const panel = tab.dataset.panel;
        if (panel === 'damage' && !hasDamage) tab.style.display = 'none';
        else if (panel === 'chat' && !hasChat) tab.style.display = 'none';
        else tab.style.display = '';
      });

      killFeedEl.innerHTML = renderKillFeed(game.killFeed || []);
      killMatrixEl.innerHTML = renderKillMatrix(game.killMatrix || {}, players);
      damageEl.innerHTML = renderDamageBreakdown(game.damageBreakdown || [], players);
      timelineEl.innerHTML = renderTimeline(game.timeline || []);
      chatEl.innerHTML = renderChatLog(game.chatLog || []);
    } else {
      tabsEl.style.display = 'none';
      killFeedEl.innerHTML = `
        <div class="gamelog-status-notice">
          <h4>📝 Live Event Feed</h4>
          <p>No gamelog events yet. Events (kills, deaths, chat) appear here <strong>in real-time</strong> as they happen during the game — you don't have to wait for the game to end.</p>
          <details>
            <summary>Not seeing events?</summary>
            <ul>
              <li>The tracker watches <code>~/.d1x-redux/gamelog.txt</code> and <code>~/.d2x-redux/gamelog.txt</code></li>
              <li>DXX-Redux writes to gamelog.txt as you play — kills, deaths, and chat all appear live</li>
              <li>Make sure the tracker (<code>node scraper/udp-tracker.js</code>) is running</li>
              <li>You can set <code>LOCAL_PLAYER=YourName</code> env var to replace "You" with your name</li>
              <li>Other players can upload their gamelog via <code>POST /api/gamelog</code> on port 9998 to merge perspectives</li>
            </ul>
          </details>
        </div>`;
    }
  }

  // ── Render: Header ──
  function renderHeader(game) {
    const modeClass = (game.players || []).length === 2 ? 'mode-1v1' : 'mode-ffa';
    const modeLabel = (game.players || []).length === 2 ? '1v1 Duel' : 'Free-For-All';

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
        <span class="live-badge">🔴 LIVE</span>
      </div>`;
  }

  // ── Render: Scoreboard ──
  function renderScoreboard(players, gameType) {
    if (!players || players.length === 0) {
      return '<p class="gdm-empty">Waiting for players…</p>';
    }

    const medals = ['🥇', '🥈', '🥉'];

    if (gameType === '1v1' && players.length === 2) {
      const p1 = players[0];
      const p2 = players[1];
      const p1Wins = (p1.kills || 0) > (p2.kills || 0);
      const tied = (p1.kills || 0) === (p2.kills || 0);

      return `
        <div class="gdm-duel-scoreboard">
          <div class="gdm-duel-player ${tied ? '' : p1Wins ? 'winner' : 'loser'}">
            <div class="gdm-duel-name">${p1Wins && !tied ? '🏆 ' : ''}${esc(p1.name)}</div>
            <div class="gdm-duel-score">${p1.kills || 0}</div>
            <div class="gdm-duel-sub">${p1.deaths || 0}D · ${p1.suicides || 0}S</div>
          </div>
          <div class="gdm-duel-divider">VS</div>
          <div class="gdm-duel-player ${tied ? '' : !p1Wins ? 'winner' : 'loser'}">
            <div class="gdm-duel-name">${!p1Wins && !tied ? '🏆 ' : ''}${esc(p2.name)}</div>
            <div class="gdm-duel-score">${p2.kills || 0}</div>
            <div class="gdm-duel-sub">${p2.deaths || 0}D · ${p2.suicides || 0}S</div>
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

    const items = killFeed.map(k => {
      const timeStr = k.time ? `<span class="kf-time">${esc(typeof k.time === 'string' ? k.time : '')}</span>` : '';
      let icon = '💀';
      if (k.method && k.method.toLowerCase().includes('mine')) icon = '💣';
      if (k.method && k.method.toLowerCase().includes('missile')) icon = '🚀';
      if (k.method && k.method.toLowerCase().includes('fusion')) icon = '⚡';
      if (k.method && k.method.toLowerCase().includes('laser')) icon = '🔫';
      if (k.killer === k.victim || !k.killer) icon = '☠️';

      return `
        <div class="kf-entry">
          ${timeStr}
          <span class="kf-icon">${icon}</span>
          <span class="kf-msg">${esc(k.message || `${k.killer || ''} killed ${k.victim || ''}`)}</span>
          ${k.method ? `<span class="kf-method">${esc(k.method)}</span>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="gdm-kill-feed-header">
        <span>⚔️ Kill Feed</span>
        <span class="kf-count">${killFeed.length} kills</span>
      </div>
      <div class="gdm-kill-feed">${items}</div>`;
  }

  // ── Render: Kill Matrix ──
  function renderKillMatrix(matrix, players) {
    const names = players.map(p => p.name);
    if (names.length === 0 || Object.keys(matrix).length === 0) {
      return '<p class="gdm-empty">No kill matrix data.</p>';
    }

    let headerCells = '<th class="km-corner">Killer \\ Victim</th>';
    names.forEach(n => {
      headerCells += `<th class="km-name">${esc(n)}</th>`;
    });

    let rows = '';
    names.forEach(killer => {
      let cells = `<td class="km-row-name"><strong>${esc(killer)}</strong></td>`;
      names.forEach(victim => {
        const count = (matrix[killer] && matrix[killer][victim]) || 0;
        const cls = killer === victim ? 'km-self' : count > 0 ? 'km-has-kills' : 'km-zero';
        const intensity = Math.min(count / 10, 1);
        cells += `<td class="km-cell ${cls}" style="--intensity: ${intensity}">${count || '·'}</td>`;
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

  // ── Render: Timeline ──
  function renderTimeline(timeline) {
    if (!timeline || timeline.length === 0) {
      return '<p class="gdm-empty">No timeline data.</p>';
    }

    const typeIcons = {
      kill: '⚔️', death: '💀', suicide: '☠️',
      join: '📥', leave: '📤', disconnect: '📤',
      reactor: '💥', escape: '🚀', chat: '💬',
      flag: '🚩', orb: '🔮', damage: '💢',
      promotion: '⬆️', demotion: '⬇️',
      start: '🎮', end: '🏁',
    };

    const items = timeline.map(ev => {
      const icon = typeIcons[ev.type] || '•';
      const timeStr = ev.time ? `<span class="tl-time">${esc(typeof ev.time === 'string' ? ev.time : '')}</span>` : '';
      return `
        <div class="tl-entry tl-${esc(ev.type)}">
          ${timeStr}
          <span class="tl-icon">${icon}</span>
          <span class="tl-desc">${esc(ev.description)}</span>
        </div>`;
    }).join('');

    return `
      <div class="gdm-timeline-header">
        <span>📜 Event Timeline</span>
        <span class="tl-count">${timeline.length} events</span>
      </div>
      <div class="gdm-timeline">${items}</div>`;
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
        <span>💬 Chat Log</span>
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
    console.log(`🎮 DXX Game Page v1.0 — Game ID: ${gameId}`);
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

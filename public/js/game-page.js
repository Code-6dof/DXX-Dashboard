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
  const contentEl   = document.getElementById('gameContent');  const loadingTitle = document.getElementById('gameLoadingTitle');
  const loadingMessage = document.getElementById('gameLoadingMessage');
  const loadingProgress = document.getElementById('gameLoadingProgress');  const headerEl    = document.getElementById('gameHeader');
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
      console.log('Loading from archive...');
      loadingTitle.textContent = 'Loading from archive...';
      loadingMessage.textContent = 'Searching for game...';
      loadingProgress.textContent = 'Fetching game';
      
      // Try Firebase first (newer games), then fall back to games.json archive
      let data = null;
      let fromFirebase = false;

      try {
        const fbResp = await fetch(`/api/firebase/game/${encodeURIComponent(gameId)}?t=${Date.now()}`);
        if (fbResp.ok) {
          data = await fbResp.json();
          if (data.game) {
            fromFirebase = true;
            console.log('Found game in Firebase');
          }
        }
      } catch (fbErr) {
        console.log('Firebase lookup failed, trying archive:', fbErr.message);
      }

      // Fall back to games.json archive
      if (!data || !data.game) {
        const resp = await fetch(`/api/games/${encodeURIComponent(gameId)}?t=${Date.now()}`);
        
        if (!resp.ok) {
          if (resp.status === 404) {
            console.warn(`Game not found: ${gameId}`);
            loadingEl.style.display = 'none';
            notFoundEl.style.display = 'block';
            return;
          }
          throw new Error(`HTTP ${resp.status}`);
        }
        
        data = await resp.json();
      }
      
      if (!data.game) {
        console.warn(`Game not found: ${gameId}`);
        loadingEl.style.display = 'none';
        notFoundEl.style.display = 'block';
        return;
      }

      isArchiveGame = true;
      currentGame = data.game;
      
      // Firebase games have events embedded; archive games need event file fetch
      if (fromFirebase && data.game.events) {
        const ev = data.game.events;
        currentGame.killFeed = ev.killFeed || [];
        currentGame.chatLog = ev.chatLog || [];
        currentGame.timeline = ev.timeline || [];
        currentGame.killMatrix = ev.killMatrix || {};
        currentGame.damageBreakdown = ev.damageBreakdown || [];
        if (ev.players && ev.players.length > 0) {
          currentGame.players = ev.players;
        }
        delete currentGame.events; // Clean up nested events
      } else {
        // Try to fetch event data from event files
        loadingMessage.textContent = 'Loading event data...';
        try {
          const eventResp = await fetch(`data/events/${encodeURIComponent(gameId)}.json?t=${Date.now()}`);
          if (eventResp.ok) {
            const eventData = await eventResp.json();
            console.log('Loaded event data for archive game');
            
            currentGame.killFeed = eventData.killFeed || [];
            currentGame.chatLog = eventData.chatLog || [];
            currentGame.timeline = eventData.timeline || [];
            currentGame.killMatrix = eventData.killMatrix || {};
            currentGame.damageBreakdown = eventData.damageBreakdown || [];
            
            if (eventData.players && eventData.players.length > 0) {
              currentGame.players = eventData.players;
            }
          } else {
            console.log('No event file found for this game');
          }
        } catch (eventErr) {
          console.log('Could not load event data:', eventErr.message);
        }
      }
      
      console.log(`Loaded ${fromFirebase ? 'Firebase' : 'archive'} game:`, currentGame.id || gameId);
      render(currentGame);
    } catch (e) {
      console.error('Failed to load archive game:', e);
      loadingEl.style.display = 'none';
      notFoundEl.style.display = 'block';
    }
  }

  // ── Fetch Events from Tracker API (proxied through main server) ──
  async function fetchEvents(gameId) {
    try {
      const resp = await fetch(`/api/events/${encodeURIComponent(gameId)}?t=${Date.now()}`);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      console.warn('Failed to fetch events:', e.message);
      return null;
    }
  }

  // ── Poll Loop ──
  async function poll() {
    try {
      loadingMessage.textContent = 'Checking live games...';
      loadingProgress.textContent = `Poll ${missedPolls + 1}`;
      
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

      // Fetch real-time events from tracker
      const events = await fetchEvents(gameId);
      if (events) {
        game.killFeed = events.killFeed || [];
        game.chatLog = events.chat || [];
        game.timeline = events.timeline || [];
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

    // Build unique display names (handle duplicate player names)
    const displayNames = [];
    const nameCounts = {};
    players.forEach(p => { nameCounts[p.name] = (nameCounts[p.name] || 0) + 1; });
    const nameSeens = {};
    players.forEach((p, i) => {
      if (nameCounts[p.name] > 1) {
        nameSeens[p.name] = (nameSeens[p.name] || 0) + 1;
        displayNames[i] = `${p.name} (${nameSeens[p.name]})`;
      } else {
        displayNames[i] = p.name;
      }
    });

    // Normalize killMatrix: convert array format [i][j] to object {displayName: {displayName: count}}
    let killMatrix = game.killMatrix || null;
    if (Array.isArray(killMatrix) && players.length > 0) {
      const namedMatrix = {};
      players.forEach((p, i) => {
        const dn = displayNames[i];
        namedMatrix[dn] = {};
        players.forEach((p2, j) => {
          namedMatrix[dn][displayNames[j]] = (killMatrix[i] && killMatrix[i][j]) || 0;
        });
      });
      killMatrix = namedMatrix;
    }

    // If no kill feed but we have a kill matrix, generate a summary kill feed from it
    let killFeed = game.killFeed || [];
    if (killFeed.length === 0 && killMatrix && typeof killMatrix === 'object' && !Array.isArray(killMatrix)) {
      const names = Object.keys(killMatrix);
      names.forEach(killer => {
        names.forEach(victim => {
          const count = killMatrix[killer][victim] || 0;
          if (count > 0 && killer !== victim) {
            for (let i = 0; i < count; i++) {
              killFeed.push({
                killer: killer,
                killed: victim,
                victim: victim,
                message: `${killer} killed ${victim}`,
              });
            }
          }
        });
      });
    }

    // If no timeline but we have events, build one from kill feed + chat
    let timeline = game.timeline || [];
    if (timeline.length === 0) {
      if (killFeed.length > 0) {
        killFeed.forEach((k, idx) => {
          const isSuicide = (k.killerNum !== undefined && k.killedNum !== undefined)
            ? k.killerNum === k.killedNum
            : (k.killer === k.killed || k.killer === k.victim);
          timeline.push({
            type: 'kill',
            time: k.time || '',
            description: k.message || (isSuicide ? `${k.killed || k.victim} died` : `${k.killer} killed ${k.killed || k.victim}`),
          });
        });
      }
      if ((game.chatLog || []).length > 0) {
        game.chatLog.forEach(msg => {
          timeline.push({
            type: 'chat',
            time: msg.time || '',
            description: `${msg.from || msg.player || 'Unknown'}: ${msg.message}`,
          });
        });
      }
    }

    // Event data panels
    const hasKillFeed = killFeed.length > 0;
    const hasMatrix = killMatrix && typeof killMatrix === 'object' && !Array.isArray(killMatrix) && Object.keys(killMatrix).length > 0;
    const hasTimeline = timeline.length > 0;
    const hasDamage = game.damageBreakdown && game.damageBreakdown.length > 0;
    const hasChat = game.chatLog && game.chatLog.length > 0;
    const hasAnyEvents = hasKillFeed || hasMatrix || hasTimeline || hasDamage || hasChat;

    if (hasAnyEvents) {
      tabsEl.style.display = 'flex';

      // Show/hide tab buttons based on available data
      tabsEl.querySelectorAll('.gdm-tab').forEach(tab => {
        const panel = tab.dataset.panel;
        if (panel === 'killFeed' && !hasKillFeed) tab.style.display = 'none';
        else if (panel === 'killMatrix' && !hasMatrix) tab.style.display = 'none';
        else if (panel === 'timeline' && !hasTimeline) tab.style.display = 'none';
        else if (panel === 'damage' && !hasDamage) tab.style.display = 'none';
        else if (panel === 'chat' && !hasChat) tab.style.display = 'none';
        else tab.style.display = '';
      });

      // Auto-select first visible tab if current active tab is hidden
      const activeTab = tabsEl.querySelector('.gdm-tab.active');
      if (activeTab && activeTab.style.display === 'none') {
        const firstVisible = tabsEl.querySelector('.gdm-tab:not([style*="display: none"])');
        if (firstVisible) {
          tabsEl.querySelectorAll('.gdm-tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.gdm-panel').forEach(p => p.classList.remove('active'));
          firstVisible.classList.add('active');
          const panel = document.getElementById(`panel-${firstVisible.dataset.panel}`);
          if (panel) panel.classList.add('active');
        }
      }

      killFeedEl.innerHTML = renderKillFeed(killFeed);
      killMatrixEl.innerHTML = renderKillMatrix(killMatrix || {}, players);
      timelineEl.innerHTML = renderTimeline(timeline);
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

    // Format timestamp if available
    const timestampHtml = game.timestamp 
      ? `<span class="game-page-meta-item" style="color:var(--text-dim);font-size:0.9rem">${formatDateTime(game.timestamp)}</span>`
      : '';

    headerEl.innerHTML = `
      <div class="game-page-title-row">
        <div>
          <h1>${esc(game.gameName || game.mission || 'Unknown Map')}</h1>
          <div class="game-page-meta">
            ${timestampHtml}
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
      // Handle both old format (k.time as string) and new format (k.time as game seconds)
      let timeStr;
      if (k.time) {
        timeStr = `<span class="kf-time">${esc(k.time)}s</span>`;
      } else {
        timeStr = `<span class="kf-time">#${idx + 1}</span>`;
      }

      // Handle both old format (k.victim/k.killer) and new format (k.killed/k.killer)
      const victim = k.killed || k.victim || 'Unknown';
      const killer = k.killer || 'Unknown';
      // Use player numbers for suicide detection when available (handles same-name players)
      const isSuicide = (k.killerNum !== undefined && k.killedNum !== undefined)
        ? k.killerNum === k.killedNum
        : (killer === victim || !killer || killer === 'Unknown');
      const killClass = isSuicide ? 'kf-suicide' : 'kf-kill';
      
      // Build message
      let message;
      if (k.message) {
        message = k.message;
      } else if (isSuicide) {
        message = `${victim} died`;
      } else {
        message = `${killer} → ${victim}`;
      }
      
      return `
        <div class="kf-entry ${killClass}">
          ${timeStr}
          <span class="kf-msg">${esc(message)}</span>
          ${k.method || k.weapon ? `<span class="kf-method">${esc(k.method || k.weapon)}</span>` : ''}
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

    // Use killMatrix keys (already unique display names) instead of raw player names
    const names = Object.keys(killMatrix);
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
        const intensity = Math.min(count / 5, 1); // scale for color intensity
        const display = isSelf ? '—' : count > 0 ? count : '·';
        cells += `<td class="km-cell ${cls}" style="--intensity: ${intensity}" title="${esc(killer)} killed ${esc(victim)} ${count} times">${display}</td>`;
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
      </div>`;
  }

  // ── Render: Timeline (shows all events: kills, chat, deaths, etc) ──
  function renderTimeline(timeline) {
    if (!timeline || timeline.length === 0) {
      return '<p class="gdm-empty">No timeline events.</p>';
    }

    const items = timeline.map((evt, idx) => {
      const timeStr = evt.time ? `${evt.time}s` : `#${idx + 1}`;
      
      let typeClass, icon, desc;
      
      // If event has pre-built description (from event files), use it
      if (evt.description) {
        desc = esc(evt.description);
        // Determine icon and class based on type
        switch (evt.type) {
          case 'kill':
            typeClass = 'tl-kill';
            icon = '💀';
            break;
          case 'join':
            typeClass = 'tl-join';
            icon = '👤';
            break;
          case 'chat':
            typeClass = 'tl-chat';
            icon = '💬';
            break;
          case 'reactor':
            typeClass = 'tl-reactor';
            icon = '💥';
            break;
          case 'escape':
            typeClass = 'tl-escape';
            icon = '✈️';
            break;
          case 'death':
            typeClass = 'tl-death';
            icon = '☠️';
            break;
          case 'quit':
            typeClass = 'tl-quit';
            icon = '🚪';
            break;
          default:
            typeClass = 'tl-other';
            icon = '•';
        }
      } else {
        // Build description from individual fields (live tracker format)
        switch (evt.type) {
          case 'kill':
            const isSuicide = (evt.killerNum !== undefined && evt.killedNum !== undefined)
              ? evt.killerNum === evt.killedNum
              : (evt.killer === evt.killed || !evt.killer);
            typeClass = isSuicide ? 'tl-kill tl-suicide' : 'tl-kill';
            icon = '💀';
            desc = isSuicide 
              ? `${esc(evt.killed || 'Unknown')} died`
              : `${esc(evt.killer || '?')} killed ${esc(evt.killed || '?')}`;
            if (evt.weapon) desc += ` (${esc(evt.weapon)})`;
            break;
          case 'chat':
            typeClass = 'tl-chat';
            icon = '💬';
            desc = `${esc(evt.from)}: ${esc(evt.message)}`;
            break;
          case 'death':
            typeClass = 'tl-death';
            icon = '💥';
            desc = `${esc(evt.player)} exploded`;
            break;
          case 'quit':
            typeClass = 'tl-quit';
            icon = '🚪';
            desc = `${esc(evt.player)} left the game`;
            break;
          default:
            typeClass = 'tl-other';
            icon = '•';
            desc = JSON.stringify(evt);
        }
      }

      return `
        <div class="tl-entry ${typeClass}">
          <span class="tl-time">${esc(timeStr)}</span>
          <span class="tl-icon">${icon}</span>
          <span class="tl-desc">${desc}</span>
        </div>`;
    }).join('');

    return `
      <div class="gdm-timeline-header">
        <span>Timeline</span>
        <span class="tl-count">${timeline.length} events</span>
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

    const items = chatLog.map(msg => {
      // Handle both old format and new format
      const player = msg.from || msg.player || 'Unknown';
      const time = msg.time ? `${msg.time}s` : '';
      const isObserver = msg.isObserver || false;
      const observerClass = isObserver ? 'chat-observer' : '';
      
      return `
        <div class="chat-entry ${observerClass}">
          ${time ? `<span class="chat-time">${esc(time)}</span>` : ''}
          <span class="chat-player">${esc(player)}:</span>
          <span class="chat-msg">${esc(msg.message)}</span>
        </div>
      `;
    }).join('');

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

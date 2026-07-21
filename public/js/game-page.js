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
  const POLL_INTERVAL = 5000;  // 5s — match tracker write cadence
  const LIVE_MISS_GRACE = 6;   // retries before falling back to archive (6 × 5s = 30s)

  // ── State ──
  const gameId = new URLSearchParams(window.location.search).get('id');
  let currentGame = null;
  let pollTimer = null;
  let missedPolls = 0; // track how many polls without finding the game
  const MAX_MISSED = 12; // kept for archive fallback path
  let isArchiveGame = false; // flag to distinguish archive vs live
  const openPanelIds = new Set(); // kill feed panels kept open across re-renders

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
  const weaponsEl   = document.getElementById('weaponsContent');
  const combatEl    = document.getElementById('combatContent');
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

  // ── Weapon token icons ──────────────────────────────────────────
  const WEAPON_ICONS = {
    'Laser':              'tokens/laser.webp',
    'Vulcan Cannon':      'tokens/vulcan.webp',
    'Spreadfire (X)':     'tokens/spreadfire.webp',
    'Spreadfire':         'tokens/spreadfire.webp',
    'Plasma Cannon':      'tokens/plasma.webp',
    'Fusion Cannon':      'tokens/fusion.webp',
    'Concussion Missile': 'tokens/concussion.webp',
    'Homing Missile':     'tokens/homer.webp',
    'Proximity Bomb':     'tokens/pbomb.webp',
    'Smart Missile':      'tokens/smissile.webp',
    'Smart Blob':         'tokens/smissile.webp',
    'Mega Missile':       'tokens/mmissile.webp',
    'Earthshaker Missile':   'tokens/earthshaker.webp',
    'Flash Missile':           'tokens/flash.webp',
    'Helix Missile':           'tokens/helix.webp',
    'Reactor':             'tokens/reactor.webp',
    'Omega Cannon':           'tokens/omega.webp',
    'Super Laser':             'tokens/superlaser.webp',
    'Lava':                    'tokens/lava03d2.webp',
    'Mercury Missile':                 'tokens/mercury.webp',
    'Pheonix Cannon':                'tokens/pheonix.webp',
    'Guass':                    'tokens/gauss.webp',
  };
  function weaponIcon(name, size) {
    const src = WEAPON_ICONS[name];
    if (!src) return '';
    const s = size || 20;
    return `<img src="${src}" alt="" class="wi" height="${s}" style="image-rendering:pixelated;vertical-align:middle;margin-right:4px;width:auto;max-width:${s * 3}px">`;
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

      // Update back link to go to archive instead of live
      const backLink = document.getElementById('backLink');
      if (backLink) { backLink.href = 'live.html'; backLink.textContent = '← Back to Archive'; }
      
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

        if (currentGame && !isArchiveGame) {
          // We already have a live game rendered — keep showing it silently
          // until we exceed the grace period, in case the tracker just restarted
          if (missedPolls < LIVE_MISS_GRACE) {
            console.log(`Game not in live poll (miss ${missedPolls}/${LIVE_MISS_GRACE}), retrying…`);
            return;
          }
          // Grace period exhausted — fall through to archive
        }

        // First miss with no game loaded yet — give it a few retries before
        // jumping to the archive, since the tracker file may be momentarily stale
        if (!currentGame && missedPolls < LIVE_MISS_GRACE) {
          console.log(`Game not in live poll (miss ${missedPolls}/${LIVE_MISS_GRACE}), retrying…`);
          loadingMessage.textContent = `Waiting for live game… (${missedPolls}/${LIVE_MISS_GRACE})`;
          return;
        }

        // Exceeded grace — try archive
        console.log('Game not in live-games after grace period, trying archive...');
        clearInterval(pollTimer);
        await loadArchiveGame();
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

    // Sort players by kills (preserve slot index for kill-event matching)
    const players = [...(game.players || [])].map((p, i) => ({ ...p, slotIndex: i })).sort((a, b) => (b.kills || 0) - (a.kills || 0));
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
      p.displayName = displayNames[i];
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
    const hasWeapons = killFeed.length > 0;   // show if any kills recorded
    const hasCombat  = killFeed.length > 0;   // always show progression if kills exist
    const hasAnyEvents = hasKillFeed || hasMatrix || hasTimeline || hasDamage || hasChat || hasWeapons || hasCombat;

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
        else if (panel === 'weapons' && !hasWeapons) tab.style.display = 'none';
        else if (panel === 'combat' && !hasCombat) tab.style.display = 'none';
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
      restoreOpenPanels();
      killMatrixEl.innerHTML = renderKillMatrix(killMatrix || {}, players);
      timelineEl.innerHTML = renderTimeline(timeline);
      damageEl.innerHTML = renderDamageBreakdown(game.damageBreakdown || [], players);
      chatEl.innerHTML = renderChatLog(game.chatLog || []);
      weaponsEl.innerHTML = renderWeaponsChart(killFeed);
      combatEl.innerHTML  = renderCombatChart(killFeed, players);
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
  // Format game-time seconds (float/string) as M:SS
  function fmtTime(t) {
    const secs = parseFloat(t);
    if (isNaN(secs)) return String(t);
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function renderKillFeed(killFeed) {
    if (!killFeed || killFeed.length === 0) {
      return '<p class="gdm-empty">No kills recorded.</p>';
    }

    // Sort newest-first (descending): most recent kill at top, oldest at bottom
    const sorted = [...killFeed].sort((a, b) => {
      const ta = a.time !== undefined ? parseFloat(a.time) : -Infinity;
      const tb = b.time !== undefined ? parseFloat(b.time) : -Infinity;
      return tb - ta;
    });

    const items = sorted.map((k, idx) => {
      // Handle both old format (k.time as string) and new format (k.time as game seconds)
      let timeStr;
      if (k.time !== undefined && k.time !== '') {
        timeStr = `<span class="kf-time">${fmtTime(k.time)}</span>`;
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

      // Damage breakdown — open by default, click to collapse
      const hasDmg = k.killerBreakdown && k.killerBreakdown.length > 0;
      const dmgId = `kf-dmg-${idx}`;
      let dmgHtml = '';
      if (hasDmg) {
        const rows = k.killerBreakdown.map(attacker => {
          const weaponList = attacker.weapons.map(w =>
            `<span class="kf-dmg-weapon">${weaponIcon(w.name, 14)}${esc(w.name)} <em>${w.damage} dmg · ${w.hits}h</em></span>`
          ).join('');
          return `<div class="kf-dmg-attacker">
            <span class="kf-dmg-name">${esc(attacker.killerName)}</span>
            <span class="kf-dmg-total">${attacker.totalDamage} dmg · ${attacker.hits} hits</span>
            <div class="kf-dmg-weapons">${weaponList}</div>
          </div>`;
        }).join('');
        dmgHtml = `<div class="kf-dmg-panel" id="${dmgId}">${rows}</div>`;
      }

      const expandAttr = hasDmg ? `data-dmg="${dmgId}" title="Click to show damage breakdown"` : '';
      const expandClass = hasDmg ? ' kf-has-dmg' : '';

      return `
        <div class="kf-entry ${killClass}${expandClass}" ${expandAttr}>
          ${timeStr}
          <span class="kf-msg">${esc(message)}</span>
          ${k.method || k.weapon ? `<span class="kf-method">${esc(k.method || k.weapon)}</span>` : ''}
        </div>
        ${dmgHtml}`;
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

    // Sort chronologically: timed events ascending, untimed at end
    const sorted = [...timeline].sort((a, b) => {
      const ta = a.time !== undefined && a.time !== '' ? parseFloat(a.time) : Infinity;
      const tb = b.time !== undefined && b.time !== '' ? parseFloat(b.time) : Infinity;
      return ta - tb;
    });
    const items = sorted.map((evt, idx) => {
      const timeStr = evt.time !== undefined && evt.time !== '' ? fmtTime(evt.time) : `#${idx + 1}`;
      
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

  // ── Render: Weapons Chart ──
  function renderWeaponsChart(killFeed) {
    if (!killFeed || killFeed.length === 0) return '<p class="gdm-empty">No kill data.</p>';

    const weaponCounts = {};
    killFeed.forEach(k => {
      if (k.isEnvKill) return;
      const w = k.weapon || 'Unknown';
      weaponCounts[w] = (weaponCounts[w] || 0) + 1;
    });

    const playerKillCount = killFeed.filter(k => !k.isEnvKill).length;
    const envKills        = killFeed.filter(k => k.isEnvKill).length;
    const entries = Object.entries(weaponCounts).sort((a, b) => b[1] - a[1]);
    const max     = entries.length ? entries[0][1] : 1;

    const bars = entries.map(([name, count]) => {
      const pct   = max > 0 ? (count / max * 100).toFixed(1) : 0;
      const share = playerKillCount > 0 ? (count / playerKillCount * 100).toFixed(0) : 0;
      return `
        <div class="wc-row">
          <span class="wc-name">${weaponIcon(name, 20)}${esc(name)}</span>
          <div class="wc-bar-track"><div class="wc-bar-fill" style="width:${pct}%"></div></div>
          <span class="wc-count">${count}</span>
          <span class="wc-share">${share}%</span>
        </div>`;
    }).join('');

    const killerTotals = {};
    killFeed.forEach(k => {
      if (k.isEnvKill || !k.killer) return;
      killerTotals[k.killer] = (killerTotals[k.killer] || 0) + 1;
    });
    
    const statPills = Object.entries(killerTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([name, kills]) => `<span class="wc-stat-pill"><strong>${esc(name)}</strong> ${kills}K</span>`)
      .join('');

    return `
      <div class="gdm-kill-feed-header">
        <span>Kills by Weapon</span>
        <span class="kf-count">${playerKillCount} player kills · ${envKills} env</span>
      </div>
      ${statPills ? `<div class="wc-stat-pills">${statPills}</div>` : ''}
      <div class="wc-chart">${bars || '<p class="gdm-empty">All kills were environment kills.</p>'}</div>`;
  }

  // ── Render: Combat Chart ──
  function renderCombatChart(killFeed, players) {
    if (!killFeed || killFeed.length === 0) return '<p class="gdm-empty">No kill data.</p>';

    // Descent player colors by color index (0-7) as assigned in-game
    const DESCENT_COLORS = [
      '#4488ff', // 0 Blue
      '#ff3333', // 1 Red
      '#00cc44', // 2 Green
      '#ffdd00', // 3 Yellow
      '#00cccc', // 4 Cyan
      '#cc44ff', // 5 Purple
      '#ff8800', // 6 Orange
      '#dddddd', // 7 White
    ];
    // Fall back to position-based palette for players with no color set
    const FALLBACK_COLORS = ['#4488ff','#ff3333','#00cc44','#ffdd00','#00cccc','#cc44ff','#ff8800','#dddddd'];
    const getPlayerColor = (p, idx) => DESCENT_COLORS[p.color] ?? FALLBACK_COLORS[idx % FALLBACK_COLORS.length];

    // Order by netgame slot (slotIndex = original game.players array position)
    const slotOrderedPlayers = [...players].sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0));

    // Parse kill times and sort by time
    const timedKills = killFeed
      .filter(k => !k.isEnvKill && k.time !== undefined && k.killer)
      .map(k => {
        const t = typeof k.time === 'string' ? parseFloat(k.time) : k.time;
        return { t, killer: k.killer, killerNum: k.killerNum };
      })
      .filter(k => typeof k.t === 'number' && !isNaN(k.t))
      .sort((a, b) => a.t - b.t);

    let svgHtml = '';
    if (timedKills.length > 0 && slotOrderedPlayers.length > 0) {
      const W = 600, H = 180;
      const PAD = { top: 12, right: 15, bottom: 28, left: 30 };
      const cW = W - PAD.left - PAD.right;
      const cH = H - PAD.top  - PAD.bottom;
      const maxT = Math.max(timedKills[timedKills.length - 1].t, 1);
      const maxK = Math.max(...slotOrderedPlayers.map(p => p.kills || 0), 1);
      const toX  = t => (PAD.left + (t / maxT) * cW).toFixed(1);
      const toY  = k => (PAD.top  + cH - (k / (maxK + 0.5)) * cH).toFixed(1);

      const grid = [];
      const ySteps = Math.min(maxK, 5);
      for (let i = 0; i <= ySteps; i++) {
        const v = Math.round(i * maxK / ySteps);
        const y = toY(v);
        grid.push(`<line x1="${PAD.left}" x2="${PAD.left + cW}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`);
        grid.push(`<text x="${PAD.left - 4}" y="${y}" text-anchor="end" dominant-baseline="middle" class="cc-axis">${v}</text>`);
      }
      const xStep = maxT > 120 ? 60 : maxT > 60 ? 30 : 15;
      for (let t = 0; t <= maxT; t += xStep) {
        grid.push(`<text x="${toX(t)}" y="${PAD.top + cH + 16}" text-anchor="middle" class="cc-axis">${t}s</text>`);
      }

      const paths = slotOrderedPlayers.map((p, idx) => {
        const color = getPlayerColor(p, idx);
        let kills = 0;
        const pts = [[0, 0]];
        timedKills.forEach(k => {
          // Prefer slot-number match (immune to dedup name suffixes); fall back to name
          const matches = k.killerNum !== undefined ? k.killerNum === p.slotIndex : k.killer === p.name;
          if (matches) {
            pts.push([k.t, kills]);      // Before kill
            kills++;
            pts.push([k.t, kills]);      // After kill
          }
        });
        pts.push([maxT, kills]);  // Extend line to end for all players
        const d = pts.map(([t, k], i) => `${i === 0 ? 'M' : 'L'}${toX(t)} ${toY(k)}`).join(' ');
        return `<path d="${d}" stroke="${color}" stroke-width="2.5" fill="none" stroke-linejoin="round"/>`;
      });

      const legend = slotOrderedPlayers.map((p, idx) => {
        const color = getPlayerColor(p, idx);
        return `<span class="cc-legend-item"><svg width="18" height="4" style="flex-shrink:0"><line x1="0" y1="2" x2="18" y2="2" stroke="${color}" stroke-width="2.5"/></svg>${esc(p.displayName || p.name)}</span>`;
      }).join('');

      svgHtml = `
        <div class="cc-legend">${legend}</div>
        <div class="cc-chart-wrap">
          <svg viewBox="0 0 ${W} ${H}" class="cc-svg" preserveAspectRatio="xMidYMid meet">
            ${grid.join('')}${paths.join('')}
          </svg>
        </div>`;
    }

    // Damage dealt / received aggregated from killerBreakdown
    const dmgDealt   = {};
    const dmgReceived= {};
    slotOrderedPlayers.forEach(p => { dmgDealt[p.name] = 0; dmgReceived[p.name] = 0; });
    killFeed.forEach(k => {
      if (k.totalDamage && k.killed && dmgReceived[k.killed] !== undefined)
        dmgReceived[k.killed] += k.totalDamage;
      if (k.killerBreakdown)
        k.killerBreakdown.forEach(b => { if (dmgDealt[b.killerName] !== undefined) dmgDealt[b.killerName] += b.totalDamage; });
    });

    const hasDmgData = slotOrderedPlayers.some(p => (dmgDealt[p.name] || 0) + (dmgReceived[p.name] || 0) > 0);
    let dmgTable = '';
    if (hasDmgData) {
      const rows = [...slotOrderedPlayers]
        .sort((a, b) => (dmgDealt[b.name] || 0) - (dmgDealt[a.name] || 0))
        .map(p => {
          const dealt = dmgDealt[p.name]    || 0;
          const recv  = dmgReceived[p.name] || 0;
          const ratio = recv > 0 ? (dealt / recv).toFixed(2) : dealt > 0 ? '∞' : '—';
          return `<tr>
            <td><strong>${esc(p.name)}</strong></td>
            <td class="cc-dealt">${dealt}</td>
            <td class="cc-recv">${recv}</td>
            <td class="cc-ratio">${ratio}</td>
          </tr>`;
        }).join('');
      dmgTable = `
        <h4 class="cc-sub">Damage Summary</h4>
        <table class="cc-dmg-table">
          <thead><tr><th>Player</th><th>Dealt</th><th>Received</th><th>Ratio</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    return `
      <div class="gdm-kill-feed-header"><span>Kill Progression</span></div>
      ${svgHtml}
      ${dmgTable}`;
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

  // ── Restore open panels after kill feed re-render ──
  function restoreOpenPanels() {
    openPanelIds.forEach(id => {
      const panel = document.getElementById(id);
      if (!panel) return;
      panel.classList.add('kf-dmg-open');
      const entry = killFeedEl.querySelector(`[data-dmg="${id}"]`);
      if (entry) {
        entry.classList.add('kf-expanded');
        entry.title = 'Damage breakdown';
      }
    });
  }

  // ── Kill feed click: toggle damage breakdown panel ──
  function setupKillFeedClicks() {
    killFeedEl.addEventListener('click', e => {
      const entry = e.target.closest('.kf-has-dmg');
      if (!entry) return;
      const panelId = entry.dataset.dmg;
      const panel = panelId ? document.getElementById(panelId) : null;
      if (!panel) return;
      const isOpen = panel.classList.contains('kf-dmg-open');
      if (isOpen) {
        panel.classList.remove('kf-dmg-open');
        entry.classList.remove('kf-expanded');
        entry.title = 'Click to show damage breakdown';
        openPanelIds.delete(panelId);
      } else {
        panel.classList.add('kf-dmg-open');
        entry.classList.add('kf-expanded');
        entry.title = 'Click to hide damage breakdown';
        openPanelIds.add(panelId);
      }
    });
  }

  // ── Start ──
  function init() {
    console.log(`DXX Game Page v2.1 — Game ID: ${gameId}`);
    setupTabs();
    setupKillFeedClicks();
    poll(); // First poll immediately
    pollTimer = setInterval(poll, POLL_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

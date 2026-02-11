/**
 * DXX-Redux Gamelog Watcher
 * 
 * Watches a directory for DXX-Redux gamelog files (gamelog.txt, gamelog-*.txt),
 * parses them in real-time, and stores structured event data as JSON files
 * that the DXX Dashboard can load.
 * 
 * This acts as a lightweight "tracker" - it doesn't intercept network traffic,
 * but instead reads the game's own event log that DXX-Redux writes to disk.
 * 
 * Setup:
 *   1. Configure DXX-Redux to write split gamelogs:
 *      Add to your dxx-redux ini or launch args: -gamelog_split -gamelog_timestamp
 *   2. Point GAMELOG_DIR to where DXX-Redux writes gamelog files
 *      (usually ~/.d1x-redux/ or ~/.d2x-redux/ on Linux,
 *       or the game directory on Windows)
 *   3. Run: node scraper/gamelog-watcher.js
 * 
 * The watcher will:
 *   - Scan for existing gamelog files and parse them
 *   - Watch for new/modified gamelog files
 *   - Output structured JSON to public/data/events/
 *   - Optionally serve a WebSocket feed for live dashboard updates
 * 
 * Environment variables:
 *   GAMELOG_DIR    - Directory to watch (default: auto-detect)
 *   EVENTS_DIR    - Output directory for event JSON (default: public/data/events)
 *   WATCH_MODE    - 'poll' or 'fs' (default: fs)
 *   POLL_INTERVAL - Poll interval in ms if using poll mode (default: 2000)
 *   WS_PORT       - WebSocket port for live feed (default: 0 = disabled)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseGamelog, summarize, findGamelogs } = require('./gamelog-parser');

// ── Configuration ───────────────────────────────────────────────
const CONFIG = {
  // Where DXX-Redux writes gamelog files
  gamelogDirs: resolveGamelogDirs(),
  // Where we output parsed event JSON
  eventsDir: path.resolve(__dirname, '../public/data/events'),
  // Watch mode: 'fs' (fs.watch) or 'poll' (periodic scan)
  watchMode: process.env.WATCH_MODE || 'fs',
  // Poll interval in ms
  pollInterval: parseInt(process.env.POLL_INTERVAL) || 2000,
  // WebSocket port (0 = disabled)
  wsPort: parseInt(process.env.WS_PORT) || 0,
};

// ── Auto-detect gamelog directories ─────────────────────────────
function resolveGamelogDirs() {
  if (process.env.GAMELOG_DIR) {
    return process.env.GAMELOG_DIR.split(':').filter(Boolean);
  }

  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'linux' || process.platform === 'darwin') {
    candidates.push(
      path.join(home, '.d1x-redux'),
      path.join(home, '.d2x-redux'),
      path.join(home, '.d1x-rebirth'),
      path.join(home, '.d2x-rebirth'),
    );
  } else if (process.platform === 'win32') {
    // Windows: game directory or AppData
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(
      path.join(appData, 'd1x-redux'),
      path.join(appData, 'd2x-redux'),
      path.join(appData, 'd1x-rebirth'),
      path.join(appData, 'd2x-rebirth'),
    );
  }

  return candidates.filter((d) => fs.existsSync(d));
}

// ── State ───────────────────────────────────────────────────────
const processedFiles = new Map(); // filename -> { mtime, size, hash }
let allGameEvents = [];           // all parsed game event summaries

// ── Ensure output directory exists ──────────────────────────────
function ensureEventsDir() {
  if (!fs.existsSync(CONFIG.eventsDir)) {
    fs.mkdirSync(CONFIG.eventsDir, { recursive: true });
    console.log(`📁 Created events directory: ${CONFIG.eventsDir}`);
  }
}

// ── Process a single gamelog file ───────────────────────────────
function processGamelog(filePath) {
  const filename = path.basename(filePath);
  const stat = fs.statSync(filePath);

  // Skip if already processed and unchanged
  const cached = processedFiles.get(filePath);
  if (cached && cached.mtime >= stat.mtimeMs && cached.size === stat.size) {
    return null;
  }

  console.log(`📄 Parsing: ${filename} (${(stat.size / 1024).toFixed(1)} KB)`);

  try {
    // Extract date from filename if possible
    let gameDate = stat.mtime;
    const tsMatch = filename.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (tsMatch) {
      gameDate = new Date(
        parseInt(tsMatch[1]), parseInt(tsMatch[2]) - 1, parseInt(tsMatch[3]),
        parseInt(tsMatch[4]), parseInt(tsMatch[5]), parseInt(tsMatch[6])
      );
    }

    // Extract mission/level from filename if available
    // Format: gamelog-missionname-level-YYYYMMDD-HHMMSS.txt
    let mission = null;
    let level = null;
    const missionMatch = filename.match(/^gamelog-(.+?)-(\d+)-\d{8}-\d{6}\.txt$/);
    if (missionMatch) {
      mission = missionMatch[1];
      level = parseInt(missionMatch[2]);
    }

    const events = parseGamelog(filePath, { gameDate });
    const summary = summarize(events);

    const gameEvent = {
      id: filename.replace('.txt', ''),
      filename,
      source: filePath,
      timestamp: gameDate.toISOString(),
      mission,
      level,
      ...summary,
      parsedAt: new Date().toISOString(),
    };

    // Save individual event file
    const outPath = path.join(CONFIG.eventsDir, `${gameEvent.id}.json`);
    fs.writeFileSync(outPath, JSON.stringify(gameEvent, null, 2));

    // Update cache
    processedFiles.set(filePath, { mtime: stat.mtimeMs, size: stat.size });

    console.log(`   ${summary.totalKills} kills, ${summary.players.length} players, ${summary.timeline.length} events`);

    return gameEvent;
  } catch (err) {
    console.error(`  ❌ Error parsing ${filename}:`, err.message);
    return null;
  }
}

// ── Scan all configured directories ─────────────────────────────
function scanAll() {
  const newEvents = [];

  for (const dir of CONFIG.gamelogDirs) {
    const gamelogs = findGamelogs(dir);
    console.log(`\n📂 Found ${gamelogs.length} gamelog(s) in ${dir}`);

    for (const log of gamelogs) {
      const result = processGamelog(log.path);
      if (result) {
        newEvents.push(result);
      }
    }
  }

  if (newEvents.length > 0) {
    allGameEvents = [...allGameEvents, ...newEvents];
    writeEventIndex();
  }

  return newEvents;
}

// ── Write event index file ──────────────────────────────────────
function writeEventIndex() {
  const indexPath = path.join(CONFIG.eventsDir, 'index.json');
  const index = {
    lastUpdated: new Date().toISOString(),
    totalGames: allGameEvents.length,
    games: allGameEvents.map((g) => ({
      id: g.id,
      timestamp: g.timestamp,
      mission: g.mission,
      level: g.level,
      playerCount: g.players.length,
      playerNames: g.players.map((p) => p.name),
      totalKills: g.totalKills,
      totalEvents: g.totalEvents,
    })),
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`\n Event index updated: ${allGameEvents.length} games`);
}

// ── File System Watcher ─────────────────────────────────────────
function startFSWatch() {
  for (const dir of CONFIG.gamelogDirs) {
    console.log(`👁️  Watching: ${dir}`);

    fs.watch(dir, { persistent: true }, (eventType, filename) => {
      if (!filename || !filename.match(/^gamelog.*\.txt$/i)) return;

      const filePath = path.join(dir, filename);
      if (!fs.existsSync(filePath)) return;

      // Debounce: wait a bit for the file to finish writing
      setTimeout(() => {
        const result = processGamelog(filePath);
        if (result) {
          allGameEvents.push(result);
          writeEventIndex();
          broadcastEvent(result);
        }
      }, 500);
    });
  }
}

// ── Poll-based Watcher ──────────────────────────────────────────
function startPollWatch() {
  console.log(`🔄 Polling every ${CONFIG.pollInterval}ms`);

  setInterval(() => {
    const newEvents = scanAll();
    for (const event of newEvents) {
      broadcastEvent(event);
    }
  }, CONFIG.pollInterval);
}

// ── WebSocket broadcast (optional) ──────────────────────────────
let wsClients = [];

function broadcastEvent(event) {
  if (wsClients.length === 0) return;

  const msg = JSON.stringify({
    type: 'game_event',
    data: {
      id: event.id,
      timestamp: event.timestamp,
      players: event.players,
      totalKills: event.totalKills,
      killFeed: event.killFeed.slice(-10), // last 10 kills
    },
  });

  wsClients.forEach((ws) => {
    try {
      ws.send(msg);
    } catch (e) {
      // Client disconnected
    }
  });
}

function startWebSocket() {
  if (!CONFIG.wsPort) return;

  try {
    const WebSocket = require('ws');
    const wss = new WebSocket.Server({ port: CONFIG.wsPort });

    wss.on('connection', (ws) => {
      console.log('🔌 WebSocket client connected');
      wsClients.push(ws);

      // Send current state
      ws.send(JSON.stringify({
        type: 'init',
        data: {
          totalGames: allGameEvents.length,
          recentGames: allGameEvents.slice(-5).map((g) => ({
            id: g.id,
            timestamp: g.timestamp,
            players: g.players.map((p) => p.name),
            totalKills: g.totalKills,
          })),
        },
      }));

      ws.on('close', () => {
        wsClients = wsClients.filter((c) => c !== ws);
      });
    });

    console.log(`🔌 WebSocket server on port ${CONFIG.wsPort}`);
  } catch (e) {
    console.log('  WebSocket disabled (install ws package for live feed: npm i ws)');
  }
}

// ── Main ────────────────────────────────────────────────────────
function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   DXX-Redux Gamelog Watcher v1.0         ║');
  console.log('║   Listening for Descent game events      ║');
  console.log('╚══════════════════════════════════════════╝\n');

  if (CONFIG.gamelogDirs.length === 0) {
    console.log('  No gamelog directories found!');
    console.log('');
    console.log('Set GAMELOG_DIR to your DXX-Redux data directory:');
    console.log('  Linux:   export GAMELOG_DIR=~/.d1x-redux:~/.d2x-redux');
    console.log('  Windows: set GAMELOG_DIR=C:\\Games\\d1x-redux');
    console.log('');
    console.log('Make sure DXX-Redux is configured with:');
    console.log('  -gamelog_split -gamelog_timestamp');
    console.log('');
    console.log('Or create the directory and the watcher will pick up new files.');

    // Create a sample events dir anyway
    ensureEventsDir();
    writeSampleEvent();
    return;
  }

  console.log(`📂 Gamelog directories:`);
  CONFIG.gamelogDirs.forEach((d) => console.log(`   ${d}`));
  console.log(`📁 Events output: ${CONFIG.eventsDir}\n`);

  ensureEventsDir();

  // Initial scan
  scanAll();

  // Start watching
  if (CONFIG.watchMode === 'poll') {
    startPollWatch();
  } else {
    startFSWatch();
  }

  // Start WebSocket if configured
  startWebSocket();

  console.log('\n Waiting for new game events... (Ctrl+C to stop)\n');
}

// ── Write a sample event for testing ────────────────────────────
function writeSampleEvent() {
  const samplePath = path.join(CONFIG.eventsDir, 'sample-game.json');
  const sample = {
    id: 'sample-game',
    filename: 'sample-gamelog.txt',
    timestamp: new Date().toISOString(),
    mission: 'Wrath',
    level: 1,
    players: [
      {
        name: 'PlayerOne',
        kills: 15,
        deaths: 8,
        suicides: 1,
        maxKillStreak: 5,
        weapons: { weapon: 10, 'Quad Laser': 3, 'Concussion Missile': 2 },
        killedBy: { PlayerTwo: 7, reactor: 1 },
        victims: { PlayerTwo: 15 },
        damageTaken: 450.5,
        damageDealt: 623.2,
      },
      {
        name: 'PlayerTwo',
        kills: 8,
        deaths: 15,
        suicides: 0,
        maxKillStreak: 3,
        weapons: { weapon: 5, 'Homing Missile': 2, 'Fusion Cannon': 1 },
        killedBy: { PlayerOne: 15 },
        victims: { PlayerOne: 8 },
        damageTaken: 623.2,
        damageDealt: 450.5,
      },
    ],
    killFeed: [
      { time: null, killer: 'PlayerOne', victim: 'PlayerTwo', method: 'Quad Laser', message: 'PlayerOne killed PlayerTwo!' },
      { time: null, killer: 'PlayerTwo', victim: 'PlayerOne', method: 'Homing Missile', message: 'PlayerTwo killed PlayerOne!' },
      { time: null, killer: 'PlayerOne', victim: 'PlayerTwo', method: 'Concussion Missile', message: 'PlayerOne killed PlayerTwo!' },
    ],
    killMatrix: {
      PlayerOne: { PlayerOne: 0, PlayerTwo: 15 },
      PlayerTwo: { PlayerOne: 8, PlayerTwo: 0 },
    },
    damageBreakdown: [
      { attacker: 'PlayerOne', weapon: 'Quad Laser', totalDamage: 312.5, hits: 45 },
      { attacker: 'PlayerTwo', weapon: 'Homing Missile', totalDamage: 180.0, hits: 12 },
      { attacker: 'PlayerOne', weapon: 'Concussion Missile', totalDamage: 155.0, hits: 8 },
      { attacker: 'PlayerTwo', weapon: 'Fusion Cannon', totalDamage: 120.5, hits: 6 },
    ],
    timeline: [
      { time: null, type: 'join', description: 'PlayerOne is joining the game.' },
      { time: null, type: 'join', description: 'PlayerTwo is joining the game.' },
      { time: null, type: 'kill', description: 'PlayerOne killed PlayerTwo!' },
      { time: null, type: 'kill', description: 'PlayerTwo killed PlayerOne!' },
      { time: null, type: 'kill', description: 'PlayerOne killed PlayerTwo!' },
      { time: null, type: 'reactor', description: 'The control center has been destroyed!' },
      { time: null, type: 'escape', description: 'PlayerOne has escaped!' },
    ],
    chatLog: [
      { time: null, player: 'PlayerOne', message: 'gg' },
      { time: null, player: 'PlayerTwo', message: 'gg wp' },
    ],
    totalEvents: 24,
    totalKills: 23,
    totalDeaths: 24,
    parsedAt: new Date().toISOString(),
    _sample: true,
  };

  fs.writeFileSync(samplePath, JSON.stringify(sample, null, 2));

  const indexPath = path.join(CONFIG.eventsDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify({
    lastUpdated: new Date().toISOString(),
    totalGames: 1,
    games: [{
      id: sample.id,
      timestamp: sample.timestamp,
      mission: sample.mission,
      level: sample.level,
      playerCount: 2,
      playerNames: ['PlayerOne', 'PlayerTwo'],
      totalKills: sample.totalKills,
      totalEvents: sample.totalEvents,
    }],
  }, null, 2));

  console.log(`\n📝 Created sample event data in ${CONFIG.eventsDir}`);
  console.log('   This gives the dashboard something to show in the detail view.');
}

// Run
main();

/**
 * DXX-Redux/Rebirth UDP Game Tracker
 *
 * Compatible with the PyTracker protocol (pudlez/PyTracker).
 *
 * Protocol opcodes:
 *    0  Register         (Game → Tracker, 14-15 bytes)
 *    1  Unregister/VersionDeny (Game → Tracker, 5 or 9 bytes)
 *    2  Game list request (Client → Tracker, 3 bytes)
 *    3  Game info full    (Game → Tracker, variable)
 *    4  Game info lite req(Tracker → Game, 11 bytes)
 *    5  Game info lite    (Game → Tracker, 73 bytes)
 *   21  Register ACK      (Tracker → Game, 1 byte)
 *   22  Game list response(Tracker → Client, variable)
 *   99  Web UI ping       (IPC)
 *
 * Flow:
 *   1. Game sends opcode 0 (register) to tracker
 *   2. Tracker sends opcode 4 (game_info_lite_req) to game IP:port
 *   3. Game responds with opcode 5 (73-byte game_info_lite)
 *   4. Tracker sends opcode 21 (1-byte ACK) to register address ×3
 *   5. Tracker polls confirmed games with opcode 2 (full info, gets player names)
 *      or opcode 4 (lite) for unconfirmed/unknown-proto games
 *   6. If game sends opcode 1 len=9 (version_deny), tracker learns netgame_proto
 *   7. Gamelog watcher tails ~/.d1x-redux/gamelog.txt for live kill/event feed
 *
 * Usage:  node scraper/udp-tracker.js
 * Config: -tracker_hostaddr 127.0.0.1 -tracker_hostport 9999
 */

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseGamelogContent, replaceLocalPlayer, summarize, EVENT } = require('./gamelog-parser');

// ── Configuration ───────────────────────────────────────────────
const CONFIG = {
  udpPort: parseInt(process.env.UDP_PORT) || 9999,
  wsPort: parseInt(process.env.WS_PORT) || 8081,
  eventsDir: path.resolve(__dirname, '../public/data/events'),
  liveGamesFile: path.resolve(__dirname, '../public/data/live-games.json'),
  gameTimeout: 300000,      // 5 min — consider game dead
  cleanupInterval: 60000,   // Check for dead games every minute
  pollInterval: 5000,       // Poll games for stats every 5 seconds
  gamelogDirs: resolveGamelogDirs(),
  gamelogPollInterval: 1000, // Check gamelog for updates every 1s
};

function resolveGamelogDirs() {
  const home = os.homedir();
  if (process.env.GAMELOG_DIR) {
    return process.env.GAMELOG_DIR.split(':').filter(Boolean);
  }
  const candidates = [
    path.join(home, '.d1x-redux'),
    path.join(home, '.d2x-redux'),
    path.join(home, '.d1x-rebirth'),
    path.join(home, '.d2x-rebirth'),
  ];
  return candidates.filter(d => fs.existsSync(d));
}

// ── Protocol Constants (from pudlez/PyTracker dxxtoolkit.py) ────
const OP = {
  REGISTER: 0,
  UNREGISTER_OR_VDENY: 1,
  GAME_LIST_REQUEST: 2,
  GAME_INFO_RESPONSE: 3,
  GAME_INFO_LITE_REQ: 4,
  GAME_INFO_LITE: 5,
  REGISTER_ACK: 21,
  GAME_LIST_RESPONSE: 22,
  WEBUI_IPC: 99,
};
const TRACKER_PROTOCOL_VERSION = 0;

// ── State ───────────────────────────────────────────────────────
const activeGames = new Map(); // "ip:gamePort" → game entry
const wsClients = [];
let server = null;
let wss = null;

// ── Gamelog State ────────────────────────────────────────────────
let gamelogPos = {};          // path → file position (for tailing)
let gamelogEvents = [];       // accumulated events for current game
let gamelogSummary = null;    // running summary
let localPlayerName = null;   // detected local player name (from env or active game)

// ── Multi-client gamelog merging ────────────────────────────────
// Each client can upload their gamelog. We store per-player events
// and merge them into a combined view.
const clientGamelogs = new Map(); // playerName → { events: [], raw: '' }

// ── Ensure output directory ─────────────────────────────────────
function ensureEventsDir() {
  if (!fs.existsSync(CONFIG.eventsDir)) {
    fs.mkdirSync(CONFIG.eventsDir, { recursive: true });
    console.log(`📁 Created events directory: ${CONFIG.eventsDir}`);
  }
}

// ── UDP Server ──────────────────────────────────────────────────
function startUDPServer() {
  server = dgram.createSocket('udp4');

  server.on('message', (msg, rinfo) => {
    try {
      console.log(`\n Packet from ${rinfo.address}:${rinfo.port} | ${msg.length} bytes | opcode=${msg[0]}`);
      console.log(`   Hex: ${msg.toString('hex')}`);
      handlePacket(msg, rinfo);
    } catch (err) {
      console.error(`❌ Error handling packet from ${rinfo.address}:${rinfo.port}:`, err.message);
    }
  });

  server.on('error', (err) => {
    console.error('❌ UDP server error:', err.message);
    server.close();
  });

  server.on('listening', () => {
    const a = server.address();
    console.log(` Tracker listening on ${a.address}:${a.port}`);
  });

  server.bind(CONFIG.udpPort);
}

// ── Packet Router ───────────────────────────────────────────────
function handlePacket(packet, rinfo) {
  if (packet.length < 1) return;
  const opcode = packet[0];

  switch (opcode) {
    case OP.REGISTER: // 0
      console.log('   📝 REGISTER');
      handleRegister(packet, rinfo);
      break;

    case OP.UNREGISTER_OR_VDENY: // 1
      if (packet.length === 5) {
        console.log('     UNREGISTER');
        handleUnregister(packet, rinfo);
      } else if (packet.length === 9) {
        console.log('   🔒 VERSION DENY');
        handleVersionDeny(packet, rinfo);
      } else {
        console.log(`     Opcode 1 unexpected length: ${packet.length}`);
      }
      break;

    case OP.GAME_LIST_REQUEST: // 2
      console.log('    GAME LIST REQUEST');
      handleGameListRequest(packet, rinfo);
      break;

    case OP.GAME_INFO_RESPONSE: // 3
    case OP.GAME_INFO_LITE:     // 5
      console.log(`    GAME INFO (opcode ${opcode}, ${packet.length} bytes)`);
      handleGameInfoResponse(packet, rinfo);
      break;

    case OP.WEBUI_IPC: // 99
      handleWebUIPing(packet, rinfo);
      break;

    default:
      console.log(`   ❓ Unknown opcode ${opcode}`);
      break;
  }
}

// ═══════════════════════════════════════════════════════════════
// Opcode 0: Register Game
// Format: =BBBHIHHH (15 bytes) or =BBBHIHHB (14 bytes)
//   opcode(0), tracker_ver, version(1=D1/2=D2), port(H),
//   game_id(I), major(H), minor(H), micro(H or B)
// ═══════════════════════════════════════════════════════════════
function handleRegister(packet, rinfo) {
  if (packet.length !== 14 && packet.length !== 15) {
    console.log(`     Register: bad length ${packet.length} (expected 14 or 15)`);
    return;
  }

  let o = 1;
  const trackerVer = packet[o++];
  const version    = packet[o++]; // 1 = D1X, 2 = D2X
  const gamePort   = packet.readUInt16LE(o); o += 2;
  const gameId     = packet.readUInt32LE(o); o += 4;
  const relMajor   = packet.readUInt16LE(o); o += 2;
  const relMinor   = packet.readUInt16LE(o); o += 2;
  const relMicro   = (packet.length === 15) ? packet.readUInt16LE(o) : packet[o];

  const vStr = version === 1 ? 'D1X' : 'D2X';
  console.log(`   ${vStr} v${relMajor}.${relMinor}.${relMicro} | port=${gamePort} | gameId=${gameId} | trackerVer=${trackerVer}`);

  if (gamePort < 1024) {
    console.log('     Port < 1024, dropping');
    return;
  }

  // Key by ip:gamePort (matches PyTracker behaviour)
  const key = `${rinfo.address}:${gamePort}`;
  const existing = activeGames.get(key);

  // Duplicate with different game_id? Mark old one stale.
  if (existing && existing.gameId !== gameId) {
    console.log(`     Game ID changed (${existing.gameId} → ${gameId}), resetting`);
    activeGames.delete(key);
  }

  const isNew = !activeGames.has(key);
  const g = activeGames.get(key) || {
    gameName: 'Pending…',
    mission: 'Awaiting game info',
    level: 0,
    gameMode: 'Unknown',
    difficulty: 0,
    status: 'Registering',
    playerCount: 0,
    maxPlayers: 0,
    players: [],
    confirmed: false,
    _broadcasted: false,
  };

  g.id = key;
  g.ip = rinfo.address;
  g.port = gamePort;
  g.gameId = gameId;
  g.version = version;
  g.releaseMajor = relMajor;
  g.releaseMinor = relMinor;
  g.releaseMicro = relMicro;
  g.registerIp = rinfo.address;
  g.registerPort = rinfo.port;
  g.lastSeen = Date.now();
  g.pendingInfoReqs = 0;

  activeGames.set(key, g);

  if (isNew) {
    console.log(`    Game registered: ${key}`);
  } else {
    console.log(`    Game re-registered: ${key}`);
  }

  // Immediately ask the game for details (opcode 4 → game responds with opcode 5)
  sendGameInfoLiteReq(g);
}

// ═══════════════════════════════════════════════════════════════
// Send game_info_lite_req (opcode 4) to a game
// Format: =B4sHHH (11 bytes)
//   opcode(4), request_id("D1XR"/"D2XR"), major, minor, micro
// ═══════════════════════════════════════════════════════════════
function sendGameInfoLiteReq(g) {
  const reqId = g.version === 1 ? 'D1XR' : 'D2XR';
  const buf = Buffer.alloc(11);
  let o = 0;
  buf[o++] = OP.GAME_INFO_LITE_REQ; // 4
  buf.write(reqId, o, 4, 'ascii'); o += 4;
  buf.writeUInt16LE(g.releaseMajor, o); o += 2;
  buf.writeUInt16LE(g.releaseMinor, o); o += 2;
  buf.writeUInt16LE(g.releaseMicro, o);

  server.send(buf, g.port, g.ip, (err) => {
    if (err) console.error(`   ❌ game_info_lite_req error: ${err.message}`);
    else {
      console.log(`    Sent game_info_lite_req to ${g.ip}:${g.port}`);
      g.pendingInfoReqs++;
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Send game_info_full_req (opcode 2) to a game
// Format: =B4sHHHH (13 bytes)
//   opcode(2), request_id("D1XR"/"D2XR"), major, minor, micro, netgame_proto
// Requires known netgame_proto (learned from version_deny).
// Response: opcode 3 (full game_info) or opcode 1 len=9 (version_deny)
// ═══════════════════════════════════════════════════════════════
function sendGameInfoFullReq(g) {
  const reqId = g.version === 1 ? 'D1XR' : 'D2XR';
  const proto = g.netgameProto || 0;
  const buf = Buffer.alloc(13);
  let o = 0;
  buf[o++] = OP.GAME_LIST_REQUEST; // opcode 2 (full info request uses same opcode)
  buf.write(reqId, o, 4, 'ascii'); o += 4;
  buf.writeUInt16LE(g.releaseMajor, o); o += 2;
  buf.writeUInt16LE(g.releaseMinor, o); o += 2;
  buf.writeUInt16LE(g.releaseMicro, o); o += 2;
  buf.writeUInt16LE(proto, o);

  server.send(buf, g.port, g.ip, (err) => {
    if (err) console.error(`   ❌ game_info_full_req error: ${err.message}`);
    else {
      console.log(`    Sent game_info_full_req (proto=${proto}) to ${g.ip}:${g.port}`);
      g.pendingInfoReqs++;
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Send register ACK (opcode 21) — single byte [21]
// Sent 3 times at 25 ms intervals to the REGISTER source address
// (matches PyTracker: dxx_send_register_response × 3)
// ═══════════════════════════════════════════════════════════════
function sendRegisterAck(g) {
  const ack = Buffer.from([OP.REGISTER_ACK]); // [21]
  const ip = g.registerIp;
  const port = g.registerPort;

  function fire(n) {
    server.send(ack, port, ip, (err) => {
      if (err) console.error(`   ❌ ACK #${n} error: ${err.message}`);
      else if (n === 0) console.log(`    Sent register ACK [21] ×3 to ${ip}:${port}`);
    });
  }

  fire(0);
  setTimeout(() => fire(1), 25);
  setTimeout(() => fire(2), 50);
}

// ═══════════════════════════════════════════════════════════════
// Opcode 5 / 3: Game Info Response
// game_info_lite (73 bytes) = =BHHHI16s26s9sIBBBBBBB
// game_info_full (variable) = complex per-version struct
// ═══════════════════════════════════════════════════════════════
function handleGameInfoResponse(packet, rinfo) {
  // Find the game this response belongs to.
  // The game responds from its game port, so match by ip:port.
  let g = null;
  let gKey = null;

  for (const [k, entry] of activeGames) {
    if (entry.ip === rinfo.address && entry.port === rinfo.port) {
      g = entry;
      gKey = k;
      break;
    }
  }

  // Fallback: match by IP only (game may respond from a different port)
  if (!g) {
    for (const [k, entry] of activeGames) {
      if (entry.ip === rinfo.address) {
        g = entry;
        gKey = k;
        break;
      }
    }
  }

  if (!g) {
    console.log(`     Info from unknown source ${rinfo.address}:${rinfo.port}`);
    return;
  }

  g.pendingInfoReqs = Math.max(0, g.pendingInfoReqs - 1);

  const opcode = packet[0];
  if (opcode === OP.GAME_INFO_LITE && packet.length === 73) {
    parseGameInfoLite(packet, g);
  } else if (opcode === OP.GAME_INFO_RESPONSE) {
    // Full info — we can extract basics but detailed parsing is complex
    parseGameInfoFull(packet, g);
  } else {
    console.log(`     Unexpected info: opcode=${opcode} len=${packet.length}`);
    return;
  }

  // First confirmation? Send the register ACK now.
  if (!g.confirmed) {
    g.confirmed = true;
    sendRegisterAck(g);

    console.log(`\n GAME CONFIRMED:`);
    console.log(`   "${g.gameName}" on "${g.mission}"`);
    console.log(`   ${g.playerCount}/${g.maxPlayers} | ${g.gameMode} | Level ${g.level}`);
    console.log(`   Host: ${g.ip}:${g.port}`);
  }

  g.lastSeen = Date.now();
  g.timestamp = new Date().toISOString();

  saveGameData(g);
  broadcastGameUpdate(g, !g._broadcasted);
  g._broadcasted = true;
}

// ── Parse game_info_lite (73 bytes) ─────────────────────────────
// =BHHHI16s26s9sIBBBBBBB
function parseGameInfoLite(packet, g) {
  let o = 1; // skip opcode
  const major   = packet.readUInt16LE(o); o += 2;
  const minor   = packet.readUInt16LE(o); o += 2;
  const micro   = packet.readUInt16LE(o); o += 2;
  const gameId  = packet.readUInt32LE(o); o += 4;

  if (g.gameId && gameId !== g.gameId) {
    console.log(`     Game ID mismatch: expected ${g.gameId}, got ${gameId}`);
    return;
  }

  const gameName     = readCString(packet, o, 16); o += 16;
  const missionTitle = readCString(packet, o, 26); o += 26;
  const missionName  = readCString(packet, o, 9);  o += 9;
  const levelNum     = packet.readUInt32LE(o);      o += 4;
  const mode         = packet[o++];
  const refuse       = packet[o++];
  const difficulty   = packet[o++];
  const status       = packet[o++];
  const players      = packet[o++];
  const maxPlayers   = packet[o++];
  const flags        = packet[o++];

  const MODE_NAMES = [
    'Anarchy', 'Team Anarchy', 'Robo Anarchy', 'Cooperative',
    'Capture Flag', 'Hoard', 'Team Hoard', 'Bounty',
  ];

  g.gameName      = gameName || 'Unnamed Game';
  g.mission       = missionTitle || missionName || 'Unknown';
  g.missionName   = missionName;
  g.level         = levelNum;
  g.gameMode      = MODE_NAMES[mode] || 'Unknown';
  g.modeNum       = mode;
  g.difficulty    = difficulty;
  g.refusePlayers = refuse;
  g.statusNum     = status;
  g.status        = statusName(status);
  g.playerCount   = players;
  g.maxPlayers    = maxPlayers;
  g.flags         = flags;
  g.gameId        = gameId;
  g.players       = Array.from({ length: players }, (_, i) => ({
    name: `Player ${i + 1}`, kills: 0, deaths: 0, suicides: 0,
  }));

  console.log(`   Game: "${g.gameName}" | Mission: "${g.mission}" | ${players}/${maxPlayers} | ${g.gameMode} | Level ${levelNum}`);
}

// ── Parse game_info full (variable length) ──────────────────────
// Full game_info has real player names, connected status, kills, deaths.
// Binary layout (after opcode byte):
//   BHHH          → opcode(3), major, minor, micro
//   12× playerBlk → callsign(9s), connected(B), rank(B), [color(B), missileColor(B), extra(B)]
//   16s26s9sI...  → netgame_name, mission, settings, kills/deaths, etc.
//
// Player block stride depends on version:
//   Retro 1.3 (519/520 bytes): 9s+BBB     = 12 bytes per slot
//   x3up/Redux  (≥546 bytes):  9s+BBBBB   = 14 bytes per slot
// 12 player slots × stride, but only first 8 are real players.
function parseGameInfoFull(packet, g) {
  try {
    if (packet.length < 50) {
      console.log(`     Full info too short: ${packet.length} bytes`);
      return;
    }

    let o = 1; // skip opcode
    const major = packet.readUInt16LE(o); o += 2;
    const minor = packet.readUInt16LE(o); o += 2;
    const micro = packet.readUInt16LE(o); o += 2;

    // Determine player block stride from packet length
    let stride;
    if (packet.length === 519 || packet.length === 520) {
      stride = 12; // Retro 1.3: 9s + BBB
    } else {
      stride = 14; // x3up / Redux: 9s + BBBBB
    }

    const CALLSIGN_LEN = 9;
    const MAX_PLAYERS = 8;
    const TOTAL_SLOTS = 12;
    const playerDataStart = 7; // byte 7 (after B+HHH)
    const playerDataEnd = playerDataStart + TOTAL_SLOTS * stride;

    if (packet.length < playerDataEnd) {
      console.log(`     Packet too short for player data: ${packet.length} < ${playerDataEnd}`);
      // Fallback: just log version
      console.log(`   Full game_info v${major}.${minor}.${micro} (${packet.length} bytes)`);
      return;
    }

    // Extract player names + connected status
    const players = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const blockStart = playerDataStart + i * stride;
      const name = readCString(packet, blockStart, CALLSIGN_LEN);
      const connected = packet[blockStart + CALLSIGN_LEN];

      if (name && connected > 0) {
        players.push({
          name,
          connected,
          rank: packet[blockStart + CALLSIGN_LEN + 1],
          color: stride >= 14 ? packet[blockStart + CALLSIGN_LEN + 2] : 0,
          kills: 0,
          deaths: 0,
          suicides: 0,
        });
      }
    }

    // Try to read settings area for game details
    const settingsStart = playerDataEnd;
    if (packet.length >= settingsStart + 60) {
      const netgameName = readCString(packet, settingsStart, 16);
      const missionTitle = readCString(packet, settingsStart + 16, 26);
      const missionName = readCString(packet, settingsStart + 42, 9);
      const levelNum = packet.readUInt32LE(settingsStart + 51);
      const mode = packet[settingsStart + 55];
      const status = packet[settingsStart + 58];
      const numPlayers = packet[settingsStart + 59]; // total ever connected
      const maxPlayers = packet[settingsStart + 60];
      const curPlayers = packet[settingsStart + 61];

      const MODE_NAMES = [
        'Anarchy', 'Team Anarchy', 'Robo Anarchy', 'Cooperative',
        'Capture Flag', 'Hoard', 'Team Hoard', 'Bounty',
      ];

      if (netgameName) g.gameName = netgameName;
      if (missionTitle) g.mission = missionTitle;
      if (missionName) g.missionName = missionName;
      g.level = levelNum;
      g.gameMode = MODE_NAMES[mode] || g.gameMode;
      g.modeNum = mode;
      g.status = statusName(status);
      g.statusNum = status;
      if (curPlayers > 0) g.playerCount = curPlayers;
      if (maxPlayers > 0) g.maxPlayers = maxPlayers;
    }

    // Merge gamelog stats if available
    if (gamelogSummary && gamelogSummary.players.length > 0) {
      for (const p of players) {
        const logPlayer = gamelogSummary.players.find(
          lp => lp.name.toLowerCase() === p.name.toLowerCase()
        );
        if (logPlayer) {
          p.kills = logPlayer.kills;
          p.deaths = logPlayer.deaths;
          p.suicides = logPlayer.suicides;
        }
      }
    }

    // Update game entry
    if (players.length > 0) {
      g.players = players;
      g.playerCount = players.length;
    }
    g.detailed = true;

    console.log(`   Full game_info v${major}.${minor}.${micro} (${packet.length} bytes, stride=${stride})`);
    console.log(`   Players: ${players.map(p => `${p.name}(${p.connected})`).join(', ') || 'none'}`);

  } catch (err) {
    console.log(`     Full info parse error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Opcode 1 (len=5): Unregister
// Format: =BI (opcode, game_id uint32)
// ═══════════════════════════════════════════════════════════════
function handleUnregister(packet, rinfo) {
  const gameId = packet.readUInt32LE(1);
  console.log(`   game_id=${gameId} from ${rinfo.address}`);

  // PyTracker note: the unregister may come from a different port than the
  // game port, so we match by game_id + IP rather than ip:port.
  for (const [key, g] of activeGames) {
    if (g.gameId === gameId && g.ip === rinfo.address) {
      console.log(`   Removed: "${g.gameName}"`);
      activeGames.delete(key);
      broadcastGameRemoval(key);
      return;
    }
  }
  console.log('     Game not found');
}

// ═══════════════════════════════════════════════════════════════
// Opcode 1 (len=9): Version Deny
// Format: =BHHHH (opcode, major, minor, micro, netgame_proto)
// ═══════════════════════════════════════════════════════════════
function handleVersionDeny(packet, rinfo) {
  let o = 1;
  const major = packet.readUInt16LE(o); o += 2;
  const minor = packet.readUInt16LE(o); o += 2;
  const micro = packet.readUInt16LE(o); o += 2;
  const proto = packet.readUInt16LE(o);

  console.log(`   v${major}.${minor}.${micro} proto=${proto} from ${rinfo.address}:${rinfo.port}`);

  // Update netgame protocol for this game (used for full info parsing)
  for (const [, g] of activeGames) {
    if (g.ip === rinfo.address) {
      g.netgameProto = proto;
      console.log(`   Updated netgame proto for ${g.gameName}`);
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Opcode 2: Game List Request
// Format: =BH (3 bytes): opcode(2), version(uint16, 1=D1X, 2=D2X)
// Respond with opcode 22 for each matching confirmed game.
// ═══════════════════════════════════════════════════════════════
function handleGameListRequest(packet, rinfo) {
  if (packet.length !== 3) {
    console.log(`     Wrong length: ${packet.length}`);
    return;
  }

  const version = packet.readUInt16LE(1);
  console.log(`   version=${version} from ${rinfo.address}:${rinfo.port}`);

  let sent = 0;
  for (const [, g] of activeGames) {
    if (g.confirmed && g.version === version) {
      sendGameListResponse(g, rinfo);
      sent++;
    }
  }
  console.log(`   Sent ${sent} game(s)`);
}

// ── Send game_list_response (opcode 22) ─────────────────────────
// Format: =BB{ipLen}sHHHHI16s26s9sIBBBBBBBB
function sendGameListResponse(g, rinfo) {
  const ipStr = g.ip + '\0';
  const ipBuf = Buffer.from(ipStr, 'ascii');

  const fixedLen = 1 + 1 + ipBuf.length + 2+2+2+2 + 4 + 16+26+9 + 4 + 8;
  const buf = Buffer.alloc(fixedLen);
  let o = 0;

  buf[o++] = OP.GAME_LIST_RESPONSE; // 22
  buf[o++] = 0; // ipv6_flag
  ipBuf.copy(buf, o); o += ipBuf.length;
  buf.writeUInt16LE(g.port, o); o += 2;
  buf.writeUInt16LE(g.releaseMajor, o); o += 2;
  buf.writeUInt16LE(g.releaseMinor, o); o += 2;
  buf.writeUInt16LE(g.releaseMicro, o); o += 2;
  buf.writeUInt32LE(g.gameId, o); o += 4;
  writePaddedStr(buf, o, g.gameName, 16); o += 16;
  writePaddedStr(buf, o, g.mission, 26); o += 26;
  writePaddedStr(buf, o, g.missionName || '', 9); o += 9;
  buf.writeUInt32LE(g.level || 0, o); o += 4;
  buf[o++] = g.modeNum || 0;
  buf[o++] = g.refusePlayers || 0;
  buf[o++] = g.difficulty || 0;
  buf[o++] = g.statusNum || 0;
  buf[o++] = g.playerCount || 0;
  buf[o++] = g.maxPlayers || 0;
  buf[o++] = g.flags || 0;
  buf[o++] = 0; // padding

  server.send(buf, rinfo.port, rinfo.address);
  console.log(`    Sent game "${g.gameName}" to ${rinfo.address}:${rinfo.port}`);
}

// ── Opcode 99: Web UI Ping ──────────────────────────────────────
function handleWebUIPing(packet, rinfo) {
  if (packet.length < 5) return;
  const msg = packet.toString('ascii', 1, 5);
  if (msg === 'ping') {
    console.log('   🏓 Ping → Pong');
    const resp = Buffer.alloc(8);
    resp.write('pong', 0, 4, 'ascii');
    resp.writeUInt32LE(Math.floor(Date.now() / 1000), 4);
    server.send(resp, rinfo.port, rinfo.address);
  }
}

// ── Helpers ─────────────────────────────────────────────────────
function readCString(buf, offset, maxLen) {
  const end = Math.min(offset + maxLen, buf.length);
  let nul = buf.indexOf(0, offset);
  if (nul < offset || nul >= end) nul = end;
  return buf.toString('utf8', offset, nul).replace(/[^\x20-\x7E]/g, '');
}

function writePaddedStr(buf, offset, str, len) {
  buf.fill(0, offset, offset + len);
  buf.write((str || '').substring(0, len - 1), offset, 'utf8');
}

function statusName(s) {
  switch (s) {
    case 0: return 'Menu';
    case 1: return 'Playing';
    case 2: return 'Between';
    case 3: return 'EndLevel';
    case 4: return 'Forming';
    default: return 'Unknown';
  }
}

// ── Poll active games for stats ─────────────────────────────────
// PyTracker logic: send lite request to unconfirmed games,
// full request to confirmed games (even with proto=0 — this triggers
// a version_deny response which teaches us the real netgame_proto).
function pollActiveGames() {
  if (activeGames.size === 0) {
    writeGamelistFile(); // Write empty list so the web UI clears
    return;
  }
  for (const [, g] of activeGames) {
    if (!g.confirmed) {
      sendGameInfoLiteReq(g);
    } else {
      sendGameInfoFullReq(g);
    }
  }
  writeGamelistFile();
}

// ── Write gamelist JSON (like PyTracker's gamelist.txt) ──────────
function writeGamelistFile() {
  const games = [];
  for (const [, g] of activeGames) {
    if (!g.confirmed) continue;
    games.push({
      id: g.id,
      gameName: g.gameName || '',
      mission: g.mission || '',
      level: g.level || 0,
      gameMode: g.gameMode || 'Anarchy',
      playerCount: g.playerCount || 0,
      maxPlayers: g.maxPlayers || 8,
      version: g.version || '',
      detailed: g.detailed || false,
      status: g.status || 0,
      timestamp: g.timestamp || new Date().toISOString(),
      lastSeen: g.lastSeen || Date.now(),
      players: (g.players || []).map(p => ({
        name: p.name || '',
        connected: p.connected || false,
        kills: p.kills || 0,
        deaths: p.deaths || 0,
        suicides: p.suicides || 0,
      })),
    });
  }

  const payload = {
    updated: new Date().toISOString(),
    gameCount: games.length,
    games,
    // Include full gamelog summary for the game detail page
    gamelog: gamelogSummary ? {
      totalKills: gamelogSummary.totalKills || 0,
      totalDeaths: gamelogSummary.totalDeaths || 0,
      totalEvents: gamelogSummary.totalEvents || 0,
      players: gamelogSummary.players || [],
      killFeed: (gamelogSummary.killFeed || []).slice(-50),
      killMatrix: gamelogSummary.killMatrix || {},
      timeline: (gamelogSummary.timeline || []).slice(-100),
      chatLog: (gamelogSummary.chatLog || []).slice(-50),
      damageBreakdown: (gamelogSummary.damageBreakdown || []).slice(0, 30),
      clientCount: 1 + clientGamelogs.size, // how many perspectives merged
    } : null,
  };

  try {
    fs.writeFileSync(CONFIG.liveGamesFile, JSON.stringify(payload));
  } catch (err) {
    // Silently ignore — non-critical
  }
}

// ── Game Management ─────────────────────────────────────────────
function saveGameData(g) {
  const filename = `${g.id.replace(/[^a-z0-9]/gi, '_')}.json`;
  const filePath = path.join(CONFIG.eventsDir, filename);
  const { _broadcasted, pendingInfoReqs, ip, registerIp, ...data } = g;
  data.savedAt = new Date().toISOString();
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`❌ Save error:`, err.message);
  }
}

function cleanupDeadGames() {
  const now = Date.now();
  const dead = [];
  for (const [id, g] of activeGames) {
    if (now - g.lastSeen > CONFIG.gameTimeout) dead.push(id);
  }
  if (dead.length) {
    console.log(`\n🧹 Cleaning up ${dead.length} inactive game(s)`);
    dead.forEach(id => {
      const g = activeGames.get(id);
      console.log(`   Removed: ${g.gameName}`);
      activeGames.delete(id);
      broadcastGameRemoval(id);
    });
  }
}

// ── WebSocket Server ────────────────────────────────────────────
function startWebSocketServer() {
  if (!CONFIG.wsPort) return;
  try {
    const WebSocket = require('ws');
    wss = new WebSocket.Server({ port: CONFIG.wsPort });

    wss.on('connection', (ws) => {
      console.log('🔌 WebSocket client connected');
      wsClients.push(ws);

      ws.send(JSON.stringify({
        type: 'init',
        data: {
          totalGames: activeGames.size,
          games: Array.from(activeGames.values())
            .filter(g => g.confirmed)
            .map(g => ({
              id: g.id, gameName: g.gameName, mission: g.mission,
              level: g.level, playerCount: g.playerCount,
              maxPlayers: g.maxPlayers,
              timestamp: g.timestamp,
            })),
        },
      }));

      ws.on('close', () => {
        const i = wsClients.indexOf(ws);
        if (i > -1) wsClients.splice(i, 1);
      });
      ws.on('error', (e) => console.error('WS error:', e.message));
    });

    console.log(`🔌 WebSocket server on port ${CONFIG.wsPort}`);
  } catch (e) {
    console.log('  WebSocket disabled (npm i ws)');
  }
}

function broadcastGameUpdate(g, isNew) {
  if (!wsClients.length) return;
  const msg = JSON.stringify({
    type: isNew ? 'game_new' : 'game_update',
    data: {
      id: g.id, gameName: g.gameName, mission: g.mission,
      level: g.level, players: g.players,
      playerCount: g.playerCount, maxPlayers: g.maxPlayers,
      gameMode: g.gameMode,
      timestamp: g.timestamp, detailed: g.detailed || false,
      totalKills: gamelogSummary ? gamelogSummary.totalKills : 0,
      killFeed: gamelogSummary ? gamelogSummary.killFeed.slice(-10) : [],
    },
  });
  wsClients.forEach(ws => {
    try { if (ws.readyState === 1) ws.send(msg); } catch (e) {}
  });
}

function broadcastGameRemoval(id) {
  if (!wsClients.length) return;
  const msg = JSON.stringify({ type: 'game_removed', data: { id } });
  wsClients.forEach(ws => {
    try { if (ws.readyState === 1) ws.send(msg); } catch (e) {}
  });
}

// ═══════════════════════════════════════════════════════════════
// Gamelog Watcher — tails the master's gamelog.txt in real time
// ═══════════════════════════════════════════════════════════════
function startGamelogWatcher() {
  if (CONFIG.gamelogDirs.length === 0) {
    console.log('  No gamelog directories found (set GAMELOG_DIR or create ~/.d1x-redux/)');
    return;
  }

  for (const dir of CONFIG.gamelogDirs) {
    const gamelogFile = path.join(dir, 'gamelog.txt');
    console.log(`📝 Watching gamelog: ${gamelogFile}`);

    // Start from end of existing file (don't replay old content)
    if (fs.existsSync(gamelogFile)) {
      const stat = fs.statSync(gamelogFile);
      gamelogPos[gamelogFile] = stat.size;
    } else {
      gamelogPos[gamelogFile] = 0;
    }

    // Watch the directory for changes to gamelog.txt
    try {
      fs.watch(dir, (eventType, filename) => {
        if (filename && filename.toLowerCase() === 'gamelog.txt') {
          processGamelogUpdate(gamelogFile);
        }
      });
    } catch (err) {
      console.log(`     fs.watch failed for ${dir}: ${err.message}`);
    }
  }

  // Also poll periodically (fs.watch can be unreliable on some systems)
  setInterval(() => {
    for (const dir of CONFIG.gamelogDirs) {
      processGamelogUpdate(path.join(dir, 'gamelog.txt'));
    }
  }, CONFIG.gamelogPollInterval);
}

/**
 * Detect the local player name.
 * Priority:
 *   1. LOCAL_PLAYER env variable
 *   2. First player in the active game's player list (host is usually first)
 *   3. null (will use _local_ placeholder)
 */
function detectLocalPlayer() {
  if (process.env.LOCAL_PLAYER) {
    console.log(`   👤 Local player (from env): ${process.env.LOCAL_PLAYER}`);
    return process.env.LOCAL_PLAYER;
  }

  // Try to find from active games — the first player is typically the host
  for (const [, g] of activeGames) {
    if (g.confirmed && g.players && g.players.length > 0) {
      const name = g.players[0].name;
      if (name) {
        console.log(`   👤 Local player (detected from game): ${name}`);
        return name;
      }
    }
  }

  return null;
}

/**
 * Merge events from all client gamelogs into a unified timeline.
 * Each client's "You"/"Yourself" gets replaced with their actual name.
 * Duplicate events (same timestamp + same raw message) are deduplicated.
 */
function getMergedGamelogSummary() {
  // Start with local gamelog events
  let allEvents = [...gamelogEvents];

  // Add events from remote clients
  for (const [playerName, data] of clientGamelogs) {
    // These events already have _local_ replaced with playerName
    allEvents.push(...data.events);
  }

  if (allEvents.length === 0) return null;

  // Deduplicate: events with same timestamp + type + involved players
  const seen = new Set();
  const deduped = [];
  for (const ev of allEvents) {
    // Create a dedup key from the normalized event
    const ts = ev.timestamp ? ev.timestamp.getTime() : 0;
    const key = `${ts}|${ev.type}|${ev.killer || ''}|${ev.victim || ''}|${ev.player || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ev);
    }
  }

  // Sort by timestamp
  deduped.sort((a, b) => {
    const ta = a.timestamp ? a.timestamp.getTime() : 0;
    const tb = b.timestamp ? b.timestamp.getTime() : 0;
    return ta - tb;
  });

  return summarize(deduped);
}

function processGamelogUpdate(gamelogFile) {
  if (!fs.existsSync(gamelogFile)) return;

  const stat = fs.statSync(gamelogFile);
  const lastPos = gamelogPos[gamelogFile] || 0;

  // File was truncated or replaced → new game started
  if (stat.size < lastPos) {
    console.log(`\n🔄 Gamelog reset detected (new game?) — ${gamelogFile}`);
    gamelogPos[gamelogFile] = 0;
    gamelogEvents = [];
    gamelogSummary = null;
    localPlayerName = null; // reset — new game, may be different player

    // Broadcast reset to clients
    broadcastWS({ type: 'gamelog_reset', data: { file: gamelogFile } });
  }

  const currentPos = gamelogPos[gamelogFile] || 0;
  if (stat.size <= currentPos) return; // No new content

  // Read only the new bytes
  try {
    const fd = fs.openSync(gamelogFile, 'r');
    const newBytes = stat.size - currentPos;
    const buf = Buffer.alloc(newBytes);
    fs.readSync(fd, buf, 0, newBytes, currentPos);
    fs.closeSync(fd);

    const newContent = buf.toString('utf8');
    gamelogPos[gamelogFile] = stat.size;

    // Detect local player name if we don't have one yet
    if (!localPlayerName) {
      localPlayerName = detectLocalPlayer();
    }

    // Parse new content into events, replacing _local_ with actual name
    const newEvents = parseGamelogContent(newContent, { localPlayer: localPlayerName });
    if (newEvents.length === 0) return;

    // Filter out UNKNOWN type events for cleaner output
    const meaningfulEvents = newEvents.filter(e => e.type !== EVENT.UNKNOWN);
    if (meaningfulEvents.length === 0) return;

    gamelogEvents.push(...newEvents);
    gamelogSummary = summarize(gamelogEvents);

    // Log new events
    for (const event of meaningfulEvents) {
      const typeIcon = {
        [EVENT.KILL]: '💀', [EVENT.DEATH]: '☠️',
        [EVENT.SUICIDE]: '💥', [EVENT.JOIN]: '📥',
        [EVENT.REJOIN]: '📥', [EVENT.DISCONNECT]: '',
        [EVENT.REACTOR_DESTROYED]: '🔥', [EVENT.ESCAPE]: '🚀',
        [EVENT.CHAT]: '💬', [EVENT.KILL_GOAL]: '🏆',
        [EVENT.FLAG_CAPTURED]: '🚩',
      }[event.type] || '';
      console.log(`   ${typeIcon} [${event.type}] ${event.rawMessage}`);
    }

    // Broadcast each meaningful event to WebSocket clients
    for (const event of meaningfulEvents) {
      broadcastWS({
        type: 'game_event',
        data: {
          eventType: event.type,
          timestamp: event.timestamp,
          rawMessage: event.rawMessage,
          killer: event.killer,
          victim: event.victim,
          player: event.player,
          method: event.method,
          cause: event.cause,
          message: event.message, // for chat events
        },
      });
    }

    // Broadcast updated summary
    broadcastWS({
      type: 'game_summary',
      data: {
        players: gamelogSummary.players,
        killFeed: gamelogSummary.killFeed.slice(-20),
        timeline: gamelogSummary.timeline.slice(-50),
        chatLog: gamelogSummary.chatLog.slice(-20),
        totalKills: gamelogSummary.totalKills,
        totalDeaths: gamelogSummary.totalDeaths,
        totalEvents: gamelogSummary.totalEvents,
      },
    });

    // Merge gamelog stats into active game players
    mergeGamelogStatsIntoActiveGames();

  } catch (err) {
    console.error(`   ❌ Gamelog read error: ${err.message}`);
  }
}

function mergeGamelogStatsIntoActiveGames() {
  // Use merged summary if we have remote client data, otherwise local only
  const summary = clientGamelogs.size > 0 ? getMergedGamelogSummary() : gamelogSummary;
  if (!summary || summary.players.length === 0) return;

  // Update the working summary so writeGamelistFile uses merged data
  if (clientGamelogs.size > 0) {
    gamelogSummary = summary;
  }

  for (const [, g] of activeGames) {
    if (!g.confirmed) continue;

    for (const p of g.players) {
      const logPlayer = summary.players.find(
        lp => lp.name.toLowerCase() === p.name.toLowerCase()
      );
      if (logPlayer) {
        p.kills = logPlayer.kills;
        p.deaths = logPlayer.deaths;
        p.suicides = logPlayer.suicides;
      }
    }
  }

  // Update the JSON file immediately after merging stats
  writeGamelistFile();
}

// ── Generic WebSocket broadcast helper ──────────────────────────
function broadcastWS(obj) {
  if (!wsClients.length) return;
  const msg = JSON.stringify(obj);
  wsClients.forEach(ws => {
    try { if (ws.readyState === 1) ws.send(msg); } catch (e) {}
  });
}

// ═══════════════════════════════════════════════════════════════
// HTTP API Server — Gamelog Upload Endpoint
// POST /api/gamelog { playerName: "...", content: "..." }
// Allows remote clients to upload their gamelog perspective.
// ═══════════════════════════════════════════════════════════════
function startHTTPServer() {
  const httpPort = parseInt(process.env.HTTP_PORT || '9998', 10);
  const http = require('http');

  const httpServer = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /api/status — basic status
    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        activeGames: activeGames.size,
        gamelogClients: clientGamelogs.size,
        localPlayer: localPlayerName,
        uptime: process.uptime(),
      }));
      return;
    }

    // POST /api/gamelog — upload gamelog from a remote client
    if (req.method === 'POST' && req.url === '/api/gamelog') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const playerName = data.playerName;
          const content = data.content;

          if (!playerName || !content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing playerName or content' }));
            return;
          }

          console.log(`\n Gamelog upload from "${playerName}" (${content.length} bytes)`);

          // Parse the content, replacing "You"/"Yourself" with this player's name
          const events = parseGamelogContent(content, { localPlayer: playerName });
          const meaningful = events.filter(e => e.type !== EVENT.UNKNOWN);

          // Store/update this client's events
          clientGamelogs.set(playerName, {
            events: meaningful,
            raw: content,
            uploadedAt: new Date().toISOString(),
          });

          console.log(`    ${meaningful.length} events parsed from ${playerName}`);
          console.log(`    Total clients: ${clientGamelogs.size}`);

          // Re-merge all gamelogs and update
          mergeGamelogStatsIntoActiveGames();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            eventsReceived: meaningful.length,
            totalClients: clientGamelogs.size + 1, // +1 for local
          }));

        } catch (err) {
          console.error(`   ❌ Gamelog upload error: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /api/gamelog/append — append new lines (incremental upload)
    if (req.method === 'POST' && req.url === '/api/gamelog/append') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const playerName = data.playerName;
          const newLines = data.content;

          if (!playerName || !newLines) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing playerName or content' }));
            return;
          }

          // Parse only the new lines
          const newEvents = parseGamelogContent(newLines, { localPlayer: playerName });
          const meaningful = newEvents.filter(e => e.type !== EVENT.UNKNOWN);

          // Append to existing client data
          const existing = clientGamelogs.get(playerName);
          if (existing) {
            existing.events.push(...meaningful);
            existing.raw += '\n' + newLines;
            existing.uploadedAt = new Date().toISOString();
          } else {
            clientGamelogs.set(playerName, {
              events: meaningful,
              raw: newLines,
              uploadedAt: new Date().toISOString(),
            });
          }

          mergeGamelogStatsIntoActiveGames();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            newEvents: meaningful.length,
            totalEvents: (existing ? existing.events.length : meaningful.length),
          }));

        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  httpServer.listen(httpPort, () => {
    console.log(`🌐 HTTP API server on port ${httpPort}`);
    console.log(`   POST /api/gamelog — Upload full gamelog`);
    console.log(`   POST /api/gamelog/append — Append new lines`);
    console.log(`   GET  /api/status — Tracker status`);
  });
}

// ── Main ────────────────────────────────────────────────────────
function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   DXX-Redux/Rebirth Game Tracker v3.1                     ║');
  console.log('║   PyTracker-compatible + Gamelog Events                    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  ensureEventsDir();
  startUDPServer();
  startWebSocketServer();
  startHTTPServer();
  startGamelogWatcher();
  setInterval(cleanupDeadGames, CONFIG.cleanupInterval);
  setInterval(pollActiveGames, CONFIG.pollInterval);
  writeGamelistFile(); // Write initial (empty) file immediately

  if (CONFIG.gamelogDirs.length) {
    console.log(`\n📝 Gamelog directories:`);
    CONFIG.gamelogDirs.forEach(d => console.log(`   ${d}/gamelog.txt`));
  }
  console.log(`\n Steam launch options for DXX-Redux:`);
  console.log(`   -tracker_hostaddr <YOUR_IP> -tracker_hostport ${CONFIG.udpPort}`);
  console.log(`\n Active games: ${activeGames.size}`);  
  console.log(`⏳ Waiting for game announcements… (Ctrl+C to stop)\n`);
}

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down…');
  if (server) server.close();
  if (wss) wss.close();
  console.log(` ${activeGames.size} game(s) were active`);
  console.log('👋 Goodbye!\n');
  process.exit(0);
});

main();
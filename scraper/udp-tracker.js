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
 *   17  MDATA_PNORM       (Game → Tracker, variable, header=6 bytes)
 *   18  MDATA_PNEEDACK    (Game → Tracker, variable, header=10 bytes)
 *   21  Register ACK      (Tracker → Game, 1 byte)
 *   22  Game list response(Tracker → Client, variable)
 *   99  Web UI ping       (IPC)
 *
 * MDATA payload message types (walked byte-by-byte):
 *   48  MULTI_DAMAGE     14 bytes  [type][victim][damage int32LE][new_shields int32LE][killer_type][killer_id][damage_type][source_id]
 *                                   killer_type: 0=OBJ_WALL, 2=OBJ_ROBOT, 4=OBJ_PLAYER, 5=OBJ_WEAPON
 *                                   damage_type: 0=WEAPON, 1=BLAST, 2=COLLISION, 3=WALL, 4=LAVA, 5=OVERCHARGE
 *                                   source_id:   weapon ID (254=ship_collision, 255=ship_explosion)
 *   43  MULTI_KILL_HOST   7 bytes  [type][killed_pnum][killer_objnum int16LE][killer_net][team_vector][bounty_target]
 *                                   killer_net=0xFF → environment/no-player kill
 *   44  MULTI_KILL_CLIENT 5 bytes  [type][killed_pnum][killer_objnum int16LE][killer_net]
 *    5  MULTI_MESSAGE    37 bytes  [type][player_num][text 35 bytes, null-terminated]
 *    6  MULTI_OBS_MESSAGE 47 bytes [type][observer_id][text 45 bytes, null-terminated]
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
const firebase = require('./firebase-service');

// ── Configuration ───────────────────────────────────────────────
const CONFIG = {
  udpPort: parseInt(process.env.UDP_PORT) || 9999,
  wsPort: parseInt(process.env.WS_PORT) || 8081,
  eventsDir: path.resolve(__dirname, '../public/data/events'),
  liveGamesFile: path.resolve(__dirname, '../public/data/live-games.json'),
  gamesJsonFile: path.resolve(__dirname, '../public/data/games.json'),
  gameTimeout: 300000,      // 5 min — consider game dead
  cleanupInterval: 60000,   // Check for dead games every minute
  pollInterval: 5000,       // Poll games for stats every 5 seconds
};

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
  PDATA: 13,                // Player position data
  MDATA_PNORM: 17,          // Multiplayer data (normal)
  MDATA_PNEEDACK: 18,       // Multiplayer data (needs ACK)
  OBSDATA: 25,              // Observer data
  WEBUI_IPC: 99,
};
const TRACKER_PROTOCOL_VERSION = 0;

// ── Weapon Names (for kill feed display) ────
// Weapon ID → Name mapping (from DXX-Redux weapon.h)
// weapon_type: 0=Weapon kill, 1=Robot kill, 2=unused, 3=Environment
const WEAPON_NAMES = {
  // source_id values confirmed from DXX-Redux multi.c
  // IDs 0-3 are all Laser (L1-L4) — game sends whichever level is equipped
  0:   'Laser',
  1:   'Laser',
  2:   'Laser',
  3:   'Laser',
  8:   'Concussion Missile',
  9:   'Flare',
  11:  'Vulcan Cannon',
  12:  'Spreadfire (X)',
  13:  'Plasma Cannon',
  14:  'Fusion Cannon',
  15:  'Homing Missile',
  16:  'Proximity Bomb',
  17:  'Smart Missile',
  18:  'Mega Missile',
  19:  'Smart Blob',
  20:  'Spreadfire',
  254: 'Ship Collision',
  255: 'Ship Explosion',
};

// ── Damage Type Names ────
const DAMAGE_TYPE_NAMES = {
  0: 'Weapon',
  1: 'Blast',
  2: 'Collision',
  3: 'Wall',
  4: 'Lava',
  5: 'Overcharge',
  6: 'Shield',
  255: 'Unknown',
};

// Translate a MULTI_DAMAGE log entry or last-hit context into a human-readable weapon / cause-of-death.
// Accepts either a single hit object {killerType, damageType, sourceId} or null.
function describeDamage(ctx) {
  if (!ctx) return null;
  const { killerType, damageType, sourceId } = ctx;

  // Injected pseudo-weapon IDs (not real weapon indices)
  if (sourceId === 254) return 'Ship Collision';
  if (sourceId === 255) return 'Ship Explosion';

  switch (killerType) {
    case 0: // OBJ_WALL — wall impact or environmental hazard
      return damageType === 4 ? 'Lava' : 'Wall Impact';
    case 2: // OBJ_ROBOT
      return 'Robot';
    case 4: // OBJ_PLAYER — weapon or collision
    case 5: // OBJ_WEAPON — direct weapon object
      if (damageType === 2) return 'Collision';
      return WEAPON_NAMES[sourceId] || `Weapon #${sourceId}`;
    default:
      return WEAPON_NAMES[sourceId] || null;
  }
}

// ── Initialize a fresh per-player damage log for 8 slots ────
function initDamageLog() {
  const log = {};
  for (let i = 0; i < 8; i++) log[i] = [];
  return log;
}

// ── Build killerBreakdown from a damageLog snapshot ────
// Groups hits by killerId (null=env), sums damage, counts hits, tracks weapons.
function buildKillerBreakdown(log, getPlayerName) {
  const groups = {}; // key = killerId (number) or 'env'
  for (const hit of log) {
    if (hit.damageType === 6) continue; // shield restore — skip
    const key = (hit.killerType === 4 && hit.killerId !== null) ? hit.killerId : 'env';
    if (!groups[key]) {
      groups[key] = {
        killerSlot: key === 'env' ? null : key,
        killerName: key === 'env' ? 'Environment' : getPlayerName(key),
        totalDamage: 0,
        hits: 0,
        weapons: {},
      };
    }
    const g = groups[key];
    g.totalDamage += hit.damage;
    g.hits        += 1;
    const wKey = hit.sourceId;
    if (!g.weapons[wKey]) g.weapons[wKey] = { name: WEAPON_NAMES[wKey] || `Weapon #${wKey}`, damage: 0, hits: 0 };
    g.weapons[wKey].damage += hit.damage;
    g.weapons[wKey].hits   += 1;
  }
  return Object.values(groups)
    .map(g => ({ ...g, weapons: Object.values(g.weapons).sort((a, b) => b.damage - a.damage) }))
    .filter(g => g.totalDamage > 0)  // drop zero-damage env/lava entries
    .sort((a, b) => b.totalDamage - a.totalDamage);
}

// ── Game Engine Message Types (from multi.h, for_each_multiplayer_command macro) ────
// Values verified against DXX-Redux source — only the ones the tracker acts on are noted.
const MULTI = {
  POSITION:              0,
  REAPPEAR:              1,
  FIRE:                  2,
  KILL:                  3,
  REMOVE_OBJECT:         4,
  MESSAGE:               5,  // 37 bytes: [type][player_num][text×35]
  OBS_MESSAGE:           6,  // 47 bytes: [type][player_id=7][text×45] pre-formatted "callsign: msg"
  QUIT:                  7,
  PLAY_SOUND:            8,
  CONTROLCEN:            9,
  ROBOT_CLAIM:           10,
  END_SYNC:              11,
  CLOAK:                 12,
  INVULN:                13,
  ENDLEVEL_START:        14,
  CREATE_EXPLOSION:      15,
  CONTROLCEN_FIRE:       16,
  CREATE_POWERUP:        17,
  DECLOAK:               18,
  DEINVULN:              19,
  MENU_CHOICE:           20,
  ROBOT_POSITION:        21,
  PLAYER_EXPLODE:        22,
  BEGIN_SYNC:            23,
  DOOR_OPEN:             24,
  PLAYER_DROP:           25,
  ROBOT_EXPLODE:         26,
  ROBOT_RELEASE:         27,
  ROBOT_FIRE:            28,
  SCORE:                 29,
  CREATE_ROBOT:          30,
  TRIGGER:               31,
  BOSS_ACTIONS:          32,
  CREATE_ROBOT_POWERUPS: 33,
  HOSTAGE_DOOR:          34,
  SAVE_GAME:             35,
  RESTORE_GAME:          36,
  HEARTBEAT:             37,
  KILLGOALS:             38,
  POWCAP_UPDATE:         39,
  DO_BOUNTY:             40,
  TYPING_STATE:          41,
  GMODE_UPDATE:          42,
  KILL_HOST:             43, // 7 bytes: [type][killed_pnum][killer_objnum int16LE][killer_net][team_vector][bounty_target]
  KILL_CLIENT:           44,
  RANK:                  45,
  RESPAWN_ROBOT:         46,
  OBS_UPDATE:            47,
  DAMAGE:                48,
  REPAIR:                49,
  SHIP_STATUS:           50,
  CREATE_EXPLOSION2:     51,
};

// ── State ───────────────────────────────────────────────────────
const activeGames = new Map(); // "ip:gamePort" → game entry
const gameEvents = new Map();  // "ip:gamePort" → { killFeed: [], chat: [], timeline: [] }
const wsClients = [];
let server = null;
let wss = null;

// ── Player name utilities ──────────────────────────────────────
/**
 * Build a unique display name for a player, appending "(N)" if
 * multiple players share the same name (e.g. "code (1)", "code (2)").
 */
function getUniquePlayerName(players, pnum) {
  if (!players || !players[pnum]) return `Player ${pnum}`;
  const name = players[pnum].name;
  // Check for duplicate names
  const dupeIndices = [];
  players.forEach((p, i) => { if (p && p.name === name) dupeIndices.push(i); });
  if (dupeIndices.length <= 1) return name;
  // Append 1-based order among duplicates
  const order = dupeIndices.indexOf(pnum) + 1;
  return `${name} (${order})`;
}

// ── Ensure output directory ─────────────────────────────────────
function ensureEventsDir() {
  if (!fs.existsSync(CONFIG.eventsDir)) {
    fs.mkdirSync(CONFIG.eventsDir, { recursive: true });
    console.log(`📁 Created events directory: ${CONFIG.eventsDir}`);
  }
}

// ── Self-healing port release ─────────────────────────────────
// Kill any process holding our ports before we try to bind.
// This prevents the EADDRINUSE crash loop when pm2 restarts faster
// than the OS releases the port from the previous process.
function freePorts(callback) {
  const { execSync } = require('child_process');
  const ports = [CONFIG.udpPort, CONFIG.wsPort].filter(Boolean);
  let freed = 0;
  for (const port of ports) {
    try {
      // fuser -k sends SIGKILL to whatever holds the port
      execSync(`fuser -k ${port}/tcp 2>/dev/null; fuser -k ${port}/udp 2>/dev/null`, { stdio: 'ignore' });
      freed++;
    } catch (e) { /* port was free, ignore */ }
  }
  if (freed > 0) {
    console.log(`⚡ Released stale port holders, waiting 500ms…`);
    setTimeout(callback, 500);
  } else {
    callback();
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

    case OP.PDATA: // 13
      // Player position data - silently ignore (high frequency)
      break;

    case OP.MDATA_PNORM: // 17
    case OP.MDATA_PNEEDACK: // 18
      console.log(`   📨 MDATA (opcode ${opcode})`);
      handleMDATA(packet, rinfo, opcode);
      break;

    case 43: // MULTI_KILL_HOST — bare sub-packet (no UPID wrapper)
    case 48: // MULTI_DAMAGE    — bare sub-packet (no UPID wrapper)
      console.log(`   🎯 Bare sub-packet type ${opcode} (${packet.length} bytes)`);
      handleBareSubPacket(packet, rinfo);
      break;

    case OP.OBSDATA: // 25
      console.log(`   👁️  OBSDATA`);
      handleOBSDATA(packet, rinfo);
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
// MDATA Packet Handler - Multiplayer Data
// 17 (MDATA_PNORM):    [type(1)][token(4)][player_num(1)]            = 6 byte header
// 18 (MDATA_PNEEDACK): [type(1)][token(4)][player_num(1)][pkt_num(4)]= 10 byte header
// Remaining bytes are walked as a stream of fixed-size messages.
// ═══════════════════════════════════════════════════════════════
function handleMDATA(packet, rinfo, opcode) {
  try {
    const headerSize = (opcode === OP.MDATA_PNEEDACK) ? 10 : 6;
    if (packet.length < headerSize + 1) return;

    let offset = 1; // Skip opcode
    const token = packet.readUInt32LE(offset); offset += 4;
    const playerNum = packet[offset]; offset += 1;
    if (opcode === OP.MDATA_PNEEDACK) offset += 4; // Skip pkt_num

    if (offset >= packet.length) return;

    // Find which game this belongs to (token match first, IP fallback)
    let game = null;
    for (const [, g] of activeGames.entries()) {
      if (g.ip === rinfo.address && g.gameId === token) { game = g; break; }
    }
    if (!game) {
      for (const [, g] of activeGames.entries()) {
        if (g.ip === rinfo.address) { game = g; break; }
      }
    }
    if (!game) return;

    // Stamp live activity — any MDATA means the game is actively running
    game.lastActivity = Date.now();
    game.lastSeen = Date.now();

    // Get or create event storage for this game
    if (!gameEvents.has(game.id)) {
      gameEvents.set(game.id, {
        killFeed: [],
        chat: [],
        timeline: [],
        startTime: Date.now(),
      });
    }

    const events = gameEvents.get(game.id);
    const gameTime = ((Date.now() - events.startTime) / 1000).toFixed(1);

    // Walk the payload byte-by-byte, parsing fixed-size messages
    walkMDATAPayload(packet.slice(offset), playerNum, game, events, gameTime);

    // Push updated events to the live-games file and any WS clients
    writeGamelistFile();
    broadcastGameUpdate(game, false);

  } catch (err) {
    console.error(`   MDATA parse error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// OBSDATA Packet Handler - Observer Data
// Similar to MDATA but from observer perspective
// ═══════════════════════════════════════════════════════════════
function handleOBSDATA(packet, rinfo) {
  // Observer data uses similar format to MDATA
  handleMDATA(packet, rinfo, OP.OBSDATA);
}

// ═══════════════════════════════════════════════════════════════
// Bare Sub-Packet Handler
// multi_send_kill and multi_send_damage now call net_udp_send_to_all_trackers
// directly, sending the raw sub-packet buffer with NO UPID/MDATA wrapper.
// byte[0] is the sub-packet type (43=MULTI_KILL_HOST, 48=MULTI_DAMAGE).
// The host machine is always the sender (slot 0) — only the host registers
// with the tracker and knows its address.
// ═══════════════════════════════════════════════════════════════
function handleBareSubPacket(packet, rinfo) {
  try {
    // Find game by source IP — no token in bare packets
    let game = null;
    for (const [, g] of activeGames.entries()) {
      if (g.ip === rinfo.address) { game = g; break; }
    }
    if (!game) return;

    game.lastActivity = Date.now();
    game.lastSeen     = Date.now();

    if (!gameEvents.has(game.id)) {
      gameEvents.set(game.id, {
        killFeed:  [],
        chat:      [],
        timeline:  [],
        startTime: Date.now(),
      });
    }

    const events   = gameEvents.get(game.id);
    const gameTime = ((Date.now() - events.startTime) / 1000).toFixed(1);

    // senderNum=0: bare packets always originate from the host (slot 0).
    // For client kills, killerNet inside MULTI_KILL_HOST carries the real slot.
    walkMDATAPayload(packet, 0, game, events, gameTime);

    writeGamelistFile();
    broadcastGameUpdate(game, false);
  } catch (err) {
    console.error(`   Bare sub-packet error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Walk the MDATA payload, parsing known fixed-size message types.
// Stops at the first unrecognised type byte.
//
//  48  MULTI_DAMAGE     14 bytes  [type][victim][damage int32LE][new_shields int32LE][killer_type][killer_id][damage_type][source_id]
//                                  killer_type: 0=OBJ_WALL, 2=OBJ_ROBOT, 4=OBJ_PLAYER, 5=OBJ_WEAPON
//                                  damage_type: 0=WEAPON, 1=BLAST, 2=COLLISION, 3=WALL, 4=LAVA, 5=OVERCHARGE
//                                  source_id:   weapon ID (254=ship_collision, 255=ship_explosion)
//  43  MULTI_KILL_HOST   7 bytes  [type][killed_pnum][killer_objnum int16LE][killer_net][team_vector][bounty_target]
//  44  MULTI_KILL_CLIENT 5 bytes  [type][killed_pnum][killer_objnum int16LE][killer_net]
//   5  MULTI_MESSAGE    37 bytes  [type][player_num][text 35 bytes, null-terminated]
//   6  MULTI_OBS_MESSAGE 47 bytes [type][observer_id][text 45 bytes, null-terminated]
// ═══════════════════════════════════════════════════════════════
function walkMDATAPayload(payload, senderNum, game, events, gameTime) {
  try {
    const players = game.players || [];
    const getPlayerName = (pnum) => getUniquePlayerName(players, pnum);
    const timestamp = new Date().toISOString();

    let i = 0;
    while (i < payload.length) {
      const type = payload[i];

      if (type === 48) {
        // MULTI_DAMAGE — 14 bytes
        // [0]=type [1]=victim [2-5]=damage int32LE (÷65536 = shield pts)
        // [6-9]=shields_after int32LE (÷65536) [10]=killer_type [11]=killer_id
        // [12]=damage_type [13]=source_id (weapon)
        // killer_type: 0=OBJ_WALL, 2=OBJ_ROBOT, 4=OBJ_PLAYER, 5=OBJ_WEAPON
        // damage_type: 0=WEAPON,1=BLAST,2=COLLISION,3=WALL,4=LAVA,5=OVERCHARGE,6=SHIELD,255=UNKNOWN
        if (payload.length - i < 14) { i += 14; continue; }
        const dmgVictim  = payload[i + 1];
        const dmgAmount  = Math.round(payload.readInt32LE(i + 2) / 65536);
        const shieldsAfter = Math.round(payload.readInt32LE(i + 6) / 65536);
        const killerType = payload[i + 10];
        const killerId   = payload[i + 11]; // player slot (OBJ_PLAYER=4) or robot/weapon id
        const damageType = payload[i + 12];
        const sourceId   = payload[i + 13]; // actual weapon ID
        i += 14;

        // Accumulate hit into per-victim damage log — snapshot taken on KILL_HOST
        if (!game._damageLog) game._damageLog = initDamageLog();
        if (!game._damageLog[dmgVictim]) game._damageLog[dmgVictim] = [];
        game._damageLog[dmgVictim].push({
          killerId:    killerType === 4 ? killerId : null,
          killerType,
          sourceId,
          damageType,
          damage:      dmgAmount,
          shieldsAfter,
          ts:          Date.now(),
        });

      } else if (type === 43) {
        // MULTI_KILL_HOST — 7 bytes
        // [43][killed_pnum][killer_objnum int16LE][killer_net][team_vector][bounty_target]
        // killer_net (byte[4]) is unreliable for weapon kills — the weapon object that
        // stored the owner mapping may already be freed by the time multi_send_kill runs.
        // Primary attribution source is MULTI_DAMAGE (damage_context), which arrives
        // just before the kill and carries killer_type + killer_id directly.
        if (payload.length - i < 7) break;
        const killedPnum   = payload[i + 1];
        const killerObjnum = payload.readInt16LE(i + 2);
        const killerNet    = payload[i + 4]; // fallback only
        console.log(`   🔬 KILL_HOST raw: killed=${killedPnum} objnum=${killerObjnum} killerNet=${killerNet}(0x${killerNet.toString(16)}) sender=${senderNum} bytes=[${Array.from(payload.slice(i,i+7)).join(',')}]`);
        i += 7;

        // ── Snapshot damage log for this victim ─────────────────────────
        if (!game._damageLog) game._damageLog = initDamageLog();
        const damageLog = (game._damageLog[killedPnum] || []).slice();
        game._damageLog[killedPnum] = []; // clear for next life

        // ── Killer attribution (damage log is primary) ────────────────────
        // Walk backwards through damage log for last OBJ_PLAYER=4 hit — this
        // is reliable even when killerNet=0xFF (weapon object already freed).
        const OBJ_PLAYER = 4;
        let effectiveKiller, isEnvKill, isSuicide, lastPlayerHit;

        for (let k = damageLog.length - 1; k >= 0; k--) {
          if (damageLog[k].killerType === OBJ_PLAYER) { lastPlayerHit = damageLog[k]; break; }
        }

        if (lastPlayerHit) {
          effectiveKiller = lastPlayerHit.killerId;
          isEnvKill       = false;
          isSuicide       = effectiveKiller === killedPnum;
        } else if (killerNet !== 0xFF) {
          // killerNet valid — collision/env with a named player
          effectiveKiller = killerNet;
          isEnvKill       = false;
          isSuicide       = effectiveKiller === killedPnum;
        } else {
          // No player in damage log and killerNet=0xFF → environment kill
          effectiveKiller = -1;
          isEnvKill       = true;
          isSuicide       = false;
        }

        // Killing weapon: last hit by a player or weapon object
        let lastWeaponHit = null;
        for (let k = damageLog.length - 1; k >= 0; k--) {
          if (damageLog[k].killerType === OBJ_PLAYER || damageLog[k].killerType === 5) {
            lastWeaponHit = damageLog[k]; break;
          }
        }

        const killedName = getPlayerName(killedPnum);
        const killerName = isEnvKill ? 'Environment' : getPlayerName(effectiveKiller);
        const weapon = lastWeaponHit ? describeDamage(lastWeaponHit) : describeDamage(damageLog[damageLog.length - 1] || null);

        // Build per-attacker breakdown from the full damage log
        const killerBreakdown = buildKillerBreakdown(damageLog, getPlayerName);
        const totalDamage = damageLog.reduce((s, h) => h.damageType !== 6 ? s + h.damage : s, 0);

        // ── Dedup: game sends KILL_HOST via two code paths for client kills ──
        // First packet often arrives before damage context (→ env kill).
        // Second packet arrives with context (→ attributed kill).
        // Strategy: if a kill for this victim was recorded within 1 s:
        //   • previous was env + this is attributed → upgrade event in-place
        //   • otherwise → discard duplicate
        if (!game._recentKills) game._recentKills = {};
        const KILL_DEDUP_MS = 300; // MDATA + bare duplicate typically arrives within ~100ms
        const nowMs = Date.now();
        const prevKill = game._recentKills[killedPnum];

        if (prevKill && (nowMs - prevKill.time) < KILL_DEDUP_MS) {
          if (!isEnvKill && prevKill.isEnvKill) {
            // Upgrade the existing env kill event in-place (killFeed/timeline hold the same object)
            const ev = prevKill.event;
            ev.killer          = killerName;
            ev.killerNum       = effectiveKiller;
            ev.weapon          = weapon;
            ev.isEnvKill       = false;
            ev.isSuicide       = isSuicide;
            ev.damageLog       = damageLog;
            ev.killerBreakdown = killerBreakdown;
            ev.totalDamage     = totalDamage;
            prevKill.isEnvKill = false;
            // Repair stats: undo the env death counted on first packet, apply real kill
            const killed2 = players[killedPnum];
            if (killed2) killed2.deaths = Math.max(0, (killed2.deaths || 1) - 1); // will be re-added below
            const killer2 = players[effectiveKiller];
            if (!isSuicide && killer2 && killed2) {
              killer2.kills  = (killer2.kills  || 0) + 1;
              killed2.deaths = (killed2.deaths || 0) + 1;
            } else if (isSuicide && killer2 && killed2) {
              killer2.suicides = (killer2.suicides || 0) + 1;
              killer2.deaths   = (killer2.deaths   || 0) + 1;
            }
            const weaponLabel2 = weapon ?? '?';
            console.log(`   🔁 Upgraded env→attributed: ${killerName} → ${killedName} (${weaponLabel2}) @ ${gameTime}s  [${damageLog.length} hits, total=${totalDamage}]`);
          } else {
            console.log(`   🔁 Dup KILL_HOST for ${killedName} — discarded`);
          }
        } else {
          // Normal path — new kill event
          const killEvent = {
            type: 'kill',
            time: gameTime,
            timestamp,
            killer: killerName,
            killerNum: isEnvKill ? -1 : effectiveKiller,
            killed: killedName,
            killedNum: killedPnum,
            weapon,
            isEnvKill,
            isSuicide,
            damageLog,
            killerBreakdown,
            totalDamage,
          };

          game._recentKills[killedPnum] = { time: nowMs, event: killEvent, isEnvKill };

          events.killFeed.unshift(killEvent);
          events.timeline.push(killEvent);
          if (events.killFeed.length > 100) events.killFeed.pop();
          if (events.timeline.length > 500) events.timeline.shift();

          // Update player stats
          const killer = players[effectiveKiller];
          const killed = players[killedPnum];
          if (isEnvKill) {
            if (killed) killed.deaths = (killed.deaths || 0) + 1;
          } else if (killer && killed) {
            if (isSuicide) {
              killer.suicides = (killer.suicides || 0) + 1;
              killer.deaths   = (killer.deaths   || 0) + 1;
            } else {
              killer.kills  = (killer.kills  || 0) + 1;
              killed.deaths = (killed.deaths || 0) + 1;
            }
          }

          const weaponLabel = weapon ?? '?';
          const logLabel = isEnvKill ? `${killedName} died (${weaponLabel})` : isSuicide ? `${killedName} died (${weaponLabel})` : `${killerName} → ${killedName} (${weaponLabel})`;
          console.log(`   💀 Kill: ${logLabel} @ ${gameTime}s  [${damageLog.length} dmg hits, total=${totalDamage}]`);
        }

      } else if (type === 44) {
        // MULTI_KILL_CLIENT — 5 bytes: [44][killed][killer_objnum int16LE][killer_net]
        if (payload.length - i < 5) break;
        const kcKilled = payload[i + 1];
        const kcKillerNet = payload[i + 4];
        console.log(`   📨 KILL_CLIENT: killed=${kcKilled} killerNet=${kcKillerNet}(0x${kcKillerNet.toString(16)}) sender=${senderNum} bytes=[${Array.from(payload.slice(i,i+5)).join(',')}]`);
        i += 5;

      } else if (type === 5) {
        // MULTI_MESSAGE — 37 bytes
        // [5][player_num][text 35 bytes, null-terminated]
        if (payload.length - i < 37) break;
        const fromNum = payload[i + 1];
        const text = payload.slice(i + 2, i + 37).toString('ascii').replace(/\0/g, '').trim();
        i += 37;

        if (text.length > 0) {
          const chatEvent = {
            type: 'chat',
            time: gameTime,
            timestamp,
            from: getPlayerName(fromNum),
            fromNum,
            message: text,
          };
          events.chat.push(chatEvent);
          events.timeline.push(chatEvent);
          if (events.chat.length > 200) events.chat.shift();
          if (events.timeline.length > 500) events.timeline.shift();
          console.log(`   💬 Chat: ${getPlayerName(fromNum)}: ${text}`);
        }

      } else if (type === 6) {
        // MULTI_OBS_MESSAGE — 47 bytes
        // [6][player_id=7 (OBSERVER_PLAYER_ID)][text 45 bytes, null-terminated]
        // text is pre-formatted as "callsign: message" — no further parsing needed
        if (payload.length - i < 47) break;
        const rawText = payload.slice(i + 2, i + 47).toString('ascii').replace(/\0/g, '').trim();
        i += 47;

        if (rawText.length > 0) {
          // Split pre-formatted "callsign: message" for clean display
          const colonIdx = rawText.indexOf(': ');
          const from    = colonIdx > 0 ? rawText.slice(0, colonIdx) : 'Observer';
          const message = colonIdx > 0 ? rawText.slice(colonIdx + 2) : rawText;

          const chatEvent = {
            type: 'chat',
            time: gameTime,
            timestamp,
            from,
            message,
            isObserver: true,
          };
          events.chat.push(chatEvent);
          events.timeline.push(chatEvent);
          if (events.chat.length > 200) events.chat.shift();
          if (events.timeline.length > 500) events.timeline.shift();
          console.log(`   💬 Observer ${from}: ${message}`);
        }

      } else {
        // Unknown type — stop scanning
        console.log(`   🔍 MDATA: unknown type byte ${type} at offset ${i}, stopping scan`);
        break;
      }
    }
  } catch (err) {
    console.error(`   MDATA walk error: ${err.message}`);
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
    startTime: Date.now(),
    _damageLog: initDamageLog(),
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
  
  // Preserve startTime for existing games
  if (!isNew && !g.startTime) {
    g.startTime = Date.now();
  }

  activeGames.set(key, g);

  if (isNew) {
    console.log(`    Game registered: ${key}`);
  } else {
    console.log(`    Game re-registered: ${key}`);
  }

  // Send ACK first — DXX-Redux won't respond to LITE_REQ until it receives ACK.
  sendRegisterAck(g);

  // Then ask the game for details (opcode 4 → game responds with opcode 5)
  // Small delay so the ACK lands before the LITE_REQ
  setTimeout(() => sendGameInfoLiteReq(g), 100);
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

  // Send to registerPort (the NAT-observed source port from the REGISTER
  // packet), not g.port (the client's self-declared port). For any host
  // without a forwarded port, those differ - the router only opened a NAT
  // hole for the address it actually saw traffic go out to/from, so a probe
  // to the declared port vanishes and the game never gets confirmed.
  // Falls back to g.port for games restored from disk on startup, which
  // don't have a registerPort yet until they next re-register.
  const destPort = g.registerPort || g.port;
  server.send(buf, destPort, g.ip, (err) => {
    if (err) console.error(`   ❌ game_info_lite_req error: ${err.message}`);
    else {
      console.log(`    Sent game_info_lite_req to ${g.ip}:${destPort}`);
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

  // See comment in sendGameInfoLiteReq - must use the NAT-observed port.
  const destPort = g.registerPort || g.port;
  server.send(buf, destPort, g.ip, (err) => {
    if (err) console.error(`   ❌ game_info_full_req error: ${err.message}`);
    else {
      console.log(`    Sent game_info_full_req (proto=${proto}) to ${g.ip}:${destPort}`);
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

  // First confirmation?
  if (!g.confirmed) {
    g.confirmed = true;

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

    // ── Extract kill matrix & per-player stats from packet data ──
    // DXX-Redux packet layout (offsets relative to settingsStart):
    //   +62: game_flags(1), team_vector(1)
    //   +64: AllowedItems(4), Allow_marker_view(2), AlwaysLighting(2)
    //   +72: ShowEnemyNames(2), BrightPlayers(2), spawn_invul_pad(2)
    //   +78: team_name(2×9=18)
    //   +96: locations(8×4=32)
    //  +128: kills[8][8] (8×8 × INT16LE = 128 bytes)
    //  +256: segments_checksum(2), team_kills(2×2=4)
    //  +262: killed[8] (8 × INT16LE = 16 bytes)  — total deaths
    //  +278: player_kills[8] (8 × INT16LE = 16)   — total kills
    //  +294: KillGoal(4), PlayTimeAllowed(4), level_time(4),
    //         control_invul_time(4), monitor_vector(4)
    //  +314: player_score[8] (8 × INT32LE = 32 bytes)
    const killMatrixOff   = settingsStart + 128;
    const killedOff       = settingsStart + 262;
    const playerKillsOff  = settingsStart + 278;
    const playerScoreOff  = settingsStart + 314;

    if (packet.length >= playerScoreOff + MAX_PLAYERS * 4) {
      const killMatrix = [];
      for (let i = 0; i < MAX_PLAYERS; i++) {
        killMatrix[i] = [];
        for (let j = 0; j < MAX_PLAYERS; j++) {
          killMatrix[i][j] = packet.readInt16LE(killMatrixOff + (i * MAX_PLAYERS + j) * 2);
        }
      }

      const killed = [], playerKills = [], playerScores = [];
      for (let i = 0; i < MAX_PLAYERS; i++) {
        killed[i]       = packet.readInt16LE(killedOff + i * 2);
        playerKills[i]  = packet.readInt16LE(playerKillsOff + i * 2);
        playerScores[i] = packet.readInt32LE(playerScoreOff + i * 4);
      }

      g.killMatrix    = killMatrix;
      g.playerScores  = playerScores;

      // Packet data is the authoritative source for scores
      for (let i = 0; i < players.length; i++) {
        players[i].kills    = playerKills[i] || 0;
        players[i].deaths   = killed[i] || 0;
        players[i].suicides = killMatrix[i][i] || 0;
        players[i].score    = playerScores[i] || 0;
      }

      const hasKills = playerKills.some(k => k > 0);
      if (hasKills) {
        console.log(`   📊 Kill matrix: ${players.map((p, i) => `${p.name}:${playerKills[i]}k/${killed[i]}d`).join(', ')}`);
      }
    } else {
      // Kill matrix not available — leave player stats at zero;
      // MULTI_KILL_HOST events from MDATA will update them in real time.
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
      archiveGameToHistory(g);
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
      ip: g.ip || '',
      port: g.port || 0,
      registerPort: g.registerPort || g.port || 0,
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
      lastActivity: g.lastActivity || null,
      players: (g.players || []).map(p => ({
        name: p.name || '',
        connected: p.connected || false,
        kills: p.kills || 0,
        deaths: p.deaths || 0,
        suicides: p.suicides || 0,
        score: p.score || 0,
      })),
      killMatrix: g.killMatrix || null,
      killFeed: (() => { const ev = gameEvents.get(g.id); return ev ? ev.killFeed.slice(0, 50) : []; })(),
      chat: (() => { const ev = gameEvents.get(g.id); return ev ? ev.chat.slice(-50) : []; })(),
    });
  }

  const payload = {
    updated: new Date().toISOString(),
    gameCount: games.length,
    games,
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

// ── Archive concluded game to games.json history ────────────────
function archiveGameToHistory(g) {
  // Debug logging
  console.log(`\n📦 Attempting to archive game: ${g?.gameName || 'unknown'}`);
  console.log(`   Confirmed: ${!!g?.confirmed}, Players: ${g?.players?.length || 0}`);
  
  if (!g) {
    console.log(`   ⏭️  Skipping archive: Game object is null/undefined`);
    return;
  }
  
  if (!g.confirmed) {
    console.log(`   ⏭️  Skipping archive: Game was never confirmed (${g.gameName})`);
    return; // Only archive confirmed games
  }
  
  if (!g.players || g.players.length === 0) {
    console.log(`   ⏭️  Skipping archive: No players in game (${g.gameName})`);
    return; // Only archive games with players
  }

  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${pad(now.getMonth()+1)}-${pad(now.getDate())}-${now.getFullYear()}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

    // Find top player by kills for the ID
    const topPlayer = g.players.reduce((best, p) =>
      (p.kills || 0) > (best.kills || 0) ? p : best, g.players[0]);
    const sanitizedName = (topPlayer.name || 'unknown').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const sanitizedMap = (g.missionName || g.mission || 'unknown').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

    const gameId = `game-${dateStr}-${sanitizedName}-${sanitizedMap}`;

    // Build player data from UDP stats
    const enrichedPlayers = g.players.map(p => {
      const kills = p.kills || 0;
      const deaths = p.deaths || 0;
      return {
        name: p.name || 'Unknown',
        kills,
        deaths,
        suicides: p.suicides || 0,
        kdRatio: deaths > 0 ? +(kills / deaths).toFixed(2) : kills,
        timeInGame: '',
        color: p.color || 0,
        score: p.score || 0,
      };
    });

    // Calculate game duration
    const startTime = g.startTime || now.getTime();
    const durationMs = now.getTime() - startTime;
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    const timeElapsed = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    const gameEntry = {
      id: gameId,
      filename: `live-${g.id || 'unknown'}`,
      timestamp: g.timestamp || now.toISOString(),
      gameName: g.gameName || 'Unnamed Game',
      map: g.missionName || g.mission || 'Unknown',
      mission: g.mission || 'Unknown',
      levelNumber: g.level || 1,
      playersSlots: `${g.playerCount || g.players.length}/${g.maxPlayers || 8}`,
      mode: g.gameMode || 'Anarchy',
      version: g.version === 1 ? 'D1X' : g.version === 2 ? 'D2X' : `v${g.releaseMajor || 0}.${g.releaseMinor || 0}.${g.releaseMicro || 0}`,
      difficulty: ['Trainee', 'Rookie', 'Hotshot', 'Ace', 'Insane'][g.difficulty] || 'Unknown',
      timeElapsed: timeElapsed,
      killGoal: '',
      reactorLife: '',
      maxTime: '',
      players: enrichedPlayers,
      playerCount: g.playerCount || g.players.length,
      gameType: (g.playerCount || g.players.length) === 2 ? '1v1' :
                (g.playerCount || g.players.length) > 2 ? 'FFA' : 'Unknown',
      disallowedItems: [],
      killMatrix: g.killMatrix || null,
    };

    // ── Build event data for Firebase ──
    const events = gameEvents.get(g.id);
    let eventData = null;
    if (events && (events.killFeed.length > 0 || events.chat.length > 0 || events.timeline.length > 0)) {
      // Build named kill matrix from array format
      let namedKillMatrix = null;
      if (Array.isArray(g.killMatrix) && enrichedPlayers.length > 0) {
        namedKillMatrix = {};
        enrichedPlayers.forEach((p, i) => {
          const dn = getUniquePlayerName(g.players, i);
          namedKillMatrix[dn] = {};
          enrichedPlayers.forEach((p2, j) => {
            namedKillMatrix[dn][getUniquePlayerName(g.players, j)] =
              (g.killMatrix[i] && g.killMatrix[i][j]) || 0;
          });
        });
      }

      eventData = {
        id: gameId,
        timestamp: gameEntry.timestamp,
        gameName: gameEntry.gameName,
        mission: gameEntry.mission,
        map: gameEntry.map,
        mode: gameEntry.mode,
        level: gameEntry.levelNumber,
        players: enrichedPlayers,
        killFeed: events.killFeed || [],
        killMatrix: namedKillMatrix || g.killMatrix || null,
        timeline: events.timeline || [],
        chatLog: events.chat || [],
        damageBreakdown: [],
        totalKills: enrichedPlayers.reduce((sum, p) => sum + (p.kills || 0), 0),
        totalEvents: (events.killFeed.length || 0) + (events.chat.length || 0),
      };
    }

    // ── Save to Firebase Firestore ──
    if (firebase.isEnabled()) {
      firebase.saveGame(gameEntry, eventData).catch(err => {
        console.error(`   ⚠️ Firestore save failed: ${err.message}`);
      });
      console.log(`   🔥 Archived "${g.gameName}" to Firestore`);
    } else {
      console.warn(`   ⚠️ Firebase disabled, game not archived`);
    }

    // Clean up in-memory events for this game
    gameEvents.delete(g.id);

  } catch (err) {
    console.error(`   ❌ Archive error: ${err.message}`);
  }
}

// ── Update the events/index.json for the game detail page ───────
function updateEventsIndex(eventData) {
  const indexPath = path.join(CONFIG.eventsDir, 'index.json');
  let index = { lastUpdated: new Date().toISOString(), totalGames: 0, games: [] };

  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (e) { /* start fresh */ }
  }

  // Deduplicate
  index.games = index.games.filter(g => g.id !== eventData.id);

  index.games.unshift({
    id: eventData.id,
    timestamp: eventData.timestamp,
    gameName: eventData.gameName || '',
    mission: eventData.mission,
    map: eventData.map || '',
    mode: eventData.mode || '',
    level: eventData.level,
    playerCount: eventData.players.length,
    playerNames: eventData.players.map(p => p.name),
    totalKills: eventData.totalKills,
    totalEvents: eventData.totalEvents,
  });

  index.totalGames = index.games.length;
  index.lastUpdated = new Date().toISOString();

  try {
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  } catch (e) {
    console.error(`   ⚠️ Events index error: ${e.message}`);
  }
}

function cleanupDeadGames() {
  const now = Date.now();
  const dead = [];
  for (const [id, g] of activeGames) {
    // If the game sent an MDATA packet recently it is actively live — never clean it up
    if (g.lastActivity && now - g.lastActivity < CONFIG.gameTimeout) continue;
    if (now - g.lastSeen > CONFIG.gameTimeout) dead.push(id);
  }
  if (dead.length) {
    console.log(`\n🧹 Cleaning up ${dead.length} inactive game(s)`);
    dead.forEach(id => {
      const g = activeGames.get(id);
      archiveGameToHistory(g);
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
  const ev = gameEvents.get(g.id);
  const msg = JSON.stringify({
    type: isNew ? 'game_new' : 'game_update',
    data: {
      id: g.id, gameName: g.gameName, mission: g.mission,
      level: g.level, players: g.players,
      playerCount: g.playerCount, maxPlayers: g.maxPlayers,
      gameMode: g.gameMode,
      timestamp: g.timestamp, detailed: g.detailed || false,
      killFeed: ev ? ev.killFeed.slice(0, 10) : [],
      chat: ev ? ev.chat.slice(-10) : [],
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

// ── Generic WebSocket broadcast helper ──────────────────────────
function broadcastWS(obj) {
  if (!wsClients.length) return;
  const msg = JSON.stringify(obj);
  wsClients.forEach(ws => {
    try { if (ws.readyState === 1) ws.send(msg); } catch (e) {}
  });
}

// ═══════════════════════════════════════════════════════════════
// HTTPS API Server — Gamelog Events API
// GET /api/status — Tracker status
// GET /api/events/:gameId — Game events
// ═══════════════════════════════════════════════════════════════
function startHTTPServer() {
  const httpPort = parseInt(process.env.HTTP_PORT || '9998', 10);
  const https = require('https');
  
  // Load SSL certificates (same as main server)
  const certPath = path.resolve(__dirname, '../server.crt');
  const keyPath = path.resolve(__dirname, '../server.key');
  
  let httpServer;
  try {
    const sslOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
    
    httpServer = https.createServer(sslOptions, async (req, res) => {
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
        uptime: process.uptime(),
      }));
      return;
    }

    // GET /api/events/:gameId — get events for a specific game
    if (req.method === 'GET' && req.url.startsWith('/api/events/')) {
      // Strip query string and decode URI component
      const urlPath = req.url.split('?')[0];
      const gameId = decodeURIComponent(urlPath.substring(12));
      const events = gameEvents.get(gameId);

      console.log(`   📡 Events request for: "${gameId}" → ${events ? `${events.killFeed.length} kills, ${events.chat.length} chat` : 'no events'}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (events) {
        res.end(JSON.stringify({
          gameId,
          killFeed: events.killFeed || [],
          chat: events.chat || [],
          timeline: events.timeline || [],
          startTime: events.startTime,
        }));
      } else {
        res.end(JSON.stringify({
          gameId,
          killFeed: [],
          chat: [],
          timeline: [],
          startTime: null,
        }));
      }
      return;
    }

    // GET /api/firebase/games — query games from Firestore
    if (req.method === 'GET' && req.url.startsWith('/api/firebase/games')) {
      const urlParts = new URL(req.url, `https://${req.headers.host}`);
      const limit = Math.min(parseInt(urlParts.searchParams.get('limit')) || 50, 200);
      const after = urlParts.searchParams.get('after') || undefined;
      const mode = urlParts.searchParams.get('mode') || undefined;

      try {
        const result = await firebase.queryGames({ limit, after, mode });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /api/firebase/game/:id — get single game from Firestore
    if (req.method === 'GET' && req.url.startsWith('/api/firebase/game/')) {
      const urlPath = req.url.split('?')[0];
      const gameId = decodeURIComponent(urlPath.substring(19));

      try {
        const game = await firebase.getGame(gameId);
        if (game) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ game }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Game not found in Firestore' }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /api/firebase/count — game count from Firestore
    if (req.method === 'GET' && req.url === '/api/firebase/count') {
      try {
        const count = await firebase.getGameCount();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  httpServer.listen(httpPort, '0.0.0.0', () => {
    console.log(`\u{1F512} HTTPS API server on port ${httpPort}`);
    console.log(`   GET  /api/status \u2014 Tracker status`);
    console.log(`   GET  /api/events/:gameId \u2014 Game events`);
    console.log(`   GET  /api/firebase/games \u2014 Query Firestore games`);
    console.log(`   GET  /api/firebase/game/:id \u2014 Single Firestore game`);
  });
  
  } catch (err) {
    console.error(`⚠️  HTTPS API failed: ${err.message}`);
    console.log('   Make sure server.crt and server.key exist');
  }
}

// ── Main ────────────────────────────────────────────────────────
// ── Restore game state from last live-games.json on startup ─────
// Prevents tracker restarts from wiping the active game list.
// Restored games are marked confirmed with lastSeen = now so they
// survive the first cleanup cycle. The poll loop will re-verify or
// clean them up within gameTimeout (5 min) if the game is gone.
function restoreStateFromDisk() {
  try {
    if (!fs.existsSync(CONFIG.liveGamesFile)) return;
    const raw = fs.readFileSync(CONFIG.liveGamesFile, 'utf8');
    const data = JSON.parse(raw);
    if (!data.games || !data.games.length) return;

    const now = Date.now();
    let restored = 0;
    for (const g of data.games) {
      if (!g.id || !g.ip || !g.port) continue;
      // Only restore games seen recently (within 2× gameTimeout)
      if (g.lastSeen && now - g.lastSeen > CONFIG.gameTimeout * 2) continue;
      if (activeGames.has(g.id)) continue;

      activeGames.set(g.id, {
        ...g,
        confirmed: true,
        lastSeen: now,            // Reset so cleanup doesn't kill it immediately
        lastActivity: g.lastActivity || null,  // Preserve if game was live
        _broadcasted: true,
        _restored: true,      // Flag so we know to re-verify ASAP
        pendingInfoReqs: 0,
        players: g.players || [],
        killMatrix: g.killMatrix || null,
      });

      if (g.killFeed || g.chat) {
        // Rebuild timeline from restored kill feed so the frontend doesn't
        // show an empty Timeline tab after a tracker restart.
        const restoredKillFeed = g.killFeed || [];
        const restoredTimeline = restoredKillFeed.slice().reverse().map(k => {
          const isSuicide = k.killerNum !== undefined && k.killedNum !== undefined
            ? k.killerNum === k.killedNum
            : k.killer === (k.killed || k.victim);
          return {
            type: 'kill',
            time: k.time || '',
            description: k.message || (isSuicide
              ? `${k.killed || k.victim} died`
              : `${k.killer} killed ${k.killed || k.victim}`),
          };
        });
        gameEvents.set(g.id, {
          killFeed: restoredKillFeed,
          chat: g.chat || [],
          timeline: restoredTimeline,
          startTime: g.lastSeen || now,
        });
      }
      restored++;
    }
    if (restored > 0) console.log(`♻️  Restored ${restored} game(s) from disk`);
  } catch (err) {
    // Non-critical — start fresh
  }
}

function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   DXX-Redux/Rebirth Game Tracker v3.1                     ║');
  console.log('║   PyTracker-compatible UDP Protocol                      ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  ensureEventsDir();
  firebase.init();
  restoreStateFromDisk();   // ← Restore before writing empty file

  // Free any stale port holders before binding, then start servers
  freePorts(() => {
    startUDPServer();
    startWebSocketServer();
    startHTTPServer();
    setInterval(cleanupDeadGames, CONFIG.cleanupInterval);
    setInterval(pollActiveGames, CONFIG.pollInterval);
    writeGamelistFile(); // Write restored state immediately
  });

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
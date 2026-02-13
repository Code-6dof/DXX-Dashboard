/**
 * DXX Dashboard — Firebase Firestore Service
 *
 * Stores individual game records in Firestore for efficient,
 * long-term archival. Each game is a single document (~5-50KB),
 * keeping reads at 1 per game displayed.
 *
 * Collection: "games"  — one document per archived game
 *   Fields: all gameEntry fields + event data (killFeed, chat, timeline)
 *
 * Only games after Feb 10 2026 go to Firestore.
 * Older games stay in games.json (served as static file).
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// ── Cutoff date: games after this go to Firestore ──
const FIREBASE_CUTOFF = new Date('2026-02-10T00:00:00Z');

let db = null;
let initialized = false;

/**
 * Initialize Firebase Admin SDK.
 * Returns true if successful, false if key is missing.
 */
function init() {
  if (initialized) return !!db;

  const keyPath = path.resolve(__dirname, '../serviceAccountKey.json');
  if (!fs.existsSync(keyPath)) {
    console.warn('⚠️  Firebase: serviceAccountKey.json not found — Firestore disabled');
    initialized = true;
    return false;
  }

  try {
    const serviceAccount = require(keyPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    // Ignore undefined fields instead of throwing
    db.settings({ ignoreUndefinedProperties: true });
    initialized = true;
    console.log('🔥 Firebase Firestore initialized');
    return true;
  } catch (err) {
    console.error(`❌ Firebase init error: ${err.message}`);
    initialized = true;
    return false;
  }
}

/**
 * Save a completed game to Firestore.
 * Stores game metadata + full event data in a single document.
 *
 * @param {Object} gameEntry  — the game record (id, players, map, etc.)
 * @param {Object} eventData  — kill feed, chat, timeline, killMatrix
 */
async function saveGame(gameEntry, eventData) {
  if (!db) return false;

  try {
    const docId = gameEntry.id; // e.g. "game-02-13-2026-01-27-58-code-audacity"

    const doc = {
      // ── Game metadata ──
      ...gameEntry,
      // ── Event data (embedded, not subcollection) ──
      killFeed: eventData?.killFeed || [],
      chatLog: eventData?.chatLog || eventData?.chat || [],
      timeline: eventData?.timeline || [],
      killMatrix: eventData?.killMatrix || gameEntry.killMatrix || null,
      damageBreakdown: eventData?.damageBreakdown || [],
      totalKills: eventData?.totalKills || 0,
      totalEvents: eventData?.totalEvents || 0,
      // ── Firestore metadata ──
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'live-tracker',
    };

    await db.collection('games').doc(docId).set(doc);
    console.log(`   🔥 Saved to Firestore: ${docId}`);
    return true;
  } catch (err) {
    console.error(`   ❌ Firestore save error: ${err.message}`);
    return false;
  }
}

/**
 * Query recent games from Firestore.
 *
 * @param {Object} opts
 * @param {number} opts.limit    — max results (default 50)
 * @param {string} opts.after    — ISO timestamp cursor for pagination
 * @param {string} opts.before   — ISO timestamp upper bound
 * @param {string} opts.mode     — filter by game mode
 * @returns {Object} { games: [], hasMore: boolean }
 */
async function queryGames({ limit = 50, after, before, mode } = {}) {
  if (!db) return { games: [], hasMore: false };

  try {
    let query = db.collection('games')
      .orderBy('timestamp', 'desc')
      .limit(limit + 1); // +1 to detect hasMore

    if (after) {
      query = query.where('timestamp', '<', after);
    }
    if (before) {
      query = query.where('timestamp', '>', before);
    }
    if (mode) {
      query = query.where('mode', '==', mode);
    }

    const snapshot = await query.get();
    const games = [];
    snapshot.forEach(doc => games.push(doc.data()));

    const hasMore = games.length > limit;
    if (hasMore) games.pop(); // remove the extra

    // Strip Firestore metadata fields the frontend doesn't need
    games.forEach(g => {
      delete g.createdAt;
      delete g.source;
    });

    return { games, hasMore };
  } catch (err) {
    console.error(`❌ Firestore query error: ${err.message}`);
    return { games: [], hasMore: false };
  }
}

/**
 * Get a single game by ID from Firestore.
 *
 * @param {string} gameId
 * @returns {Object|null}
 */
async function getGame(gameId) {
  if (!db) return null;

  try {
    const doc = await db.collection('games').doc(gameId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    delete data.createdAt;
    delete data.source;
    return data;
  } catch (err) {
    console.error(`❌ Firestore getGame error: ${err.message}`);
    return null;
  }
}

/**
 * Get total game count from Firestore.
 * Uses a counter document for efficiency instead of counting all docs.
 */
async function getGameCount() {
  if (!db) return 0;

  try {
    const snapshot = await db.collection('games').count().get();
    return snapshot.data().count;
  } catch (err) {
    console.error(`❌ Firestore count error: ${err.message}`);
    return 0;
  }
}

/**
 * Check if Firestore is available.
 */
function isEnabled() {
  return !!db;
}

module.exports = {
  init,
  saveGame,
  queryGames,
  getGame,
  getGameCount,
  isEnabled,
  FIREBASE_CUTOFF,
};

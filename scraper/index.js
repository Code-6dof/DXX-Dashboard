/**
 * DXX Dashboard Scraper
 *
 * Fetches game data from retro-tracker.game-server.cc/archive/full.html.
 * The archive is a flat list of links; each link is an individual game page
 * that must be fetched separately.
 *
 * Deduplication: We store every known game filename in Firestore meta/scraper_state.
 * Only NEW filenames get fetched & stored. This guarantees each game is only
 * pulled once, no matter how many times the scraper runs.
 *
 * Modes:
 *   node scraper/index.js          — one-time scrape
 *   node scraper/index.js --watch  — poll every N minutes (cron)
 */

require("dotenv").config();
const path = require("path");
const axios = require("axios");
const cron = require("node-cron");
const admin = require("firebase-admin");
const pLimit = require("p-limit");
const { parseArchiveIndex, parseGamePage } = require("./parser");

// ── Firebase Init ──────────────────────────────────────────────

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./serviceAccountKey.json";
let serviceAccount;
try {
  serviceAccount = require(path.resolve(serviceAccountPath));
} catch (err) {
  console.error(
    "❌ Cannot find serviceAccountKey.json.\n" +
    "   1. Go to Firebase Console → Project Settings → Service Accounts\n" +
    "   2. Click 'Generate New Private Key'\n" +
    "   3. Save the file as serviceAccountKey.json in the project root\n" +
    "   4. Copy .env.example → .env and fill in your project values\n"
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.firestore();
const GAMES_COL = "games";
const PLAYERS_COL = "players";
const META_COL = "meta";
const META_DOC = "scraper_state";

const ARCHIVE_URL = process.env.ARCHIVE_URL || "https://retro-tracker.game-server.cc/archive/full.html";
const ARCHIVE_BASE = process.env.ARCHIVE_BASE_URL || "https://retro-tracker.game-server.cc/archive";
const INTERVAL = parseInt(process.env.SCRAPE_INTERVAL_MINUTES || "5", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "5", 10);

const limit = pLimit(CONCURRENCY);

// ── Helpers ────────────────────────────────────────────────────

/**
 * Get the set of game filenames we have already ingested.
 * Stored as an array in Firestore; loaded into a Set for O(1) lookup.
 *
 * If the array gets very large (>30k entries), Firestore's 1MB doc limit
 * could be hit. We split into chunks if needed.
 */
async function getKnownGameIds() {
  const doc = await db.collection(META_COL).doc(META_DOC).get();
  if (doc.exists && doc.data().knownIds) {
    return new Set(doc.data().knownIds);
  }
  return new Set();
}

/**
 * Persist newly ingested game filenames to the meta doc.
 */
async function addKnownGameIds(newIds) {
  const ref = db.collection(META_COL).doc(META_DOC);
  const doc = await ref.get();
  const existing = doc.exists && doc.data().knownIds ? doc.data().knownIds : [];
  const merged = [...new Set([...existing, ...newIds])];
  await ref.set(
    { knownIds: merged, lastRun: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

/**
 * Fetch a URL with retries and exponential backoff.
 */
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await axios.get(url, {
        timeout: 30000,
        headers: { "User-Agent": "DXX-Dashboard-Scraper/1.0" },
      });
      return resp.data;
    } catch (err) {
      if (i === retries - 1) throw err;
      const delay = 1000 * Math.pow(2, i);
      console.log(`    Retry ${i + 1} for ${url} in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Upsert aggregate player stats from a single game.
 */
async function updatePlayerStats(game) {
  const batch = db.batch();
  for (const p of game.players) {
    const ref = db.collection(PLAYERS_COL).doc(p.name);
    batch.set(
      ref,
      {
        name: p.name,
        totalKills: admin.firestore.FieldValue.increment(p.kills),
        totalDeaths: admin.firestore.FieldValue.increment(p.deaths),
        totalSuicides: admin.firestore.FieldValue.increment(p.suicides || 0),
        gamesPlayed: admin.firestore.FieldValue.increment(1),
        [`${game.gameType}Games`]: admin.firestore.FieldValue.increment(1),
        lastSeen: game.timestamp,
      },
      { merge: true }
    );
  }
  await batch.commit();
}

// ── Main Scrape Function ──────────────────────────────────────

async function scrape() {
  const startTime = Date.now();
  console.log(`\n[${new Date().toISOString()}] ── Scraping ${ARCHIVE_URL} ──`);

  // 1. Fetch the archive listing page
  let indexHtml;
  try {
    indexHtml = await fetchWithRetry(ARCHIVE_URL);
  } catch (err) {
    console.error("❌ Failed to fetch archive listing:", err.message);
    return;
  }

  // 2. Parse all game links from the listing
  const allLinks = parseArchiveIndex(indexHtml);
  console.log(`  📄 Found ${allLinks.length} total game links on archive page.`);

  if (allLinks.length === 0) {
    console.log("  ⚠ No links parsed. The page structure may have changed.");
    return;
  }

  // 3. Determine which are new (not yet in Firestore)
  const knownIds = await getKnownGameIds();
  const newLinks = allLinks.filter((link) => !knownIds.has(link));

  console.log(`  🆕 ${newLinks.length} new game(s) to fetch.`);

  if (newLinks.length === 0) {
    console.log("  ✅ Everything up to date.\n");
    return;
  }

  // 4. Fetch & parse each new game page (with concurrency limit)
  let fetched = 0;
  let failed = 0;
  const newGames = [];

  const tasks = newLinks.map((link) =>
    limit(async () => {
      const url = `${ARCHIVE_BASE}/${link}`;
      try {
        const html = await fetchWithRetry(url);
        const game = parseGamePage(html, link);
        if (game && game.players.length > 0) {
          newGames.push(game);
        }
        fetched++;
        if (fetched % 50 === 0) {
          console.log(`    ... fetched ${fetched}/${newLinks.length} pages`);
        }
      } catch (err) {
        failed++;
        console.error(`    ❌ Failed to fetch ${link}: ${err.message}`);
      }
    })
  );

  await Promise.all(tasks);
  console.log(`  📊 Successfully parsed ${newGames.length} games (${failed} failures).`);

  if (newGames.length === 0) return;

  // 5. Batch write games to Firestore
  const BATCH_SIZE = 400;
  const newIds = [];

  for (let i = 0; i < newGames.length; i += BATCH_SIZE) {
    const chunk = newGames.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (const game of chunk) {
      const ref = db.collection(GAMES_COL).doc(game.id);
      batch.set(ref, {
        id: game.id,
        filename: game.filename,
        timestamp: game.timestamp,
        gameName: game.gameName,
        map: game.map,
        mission: game.mission,
        levelNumber: game.levelNumber,
        playersSlots: game.playersSlots,
        mode: game.mode,
        version: game.version,
        difficulty: game.difficulty,
        timeElapsed: game.timeElapsed,
        killGoal: game.killGoal,
        reactorLife: game.reactorLife,
        maxTime: game.maxTime,
        players: game.players,
        playerCount: game.playerCount,
        gameType: game.gameType,
        disallowedItems: game.disallowedItems,
        ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      newIds.push(game.filename);
    }

    await batch.commit();
    console.log(`  💾 Committed batch of ${chunk.length} games.`);
  }

  // 6. Update known IDs to prevent re-ingestion
  await addKnownGameIds(newIds);

  // 7. Update per-player aggregate stats
  console.log("  📈 Updating player aggregate stats...");
  for (const game of newGames) {
    try {
      await updatePlayerStats(game);
    } catch (err) {
      console.error(`    ⚠ Failed to update stats for game ${game.id}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  ✅ Done in ${elapsed}s — ingested ${newGames.length} new games.\n`);
}

// ── Entry Point ───────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--watch")) {
  console.log(`🔄 Starting scraper in watch mode — polling every ${INTERVAL} minutes.`);
  scrape(); // run immediately once
  cron.schedule(`*/${INTERVAL} * * * *`, scrape);
} else {
  scrape()
    .then(() => {
      console.log("Single scrape complete.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

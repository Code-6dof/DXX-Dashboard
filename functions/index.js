const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const pLimit = require("p-limit");
const { parseArchiveIndex, parseGamePage } = require("./parser");

admin.initializeApp();
const db = admin.firestore();

const ARCHIVE_URL = "https://retro-tracker.game-server.cc/archive/full.html";
const ARCHIVE_BASE = "https://retro-tracker.game-server.cc/archive";
const CONCURRENCY = 5;
const limit = pLimit(CONCURRENCY);

/**
 * Scheduled Cloud Function — runs every 5 minutes.
 * Deploy with: firebase deploy --only functions
 */
exports.scheduledScrape = functions
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .pubsub.schedule("every 5 minutes")
  .onRun(async () => {
    console.log("Scheduled scrape triggered");

    // 1. Fetch archive listing
    const resp = await axios.get(ARCHIVE_URL, {
      timeout: 30000,
      headers: { "User-Agent": "DXX-Dashboard-CloudFn/1.0" },
    });
    const allLinks = parseArchiveIndex(resp.data);
    console.log(`Found ${allLinks.length} links`);

    // 2. Get known IDs
    const metaRef = db.collection("meta").doc("scraper_state");
    const metaDoc = await metaRef.get();
    const knownIds = new Set(
      metaDoc.exists && metaDoc.data().knownIds ? metaDoc.data().knownIds : []
    );

    // 3. Filter new
    const newLinks = allLinks.filter((l) => !knownIds.has(l));
    if (newLinks.length === 0) {
      console.log("No new games.");
      return null;
    }
    console.log(`${newLinks.length} new games to fetch`);

    // 4. Fetch & parse with concurrency
    const newGames = [];
    const tasks = newLinks.map((link) =>
      limit(async () => {
        try {
          const html = (
            await axios.get(`${ARCHIVE_BASE}/${link}`, { timeout: 20000 })
          ).data;
          const game = parseGamePage(html, link);
          if (game && game.players.length > 0) newGames.push(game);
        } catch (err) {
          console.error(`Failed: ${link} — ${err.message}`);
        }
      })
    );
    await Promise.all(tasks);

    // 5. Write to Firestore
    const newIds = [];
    const BATCH_SIZE = 400;
    for (let i = 0; i < newGames.length; i += BATCH_SIZE) {
      const chunk = newGames.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      for (const game of chunk) {
        batch.set(db.collection("games").doc(game.id), {
          ...game,
          ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        newIds.push(game.filename);
      }
      await batch.commit();
    }

    // 6. Update known IDs
    const merged = [...knownIds, ...newIds];
    await metaRef.set(
      { knownIds: merged, lastRun: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    // 7. Update player stats
    for (const game of newGames) {
      const batch = db.batch();
      for (const p of game.players) {
        const ref = db.collection("players").doc(p.name);
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

    console.log(`Ingested ${newGames.length} new games.`);
    return null;
  });

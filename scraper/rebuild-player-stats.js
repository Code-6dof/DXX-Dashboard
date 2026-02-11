/**
 * Rebuild player aggregate stats from all games in Firestore.
 * Use this if player stats update failed due to quota limits.
 */

require("dotenv").config();
const path = require("path");
const admin = require("firebase-admin");

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./serviceAccountKey.json";
const serviceAccount = require(path.resolve(serviceAccountPath));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.firestore();

async function rebuildPlayerStats() {
  console.log("🔄 Rebuilding player stats from all games...");
  
  // Clear existing player stats
  console.log("    Clearing existing player stats...");
  const playersSnap = await db.collection("players").get();
  const deleteBatch = db.batch();
  playersSnap.docs.forEach((doc) => deleteBatch.delete(doc.ref));
  await deleteBatch.commit();
  console.log(`   Deleted ${playersSnap.size} player records.`);

  // Stream all games and rebuild stats
  const playerStats = new Map();
  
  const gamesRef = db.collection("games");
  const snapshot = await gamesRef.get();
  
  console.log(`   Processing ${snapshot.size} games...`);
  
  snapshot.docs.forEach((doc) => {
    const game = doc.data();
    if (!game.players || !Array.isArray(game.players)) return;
    
    game.players.forEach((p) => {
      if (!playerStats.has(p.name)) {
        playerStats.set(p.name, {
          name: p.name,
          totalKills: 0,
          totalDeaths: 0,
          totalSuicides: 0,
          gamesPlayed: 0,
          "1v1Games": 0,
          "ffaGames": 0,
          lastSeen: null,
        });
      }
      
      const stats = playerStats.get(p.name);
      stats.totalKills += p.kills || 0;
      stats.totalDeaths += p.deaths || 0;
      stats.totalSuicides += p.suicides || 0;
      stats.gamesPlayed += 1;
      
      if (game.gameType === "1v1") {
        stats["1v1Games"] += 1;
      } else if (game.gameType === "ffa") {
        stats["ffaGames"] += 1;
      }
      
      if (!stats.lastSeen || new Date(game.timestamp) > new Date(stats.lastSeen)) {
        stats.lastSeen = game.timestamp;
      }
    });
  });

  // Write player stats in batches of 400
  console.log(`  💾 Writing ${playerStats.size} player records...`);
  const players = Array.from(playerStats.values());
  const BATCH_SIZE = 400;
  
  for (let i = 0; i < players.length; i += BATCH_SIZE) {
    const chunk = players.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    
    chunk.forEach((player) => {
      const ref = db.collection("players").doc(player.name);
      batch.set(ref, player);
    });
    
    await batch.commit();
    console.log(`    ... committed ${i + chunk.length}/${players.length} players`);
    
    // Small delay to avoid quota issues
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("   Player stats rebuild complete!\n");
  process.exit(0);
}

rebuildPlayerStats().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});

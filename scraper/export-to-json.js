/**
 * Export all games from Firestore to a JSON file for GitHub
 */

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const admin = require("firebase-admin");

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./serviceAccountKey.json";
const serviceAccount = require(path.resolve(serviceAccountPath));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.firestore();

async function exportGames() {
  console.log("📦 Exporting games from Firestore to JSON...");
  
  // Fetch in smaller batches to avoid quota issues
  const gamesRef = db.collection("games");
  const snapshot = await gamesRef.limit(6200).get();
  
  console.log(`  📊 Found ${snapshot.size} games`);
  
  const games = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    // Convert Firestore timestamp to ISO string
    if (data.timestamp && data.timestamp.toDate) {
      data.timestamp = data.timestamp.toDate().toISOString();
    }
    if (data.ingestedAt && data.ingestedAt.toDate) {
      data.ingestedAt = data.ingestedAt.toDate().toISOString();
    }
    games.push(data);
  });
  
  // Calculate player stats from games
  console.log("  📈 Calculating player stats...");
  const playerStats = new Map();
  
  games.forEach((game) => {
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
          ffaGames: 0,
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
        stats.ffaGames += 1;
      }
      
      if (!stats.lastSeen || new Date(game.timestamp) > new Date(stats.lastSeen)) {
        stats.lastSeen = game.timestamp;
      }
    });
  });
  
  const players = Array.from(playerStats.values());
  
  // Write to JSON file
  const output = {
    exportDate: new Date().toISOString(),
    totalGames: games.length,
    totalPlayers: players.length,
    games: games,
    players: players,
  };
  
  const outputPath = path.join(__dirname, "..", "public", "data", "games.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
  console.log(`  ✅ Exported to ${outputPath}`);
  console.log(`  📊 ${games.length} games, ${players.length} players`);
  console.log(`  💾 File size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB\n`);
  
  process.exit(0);
}

exportGames().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});

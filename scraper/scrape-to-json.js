/**
 * Scrape games directly to JSON file (no Firestore)
 * This creates a static data file that can be committed to GitHub
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const pLimit = require("p-limit");
const { parseArchiveIndex, parseGamePage } = require("./parser");

// Yearly archive URLs (2014-2026)
const YEARLY_ARCHIVES = [
  "https://retro.h0m3.net/archive-temp/2014.html",
  "https://retro.h0m3.net/archive-temp/2015.html",
  "https://retro.h0m3.net/archive-temp/2016.html",
  "https://retro.h0m3.net/archive-temp/2017.html",
  "https://retro.h0m3.net/archive-temp/2018.html",
  "https://retro.h0m3.net/archive-temp/2019.html",
  "https://retro.h0m3.net/archive-temp/2020.html",
  "https://retro.h0m3.net/archive-temp/2021.html",
  "https://retro.h0m3.net/archive-temp/2022.html",
  "https://retro.h0m3.net/archive-temp/2023.html",
  "https://retro.h0m3.net/archive-temp/2024.html",
  "https://retro.h0m3.net/archive-temp/2025.html",
  "https://retro-tracker.game-server.cc/archive/full.html", // 2026 current
];

const ARCHIVE_BASE = process.env.ARCHIVE_BASE_URL || "https://retro-tracker.game-server.cc/archive/";
const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 50;
const limit = pLimit(CONCURRENCY);

async function scrapeToJSON() {
  console.log("📦 Scraping games directly to JSON file (2014-2026)...\n");
  
  // 1. Fetch all yearly archive listings
  console.log(`  📄 Fetching ${YEARLY_ARCHIVES.length} archive pages...`);
  const allLinks = [];
  
  for (const archiveUrl of YEARLY_ARCHIVES) {
    try {
      const year = archiveUrl.match(/(\d{4})/)?.[1] || "current";
      console.log(`    ... fetching ${year}`);
      const indexRes = await axios.get(archiveUrl);
      const links = parseArchiveIndex(indexRes.data);
      
      // Store links with their base URL for proper resolution
      const baseUrl = archiveUrl.substring(0, archiveUrl.lastIndexOf("/") + 1);
      const linksWithBase = links.map(link => ({ link, baseUrl }));
      allLinks.push(...linksWithBase);
      
      console.log(`    ✅ ${year}: ${links.length} games`);
    } catch (err) {
      console.error(`    ❌ Failed to fetch ${archiveUrl}: ${err.message}`);
    }
  }
  
  console.log(`  ✅ Found ${allLinks.length} total game links\n`);
  
  // 2. Fetch all game pages
  console.log(`  🔄 Fetching ${allLinks.length} game pages (${CONCURRENCY} concurrent)...`);
  let fetched = 0;
  const games = [];
  
  const tasks = allLinks.map(({ link, baseUrl }) =>
    limit(async () => {
      const url = `${baseUrl}${link}`;
      try {
        const res = await axios.get(url);
        const game = parseGamePage(res.data, link);
        if (game && game.players.length > 0) {
          games.push(game);
        }
        fetched++;
        if (fetched % 100 === 0) {
          console.log(`    ... fetched ${fetched}/${allLinks.length}`);
        }
      } catch (err) {
        console.error(`    ❌ Failed ${link}: ${err.message}`);
      }
    })
  );
  
  await Promise.all(tasks);
  console.log(`  ✅ Successfully parsed ${games.length} games\n`);
  
  // 3. Calculate player stats
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
  console.log(`  ✅ ${players.length} unique players\n`);
  
  // 4. Write to JSON file
  const output = {
    exportDate: new Date().toISOString(),
    totalGames: games.length,
    totalPlayers: players.length,
    games: games.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    players: players.sort((a, b) => b.totalKills - a.totalKills),
  };
  
  const outputPath = path.join(__dirname, "..", "public", "data", "games.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  
  // Write minified JSON (no whitespace) for faster loading
  fs.writeFileSync(outputPath, JSON.stringify(output));
  
  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
  console.log(`  ✅ Exported to public/data/games.json (minified)`);
  console.log(`  📊 ${games.length} games, ${players.length} players`);
  console.log(`  💾 File size: ${sizeMB} MB\n`);
  
  console.log("✅ Done! You can now commit this file to GitHub.\n");
}

scrapeToJSON()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
  });

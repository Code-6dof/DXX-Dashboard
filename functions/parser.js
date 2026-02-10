/**
 * Parser for DXX Retro Tracker game archive pages.
 *
 * Architecture:
 *   1. full.html  → list of <a> links to individual game pages
 *   2. Each game page → structured HTML tables with game metadata + scoreboard
 *
 * Filename pattern:
 *   game-MM-DD-YYYY-HH-MM-SS-hostname-mapname.html
 *
 * Game page structure (observed from live site):
 *   - Header row: "REDUX 1.1 - Start time: MM-DD-YYYY-HH-MM-SS GMT"
 *   - Game Name (e.g. "1v1", custom text)
 *   - Mission (map name)
 *   - Level Number
 *   - Players (current/max e.g. "2/2", "2/7")
 *   - Mode (e.g. "Anarchy")
 *   - Version (D1 or D2)
 *   - Time Elapsed
 *   - Kill Goal
 *   - Score Board table: Player | Kills | Deaths | Suicides | K/D Ratio | Time in Game
 */

const cheerio = require("cheerio");

// ── Parse the archive listing page ────────────────────────────

/**
 * Extract all game page filenames from the full.html listing page.
 * Returns an array of strings like "game-02-10-2026-03-11-44-sledding-wrath.html"
 */
function parseArchiveIndex(html) {
  const $ = cheerio.load(html);
  const links = [];

  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    // Match links like "./game-..." or "game-..."
    const match = href.match(/(game-[\w\-]+\.html)/);
    if (match) {
      links.push(match[1]);
    }
  });

  return links;
}

// ── Parse date from filename ──────────────────────────────────

/**
 * Extract a Date from the filename pattern: game-MM-DD-YYYY-HH-MM-SS-...
 */
function parseDateFromFilename(filename) {
  const match = filename.match(/game-(\d{2})-(\d{2})-(\d{4})-(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, month, day, year, hour, min, sec] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
}

/**
 * Extract host player name and map name from filename.
 * Pattern: game-MM-DD-YYYY-HH-MM-SS-<host>-<map>.html
 */
function parseMetaFromFilename(filename) {
  const match = filename.match(/game-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{2}-(.+)\.html$/);
  if (!match) return { host: "Unknown", map: "Unknown" };

  const rest = match[1];
  // The last segment after the last dash is the map, everything before is the host
  const lastDash = rest.lastIndexOf("-");
  if (lastDash === -1) return { host: rest, map: "Unknown" };

  return {
    host: rest.substring(0, lastDash),
    map: rest.substring(lastDash + 1)
  };
}

// ── Parse an individual game detail page ──────────────────────

/**
 * Parse a single game detail HTML page and extract all structured data.
 *
 * @param {string} html - Raw HTML of the game page
 * @param {string} filename - The filename (used as fallback for date/meta)
 * @returns {Object|null} Parsed game object or null if unparseable
 */
function parseGamePage(html, filename) {
  const $ = cheerio.load(html);
  const game = {
    id: filename.replace(".html", ""),
    filename: filename,
    timestamp: null,
    gameName: "",
    map: "",
    mission: "",
    levelNumber: "",
    playersSlots: "",
    mode: "",
    version: "",
    difficulty: "",
    timeElapsed: "",
    killGoal: "",
    reactorLife: "",
    maxTime: "",
    players: [],
    playerCount: 0,
    gameType: "ffa", // will be classified below
    disallowedItems: [],
  };

  // ── Extract metadata from <b>Label: </b>Value pattern ───────
  // The page uses: <b>Game Name: </b>value<br> inside <td> elements
  const bodyHtml = $("body").html() || "";

  // Start time from header
  const startTimeMatch = bodyHtml.match(/Start time:\s*([\d\-]+)\s*GMT/);
  if (startTimeMatch) {
    const ts = parseDateFromTimestamp(startTimeMatch[1]);
    game.timestamp = ts ? ts.toISOString() : null;
  }

  // Fallback: parse from filename
  if (!game.timestamp) {
    const fallback = parseDateFromFilename(filename);
    game.timestamp = fallback ? fallback.toISOString() : new Date(0).toISOString();
  }

  // Extract key-value pairs from bold labels
  const kvPattern = /<b>([^<]+?):\s*<\/b>\s*([^<]*)/gi;
  let kvMatch;
  const kv = {};
  while ((kvMatch = kvPattern.exec(bodyHtml)) !== null) {
    const key = kvMatch[1].trim().toLowerCase();
    const val = kvMatch[2].trim();
    kv[key] = val;
  }

  game.gameName = kv["game name"] || "";
  game.mission = kv["mission"] || "";
  game.map = game.mission || parseMetaFromFilename(filename).map;
  game.levelNumber = kv["level number"] || "";
  game.playersSlots = kv["players"] || "";
  game.mode = kv["mode"] || "Anarchy";
  game.version = kv["version"] || "";
  game.difficulty = kv["difficulty"] || "";
  game.timeElapsed = kv["time elapsed"] || "";
  game.killGoal = kv["kill goal"] || "";
  game.reactorLife = kv["reactor life"] || "";
  game.maxTime = kv["max time"] || "";

  // ── Parse Score Board table ─────────────────────────────────
  // Structure: After "Score Board" header, there's a table with rows:
  //   <tr><td>Player</td><td>Kills</td><td>Deaths</td><td>Suicides</td>
  //       <td>Kill/Death Ratio</td><td>Time in Game</td></tr>
  //   <tr style="color:..."><td>playername</td><td>20</td>...

  const tables = $("table");
  let scoreboardFound = false;

  tables.each((_, table) => {
    if (scoreboardFound) return;

    const rows = $(table).find("tr");
    let isScoreboard = false;

    rows.each((_, row) => {
      const cells = $(row).find("td");
      const firstCellText = cells.first().text().trim();

      // Detect the header row of the scoreboard
      if (firstCellText === "Player" && cells.length >= 5) {
        isScoreboard = true;
        return; // skip header row
      }

      if (!isScoreboard) return;

      // Stop if we hit another section header (like "Detailed Score Board")
      if (cells.length < 4) {
        isScoreboard = false;
        scoreboardFound = true;
        return;
      }

      // Check if this looks like a data row (has a number in kills column)
      const cellTexts = [];
      cells.each((_, c) => cellTexts.push($(c).text().trim()));

      const playerName = cellTexts[0];
      const kills = parseInt(cellTexts[1], 10);
      const deaths = parseInt(cellTexts[2], 10);
      const suicides = parseInt(cellTexts[3], 10);
      const kdRatio = parseFloat(cellTexts[4]) || 0;
      const timeInGame = cellTexts[5] || "";

      if (playerName && !isNaN(kills)) {
        // Extract player color from style attribute
        const style = $(row).attr("style") || "";
        const colorMatch = style.match(/color:\s*(#[0-9A-Fa-f]{6})/);
        const color = colorMatch ? colorMatch[1] : null;

        game.players.push({
          name: playerName,
          kills: kills,
          deaths: isNaN(deaths) ? 0 : deaths,
          suicides: isNaN(suicides) ? 0 : suicides,
          kdRatio: kdRatio,
          timeInGame: timeInGame,
          color: color,
        });
      }
    });
  });

  game.playerCount = game.players.length;

  // ── Parse disallowed items ──────────────────────────────────
  const disallowedMatch = bodyHtml.match(/Disallowed Items<\/b>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i);
  if (disallowedMatch) {
    const $dis = cheerio.load(disallowedMatch[1]);
    $dis("td").each((_, td) => {
      const item = $dis(td).text().trim();
      if (item) game.disallowedItems.push(item);
    });
  }

  // ── Classify game type ──────────────────────────────────────
  game.gameType = classifyGameType(game);

  return game;
}

/**
 * Parse the start time string "MM-DD-YYYY-HH-MM-SS" into a Date object.
 */
function parseDateFromTimestamp(str) {
  const match = str.match(/(\d{2})-(\d{2})-(\d{4})-(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, month, day, year, hour, min, sec] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
}

/**
 * Classify a game as "1v1" or "ffa".
 *
 * Heuristics:
 *   1. If game name explicitly contains "1v1" or "duel" → 1v1
 *   2. If exactly 2 players → 1v1
 *   3. If players slots is "2/2" → 1v1
 *   4. Otherwise → ffa
 */
function classifyGameType(game) {
  const nameLower = (game.gameName || "").toLowerCase();

  // Explicit 1v1 in game name
  if (nameLower.includes("1v1") || nameLower.includes("duel")) {
    return "1v1";
  }

  // Exactly 2 players
  if (game.playerCount === 2) {
    return "1v1";
  }

  // Players slots field shows max 2
  const slotsMatch = (game.playersSlots || "").match(/\d+\/(\d+)/);
  if (slotsMatch && parseInt(slotsMatch[1], 10) === 2) {
    return "1v1";
  }

  return "ffa";
}

module.exports = {
  parseArchiveIndex,
  parseGamePage,
  parseDateFromFilename,
  parseMetaFromFilename,
  classifyGameType,
};

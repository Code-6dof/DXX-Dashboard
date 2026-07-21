/**
 * Filtering logic for DXX Dashboard.
 * Manages dropdown population and game filtering.
 */
const DXXFilters = (() => {
  let allGames = [];
  let allPlayers = [];
  let metadataCache = null; // Store metadata for year range

  function setData(games, players, metadata) {
    allGames = games;
    allPlayers = players;
    if (metadata) metadataCache = metadata;
    populateDropdowns();
  }

  function populateDropdowns() {
    const mapSet = new Set();

    // Collect maps from loaded games
    allGames.forEach((g) => {
      if (g.map && g.map !== "Unknown") mapSet.add(g.map);
    });

    const yearSel = document.getElementById("yearFilter");
    const mapSel = document.getElementById("mapFilter");
    const monthSel = document.getElementById("monthFilter");

    // Year - use metadata date range if available, otherwise fallback to loaded games
    yearSel.innerHTML = '<option value="">All Years</option>';
    let years = [];
    
    if (metadataCache && metadataCache.oldestGame && metadataCache.newestGame) {
      // Extract year range from metadata
      const oldestYear = parseInt(metadataCache.oldestGame.slice(0, 4));
      const newestYear = parseInt(metadataCache.newestGame.slice(0, 4));
      // Generate all years in range
      for (let y = newestYear; y >= oldestYear; y--) {
        years.push(y.toString());
      }
    } else {
      // Fallback: use years from loaded games
      const yearSet = new Set();
      allGames.forEach((g) => {
        if (g.timestamp && g.timestamp.length >= 4) {
          const y = g.timestamp.slice(0, 4);
          if (y !== "1970") yearSet.add(y);
        }
      });
      years = [...yearSet].sort().reverse();
    }
    
    years.forEach((y) => {
      yearSel.innerHTML += `<option value="${y}">${y}</option>`;
    });

    // Map
    mapSel.innerHTML = '<option value="">All Maps</option>';
    [...mapSet]
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .forEach((m) => {
        mapSel.innerHTML += `<option value="${m}">${m}</option>`;
      });

    // Months (static)
    const months = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December",
    ];
    monthSel.innerHTML = '<option value="">All Months</option>';
    months.forEach((m, i) => {
      const val = String(i + 1).padStart(2, "0");
      monthSel.innerHTML += `<option value="${val}">${m}</option>`;
    });
  }

  function getFiltered() {
    const search = (document.getElementById("searchInput").value || "").toLowerCase().trim();
    const year = document.getElementById("yearFilter").value;
    const month = document.getElementById("monthFilter").value;
    const map = document.getElementById("mapFilter").value;
    const version = document.getElementById("versionFilter").value;

    return allGames.filter((g) => {
      // Year filter
      if (year && (!g.timestamp || !g.timestamp.startsWith(year))) return false;

      // Month filter: timestamp is ISO — "YYYY-MM-..."
      if (month && g.timestamp) {
        const tsMonth = g.timestamp.slice(5, 7);
        if (tsMonth !== month) return false;
      }

      // Map filter
      if (map && g.map !== map) return false;

      // Version filter
      if (version && g.version !== version) return false;

      // Search (player name or map)
      if (search) {
        const inMap = (g.map || "").toLowerCase().includes(search);
        const inGameName = (g.gameName || "").toLowerCase().includes(search);
        const inPlayers = g.players && g.players.some((p) => p.name.toLowerCase().includes(search));
        if (!inMap && !inPlayers && !inGameName) return false;
      }

      return true;
    });
  }

  function clearAll() {
    document.getElementById("searchInput").value = "";
    document.getElementById("yearFilter").value = "";
    document.getElementById("monthFilter").value = "";
    document.getElementById("mapFilter").value = "";
    document.getElementById("versionFilter").value = "";
  }

  return { setData, getFiltered, clearAll, populateDropdowns };
})();

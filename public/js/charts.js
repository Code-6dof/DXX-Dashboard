/**
 * Chart.js visualizations for the DXX Dashboard.
 */
const DXXCharts = (() => {
  let gamesOverTimeChart = null;
  let modeDistChart = null;
  let topPlayersChart = null;
  let topMapsChart = null;

  const C = {
    accent: "#00e5ff",
    red: "#ff4060",
    green: "#00e676",
    gold: "#ffd740",
    blue: "#448aff",
    dimText: "#6b7394",
    gridLine: "rgba(255,255,255,0.04)",
    bg: "#161b2c",
  };

  const defaultScaleOpts = {
    ticks: { color: C.dimText, font: { size: 11 } },
    grid: { color: C.gridLine },
  };

  Chart.defaults.color = C.dimText;
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";

  /** Games Over Time — area line chart by month. */
  function renderGamesOverTime(monthCounts) {
    const ctx = document.getElementById("gamesOverTimeChart");
    if (!ctx) return;
    const labels = Object.keys(monthCounts).sort();
    const data = labels.map((l) => monthCounts[l]);

    // Format labels as "Jan 2025"
    const formatted = labels.map((l) => {
      const [y, m] = l.split("-");
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${months[parseInt(m, 10) - 1]} ${y}`;
    });

    if (gamesOverTimeChart) gamesOverTimeChart.destroy();
    gamesOverTimeChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: formatted,
        datasets: [
          {
            label: "Games",
            data,
            borderColor: C.accent,
            backgroundColor: "rgba(0,229,255,0.08)",
            fill: true,
            tension: 0.35,
            pointRadius: 2,
            pointHoverRadius: 5,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: { legend: { display: false } },
        scales: { x: defaultScaleOpts, y: { ...defaultScaleOpts, beginAtZero: true } },
      },
    });
  }

  /** Mode distribution — doughnut. */
  function renderModeDist(modeCounts) {
    const ctx = document.getElementById("modeDistChart");
    if (!ctx) return;
    if (modeDistChart) modeDistChart.destroy();
    modeDistChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: ["1v1 Duels", "Free-For-All"],
        datasets: [
          {
            data: [modeCounts["1v1"] || 0, modeCounts["ffa"] || 0],
            backgroundColor: [C.red, C.green],
            borderWidth: 0,
            hoverOffset: 8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "65%",
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: C.dimText, padding: 16, usePointStyle: true, pointStyleWidth: 12 },
          },
        },
      },
    });
  }

  /** Top 20 players — horizontal bar chart. */
  function renderTopPlayers(players) {
    const ctx = document.getElementById("topPlayersChart");
    if (!ctx) return;
    const top = players.slice(0, 20);
    if (topPlayersChart) topPlayersChart.destroy();
    topPlayersChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: top.map((p) => p.name),
        datasets: [
          {
            label: "Total Kills",
            data: top.map((p) => p.totalKills || 0),
            backgroundColor: C.accent,
            borderRadius: 3,
            barThickness: 16,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ...defaultScaleOpts, beginAtZero: true },
          y: { ...defaultScaleOpts, ticks: { ...defaultScaleOpts.ticks, font: { size: 11 } } },
        },
      },
    });
  }

  /** Top maps — horizontal bar chart. */
  function renderTopMaps(mapCounts) {
    const ctx = document.getElementById("topMapsChart");
    if (!ctx) return;
    // Sort by count descending, take top 15
    const sorted = Object.entries(mapCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    if (topMapsChart) topMapsChart.destroy();
    topMapsChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: sorted.map((e) => e[0]),
        datasets: [
          {
            label: "Games Played",
            data: sorted.map((e) => e[1]),
            backgroundColor: C.gold,
            borderRadius: 3,
            barThickness: 14,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ...defaultScaleOpts, beginAtZero: true },
          y: defaultScaleOpts,
        },
      },
    });
  }

  return { renderGamesOverTime, renderModeDist, renderTopPlayers, renderTopMaps };
})();

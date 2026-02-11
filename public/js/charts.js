/**
 * Chart.js visualizations for the DXX Dashboard.
 */
const DXXCharts = (() => {
  let gamesOverTimeChart = null;
  let modeDistChart = null;
  let topPlayersChart = null;
  let topMapsChart = null;
  let dayOfWeekChart = null;

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

  /** Games Over Time — area line chart by month with trend line. */
  function renderGamesOverTime(monthCounts) {
    const ctx = document.getElementById("gamesOverTimeChart");
    if (!ctx) return;
    const labels = Object.keys(monthCounts).sort();
    const data = labels.map((l) => monthCounts[l]);

    // Format labels - show all months
    const formatted = labels.map((l) => {
      const [y, m] = l.split("-");
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const monthNum = parseInt(m, 10) - 1;
      return `${months[monthNum]} '${y.slice(2)}`;
    });

    // Calculate 12-month moving average
    const movingAvg = data.map((val, idx) => {
      const start = Math.max(0, idx - 11);
      const slice = data.slice(start, idx + 1);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    });

    if (gamesOverTimeChart) gamesOverTimeChart.destroy();
    gamesOverTimeChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: formatted,
        datasets: [
          {
            label: "Games per Month",
            data,
            borderColor: C.accent,
            backgroundColor: "rgba(0,229,255,0.08)",
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 5,
            borderWidth: 2,
          },
          {
            label: "12-Month Average",
            data: movingAvg,
            borderColor: C.gold,
            backgroundColor: "transparent",
            fill: false,
            tension: 0.35,
            pointRadius: 0,
            borderWidth: 2,
            borderDash: [5, 5],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: { 
          legend: { 
            display: true,
            position: "top",
            align: "end",
            labels: { color: C.dimText, padding: 12, usePointStyle: true, pointStyleWidth: 12 }
          },
          tooltip: {
            callbacks: {
              title: (items) => {
                const idx = items[0].dataIndex;
                const [y, m] = labels[idx].split("-");
                const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                return `${months[parseInt(m, 10) - 1]} ${y}`;
              }
            }
          }
        },
        scales: { 
          x: { 
            ...defaultScaleOpts,
            ticks: { 
              ...defaultScaleOpts.ticks, 
              maxRotation: 45, 
              minRotation: 45,
              autoSkip: true,
              maxTicksLimit: 24
            }
          }, 
          y: { ...defaultScaleOpts, beginAtZero: true } 
        },
      },
    });
  }

  /** Mode distribution — doughnut with percentage labels. */
  function renderModeDist(modeCounts) {
    const ctx = document.getElementById("modeDistChart");
    if (!ctx) return;
    const duelCount = modeCounts["1v1"] || 0;
    const ffaCount = modeCounts["ffa"] || 0;
    const total = duelCount + ffaCount;
    
    if (modeDistChart) modeDistChart.destroy();
    modeDistChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: ["1v1 Duels", "Free-For-All"],
        datasets: [
          {
            data: [duelCount, ffaCount],
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
          tooltip: {
            callbacks: {
              label: (context) => {
                const value = context.parsed;
                const percentage = ((value / total) * 100).toFixed(1);
                return `${context.label}: ${value.toLocaleString()} (${percentage}%)`;
              }
            }
          }
        },
      },
    });
  }

  /** Top 30 players — horizontal bar chart with gradient. */
  function renderTopPlayers(players) {
    const ctx = document.getElementById("topPlayersChart");
    if (!ctx) return;
    const top = players.slice(0, 30);
    
    // Create gradient colors for top players
    const gradientColors = top.map((_, i) => {
      if (i === 0) return C.gold; // #1
      if (i === 1) return "#c0c0c0"; // #2 silver
      if (i === 2) return "#cd7f32"; // #3 bronze
      return C.accent;
    });
    
    if (topPlayersChart) topPlayersChart.destroy();
    topPlayersChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: top.map((p, i) => `#${i + 1} ${p.name}`),
        datasets: [
          {
            label: "Total Kills",
            data: top.map((p) => p.totalKills || 0),
            backgroundColor: gradientColors,
            borderRadius: 3,
            barThickness: 14,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { 
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                const idx = items[0].dataIndex;
                return top[idx].name;
              },
              label: (context) => {
                const p = top[context.dataIndex];
                const kd = p.totalDeaths > 0 ? (p.totalKills / p.totalDeaths).toFixed(2) : p.totalKills;
                return [
                  `Kills: ${p.totalKills.toLocaleString()}`,
                  `Deaths: ${p.totalDeaths.toLocaleString()}`,
                  `K/D: ${kd}`,
                  `Games: ${p.gamesPlayed.toLocaleString()}`
                ];
              }
            }
          }
        },
        scales: {
          x: { ...defaultScaleOpts, beginAtZero: true },
          y: { 
            ...defaultScaleOpts, 
            ticks: { 
              ...defaultScaleOpts.ticks, 
              font: { size: 10 },
              autoSkip: false
            } 
          },
        },
      },
    });
  }

  /** Top 20 maps — horizontal bar chart with game counts. */
  function renderTopMaps(mapCounts) {
    const ctx = document.getElementById("topMapsChart");
    if (!ctx) return;
    // Sort by count descending, take top 20
    const sorted = Object.entries(mapCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

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
        plugins: { 
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => `${context.parsed.x.toLocaleString()} games`
            }
          }
        },
        scales: {
          x: { ...defaultScaleOpts, beginAtZero: true },
          y: { 
            ...defaultScaleOpts, 
            ticks: { 
              ...defaultScaleOpts.ticks, 
              font: { size: 10 },
              autoSkip: false
            } 
          },
        },
      },
    });
  }

  /** Day of Week Distribution — bar chart showing game activity by day */
  function renderDayOfWeek(dayCounts) {
    const ctx = document.getElementById("dayOfWeekChart");
    if (!ctx) return;
    
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const data = days.map(day => dayCounts[day] || 0);
    
    if (dayOfWeekChart) dayOfWeekChart.destroy();
    dayOfWeekChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: days,
        datasets: [
          {
            label: "Games Played",
            data,
            backgroundColor: C.accent,
            borderRadius: 4,
            barThickness: 40,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => `${context.parsed.y.toLocaleString()} games`
            }
          }
        },
        scales: {
          x: { ...defaultScaleOpts },
          y: { ...defaultScaleOpts, beginAtZero: true },
        },
      },
    });
  }

  return { renderGamesOverTime, renderModeDist, renderTopPlayers, renderTopMaps, renderDayOfWeek };
})();

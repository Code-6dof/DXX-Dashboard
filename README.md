# DXX Dashboard

A comprehensive web dashboard for tracking Descent 1 & 2 multiplayer game statistics from the [retro-tracker game server](https://retro-tracker.game-server.cc/archive/full.html).

![Dashboard Preview](https://via.placeholder.com/800x400/1a1d29/00e676?text=DXX+Dashboard)

## Features

- 📊 **6,156+ Games Tracked** - Complete history from January 2025 to present
- 🎮 **Separate 1v1 & FFA Views** - Distinct visual styles for duel matches vs free-for-all
- 📈 **Player Leaderboard** - Top players by kills, K/D ratio, and games played
- 📉 **Charts & Analytics** - Games over time, mode distribution, top players, popular maps
- 🔍 **Advanced Filtering** - Search by player, map, year, month, version (D1/D2)
- 🎨 **Dark Space Theme** - Immersive design with red (1v1) and green (FFA) accents
- 💾 **Static JSON Data** - All data in a single file that can be committed to GitHub

## Live Demo

[View Dashboard](#) <!-- Add your GitHub Pages URL here -->

## Data Coverage

- **Date Range**: January 1, 2025 - Present
- **Total Games**: 6,156
- **Unique Players**: 200
- **Game Types**: 1v1 Duels & FFA (Free-For-All)
- **Game Modes**: Anarchy, CTF, and more
- **Versions**: Descent 1 (D1) and Descent 2 (D2)

## Quick Start

### View the Dashboard Locally

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/DXX-Dashboard.git
cd DXX-Dashboard

# Open the dashboard in your browser
open public/index.html
# Or use a simple HTTP server
npx http-server public -p 8080
```

### Update Game Data

To fetch the latest games from retro-tracker:

```bash
# Install dependencies
npm install

# Scrape all games to JSON
node scraper/scrape-to-json.js
```

This will update `public/data/games.json` with the latest data.

## Project Structure

```
DXX-Dashboard/
├── public/                    # Frontend (static site)
│   ├── index.html            # Main dashboard SPA
│   ├── css/style.css         # Dark space theme
│   ├── js/
│   │   ├── app.js            # Main application logic
│   │   ├── charts.js         # Chart.js visualizations
│   │   ├── filters.js        # Filter management
│   │   └── firebase-init.js  # Firebase config (optional)
│   └── data/
│       ├── games.json        # All game data (6.5 MB)
│       └── README.md         # Data documentation
├── scraper/                   # Data collection scripts
│   ├── parser.js             # HTML parsing logic
│   ├── scrape-to-json.js     # Direct scrape → JSON
│   ├── index.js              # Firestore scraper (optional)
│   ├── export-to-json.js     # Export Firestore → JSON
│   └── rebuild-player-stats.js
├── functions/                 # Firebase Cloud Functions (optional)
└── package.json              # Dependencies
```

## Technology Stack

### Frontend
- **Vanilla JavaScript** - No framework overhead
- **Chart.js** - Beautiful, responsive charts
- **Inter + JetBrains Mono** - Professional typography
- **CSS Grid & Flexbox** - Modern, responsive layout

### Data Collection
- **Node.js** - Server-side JavaScript
- **Cheerio** - Fast HTML parsing
- **Axios** - HTTP requests
- **p-limit** - Concurrent request management

### Optional (Firebase)
- **Cloud Firestore** - NoSQL database
- **Firebase Hosting** - CDN hosting
- **Cloud Functions** - Scheduled scraping

## Data Source

All data is scraped from the [Retro Tracker Game Server](https://retro-tracker.game-server.cc/archive/full.html), which hosts a public archive of Descent multiplayer games.

### Archive Structure
- **Archive listing**: `full.html` - List of all game links
- **Game pages**: `game-MM-DD-YYYY-HH-MM-SS-hostname-mapname.html`
  - Game metadata (name, mode, version, map, etc.)
  - Scoreboard (player stats, K/D ratios, time played)
  - Ship colors for each player

## Deployment

### GitHub Pages

```bash
# Build is not required (static site)
git add -A
git commit -m "Deploy dashboard"
git push origin main

# Enable GitHub Pages in repository settings
# Select: Source > Deploy from a branch > main > /public
```

### Firebase Hosting (Optional)

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login and initialize
firebase login
firebase init hosting

# Deploy
firebase deploy --only hosting
```

## Automation

### Auto-Update with Cron

```bash
# Edit crontab
crontab -e

# Add: Update daily at 3 AM
0 3 * * * cd /path/to/DXX-Dashboard && node scraper/scrape-to-json.js && git add public/data/games.json && git commit -m "Auto-update $(date +\%Y-\%m-\%d)" && git push
```

### GitHub Actions (Coming Soon)

Automated daily scraping via GitHub Actions workflow.

## Configuration

### Update Scraper Settings

Edit `.env`:

```env
ARCHIVE_URL=https://retro-tracker.game-server.cc/archive/full.html
ARCHIVE_BASE_URL=https://retro-tracker.game-server.cc/archive/
CONCURRENCY=50  # Number of concurrent HTTP requests
```

## Development

### Prerequisites

- Node.js 18+ (recommend Node 20+)
- npm or yarn

### Install Dependencies

```bash
npm install
```

### Run Scraper

```bash
# One-time scrape to JSON
npm run scrape:json

# Or use the Firebase scraper (requires setup)
npm run scrape
```

### Test Locally

```bash
# Serve the public directory
npx http-server public -p 8080
# Open http://localhost:8080
```

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - See [LICENSE](LICENSE) for details.

## Acknowledgments

- [Retro Tracker Game Server](https://retro-tracker.game-server.cc/) - Data source
- [DXX-Rebirth](https://www.dxx-rebirth.com/) - Descent game engine
- Descent community - For keeping the game alive!

## Support

Found a bug or have a feature request? [Open an issue](https://github.com/YOUR_USERNAME/DXX-Dashboard/issues).

---

**Made with ❤️ for the Descent community**

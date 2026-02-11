# DXX-Redux Game Launcher with Auto-Uploader

This launcher automatically starts the gamelog uploader when you play, so you never have to manually run it.

## Setup Instructions

### Linux / macOS

1. **Copy files to your game directory:**
   ```bash
   cd ~/.d2x-rebirth
   cp /path/to/launch-with-uploader.sh .
   cp /path/to/gamelog-uploader.js .
   chmod +x launch-with-uploader.sh
   ```

2. **Edit launcher if needed:**
   ```bash
   nano launch-with-uploader.sh
   ```
   Change these lines if necessary:
   - `TRACKER_SERVER="http://your-server:9998"` - Your tracker URL
   - `GAME_BINARY="d2x-rebirth"` - Your game executable name

3. **Run the launcher instead of the game:**
   ```bash
   ./launch-with-uploader.sh
   ```

4. **Optional: Create desktop shortcut**
   Create `~/.local/share/applications/dxx-with-uploader.desktop`:
   ```ini
   [Desktop Entry]
   Type=Application
   Name=DXX-Redux (with Uploader)
   Comment=Descent II with automatic gamelog upload
   Exec=/home/YOUR_USERNAME/.d2x-rebirth/launch-with-uploader.sh
   Icon=d2x-rebirth
   Terminal=false
   Categories=Game;
   ```

### Windows

1. **Copy files to your game directory:**
   - Copy `launch-with-uploader.bat` to your game folder (e.g., `C:\Games\Descent\`)
   - Copy `gamelog-uploader.js` to the same folder

2. **Edit launcher if needed:**
   Right-click `launch-with-uploader.bat` → Edit
   Change these lines if necessary:
   - `set TRACKER_SERVER=http://your-server:9998`
   - `set GAME_BINARY=d2x-rebirth.exe`

3. **Run the launcher instead of the game:**
   Double-click `launch-with-uploader.bat`

4. **Optional: Create desktop shortcut**
   - Right-click `launch-with-uploader.bat` → Send to → Desktop (create shortcut)
   - Rename shortcut to "Descent II (Online)"
   - Right-click shortcut → Properties → Change Icon (optional)

## How It Works

```
You run launcher
        ↓
Launcher starts uploader (background)
        ↓
Launcher starts game
        ↓
You play (uploader sends events automatically)
        ↓
You quit game
        ↓
Launcher stops uploader
        ↓
Done
```

## Configuration

### Change Server URL

Edit the launcher script and change:
```bash
TRACKER_SERVER="http://your-server.com:9998"
```

### Use Different Game Executable

If you have multiple DXX games (D1X, D2X, Redux versions):

Linux/macOS:
```bash
GAME_BINARY="d1x-rebirth"  # or d2x-redux, etc.
```

Windows:
```batch
set GAME_BINARY=d1x-rebirth.exe
```

### Pass Game Arguments

The launcher forwards all arguments to the game:

```bash
# Linux/macOS
./launch-with-uploader.sh -hogdir ~/missions -pilot mypilot

# Windows
launch-with-uploader.bat -hogdir C:\missions -pilot mypilot
```

## Troubleshooting

### Uploader not starting
Check the log file:
- Linux/macOS: `/tmp/dxx-uploader.log`
- Windows: `%TEMP%\dxx-uploader.log`

### Game not found
Edit the launcher and set full path:
```bash
GAME_BINARY="/usr/local/bin/d2x-rebirth"
```

### Multiple uploads from same machine
If you have multiple game instances, each will start its own uploader. This is fine - the server handles multiple perspectives.

### Uploader keeps running after crash
If game crashes, the uploader might keep running:

Linux/macOS:
```bash
pkill -f gamelog-uploader
```

Windows:
```batch
taskkill /F /IM node.exe
```

## Advanced: System Integration

### Auto-start with Steam

1. Add non-Steam game to library
2. Set launch options to point to `launch-with-uploader.sh` (Linux) or `launch-with-uploader.bat` (Windows)

### Auto-start with Lutris

1. Configure game runner
2. Set executable to the launcher script
3. Set working directory to game directory

## Distribution to Players

Share these files with your players:
1. `launch-with-uploader.sh` (Linux/macOS) or `launch-with-uploader.bat` (Windows)
2. `gamelog-uploader.js`
3. `LAUNCHER-README.md` (this file)

Players just need to:
1. Copy both files to their game directory
2. Edit the TRACKER_SERVER line with your server URL
3. Run the launcher instead of the game

That's it - no manual uploader management needed!

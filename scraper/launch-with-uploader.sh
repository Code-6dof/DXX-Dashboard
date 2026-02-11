#!/bin/bash
# DXX-Redux Game Launcher with Gamelog Uploader
# Place this script in your game directory and run it instead of d2x-rebirth directly

# Configuration
TRACKER_SERVER="http://192.210.140.94:9998"
GAME_BINARY="d2x-rebirth"
UPLOADER_SCRIPT="gamelog-uploader.js"

# Find uploader script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/$UPLOADER_SCRIPT" ]; then
    UPLOADER_PATH="$SCRIPT_DIR/$UPLOADER_SCRIPT"
elif [ -f "./$UPLOADER_SCRIPT" ]; then
    UPLOADER_PATH="./$UPLOADER_SCRIPT"
else
    echo "Warning: gamelog-uploader.js not found, skipping uploader"
    UPLOADER_PATH=""
fi

# Start uploader in background if found
if [ -n "$UPLOADER_PATH" ]; then
    echo "Starting gamelog uploader..."
    node "$UPLOADER_PATH" --server "$TRACKER_SERVER" > /tmp/dxx-uploader.log 2>&1 &
    UPLOADER_PID=$!
    echo "Uploader started (PID: $UPLOADER_PID)"
    
    # Give uploader time to initialize
    sleep 1
else
    UPLOADER_PID=""
fi

# Start the game
echo "Starting $GAME_BINARY..."
if command -v $GAME_BINARY &> /dev/null; then
    $GAME_BINARY "$@"
    GAME_EXIT_CODE=$?
else
    echo "Error: $GAME_BINARY not found in PATH"
    echo "Please edit this script and set GAME_BINARY to the full path of your game"
    GAME_EXIT_CODE=1
fi

# Stop uploader when game exits
if [ -n "$UPLOADER_PID" ]; then
    echo "Stopping uploader..."
    kill $UPLOADER_PID 2>/dev/null
    wait $UPLOADER_PID 2>/dev/null
    echo "Uploader stopped"
fi

exit $GAME_EXIT_CODE

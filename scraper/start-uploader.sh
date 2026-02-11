#!/bin/bash
# Start the DXX-Redux Gamelog Uploader
# This script runs the uploader with default settings

cd "$(dirname "$0")"

echo "Starting DXX-Redux Gamelog Uploader..."
echo ""
echo "Press Ctrl+C to stop"
echo ""

node gamelog-uploader.js "$@"

@echo off
REM Start the DXX-Redux Gamelog Uploader
REM This script runs the uploader with default settings

cd /d "%~dp0"

echo Starting DXX-Redux Gamelog Uploader...
echo.
echo Press Ctrl+C to stop
echo.

node gamelog-uploader.js %*

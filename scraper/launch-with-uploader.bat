@echo off
REM DXX-Redux Game Launcher with Gamelog Uploader
REM Place this script in your game directory and run it instead of d2x-rebirth.exe directly

REM Configuration
set TRACKER_SERVER=http://localhost:9998
set GAME_BINARY=d2x-rebirth.exe
set UPLOADER_SCRIPT=gamelog-uploader.js

REM Find uploader script
if exist "%~dp0%UPLOADER_SCRIPT%" (
    set UPLOADER_PATH=%~dp0%UPLOADER_SCRIPT%
) else if exist "%UPLOADER_SCRIPT%" (
    set UPLOADER_PATH=%UPLOADER_SCRIPT%
) else (
    echo Warning: gamelog-uploader.js not found, skipping uploader
    set UPLOADER_PATH=
)

REM Start uploader in background if found
if defined UPLOADER_PATH (
    echo Starting gamelog uploader...
    start /B node "%UPLOADER_PATH%" --server %TRACKER_SERVER% > "%TEMP%\dxx-uploader.log" 2>&1
    timeout /t 1 /nobreak > nul
    echo Uploader started
)

REM Start the game
echo Starting %GAME_BINARY%...
if exist "%GAME_BINARY%" (
    start /WAIT "" "%GAME_BINARY%" %*
) else if exist "%~dp0%GAME_BINARY%" (
    start /WAIT "" "%~dp0%GAME_BINARY%" %*
) else (
    echo Error: %GAME_BINARY% not found
    echo Please edit this script and set GAME_BINARY to the full path of your game
    pause
    exit /b 1
)

REM Stop uploader when game exits
if defined UPLOADER_PATH (
    echo Stopping uploader...
    taskkill /F /IM node.exe /FI "WINDOWTITLE eq gamelog-uploader*" > nul 2>&1
    echo Uploader stopped
)

exit /b 0

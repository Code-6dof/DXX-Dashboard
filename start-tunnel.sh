#!/bin/bash
# DXX Dashboard + Cloudflare Tunnel startup script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUDFLARED="/home/deck/.local/bin/cloudflared"
TUNNEL_CONFIG="/home/deck/.cloudflared/config.yml"

echo "=== DXX Dashboard Startup ==="

NODE="/home/deck/.local/bin/node"

# --- Kill any existing instances ---
pkill -f "serve.py" 2>/dev/null && echo "Stopped old serve.py" || true
pkill -f "udp-tracker.js" 2>/dev/null && echo "Stopped old udp-tracker" || true
pkill -f "cloudflared tunnel" 2>/dev/null && echo "Stopped old cloudflared" || true
sleep 1

# --- Regenerate SSL certs if missing ---
if [[ ! -f "$SCRIPT_DIR/server.crt" || ! -f "$SCRIPT_DIR/server.key" ]]; then
    echo "Generating SSL certificates..."
    openssl req -x509 -newkey rsa:2048 \
        -keyout "$SCRIPT_DIR/server.key" \
        -out "$SCRIPT_DIR/server.crt" \
        -days 3650 -nodes -subj "/CN=localhost"
fi

# --- Ensure data directories exist ---
mkdir -p "$SCRIPT_DIR/public/data/events"

# --- Start UDP Tracker (writes live-games.json) ---
echo "Starting UDP tracker on port 9999..."
cd "$SCRIPT_DIR"
nohup "$NODE" scraper/udp-tracker.js > /tmp/udp-tracker.log 2>&1 &
echo "udp-tracker PID: $!"
sleep 2

# --- Start Python HTTPS server ---
echo "Starting serve.py on port 8443..."
cd "$SCRIPT_DIR"
nohup python3 serve.py > /tmp/serve.log 2>&1 &
SERVE_PID=$!
echo "serve.py PID: $SERVE_PID"

# Wait for server to be ready
for i in {1..10}; do
    if python3 -c "import socket; s=socket.socket(); s.settimeout(1); r=s.connect_ex(('127.0.0.1',8443)); s.close(); exit(r)" 2>/dev/null; then
        echo "serve.py is listening on port 8443"
        break
    fi
    sleep 1
done

# --- Start Cloudflare Tunnel ---
echo "Starting cloudflared tunnel..."
nohup "$CLOUDFLARED" tunnel --config "$TUNNEL_CONFIG" run > /tmp/cloudflared.log 2>&1 &
CF_PID=$!
echo "cloudflared PID: $CF_PID"

sleep 3
echo ""
echo "=== Status ==="
echo "udp-tracker log:  tail -f /tmp/udp-tracker.log"
echo "serve.py log:     tail -f /tmp/serve.log"
echo "cloudflared log:  tail -f /tmp/cloudflared.log"
echo ""
tail -5 /tmp/cloudflared.log

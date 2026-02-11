#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# DXX Dashboard — Deploy to GitHub + VM
# Usage:  ./deploy.sh [commit message]
#         ./deploy.sh                     ← auto-generates message
#         ./deploy.sh "fix chart labels"  ← custom message
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ── Config ───────────────────────────────────────────────────
VM_USER="ubuntu"
VM_HOST="129.80.20.218"
VM_DIR="/home/ubuntu/DXX-Dashboard"
SSH_KEY="/home/malachi/Documents/ssh-key-2026-02-10.key"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10"
BRANCH="main"

# Colors
C='\033[0;36m'   # cyan
G='\033[0;32m'   # green
Y='\033[0;33m'   # yellow
R='\033[0;31m'   # red
P='\033[0;35m'   # purple
B='\033[1m'      # bold
N='\033[0m'      # reset

info()  { echo -e "${C}${B}▸${N} $*"; }
ok()    { echo -e "${G}${B}✓${N} $*"; }
warn()  { echo -e "${Y}${B}⚠${N} $*"; }
fail()  { echo -e "${R}${B}✗${N} $*"; exit 1; }

# ── 1. Git: Stage, Commit, Push ──────────────────────────────
echo -e "\n${P}${B}═══ DXX Dashboard Deploy ═══${N}\n"

cd "$(dirname "$0")"

# Check for changes
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  info "No local changes — skipping git push"
  GIT_SKIPPED=true
else
  GIT_SKIPPED=false
  
  # Build commit message
  if [ $# -gt 0 ]; then
    MSG="$*"
  else
    # Auto-generate from changed files
    CHANGED=$(git diff --name-only --cached 2>/dev/null; git diff --name-only 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null)
    CHANGED=$(echo "$CHANGED" | sort -u | head -5 | tr '\n' ', ' | sed 's/,$//')
    MSG="update: ${CHANGED}"
  fi

  info "Staging all changes..."
  git add -A

  info "Committing: ${MSG}"
  git commit -m "$MSG" --quiet || true

  info "Pushing to origin/${BRANCH}..."
  if git push origin "$BRANCH" --quiet 2>&1; then
    ok "GitHub push complete"
  else
    warn "Git push failed (maybe no network?) — continuing to VM sync"
  fi
fi

# ── 2. Rsync to VM ──────────────────────────────────────────
echo ""
info "Syncing to VM ${VM_HOST}..."

# Rsync the project files (exclude stuff the VM doesn't need / shouldn't overwrite)
rsync -avz --delete \
  -e "ssh $SSH_OPTS" \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.env' \
  --exclude '*.log' \
  --exclude 'package-lock.json' \
  --exclude 'public/data/games.json' \
  --exclude 'public/data/live-games.json' \
  --exclude 'public/data/events/' \
  --exclude 'cloudflared-linux-amd64' \
  --exclude '*.tmp' \
  ./ "${VM_USER}@${VM_HOST}:${VM_DIR}/" \
  2>&1 | tail -3

ok "Files synced to VM"

# ── 3. Restart services on VM ────────────────────────────────
echo ""
info "Restarting services on VM..."

ssh $SSH_OPTS "${VM_USER}@${VM_HOST}" bash -s <<'REMOTE'
  cd /home/ubuntu/DXX-Dashboard

  # Kill old serve.py and wait for port to free
  pkill -9 -f 'python3 serve.py' 2>/dev/null || true
  for i in 1 2 3 4 5; do
    ss -tlnp | grep -q ':8080' || break
    sleep 1
  done
  nohup python3 serve.py > /dev/null 2>&1 &
  echo "  ✓ serve.py restarted (PID $!)"

  # Kill old tracker and wait for port to free
  pkill -9 -f 'node scraper/udp-tracker.js' 2>/dev/null || true
  for i in 1 2 3 4 5; do
    ss -ulnp | grep -q ':9999' || break
    sleep 1
  done
  nohup node scraper/udp-tracker.js > tracker.log 2>&1 &
  echo "  ✓ udp-tracker.js restarted (PID $!)"

  # Check cloudflared — if it's not running, start it
  if ! pgrep -f 'cloudflared tunnel' > /dev/null; then
    nohup cloudflared tunnel --url http://localhost:8080 > cloudflared.log 2>&1 &
    echo "  ✓ cloudflared restarted (PID $!)"
  else
    echo "  ✓ cloudflared already running"
  fi

  sleep 1
  echo ""
  echo "  Running processes:"
  ps aux | grep -E 'serve\.py|udp-tracker|cloudflared' | grep -v grep | awk '{printf "    PID %-6s %s %s %s\n", $2, $11, $12, $13}'
REMOTE

echo ""
ok "Deploy complete! 🚀"
echo ""

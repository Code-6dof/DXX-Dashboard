#!/bin/bash
# Test script for gamelog uploader
# Creates a fake gamelog and tests upload functionality

TEST_DIR="/tmp/dxx-uploader-test"
TEST_GAMELOG="$TEST_DIR/gamelog.txt"

echo "Setting up test environment..."

# Create test directory
mkdir -p "$TEST_DIR"

# Create a sample gamelog file
cat > "$TEST_GAMELOG" << 'EOF'
[2026-02-11 15:30:00] gameId=test-game-123, mission=level01.rdl
[2026-02-11 15:30:05] [You] playerName=TestPlayer spawn at (100, 200, 300)
[2026-02-11 15:30:15] TestPlayer [You] killed EnemyPlayer with Laser
[2026-02-11 15:30:25] You were killed by EnemyPlayer with Missile
[2026-02-11 15:30:35] TestPlayer [You] picked up Shield powerup
EOF

echo "Created test gamelog at: $TEST_GAMELOG"
echo ""
echo "Test gamelog contents:"
cat "$TEST_GAMELOG"
echo ""
echo ""
echo "Starting uploader with test gamelog..."
echo "Press Ctrl+C to stop"
echo ""

# Run uploader pointing to test file
node gamelog-uploader.js --gamelog "$TEST_GAMELOG" --player TestPlayer --server http://localhost:9998

# Cleanup on exit
trap "rm -rf $TEST_DIR" EXIT

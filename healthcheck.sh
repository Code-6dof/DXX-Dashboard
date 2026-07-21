#!/bin/bash
# Watchdog for dxx-server: systemd's Restart=always only fires when the
# process *exits*. It doesn't help when the process is alive but hung (the
# exact failure that took dxxtracker.com down with 502s on 2026-07-20 - a
# stalled client TLS handshake froze the single-threaded accept loop while
# the process itself kept running). This checks that the server actually
# answers a request, and restarts it if not.

URL="https://localhost:8443/api/games/meta"
TIMEOUT=10

if ! curl -sk -o /dev/null --max-time "$TIMEOUT" --fail "$URL"; then
    echo "$(date -Is) dxx-server health check failed, restarting" >> /root/DXX-Dashboard/healthcheck.log
    systemctl restart dxx-server
fi

#!/usr/bin/env bash
# Restart the local contract server on a fixed port, detached from this shell.
set -u
cd "$(dirname "$0")"
PID_FILE=.pid
if [ -f "$PID_FILE" ]; then kill "$(cat $PID_FILE)" 2>/dev/null || true; fi
# Also clear anything else holding the port.
for p in $(ss -ltnp 2>/dev/null | awk '/:8787 /{print $NF}' | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill "$p" 2>/dev/null || true; done
sleep 0.6
setsid node ./server.cjs > server.out 2>&1 < /dev/null &
echo $! > "$PID_FILE"
sleep 1.2
tail -1 server.out

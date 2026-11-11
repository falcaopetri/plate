#!/bin/sh
# What Plate.app runs (scripts/build-app.sh): starts the server if it isn't up, then opens it in Safari.
# PLATE_AUTOQUIT=1 makes the server stop itself once the last page closes (lib/autoquit.mjs).
cd "$(dirname "$0")/.." || exit 1
PORT="${PORT:-4173}"; URL="http://127.0.0.1:$PORT"
up() { curl -fs -o /dev/null --max-time 1 "$URL/api/ping"; }
if ! up; then
  PORT="$PORT" PLATE_AUTOQUIT=1 nohup sh scripts/start.sh >> "$HOME/Library/Logs/plate-app.log" 2>&1 < /dev/null &
  n=0; until up || [ $n -ge 40 ]; do sleep 0.25; n=$((n + 1)); done
fi
open -a Safari "$URL"

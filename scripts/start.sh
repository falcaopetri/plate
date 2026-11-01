#!/bin/sh
# Runs the server with .bin/node/bin/plate-node when it exists (a private copy of node + libnode, so the macOS firewall can allow
# incoming connections for Plate alone instead of for every node program; see README, `lan`). Else the node on PATH.
cd "$(dirname "$0")/.." || exit 1
if [ -x .bin/node/bin/plate-node ]; then exec .bin/node/bin/plate-node server.mjs; fi
exec node server.mjs

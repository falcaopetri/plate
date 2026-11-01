#!/bin/sh
# Makes .bin/node: a private copy of the node on PATH (+ the libnode dylib Homebrew's node needs), and prints the one-time command
# that lets the macOS firewall accept incoming connections for that copy only (for `lan: on`). Re-run after a node upgrade to refresh it.
cd "$(dirname "$0")/.." || exit 1
real=$(readlink -f "$(command -v node)") || exit 1
root=$(dirname "$(dirname "$real")")
mkdir -p .bin/node/bin .bin/node/lib
cp "$real" .bin/node/bin/plate-node
for d in "$root"/lib/libnode*.dylib; do [ -e "$d" ] && cp "$d" .bin/node/lib/; done
.bin/node/bin/plate-node -v >/dev/null || { echo "the copy does not run (missing libraries?)"; exit 1; }
bin="$PWD/.bin/node/bin/plate-node"
echo "Copied node $(.bin/node/bin/plate-node -v) to $bin"
echo "Run once (changes the firewall, so it is yours to run):"
echo "  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add \"$bin\" && sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp \"$bin\""
echo "Then restart Plate: npm start"

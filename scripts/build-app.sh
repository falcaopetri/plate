#!/bin/bash
# Builds Plate.app (Dock icon): starts the server when needed, opens Safari, and the server quits when the last page closes.
# Usage: scripts/build-app.sh [destination folder]   (default ~/Applications). Drag the app to the Dock once.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/Applications}"
NODE_DIR="$(dirname "$(command -v node)")"
LOG="$HOME/Library/Logs/plate-app.log"
mkdir -p "$DEST"; rm -rf "$DEST/Plate.app"
# the grouped redirect keeps "do shell script" from waiting on the background server
osacompile -o "$DEST/Plate.app" -e "do shell script \"{ PATH='$NODE_DIR':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin sh '$ROOT/scripts/app-launch.sh'; } >> '$LOG' 2>&1 < /dev/null\""
# icon from public/icon.svg (QuickLook rasterizes the SVG)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
qlmanage -t -s 1024 -o "$TMP" "$ROOT/public/icon.svg" >/dev/null 2>&1 || true
if [ -f "$TMP/icon.svg.png" ]; then
  SET="$TMP/i.iconset"; mkdir "$SET"
  for t in 16 32 128 256 512; do
    sips -z $t $t "$TMP/icon.svg.png" --out "$SET/icon_${t}x${t}.png" >/dev/null
    sips -z $((t*2)) $((t*2)) "$TMP/icon.svg.png" --out "$SET/icon_${t}x${t}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$DEST/Plate.app/Contents/Resources/applet.icns"
  rm -f "$DEST/Plate.app/Contents/Resources/Assets.car"
  plutil -remove CFBundleIconName "$DEST/Plate.app/Contents/Info.plist" 2>/dev/null || true
else echo "Could not rasterize the icon; the app keeps the default one."; fi
PLIST="$DEST/Plate.app/Contents/Info.plist"
plutil -insert CFBundleIdentifier -string "com.falcaopetri.plate" "$PLIST"
plutil -insert LSUIElement -bool true "$PLIST"
codesign --force --deep --sign - "$DEST/Plate.app" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST/Plate.app" 2>/dev/null || true
echo "Created $DEST/Plate.app (log: $LOG). Drag it to the Dock."

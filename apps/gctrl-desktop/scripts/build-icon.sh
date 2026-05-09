#!/usr/bin/env bash
# Regenerate build/icon.icns from build/icon.png using macOS-native sips + iconutil.
# Run from apps/gctrl-desktop/.
set -euo pipefail

SRC="build/icon.png"
OUT="build/icon.icns"

if [[ ! -f "$SRC" ]]; then
  echo "missing $SRC" >&2
  exit 1
fi

ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"

for s in 16 32 64 128 256 512 1024; do
  sips -z "$s" "$s" "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
done

cp "$ICONSET/icon_32x32.png"     "$ICONSET/icon_16x16@2x.png"
cp "$ICONSET/icon_64x64.png"     "$ICONSET/icon_32x32@2x.png"
cp "$ICONSET/icon_256x256.png"   "$ICONSET/icon_128x128@2x.png"
cp "$ICONSET/icon_512x512.png"   "$ICONSET/icon_256x256@2x.png"
cp "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"
rm "$ICONSET/icon_64x64.png" "$ICONSET/icon_1024x1024.png"

iconutil -c icns "$ICONSET" -o "$OUT"
echo "wrote $OUT"

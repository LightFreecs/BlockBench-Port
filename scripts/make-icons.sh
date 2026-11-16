#!/usr/bin/env bash
# Regenerates the iOS app icon + launch splash from blockbench/icon.png (ImageMagick 6 `convert`).
#   AppIcon: full-bleed opaque 1024x1024 — the white bench on the Blockbench blue, a fresh long
#            shadow, orange "touch" badge (tap ripple) bottom-right.
#   Splash:  2732x2732, app background #1e2127, round logo + badge centred (storyboard uses
#            scaleAspectFill, so only the centre is guaranteed visible).
# Usage: scripts/make-icons.sh   (writes into ios/App/App/Assets.xcassets and docs/brand)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
cp "$root/blockbench/icon.png" icon.png

# bench mask = bright + opaque pixels of the round icon
convert icon.png -alpha extract a.png
convert icon.png -alpha off -colorspace gray -threshold 88% g.png
convert a.png g.png -compose multiply -composite -morphology Erode Disk:0.5 mask.png
convert icon.png mask.png -alpha off -compose copyopacity -composite bench.png
# 80 % size, centred
convert mask.png -resize 80% -background black -gravity center -extent 1024x1024 m2.png
convert bench.png -resize 80% -background none -gravity center -extent 1024x1024 b2.png
# long shadow: smear the mask towards the bottom right
args=(); for i in $(seq 0 6 760); do args+=(-page "+$i+$i" m2.png); done
convert -size 1024x1024 xc:black "${args[@]}" -background black -compose lighten -layers flatten s2.png
convert -size 1024x1024 gradient:'#1c96dc-#1283c6' bg.png
convert bg.png \( -size 1024x1024 xc:'#0b6aa6' s2.png -alpha off -compose copyopacity -composite -channel A -evaluate multiply 0.55 +channel \) \
	-compose over -composite b2.png -compose over -composite nobadge.png
convert nobadge.png \
	-fill 'rgba(0,0,0,0.25)' -draw "circle 806,814 806,688" \
	-fill '#ff9f1a' -stroke white -strokewidth 14 -draw "circle 800,800 800,682" \
	-fill none -stroke white -strokewidth 16 -draw "circle 800,800 800,736" \
	-fill white -stroke none -draw "circle 800,800 800,770" \
	-alpha off -depth 8 -strip AppIcon.png

convert -size 2732x2732 xc:'#1e2127' \( icon.png -resize 560x560 \) -gravity center -geometry +0-60 -compose over -composite \
	\( -size 2732x2732 xc:none -fill '#ff9f1a' -stroke white -strokewidth 10 -draw "circle 1556,1566 1556,1486" \
	   -fill none -stroke white -strokewidth 11 -draw "circle 1556,1566 1556,1526" -fill white -stroke none -draw "circle 1556,1566 1556,1546" \) \
	-compose over -composite -alpha off -depth 8 -strip splash.png

A="$root/ios/App/App/Assets.xcassets"
cp AppIcon.png "$A/AppIcon.appiconset/AppIcon-512@2x.png"
for f in splash-2732x2732.png splash-2732x2732-1.png splash-2732x2732-2.png; do cp splash.png "$A/Splash.imageset/$f"; done
mkdir -p "$root/docs/brand"
cp AppIcon.png "$root/docs/brand/app-icon.png"
convert splash.png -crop 1000x1000+866+866 -resize 500x500 "$root/docs/brand/splash-center.png"
echo "icons written"

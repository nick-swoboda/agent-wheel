#!/bin/zsh
# Build wheel.icns from the repo's 1024px icon. Usage: make-icns.sh OUTPUT_ICNS
set -euo pipefail

repo_dir=${0:A:h:h:h}
src_png="$repo_dir/wheel-icon-1024.png"
output=${1:?usage: make-icns.sh OUTPUT_ICNS}

if [[ ! -f "$src_png" ]]; then
  print -u2 "missing $src_png"
  exit 1
fi

iconset=$(mktemp -d "${TMPDIR:-/private/tmp}/wheel-icns.XXXXXX")/wheel.iconset
mkdir -p "$iconset"
trap 'rm -rf "${iconset:h}"' EXIT

for size in 16 32 128 256 512; do
  sips -z $size $size "$src_png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$src_png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$iconset" -o "$output"
print "icns written: $output"

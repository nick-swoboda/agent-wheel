#!/bin/zsh
set -euo pipefail

repo_dir=${0:A:h:h}
app_dir="$repo_dir/app/Convobus.app"
plist="$app_dir/Contents/Info.plist"

if (( $# != 1 )); then
  print -u2 "usage: create-dmg.sh OUTPUT_DMG"
  exit 2
fi

output_dmg=${1:A}
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")
staging_dir=$(mktemp -d "${TMPDIR:-/private/tmp}/convobus-dmg.XXXXXX")

cleanup() {
  rm -rf "$staging_dir"
}
trap cleanup EXIT

ditto --norsrc --noextattr --noqtn --noacl "$app_dir" "$staging_dir/Convobus.app"
ln -s /Applications "$staging_dir/Applications"

hdiutil create \
  -volname "Convobus $version" \
  -srcfolder "$staging_dir" \
  -format UDZO \
  -ov \
  "$output_dmg"

if ! hdiutil verify "$output_dmg"; then
  attached_device=$(hdiutil info | /usr/bin/awk -v image="$output_dmg" '
    index($0, "image-path") && index($0, image) { found = 1; next }
    found && $1 ~ /^\/dev\/disk/ { print $1; exit }
  ')
  if [[ -n "$attached_device" ]]; then
    hdiutil detach "$attached_device"
  fi
  /bin/sleep 1
  hdiutil verify "$output_dmg"
fi

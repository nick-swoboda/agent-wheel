#!/bin/zsh
# Wrap Agent Wheel.app in a compressed DMG with a volume icon and a short read-me.
# Usage: create-dmg.sh APP_PATH OUTPUT_DMG [ICNS]
set -euo pipefail

app=${1:?usage: create-dmg.sh APP_PATH OUTPUT_DMG [ICNS]}
output_dmg=${2:?usage: create-dmg.sh APP_PATH OUTPUT_DMG [ICNS]}
icns=${3:-}

version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
volname="Agent Wheel $version"

staging=$(mktemp -d "${TMPDIR:-/private/tmp}/agentwheel-dmg.XXXXXX")
rw_dmg="$staging.rw.dmg"
cleanup() { rm -rf "$staging" "$rw_dmg"; }
trap cleanup EXIT

ditto --norsrc --noextattr --noqtn --noacl "$app" "$staging/Agent Wheel.app"
ln -s /Applications "$staging/Applications"
cat > "$staging/Read Me.txt" <<TXT
Agent Wheel $version
====================

1. Drag "Agent Wheel.app" into Applications.
2. Self-contained: the app bundles its own Node.js runtime and supports
   macOS 13 or newer on Apple silicon. Nothing to install.
3. This build is ad-hoc signed and not notarized: on first launch,
   allow it via System Settings -> Privacy & Security -> Open Anyway.
   Because the ad-hoc identity changes with every build, Accessibility
   and Keychain access re-prompt after each rebuild.

Agent Wheel runs as a menu bar item with one window. Closing the window
keeps it running; choose Quit Agent Wheel from the menu bar item to stop.
Local state lives in ~/Library/Application Support/Agent Wheel.
TXT

if [[ -n "$icns" && -f "$icns" ]]; then
  cp "$icns" "$staging/.VolumeIcon.icns"
fi

# Build read-write first so the volume-icon bit can be set, then compress.
hdiutil create -volname "$volname" -srcfolder "$staging" -noanyowners -nospotlight -format UDRW -ov "$rw_dmg" >/dev/null

if [[ -n "$icns" && -f "$icns" ]]; then
  mount_point=$(mktemp -d "${TMPDIR:-/private/tmp}/agentwheel-mnt.XXXXXX")
  hdiutil attach "$rw_dmg" -mountpoint "$mount_point" -nobrowse -quiet
  SetFile -a C "$mount_point" || true
  hdiutil detach "$mount_point" -quiet
  rmdir "$mount_point" 2>/dev/null || true
fi

rm -f "$output_dmg"
hdiutil convert "$rw_dmg" -format ULMO -o "$output_dmg" >/dev/null   # LZMA: a third smaller than zlib; macOS 10.15+
hdiutil verify "$output_dmg" >/dev/null

print "dmg written: $output_dmg"

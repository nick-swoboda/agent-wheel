#!/bin/zsh
# Usage: build-app.sh OUTPUT_DIR
set -euo pipefail

script_dir=${0:A:h}
app_src=${script_dir:h}
repo_dir=${app_src:h}
law="$repo_dir/Agent-Wheel-ascii-diagram.txt"
convobus_src="$repo_dir/Convobus/convobus-0.2.0-source"
out_dir=${1:?usage: build-app.sh OUTPUT_DIR}
version=$(node -p "require('$app_src/package.json').version")

if [[ ! -f "$law" ]]; then
  print -u2 "build: the law is missing at $law"
  exit 1
fi

app="$out_dir/Agent Wheel.app"
contents="$app/Contents"
payload="$contents/Resources/payload"

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources" "$payload"

cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleName</key><string>Agent Wheel</string>
  <key>CFBundleDisplayName</key><string>Agent Wheel</string>
  <key>CFBundleIdentifier</key><string>local.agentwheel</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>AgentWheel</string>
  <key>CFBundleIconFile</key><string>wheel</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSExceptionDomains</key>
    <dict>
      <key>127.0.0.1</key>
      <dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
    </dict>
  </dict>
  <key>NSAccessibilityUsageDescription</key>
  <string>Agent Wheel delivers a card to a provider app through its accessibility roles on an ax route and reads the reply back.</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>Agent Wheel delivers a card to a provider app through its scripting dictionary on an applescript route and reads the reply back.</string>
</dict>
</plist>
PLIST

native_dir=$(mktemp -d "${TMPDIR:-/private/tmp}/agentwheel-native.XXXXXX")
runtime_slices=$(mktemp -d "${TMPDIR:-/private/tmp}/agentwheel-slices.XXXXXX")
trap 'rm -rf "$native_dir" "$runtime_slices"' EXIT
"$script_dir/build-native-app.sh" "$native_dir"
install -m 755 "$native_dir/AgentWheel" "$contents/MacOS/AgentWheel"
install -m 755 "$native_dir/ax-helper" "$contents/MacOS/ax-helper"

"$script_dir/make-icns.sh" "$contents/Resources/wheel.icns"

node - "$repo_dir" "$payload" <<'JS'
const path = require('node:path');
const root = process.argv[2];
const { copyFiles } = require(path.join(root, 'agentwheel/scripts/release-source'));
const { app } = require(path.join(root, 'agentwheel/scripts/release-files.json'));
copyFiles(root, process.argv[3], app);
JS
cp "$repo_dir/wheel-icon.svg" "$payload/"

core_dir="$payload/Convobus/convobus-0.2.0-source"
mkdir -p "$core_dir/lib/methods" "$core_dir/lib/jxa"
core_files=(
  card.js providers.js provider-catalog.json seats.js turn.js control.js store.js
  methods/stdio.js methods/ax.js methods/applescript.js methods/filewins.js methods/cursor-cdp.js
  jxa/ax.js
)
core_dependencies=(catalog.js check.js graph.js)   # required at load by seats.js, turn.js, control.js
for f in "${core_files[@]}" "${core_dependencies[@]}"; do
  install -m 644 "$convobus_src/lib/$f" "$core_dir/lib/$f"
done
install -m 644 "$convobus_src/LICENSE" "$core_dir/LICENSE"
install -m 644 "$convobus_src/THIRD_PARTY_NOTICES.md" "$core_dir/THIRD_PARTY_NOTICES.md"
install -m 644 "$convobus_src/package.json" "$core_dir/package.json"
for never in gui.js gui-main.js cli.js loops.js loop-ui.swift app-main.swift app-entry.swift \
             native-models.swift bundle-helper.js via-app.js resolver-worker.js; do
  if [[ -e "$core_dir/lib/$never" ]]; then
    print -u2 "build: never-packaged Convobus file present: $never"
    exit 1
  fi
done

cp "$repo_dir/LICENSE" "$repo_dir/THIRD_PARTY_NOTICES.md" "$payload/"

runtime_dir="$contents/Resources/runtime/bin"
"$script_dir/fetch-node-runtime.sh" "$runtime_slices"
mkdir -p "$runtime_dir"
install -m 755 "$runtime_slices/node-arm64" "$runtime_dir/node"
lipo "$runtime_dir/node" -verify_arch arm64
cp "$runtime_slices/Node-LICENSE.txt" "$contents/Resources/runtime/Node-LICENSE.txt"
"$runtime_dir/node" -p 'process.versions.node' > "$contents/Resources/runtime/VERSION.txt"
# Keep exported symbols; sign again after stripping local symbols.
/usr/bin/strip -x "$runtime_dir/node"
codesign --force --sign - "$runtime_dir/node"
codesign --verify --strict "$runtime_dir/node"

if grep -rIl --exclude-dir=runtime -e 'open http://' -e 'open https://' "$app" >/dev/null 2>&1; then
  print -u2 "build: a browser hand-off string is present in the bundle:"
  grep -rIl --exclude-dir=runtime -e 'open http://' -e 'open https://' "$app" >&2
  exit 1
fi

/usr/bin/strip -x "$contents/MacOS/AgentWheel" "$contents/MacOS/ax-helper"
codesign --force --sign - "$contents/MacOS/ax-helper"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
node "$script_dir/audit-release.js" "$app"

print "app built: $app (version $version, arm64, self-contained Node.js $(cat "$contents/Resources/runtime/VERSION.txt"))"

#!/bin/zsh
set -euo pipefail

repo_dir=${0:A:h:h}
published_app="$repo_dir/app/Convobus.app"
module_cache="${TMPDIR:-/private/tmp}/convobus-swift-cache"
build_dir=$(mktemp -d "${TMPDIR:-/private/tmp}/convobus-native-build.XXXXXX")
runtime_slices=$(mktemp -d "${TMPDIR:-/private/tmp}/convobus-runtime-slices.XXXXXX")
stage_root=$(mktemp -d "$repo_dir/app/.convobus-stage.XXXXXX")
stage_app="$stage_root/Convobus.app"
backup_app="$repo_dir/app/.Convobus.app.previous.$$"

cleanup() {
  rm -rf "$build_dir" "$runtime_slices" "$stage_root"
  if [[ -e "$backup_app" && ! -e "$published_app" ]]; then
    mv "$backup_app" "$published_app"
  elif [[ -e "$backup_app" ]]; then
    rm -rf "$backup_app"
  fi
}
trap cleanup EXIT

if [[ "$published_app" != "$repo_dir/app/Convobus.app" || ! -f "$published_app/Contents/Info.plist" ]]; then
  print -u2 "build: source bundle skeleton is missing"
  exit 1
fi

mkdir -p \
  "$stage_app/Contents/MacOS" \
  "$stage_app/Contents/Resources/Backend/lib/methods" \
  "$stage_app/Contents/Resources/Backend/lib/jxa" \
  "$stage_app/Contents/Resources/Runtime" \
  "$module_cache"

install -m 644 "$published_app/Contents/Info.plist" "$stage_app/Contents/Info.plist"
for resource in ConvobusIcon.icns ConvobusIcon.png ConvobusMenuTemplate.png; do
  install -m 644 "$published_app/Contents/Resources/$resource" "$stage_app/Contents/Resources/$resource"
done
install -m 644 "$repo_dir/lib/provider-catalog.json" "$stage_app/Contents/Resources/provider-catalog.json"
install -m 644 "$repo_dir/LICENSE" "$stage_app/Contents/Resources/LICENSE.txt"
install -m 644 "$repo_dir/THIRD_PARTY_NOTICES.md" "$stage_app/Contents/Resources/THIRD_PARTY_NOTICES.md"

backend_dir="$stage_app/Contents/Resources/Backend"
runtime_dir="$stage_app/Contents/Resources/Runtime"
install -m 755 "$repo_dir/convobus" "$backend_dir/convobus"
install -m 644 "$repo_dir/package.json" "$backend_dir/package.json"
backend_sources=(
  bundle-helper.js
  card.js
  catalog.js
  check.js
  cli.js
  control.js
  graph.js
  gui-main.js
  gui.js
  loops.js
  provider-catalog.json
  providers.js
  resolver-worker.js
  seats.js
  store.js
  turn.js
  via-app.js
  jxa/ax.js
  methods/applescript.js
  methods/ax.js
  methods/cursor-cdp.js
  methods/filewins.js
  methods/stdio.js
)
for relative_path in "${backend_sources[@]}"; do
  source_file="$repo_dir/lib/$relative_path"
  mkdir -p "$backend_dir/lib/${relative_path:h}"
  install -m 644 "$source_file" "$backend_dir/lib/$relative_path"
done

compile_arch() {
  local arch=$1
  local target="$arch-apple-macosx13.0"
  local arch_dir="$build_dir/$arch"
  mkdir -p "$arch_dir"

  xcrun swiftc \
    -module-cache-path "$module_cache" \
    -target "$target" \
    -parse-as-library \
    -O \
    -framework AppKit \
    -framework ApplicationServices \
    "$repo_dir/lib/native-models.swift" \
    "$repo_dir/lib/app-main.swift" \
    "$repo_dir/lib/loop-ui.swift" \
    "$repo_dir/lib/ax-helper.swift" \
    "$repo_dir/lib/app-entry.swift" \
    -o "$arch_dir/Convobus"

  xcrun swiftc \
    -module-cache-path "$module_cache" \
    -target "$target" \
    -parse-as-library \
    -O \
    -framework AppKit \
    -framework ApplicationServices \
    "$repo_dir/lib/ax-helper.swift" \
    "$repo_dir/lib/ax-helper-main.swift" \
    -o "$arch_dir/ax-helper"
}

compile_arch arm64
compile_arch x86_64

lipo -create "$build_dir/arm64/Convobus" "$build_dir/x86_64/Convobus" \
  -output "$stage_app/Contents/MacOS/Convobus"
lipo -create "$build_dir/arm64/ax-helper" "$build_dir/x86_64/ax-helper" \
  -output "$stage_app/Contents/MacOS/ax-helper"

"$repo_dir/scripts/fetch-node-runtime.sh" "$runtime_slices"
lipo -create "$runtime_slices/node-arm64" "$runtime_slices/node-x64" -output "$runtime_dir/node"
chmod 755 "$runtime_dir/node"
install -m 644 "$runtime_slices/Node-LICENSE.txt" "$runtime_dir/Node-LICENSE.txt"
print "Node.js 22.23.2 LTS (official macOS arm64 + x64 binaries)" > "$runtime_dir/VERSION.txt"

version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$stage_app/Contents/Info.plist")
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$stage_app/Contents/Info.plist")
backend_hash=$(
  find "$backend_dir" -type f -print |
    sort |
    xargs shasum -a 256 |
    shasum -a 256 |
    awk '{print $1}'
)
protocol_file="$stage_app/Contents/Resources/ConvobusProtocol.json"
protocol_plist="$build_dir/ConvobusProtocol.plist"
/usr/bin/plutil -create xml1 "$protocol_plist"
/usr/bin/plutil -insert protocolVersion -integer 3 "$protocol_plist"
/usr/bin/plutil -insert version -string "$version" "$protocol_plist"
/usr/bin/plutil -insert build -string "$build" "$protocol_plist"
/usr/bin/plutil -insert backendHash -string "$backend_hash" "$protocol_plist"
/usr/bin/plutil -convert json -o "$protocol_file" "$protocol_plist"
chmod 644 "$protocol_file"

lipo "$runtime_dir/node" -verify_arch arm64 x86_64
lipo "$stage_app/Contents/MacOS/Convobus" -verify_arch arm64 x86_64
lipo "$stage_app/Contents/MacOS/ax-helper" -verify_arch arm64 x86_64
codesign --force --sign - "$runtime_dir/node"
codesign --verify --strict --verbose=2 "$runtime_dir/node"
codesign --force --deep --sign - "$stage_app"
codesign --verify --deep --strict --verbose=2 "$stage_app"

mv "$published_app" "$backup_app"
mv "$stage_app" "$published_app"
codesign --verify --deep --strict --verbose=2 "$published_app"
rm -rf "$backup_app"

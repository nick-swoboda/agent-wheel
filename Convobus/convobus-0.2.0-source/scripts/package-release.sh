#!/bin/zsh
set -euo pipefail

repo_dir=${0:A:h:h}
app_dir="$repo_dir/app/Convobus.app"
plist="$app_dir/Contents/Info.plist"

version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")
package_version=$(/usr/bin/plutil -extract version raw "$repo_dir/package.json")
if [[ "$version" != "$package_version" ]]; then
  print -u2 "release: app version $version does not match package version $package_version"
  exit 1
fi

release_dir="$repo_dir/release/v$version"
source_name="convobus-$version-source"
source_dir="$release_dir/$source_name"
app_archive="$release_dir/Convobus-$version-macOS-universal.dmg"
source_archive="$release_dir/$source_name.zip"

if [[ -e "$release_dir" ]]; then
  print -u2 "release: $release_dir already exists; move it aside before packaging again"
  exit 1
fi

if [[ -n "${CONVO_TESTED_APP_SHA256:-}" ]]; then
  actual_app_sha=$(
    shasum -a 256 "$app_dir/Contents/MacOS/Convobus" | awk '{print $1}'
  )
  if [[ "$actual_app_sha" != "$CONVO_TESTED_APP_SHA256" ]]; then
    print -u2 "release: tested app hash does not match the current bundle"
    exit 1
  fi
  codesign --verify --deep --strict "$app_dir"
else
  "$repo_dir/scripts/test.sh"
fi

mkdir -p "$release_dir/website" "$source_dir"

rsync -a \
  --exclude '/.git/' \
  --exclude '/.convobus/' \
  --exclude '.DS_Store' \
  --exclude '/release/' \
  --exclude '/Convobus-*-release-*/' \
  --exclude '/node_modules/' \
  --exclude '/test/.tmp/' \
  --exclude '/app/Convobus.app/Contents/MacOS/' \
  --exclude '/app/Convobus.app/Contents/_CodeSignature/' \
  --exclude '/app/Convobus.app/Contents/Resources/Backend/' \
  --exclude '/app/Convobus.app/Contents/Resources/Runtime/' \
  --exclude '/app/Convobus.app/Contents/Resources/ConvobusProtocol.json' \
  --exclude '/app/Convobus.app/Contents/Resources/provider-catalog.json' \
  "$repo_dir/" "$source_dir/"

ditto --norsrc --noextattr --noqtn --noacl \
  "$app_dir" "$release_dir/website/Convobus.app"
"$repo_dir/scripts/create-dmg.sh" "$app_archive"
ditto -c -k --norsrc --noextattr --noqtn --noacl --keepParent \
  "$source_dir" "$source_archive"
install -m 644 "$repo_dir/docs/releases/v$version.md" "$release_dir/RELEASE_NOTES.md"

(
  cd "$release_dir"
  shasum -a 256 "${app_archive:t}" "${source_archive:t}" > SHA256SUMS.txt
)

print "Release created at $release_dir"

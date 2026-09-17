#!/bin/zsh
# Verify the release set (law, DONE / FINAL PRODUCT and A12): recompute every hash, compare
# tag = app_version = manifest, check what the DMG and the source zip contain, and exit 0 only when
# all agree. Usage: verify-release.sh [RELEASE_DIR]   (default: <repo>/release)
set -uo pipefail

script_dir=${0:A:h}
repo_dir=${script_dir:h:h}
# ${:A} resolves a relative argument against the caller's cwd.
release_dir=${${1:-$repo_dir/release}:A}
manifest="$release_dir/RELEASE_MANIFEST.json"

fail=0
check() {                       # check LABEL ACTUAL EXPECTED
  if [[ "$2" == "$3" ]]; then print "ok    $1: $2"
  else print "FAIL  $1: got '$2', expected '$3'"; fail=1; fi
}
present() {                     # present LABEL PATH
  if [[ -e "$2" ]]; then print "ok    $1 present"
  else print "FAIL  $1 missing: $2"; fail=1; fi
}
sha() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }

[[ -f "$manifest" ]] || { print -u2 "FAIL  no manifest at $manifest"; exit 1; }
field() { node -p "const m = require('$manifest'); m.$1 === undefined ? '' : String(m.$1)"; }

app_version=$(field app_version)
tag=$(field tag)
commit=$(field commit)
dmg_sha=$(field dmg_sha256)
zip_sha=$(field source_zip_sha256)
node_version=$(field node_version)
node_sha=$(field node_sha256)
convobus_upstream=$(field convobus_upstream_version)
convobus_adapter=$(field convobus_adapter_version)
built_at=$(field built_at)

print "== manifest: $manifest"
for f in tag commit app_version dmg_sha256 source_zip_sha256 node_version node_sha256 convobus_upstream_version convobus_adapter_version built_at; do
  v=$(field "$f")
  if [[ -z "$v" ]]; then print "FAIL  manifest field empty: $f"; fail=1; fi
done
check "manifest has exactly the ten law fields" \
  "$(node -p "Object.keys(require('$manifest')).sort().join(',')")" \
  "app_version,built_at,commit,convobus_adapter_version,convobus_upstream_version,dmg_sha256,node_sha256,node_version,source_zip_sha256,tag"

print "== the exact release set"
dmg="$release_dir/Agent-Wheel-$app_version-macOS-arm64.dmg"
zip="$release_dir/agent-wheel-$app_version-source.zip"
present "Agent-Wheel-$app_version-macOS-arm64.dmg" "$dmg"
present "agent-wheel-$app_version-source.zip" "$zip"
present "SHA256SUMS.txt" "$release_dir/SHA256SUMS.txt"
present "RELEASE_NOTES.md" "$release_dir/RELEASE_NOTES.md"
present "RELEASE_MANIFEST.json" "$manifest"
stray=$(ls -A "$release_dir" | grep -v -x -e "Agent-Wheel-$app_version-macOS-arm64.dmg" \
  -e "agent-wheel-$app_version-source.zip" -e SHA256SUMS.txt -e RELEASE_NOTES.md -e RELEASE_MANIFEST.json || true)
if [[ -z "$stray" ]]; then print "ok    nothing beside the five release assets"
else print "FAIL  stray entries in $release_dir: ${stray//$'\n'/ }"; fail=1; fi

print "== hashes recomputed"
[[ -f "$dmg" ]] && check "dmg sha256 = manifest.dmg_sha256" "$(sha "$dmg")" "$dmg_sha"
[[ -f "$zip" ]] && check "source zip sha256 = manifest.source_zip_sha256" "$(sha "$zip")" "$zip_sha"
if [[ -f "$release_dir/SHA256SUMS.txt" ]]; then
  check "SHA256SUMS.txt lines" "$(grep -c . "$release_dir/SHA256SUMS.txt")" "2"
  check "SHA256SUMS.txt dmg line" "$(grep " ${dmg:t}\$" "$release_dir/SHA256SUMS.txt" | /usr/bin/awk '{print $1}')" "$dmg_sha"
  check "SHA256SUMS.txt zip line" "$(grep " ${zip:t}\$" "$release_dir/SHA256SUMS.txt" | /usr/bin/awk '{print $1}')" "$zip_sha"
  if (cd "$release_dir" && /usr/bin/shasum -a 256 -c SHA256SUMS.txt --status); then print "ok    shasum -c SHA256SUMS.txt"
  else print "FAIL  shasum -c SHA256SUMS.txt"; fail=1; fi
fi

print "== tag = app_version = manifest"
check "tag name" "$tag" "v$app_version"
check "package.json version at HEAD" "$(node -p "require('$repo_dir/agentwheel/package.json').version")" "$app_version"
tag_commit=$(git -C "$repo_dir" rev-list -n 1 "$tag" 2>/dev/null || true)
if [[ -n "$tag_commit" ]]; then
  check "tag $tag commit = manifest.commit" "$tag_commit" "$commit"
  check "package.json version at the tag" \
    "$(git -C "$repo_dir" show "${tag}:agentwheel/package.json" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")" "$app_version"
  check "convobus_adapter_version = ADAPTER_VERSION at the tag" \
    "$(git -C "$repo_dir" show "${tag}:agentwheel/lib/transport/index.js" | grep -o "ADAPTER_VERSION = '[^']*'" | cut -d"'" -f2)" "$convobus_adapter"
  check "convobus_upstream_version = CONVOBUS_UPSTREAM_VERSION at the tag" \
    "$(git -C "$repo_dir" show "${tag}:agentwheel/lib/transport/index.js" | grep -o "CONVOBUS_UPSTREAM_VERSION = '[^']*'" | cut -d"'" -f2)" "$convobus_upstream"
fi
if [[ -z "$tag_commit" ]]; then print "info  no local tag; checking the public source snapshot below"; fi
check "built_at is an ISO-8601 UTC instant" "$(node -p "/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z\$/.test('$built_at') && !isNaN(Date.parse('$built_at'))")" "true"

print "== inside the DMG"
if [[ -f "$dmg" ]]; then
  mount=$(mktemp -d "${TMPDIR:-/private/tmp}/agentwheel-verify.XXXXXX")
  if hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly -quiet; then
    app="$mount/Agent Wheel.app"
    contents="$app/Contents"
    present "Agent Wheel.app" "$app"
    check "Info.plist CFBundleShortVersionString" "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$contents/Info.plist" 2>/dev/null)" "$app_version"
    check "Info.plist CFBundleVersion" "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$contents/Info.plist" 2>/dev/null)" "$app_version"
    check "Info.plist LSMinimumSystemVersion" "$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$contents/Info.plist" 2>/dev/null)" "13.0"
    check "payload package.json version" "$(node -p "require('$contents/Resources/payload/agentwheel/package.json').version" 2>/dev/null)" "$app_version"
    check "bundled node version (VERSION.txt)" "$(cat "$contents/Resources/runtime/VERSION.txt" 2>/dev/null)" "$node_version"
    check "bundled node sha256 = manifest.node_sha256" "$(sha "$contents/Resources/runtime/bin/node")" "$node_sha"
    check "bundled node is arm64 only" "$(lipo -archs "$contents/Resources/runtime/bin/node" 2>/dev/null | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')" "arm64"
    check "app binary is arm64 only" "$(lipo -archs "$contents/MacOS/AgentWheel" 2>/dev/null | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')" "arm64"
    check "ax-helper is arm64 only" "$(lipo -archs "$contents/MacOS/ax-helper" 2>/dev/null | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')" "arm64"
    core_dir="$contents/Resources/payload/Convobus/convobus-0.2.0-source"
    check "convobus core package version" "$(node -p "require('$core_dir/package.json').version" 2>/dev/null)" "$convobus_upstream"
    never_found=""
    for never in gui.js gui-main.js cli.js loops.js loop-ui.swift app-main.swift app-entry.swift native-models.swift bundle-helper.js via-app.js resolver-worker.js; do
      [[ -e "$core_dir/lib/$never" ]] && never_found="$never_found $never"
    done
    check "never-packaged Convobus files absent" "${never_found:-none}" "none"
    for f in card.js providers.js provider-catalog.json seats.js turn.js control.js store.js methods/stdio.js methods/ax.js methods/applescript.js methods/filewins.js methods/cursor-cdp.js jxa/ax.js catalog.js check.js graph.js LICENSE THIRD_PARTY_NOTICES.md; do
      [[ -e "$core_dir/lib/$f" || -e "$core_dir/$f" ]] || { print "FAIL  core manifest file missing: $f"; fail=1; }
    done
    print "ok    CORE MANIFEST files present"
    handoff=$(grep -rIl --exclude-dir=runtime -e 'open http://' -e 'open https://' "$app" 2>/dev/null || true)
    check "no browser hand-off string in the bundle" "${handoff:-none}" "none"
    if codesign --verify --deep --strict "$app" 2>/dev/null; then print "ok    codesign --verify --deep --strict"
    else print "FAIL  codesign verification"; fail=1; fi
    for excluded in payload/agentwheel/test payload/agentwheel/evidence payload/agentwheel/native payload/agentwheel/scripts; do
      [[ -e "$contents/Resources/$excluded" ]] && { print "FAIL  bundle carries $excluded"; fail=1; }
    done
    print "ok    tests, evidence, native sources, and scripts are not in the bundle"
    signature=$(codesign -dvv "$app" 2>&1)
    check "no developer signing identity" "$(print -r -- "$signature" | grep -c '^Authority=' || true)" "0"
    check "ad-hoc signature" "$(print -r -- "$signature" | grep -c '^Signature=adhoc$' || true)" "1"
    if node "$script_dir/audit-release.js" "$app"; then print "ok    app privacy audit"
    else fail=1; fi
    hdiutil detach "$mount" -quiet || hdiutil detach "$mount" -force -quiet
  else
    print "FAIL  could not mount $dmg"; fail=1
  fi
  rmdir "$mount" 2>/dev/null || true
fi

print "== inside the source zip"
if [[ -f "$zip" ]]; then
  listing=$(unzip -Z1 "$zip")
  prefix="agent-wheel-$app_version/"
  for must in "Agent-Wheel-ascii-diagram.txt" "LICENSE" "THIRD_PARTY_NOTICES.md" "agentwheel/package.json" \
              "Convobus/convobus-0.2.0-source/LICENSE" "Convobus/convobus-0.2.0-source/THIRD_PARTY_NOTICES.md" \
              "Convobus/convobus-0.2.0-source/lib/loops.js" "agentwheel/scripts/verify-release.sh"; do
    if print -r -- "$listing" | grep -q -x "$prefix$must"; then print "ok    source zip has $must"
    else print "FAIL  source zip lacks $must"; fail=1; fi
  done
  check "source zip has no release/ or store/ entries" "$(print -r -- "$listing" | grep -c -e "^${prefix}release/" -e "^${prefix}agentwheel/store" || true)" "0"
  check "source snapshot commit = manifest.commit" "$(unzip -z "$zip" | tail -n 1)" "$commit"
  source_tmp=$(mktemp -d "${TMPDIR:-/private/tmp}/agentwheel-source-check.XXXXXX")
  if print -r -- "$listing" | node -e '
    let text = ""; process.stdin.on("data", c => text += c).on("end", () => {
      const prefix = process.argv[1];
      const names = text.trim().split("\n");
      process.exit(names.every(n => n.startsWith(prefix) && !n.includes("\\") && !n.split("/").includes("..")) ? 0 : 1);
    });' "$prefix" && unzip -q "$zip" -d "$source_tmp"; then
    source_root="$source_tmp/${prefix%/}"
    if node "$script_dir/audit-release.js" "$source_root" --source; then print "ok    source privacy and allowlist audit"
    else fail=1; fi
    check "archived package version" "$(node -p "require('$source_root/agentwheel/package.json').version")" "$app_version"
  else print "FAIL  unsafe or unreadable source archive"; fail=1; fi
  rm -rf "$source_tmp"
fi

if [[ $fail -eq 0 ]]; then print "\nverify-release: all agree (tag $tag = app_version $app_version = manifest; every hash recomputed)"; exit 0
else print "\nverify-release: FAILED"; exit 1; fi

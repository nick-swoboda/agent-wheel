#!/bin/zsh
set -euo pipefail

repo_dir=${0:A:h:h}
runtime="$repo_dir/app/Convobus.app/Contents/Resources/Runtime/node"
native_models=$(mktemp "${TMPDIR:-/private/tmp}/convobus-native-models.XXXXXX")
native_ui=$(mktemp "${TMPDIR:-/private/tmp}/convobus-native-ui.XXXXXX")
module_cache="${TMPDIR:-/private/tmp}/convobus-swift-test-cache"

cleanup() {
  rm -f "$native_models" "$native_ui"
}
trap cleanup EXIT

"$repo_dir/scripts/build-native-app.sh"

xcrun swiftc \
  -module-cache-path "$module_cache" \
  -target "$(uname -m)-apple-macosx13.0" \
  -parse-as-library \
  "$repo_dir/lib/native-models.swift" \
  "$repo_dir/test/native-models-main.swift" \
  -o "$native_models"
"$native_models"

xcrun swiftc \
  -module-cache-path "$module_cache" \
  -target "$(uname -m)-apple-macosx13.0" \
  -parse-as-library \
  -framework AppKit \
  -framework ApplicationServices \
  "$repo_dir/lib/native-models.swift" \
  "$repo_dir/lib/app-main.swift" \
  "$repo_dir/lib/loop-ui.swift" \
  "$repo_dir/lib/ax-helper.swift" \
  "$repo_dir/test/native-ui-main.swift" \
  -o "$native_ui"
CONVO_UI_TEST=1 "$native_ui" "$repo_dir/lib/provider-catalog.json"

"$runtime" --test --test-timeout=60000 "$repo_dir"/test/*.test.js

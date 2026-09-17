#!/bin/zsh
# Compile the Agent Wheel native shell and the Convobus ax-helper with swiftc for Apple Silicon (arm64),
# macOS 13 deployment target.
# Usage: build-native-app.sh OUTPUT_DIR   -> OUTPUT_DIR/AgentWheel and OUTPUT_DIR/ax-helper
set -euo pipefail

script_dir=${0:A:h}
app_dir=${script_dir:h}
repo_dir=${app_dir:h}
convobus_lib="$repo_dir/Convobus/convobus-0.2.0-source/lib"
out_dir=${1:?usage: build-native-app.sh OUTPUT_DIR}
module_cache="${TMPDIR:-/private/tmp}/agentwheel-swift-cache"
build_dir=$(mktemp -d "${TMPDIR:-/private/tmp}/agentwheel-native-build.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT
mkdir -p "$out_dir" "$module_cache"

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
    -file-prefix-map "$repo_dir=/AgentWheelSource" \
    -debug-prefix-map "$repo_dir=/AgentWheelSource" \
    -framework AppKit \
    -framework WebKit \
    -framework Security \
    -framework ApplicationServices \
    "$app_dir/native/app-main.swift" \
    "$app_dir/native/app-entry.swift" \
    -o "$arch_dir/AgentWheel"

  xcrun swiftc \
    -module-cache-path "$module_cache" \
    -target "$target" \
    -parse-as-library \
    -O \
    -file-prefix-map "$repo_dir=/AgentWheelSource" \
    -debug-prefix-map "$repo_dir=/AgentWheelSource" \
    -framework AppKit \
    -framework ApplicationServices \
    "$convobus_lib/ax-helper.swift" \
    "$convobus_lib/ax-helper-main.swift" \
    -o "$arch_dir/ax-helper"
}

compile_arch arm64

install -m 755 "$build_dir/arm64/AgentWheel" "$out_dir/AgentWheel"
install -m 755 "$build_dir/arm64/ax-helper" "$out_dir/ax-helper"
lipo "$out_dir/AgentWheel" -verify_arch arm64
lipo "$out_dir/ax-helper" -verify_arch arm64
print "native binaries built in $out_dir (arm64, macOS 13.0 target)"

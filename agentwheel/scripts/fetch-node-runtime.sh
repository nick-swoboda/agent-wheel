#!/bin/zsh
# Fetch the official Node.js 26 macOS arm64 runtime for the self-contained app bundle: pinned version,
# pinned official SHA-256, https-only, cached, verified before use.
set -euo pipefail

node_version="26.8.1"
base_url="https://nodejs.org/dist/v$node_version"
arm64_archive="node-v$node_version-darwin-arm64.tar.xz"
arm64_sha256="b32047d86467497d3f59b8cf81f422c06938cf5f36ece2b36f6e7c024a0a3e5b"

if (( $# != 1 )); then
  print -u2 "usage: fetch-node-runtime.sh OUTPUT_DIRECTORY"
  exit 2
fi

output_dir=$1
cache_dir="${TMPDIR:-/private/tmp}/agentwheel-node-v$node_version-cache"
mkdir -p "$output_dir" "$cache_dir"

fetch_arch() {
  local arch=$1
  local archive_name=$2
  local expected_sha=$3
  local archive_path="$cache_dir/$archive_name"
  local partial_path="$cache_dir/$archive_name.download"
  local extract_dir

  if [[ ! -f "$archive_path" ]]; then
    /usr/bin/curl \
      --fail \
      --location \
      --proto '=https' \
      --tlsv1.2 \
      --output "$partial_path" \
      "$base_url/$archive_name"
    mv "$partial_path" "$archive_path"
  fi

  local actual_sha
  actual_sha=$(/usr/bin/shasum -a 256 "$archive_path" | /usr/bin/awk '{print $1}')
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    print -u2 "runtime: checksum mismatch for $archive_name"
    print -u2 "runtime: expected $expected_sha"
    print -u2 "runtime: received $actual_sha"
    exit 1
  fi

  extract_dir=$(mktemp -d "${TMPDIR:-/private/tmp}/agentwheel-node-$arch.XXXXXX")
  /usr/bin/tar -xJf "$archive_path" -C "$extract_dir"
  install -m 755 "$extract_dir/node-v$node_version-darwin-$arch/bin/node" "$output_dir/node-$arch"
  if [[ ! -f "$output_dir/Node-LICENSE.txt" ]]; then
    install -m 644 "$extract_dir/node-v$node_version-darwin-$arch/LICENSE" "$output_dir/Node-LICENSE.txt"
  else
    cmp "$extract_dir/node-v$node_version-darwin-$arch/LICENSE" "$output_dir/Node-LICENSE.txt"
  fi
  rm -rf "$extract_dir"
}

fetch_arch "arm64" "$arm64_archive" "$arm64_sha256"
print "Node.js v$node_version arm64 runtime is ready."

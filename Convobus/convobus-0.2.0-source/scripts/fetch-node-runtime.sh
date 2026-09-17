#!/bin/zsh
set -euo pipefail

node_version="22.23.2"
base_url="https://nodejs.org/download/release/v$node_version"
arm64_archive="node-v$node_version-darwin-arm64.tar.xz"
x64_archive="node-v$node_version-darwin-x64.tar.xz"
arm64_sha256="5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1"
x64_sha256="96dff79f4e19a78715da559ec7cac2028f4985a175ea0c3454625a269c21deb7"

if (( $# != 1 )); then
  print -u2 "usage: fetch-node-runtime.sh OUTPUT_DIRECTORY"
  exit 2
fi

output_dir=$1
cache_dir="${TMPDIR:-/private/tmp}/convobus-node-v$node_version-cache"
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

  extract_dir=$(mktemp -d "${TMPDIR:-/private/tmp}/convobus-node-$arch.XXXXXX")
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
fetch_arch "x64" "$x64_archive" "$x64_sha256"
print "Node.js v$node_version runtime slices are ready."

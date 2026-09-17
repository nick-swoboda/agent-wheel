#!/bin/zsh
# Build and verify the five public release assets. Use --snapshot for a private workspace.
set -euo pipefail

script_dir=${0:A:h}
repo_dir=${script_dir:h:h}
app_src="$repo_dir/agentwheel"
if [[ "${1:-}" == --snapshot ]]; then
  exec node "$script_dir/release-source.js" "${2:-$repo_dir/release}"
fi
version=$(node -p "require('$app_src/package.json').version")
tag="v$version"
release_dir=${${1:-$repo_dir/release}:A}
mkdir -p "$release_dir"
build_dir=$(mktemp -d "${TMPDIR:-/private/tmp}/agentwheel-release-build.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT

print "== source state =="
if [[ -n "$(git -C "$repo_dir" status --porcelain --untracked-files=no)" ]]; then
  print -u2 "the working tree has uncommitted changes; commit them first"
  exit 1
fi
commit=$(git -C "$repo_dir" rev-parse HEAD)
tag_commit=$(git -C "$repo_dir" rev-list -n 1 "$tag" 2>/dev/null || true)
if [[ -z "$tag_commit" ]]; then
  print -u2 "tag $tag does not exist; tag the commit to release first: git tag $tag"
  exit 1
fi
if [[ "$tag_commit" != "$commit" ]]; then
  print -u2 "tag $tag points at $tag_commit but HEAD is $commit"
  exit 1
fi
print "packaging $tag at $commit"

for entry in "$release_dir"/*(N); do
  case "${entry:t}" in
    "Agent-Wheel-$version-macOS-arm64.dmg"|"agent-wheel-$version-source.zip"|SHA256SUMS.txt|RELEASE_NOTES.md|RELEASE_MANIFEST.json) ;;
    *) print -u2 "output directory contains another release; choose an empty output directory"; exit 1 ;;
  esac
done

print "== tests (every runtime group on $(node --version)) =="
if ! (cd "$app_src" && node scripts/test-runtimes.js > "$build_dir/test-log.txt" 2>&1); then
  tail -40 "$build_dir/test-log.txt" >&2
  print -u2 "tests failed; not packaging"
  exit 1
fi
grep -E "^ℹ (tests|pass|fail)|^# (tests|pass|fail)" "$build_dir/test-log.txt" | tr '\n' ' '; print

print "== app bundle =="
"$script_dir/build-app.sh" "$build_dir"
app="$build_dir/Agent Wheel.app"

print "== dmg =="
dmg="$release_dir/Agent-Wheel-$version-macOS-arm64.dmg"
"$script_dir/create-dmg.sh" "$app" "$dmg" "$app/Contents/Resources/wheel.icns"

print "== source archive (git archive of $tag; full licensed Convobus source and notices included) =="
src_zip="$release_dir/agent-wheel-$version-source.zip"
source_files=("${(@f)$(node -p "require('$script_dir/release-files.json').source.join('\\n')")}")
git -C "$repo_dir" archive --format=zip -9 --prefix="agent-wheel-$version/" -o "$src_zip" "$tag" -- "${source_files[@]}"
print "source zip: $src_zip"

print "== checksums =="
(
  cd "$release_dir"
  : > SHA256SUMS.txt
  /usr/bin/shasum -a 256 "${dmg:t}" >> SHA256SUMS.txt
  /usr/bin/shasum -a 256 "${src_zip:t}" >> SHA256SUMS.txt
  cat SHA256SUMS.txt
)

print "== manifest =="
dmg_sha256=$(/usr/bin/shasum -a 256 "$dmg" | /usr/bin/awk '{print $1}')
source_zip_sha256=$(/usr/bin/shasum -a 256 "$src_zip" | /usr/bin/awk '{print $1}')
node_version=$(cat "$app/Contents/Resources/runtime/VERSION.txt")
node_sha256=$(/usr/bin/shasum -a 256 "$app/Contents/Resources/runtime/bin/node" | /usr/bin/awk '{print $1}')
convobus_upstream_version=$(grep -o "CONVOBUS_UPSTREAM_VERSION = '[^']*'" "$app_src/lib/transport/index.js" | cut -d"'" -f2)
convobus_adapter_version=$(grep -o "ADAPTER_VERSION = '[^']*'" "$app_src/lib/transport/index.js" | cut -d"'" -f2)
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node - "$release_dir/RELEASE_MANIFEST.json" <<EOF
const fs = require('fs');
const manifest = {
  tag: '$tag',
  commit: '$commit',
  app_version: '$version',
  dmg_sha256: '$dmg_sha256',
  source_zip_sha256: '$source_zip_sha256',
  node_version: '$node_version',
  node_sha256: '$node_sha256',
  convobus_upstream_version: '$convobus_upstream_version',
  convobus_adapter_version: '$convobus_adapter_version',
  built_at: '$built_at',
};
fs.writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
EOF

print "== release notes =="
cat > "$release_dir/RELEASE_NOTES.md" <<NOTES
# Agent Wheel $version

Agent Wheel takes a project from an idea through Experience, Design, Spec, and Plan to a verified
artifact. This release keeps the existing engine, provider routes, native macOS shell, and artwork.

## Changes

- Charcoal and warm gold from the logo, with faded-blue controls. Purple remains the Done color.
- Opening the window fills the usable desktop without entering full screen or restoring an old,
  smaller frame. The window remains resizable.
- Agent routes, models, reasoning, and Budget are project controls in the Inspector. Product Specs
  cannot override them. Existing accepted versions and journal history are preserved.
- Codex discovery prefers the current per-user installation. The Inspector can refresh live model
  choices, including GPT-6 Astra and the reasoning levels advertised by the installed CLI.
- Clearer first-project guidance, labeled fields, more comfortable spacing, keyboard-accessible
  project and node controls, visible focus, and reduced-motion support.
- Connection setup remains available without blocking project creation.
- Concise source comments retain important invariants; tests and engine behavior are preserved.
- Explicit source and app allowlists exclude local stores, logs, private planning material,
  repository history, and development-only payload files.
- Public snapshots use a neutral contributor identity. Native builds map source paths to a generic
  location. Disk images omit source ownership and extended attributes.
- Local native symbols are stripped, and the source ZIP uses maximum compression. The bundled
  runtime, exported symbols, original artwork, and required licenses remain intact.

## The release set

- \`Agent-Wheel-$version-macOS-arm64.dmg\` - the app for macOS 13 or newer on Apple silicon.
  Self-contained: an arm64 Node.js $node_version runtime, its debugging symbols stripped, ships
  inside the bundle. Intel Macs are not supported.
- \`agent-wheel-$version-source.zip\` - the public source at tag \`$tag\`, including the licensed
  Convobus source and notices (the app packages only the Convobus CORE MANIFEST).
- \`SHA256SUMS.txt\` - checksums of the two artifacts (\`shasum -a 256 -c SHA256SUMS.txt\`).
- \`RELEASE_MANIFEST.json\` - tag, commit, app version, every hash, the bundled Node version and
  its hash, the Convobus upstream and adapter versions, and the build instant.
- \`RELEASE_NOTES.md\` - this file.

\`scripts/verify-release.sh\` recomputes every hash, checks tag = app version = manifest, inspects
the DMG and the source zip, and exits 0 only when everything agrees.

## Seats

The default seat assignment is Leader = grok:cli, Builder = grok:cli, Reviewer = chatgpt:codex: the
\`grok\` and \`codex\` command-line tools, each logged in on its own, reached over stdio. The helper
looks first in ~/.local/bin and ~/.grok/bin, then /opt/homebrew/bin and /usr/local/bin. Other routes
(the Claude and Cursor CLIs, the desktop apps, the three API providers with a key under Advanced) are
chosen per project and per seat in the inspector, where a seat also picks
the model it rides and how hard it thinks, from lists the route's own binary gives when asked: nothing
there is typed, so nothing there can be mistyped.

## Signing

This build is ad-hoc signed and not notarized. On first launch macOS may require
System Settings -> Privacy & Security -> Open Anyway. An ad-hoc identity changes with every build, so
Accessibility and Keychain access are asked for again after each one. Optional Accessibility permission is requested from the window when setting up app routes.
CLI and API routes do not require it.

## Running from source

\`\`\`sh
cd agentwheel
node scripts/test-runtimes.js          # engine, schemas, storage, transport (+ GUI on macOS)
scripts/build-app.sh build             # the self-contained bundle
\`\`\`

Node 22 or newer runs the engine; the bundled runtime is Node $node_version.
NOTES

print "== verify =="
"$script_dir/verify-release.sh" "$release_dir"

print "\nrelease ready in $release_dir:"
ls -lh "$release_dir" | grep -v '^total\|build'

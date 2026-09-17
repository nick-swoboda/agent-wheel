# Releasing Agent Wheel

The public release is for Apple silicon on macOS 13 or newer. It uses an ad-hoc signature with no Developer ID or notarization. No signing account is required. macOS may require **System Settings → Privacy & Security → Open Anyway** on first launch.

## Build a public snapshot

Use Node.js 22 or newer and the Xcode Command Line Tools. No npm packages are required.

```sh
cd agentwheel
./scripts/package-release.sh --snapshot
```

This tests and builds the current files selected by `scripts/release-files.json` in a temporary, clean repository with a neutral contributor identity. It creates a new `v<version>` tag there; it never changes the working repository or its history. Version numbers come from `agentwheel/package.json`. Use a new version for every published release.

The source allowlist includes the engine, native shell, UI, tests, build scripts, product specification, artwork, and licensed ConvoBus source. It excludes personal stores, logs, development evidence, dictation records, old planning documents, and repository history. The app has a separate runtime allowlist. New source files must be added to the appropriate list.

The build downloads only the pinned official Node.js archive, verifies its SHA-256 checksum before extraction, preserves its license and exported symbols, and applies an ad-hoc signature after removing local symbols. Native compilation maps local source paths to a generic build path. Disk-image creation omits extended attributes and source ownership.

## Verify and publish

```sh
./scripts/verify-release.sh ../release
```

Publish only these five files from `release/`:

- `Agent-Wheel-<version>-macOS-arm64.dmg`
- `agent-wheel-<version>-source.zip`
- `SHA256SUMS.txt`
- `RELEASE_MANIFEST.json`
- `RELEASE_NOTES.md`

Build outputs and test logs stay in a temporary directory outside the release folder and are removed when packaging ends. Verification checks checksums, architecture, versions, ad-hoc signatures, the source snapshot commit, the source allowlist, and personal-identifier and credential patterns in the extracted source and app. Run verification on the build machine so it can also check that machine’s account and device identifiers.

For a new public repository, start from the extracted source ZIP. Existing development history can retain author identities and deleted files even when the current tree is clean; publishing the working repository’s history bypasses the public snapshot.

A clean, already-public repository can also use `./scripts/package-release.sh` after tagging its current commit `v<version>`.

# Third-party notices

## Node.js 26 (macOS app bundle only)

- Path in the app: `Agent Wheel.app/Contents/Resources/runtime/`
- License: Node.js license (see `Resources/runtime/Node-LICENSE.txt` in the
  built app)
- Use: the DMG release bundles the official Node.js runtime
  (the darwin-arm64 build from nodejs.org, verified against its pinned
  official SHA-256 checksum) with its local debugging symbols stripped
  (`strip -x`), so the app runs without a Node.js install. The major version
  is pinned; the exact version is in `Resources/runtime/VERSION.txt` and in
  `RELEASE_MANIFEST.json`. Source checkouts do not include it.

## ConvoBus 0.2.0

- Path: `Convobus/convobus-0.2.0-source/`
- License: Apache-2.0 (see `Convobus/convobus-0.2.0-source/LICENSE`)
- Use: ConvoBus core is Agent Wheel's packaged transport authority. The app
  ships only the CORE MANIFEST named in the law (`card.js`, `providers.js`,
  `provider-catalog.json`, `seats.js`, `turn.js`, `control.js`, `store.js`,
  `methods/stdio.js`, `methods/ax.js`, `methods/applescript.js`,
  `methods/filewins.js`, `methods/cursor-cdp.js`, `jxa/ax.js`, and the
  `ax-helper` binary built from `ax-helper.swift` + `ax-helper-main.swift`)
  plus the modules those files require at load (`catalog.js`, `check.js`,
  `graph.js`). The adapter under `agentwheel/lib/transport/` is the only
  code that touches it. The full licensed source and notices ship in the
  source release. The native shell follows the pattern of ConvoBus's
  `scripts/build-native-app.sh` and `lib/app-main.swift`.

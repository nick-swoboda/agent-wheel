# Changelog

All notable public changes to Convobus are documented here.

## 0.2.0 — 2026-08-31

- Added project-level Loops with a fixed Leader, optional Builder, and optional
  Reviewer.
- Added bounded 1–50-cycle segments, human turns, pause, correction, one-turn
  user replies, continuation, and clean new runs.
- Added one Loops workspace per project, an inline setup composer, optional run
  names, chronological project history, and synchronized menu-bar controls.
- Added exact-route checks before every AI turn, durable interruption recovery,
  and manual resume after quitting or relaunching.
- Kept direct conversations, all four providers, all eleven routes, existing
  APIs, stored data, and the legacy `convobus loop` command unchanged.

## 0.1.5 — 2026-08-31

- Preserved the complete 0.1.4 interface, workflows, APIs, CLI, stored data,
  menu-bar lifecycle, four providers, and eleven exact routes.
- Made local state private, atomic, symlink-safe, and consistent across
  simultaneous Convobus processes.
- Authenticated official native, browser, and CLI mutations against the exact
  backend instance and project root without adding user setup.
- Prevented stale composer text, sibling sessions, or another route from being
  accepted as the selected route's send or reply.
- Moved provider-session and Accessibility discovery out of the local service's
  request path and applied native context snapshots by selection epoch.
- Added one shared provider catalog, tolerant native models, an incremental
  lifecycle index, bounded requests/provider output, and exact CLI parsing.
- Rebuilt from a clean allowlisted bundle, verified the embedded universal
  Node.js runtime, and aligned the project and bundle on Apache License 2.0.

## 0.1.4 — 2026-08-30

- Added ChatGPT Classic, new-app Chat, and Work as three distinct App routes,
  bringing the supported catalog to eleven exact routes.
- Isolated ChatGPT Classic, Chat, Work, and CLI delivery so no route can attach
  through another ChatGPT application, surface, or session store.
- Made provider status inspection passive so selecting or polling Claude and
  ChatGPT never opens, unhides, or foregrounds either provider.
- Moved native app state to Application Support and replaced deep startup
  detection with a constant-time health check, so provider/project UI appears
  immediately without protected-folder or session-store scans.
- Targeted ChatGPT App processes by their exact bundle identifiers.
- Captured new-app Chat replies through macOS accessibility text markers and
  waited for the rendered reply to settle before completing its card.
- Added route-parity, attachment, filtering, persistence, and release-contract
  coverage for the complete provider matrix.
- Simplified the native workspace with more breathing room, quieter route
  controls, bottom-aligned card details, and a stable left-aligned Send action.
- Removed the redundant Conversation heading while preserving its original
  vertical spacing between route controls and message cards.
- Added a dedicated Settings page for Accessibility, provider availability,
  version information, and the Apache License 2.0 notice.
- Isolated real table clicks and keyboard navigation from polling updates so
  rapid provider and project changes always settle on the final selection.
- Commit provider and project choices at mouse-down, before AppKit begins click
  tracking, so an older context response cannot redraw the previous row before
  the user finishes a second click.
- Updated completed conversations to read Sent and carried route-state colors
  through to the menu-bar icon.
- Made the native selection coordinator authoritative after initial restore, so
  polling and programmatic table updates cannot replay a provider or project.
- Present cards and status together only after both selected-context responses
  are ready, removing intermediate Opening and color/text flashes.
- Kept the fixed four-provider list outside a scroll view while preserving
  native keyboard and VoiceOver selection.
- Replaced transport-oriented route copy with Sent, Waiting, Stopped, and the
  actionable Allow Accessibility and Folder Missing states.
- Added project right-click actions for Change Folder and Show in Finder, plus
  a disabled missing-folder conversation state with direct folder recovery.
- Made Accessibility show Allowed or Allow Access from the real macOS state and
  reopen the Accessibility pane when macOS no longer repeats its first prompt.
- Preserved the self-contained universal macOS 13+ app, embedded runtime,
  legacy APIs, Work history, and intentional Grok App unavailability.

## 0.1.3 — 2026-08-30

- Removed the end-user Node.js installation requirement by embedding the
  checksum-verified official Node.js 22.23.2 LTS runtime.
- Added universal Apple-silicon and Intel builds for macOS 13 and newer.
- Replaced the app ZIP with a standard drag-to-Applications DMG.
- Added an embedded Node.js license and reproducible, pinned runtime downloads.
- Preserved all application behavior, APIs, routing, storage, and menu-bar
  lifecycle semantics.

## 0.1.2 — 2026-08-30

Initial open-source release.

- Added the native provider → project → App/CLI → exact-route experience.
- Added strict Claude Chat, Cowork, Claude Code, and CLI routing with no
  cross-route fallback.
- Added provider-specific project history, restoration, and reliable rapid
  provider/project switching.
- Added a native macOS conversation view and production composer.
- Added a persistent menu-bar surface that remains available when the window is
  closed, with explicit window and process quit actions.
- Added light/dark appearance, selectable text, accessibility labels, keyboard
  navigation, and a centered Accessibility control.
- Preserved the existing APIs, logs, CLI commands, card lifecycle, folder
  binding, and legacy browser UI.
- Added a reproducible native build and release packaging workflow.

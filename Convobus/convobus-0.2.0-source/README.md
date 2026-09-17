<p align="center">
  <img src="assets/brand/convobus-icon-master.png" width="144" alt="Convobus icon">
</p>

<h1 align="center">Convobus</h1>

<p align="center"><strong>One focused conversation across AI apps and CLIs.</strong></p>

Convobus is a macOS app for organizing AI conversations by provider, project,
and exact route. It shows and sends only the messages that match the context you
selected.

```text
Provider → Project → App or CLI → Route
```

## What it does

- Keeps one focused conversation surface for the selected context.
- Makes it quick to switch between providers and projects.
- Keeps running in the menu bar when its window is closed.

Convobus does not silently switch to another provider, project, App/CLI surface,
or route when the selected one is unavailable.

## Supported routes

| Provider | App | CLI |
| --- | --- | --- |
| Claude | Chat, Cowork, Claude Code | Claude CLI |
| ChatGPT | Classic, Chat, Work | Codex |
| Cursor | Cursor | Cursor CLI |
| Grok | Not available | Grok CLI |

ChatGPT Classic uses `ChatGPT Classic.app`. Chat and Work are separate routes in
the newer `ChatGPT.app`. Grok App is intentionally unavailable.

## Install

Convobus 0.2.0 supports macOS 13 or newer on Apple silicon and Intel Macs.
The app is self-contained; using it does not require installing Node.js, Python,
or a package manager. You still need the provider apps or CLI tools for the
routes you plan to use.

1. Download `Convobus-0.2.0-macOS-universal.dmg`.
2. Open the DMG and drag **Convobus.app** into **Applications**.
3. Eject the disk image and open Convobus from Applications.

This release is ad-hoc signed and is not notarized. On first launch, macOS may
require the documented
[Open Anyway](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)
step in **System Settings → Privacy & Security**.

To verify the download, compare this result with `SHA256SUMS.txt`:

```sh
shasum -a 256 Convobus-0.2.0-macOS-universal.dmg
```

## Use

1. Select a provider.
2. Choose **Add Project…** and select a folder.
3. Select **App** or **CLI**, then choose the route.
4. If needed, open the existing provider session for that route.
5. Grant Accessibility access from Convobus **Settings** when an App route
   requires it.
6. Enter a message and use **Send** or <kbd>⌘</kbd><kbd>Return</kbd>.

The composer remains disabled until the exact route is ready. Convobus does not
create provider sessions or execute CLI commands automatically.

Selecting a provider restores its last project and route. Right-click a project
to change its folder or show it in Finder.

Closing the window leaves Convobus in the menu bar. Choose **Quit Convobus** from
the menu-bar menu to stop it completely.

## Loops

Each project has one Loops workspace. Choose **Loop** beside the message box or
the **+** beside **Loops**, enter what you want done, choose the team and 1–50
cycles, then start. Convobus remembers that project's last team and cycle count.

Replies move through a fixed Leader, optional Builder, and optional Reviewer.
A Loop pauses when it needs you or when a route needs attention. You can pause,
add a correction, reply for one scheduled turn, or explicitly continue another
set of cycles. Runs stay together in the project's Loops history.

Closing the window does not stop an active Loop. Quitting Convobus checkpoints
it, and relaunching leaves it paused until you continue.

## Local data

The installed app stores its local state under:

```text
~/Library/Application Support/Convobus/.convobus
```

This can include project paths, conversation records, and local session
metadata. Do not publish the directory or attach it wholesale to an issue.

The local backend listens only on `127.0.0.1`. Convobus includes no analytics or
telemetry.

## Build from source

Building requires macOS with the Xcode Command Line Tools and an internet
connection for the first embedded-runtime download.

```sh
./scripts/build-native-app.sh
./scripts/test.sh
```

The build creates a universal app under `app/Convobus.app`. Developers with
Node.js 22 or newer can also run the source CLI directly:

```sh
./convobus --help
```

See [docs/RELEASING.md](docs/RELEASING.md) for the release process.

## Security

Report suspected vulnerabilities privately through GitHub's **Report a
vulnerability** flow. See [SECURITY.md](SECURITY.md).

## License

Convobus is available under the [Apache License 2.0](LICENSE). Third-party
notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

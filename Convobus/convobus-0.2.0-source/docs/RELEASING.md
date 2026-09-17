# Releasing Convobus

This checklist publishes the open-source source tree on GitHub and the same
verified macOS download on GitHub Releases and the Convobus website.

## 1. Create the release files

From a clean source checkout with the Xcode Command Line Tools and an internet
connection for the first runtime download:

```sh
./scripts/package-release.sh
```

For version 0.2.0 this creates:

- `release/v0.2.0/Convobus-0.2.0-macOS-universal.dmg`
- `release/v0.2.0/convobus-0.2.0-source.zip`
- `release/v0.2.0/SHA256SUMS.txt`
- `release/v0.2.0/RELEASE_NOTES.md`
- an unpacked website copy at `release/v0.2.0/website/Convobus.app`

Do not publish the workspace itself or its `.convobus` directory. Publish the
clean source archive or a clean Git commit.

## 2. Publish the GitHub repository

1. Create an empty public GitHub repository.
2. Initialize this clean source tree as a Git repository if needed.
3. Commit the source, tests, documentation, icon resources, app plist, and build
   scripts. Generated native executables, private runtime data, and release
   output are intentionally ignored.
4. Push the default branch.
5. In GitHub repository settings, enable **Private vulnerability reporting**.

Before the first push, inspect the files Git will add and confirm that
`.convobus`, `test/.tmp`, `.DS_Store`, and `release` are absent.

## 3. Publish GitHub Release v0.2.0

Follow GitHub's official
[repository release workflow](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository):

1. Open **Releases → Draft a new release**.
2. Create tag `v0.2.0` from the exact commit you tested.
3. Set the title to `Convobus 0.2.0`.
4. Paste `release/v0.2.0/RELEASE_NOTES.md` into the description.
5. Upload the macOS DMG, source zip, and `SHA256SUMS.txt`.
6. Save a draft, download its assets once, and compare their SHA-256 values with
   `SHA256SUMS.txt`.
7. Publish the release.

GitHub automatically provides source archives for the tag as well. The explicit
source zip here is the same sanitized tree used for final verification.

## 4. Publish the website download

Upload the exact already-verified
`Convobus-0.2.0-macOS-universal.dmg`—do not rebuild it separately. Place
`SHA256SUMS.txt` beside it and show these facts near the download button:

- Apple silicon and Intel; macOS 13+
- Self-contained; no Node.js or supporting runtime installation
- Open source under Apache License 2.0
- Ad-hoc signed, not Developer ID signed or notarized
- First launch may require
  [System Settings → Privacy & Security → Open Anyway](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)

Link the website to the GitHub source repository and release notes. After
uploading, download the website copy and verify its SHA-256 value again.

## 5. Final smoke check

On a test Mac or clean user account:

1. Download the website DMG and verify its checksum.
2. Open it, drag the app to Applications, and follow the documented first-open flow.
3. Confirm the Finder icon and menu-bar icon appear.
4. Add or select a project and switch providers, projects, surfaces, and types.
5. Confirm the composer targets only the displayed route.
6. Start a short Loop, close the window, and confirm its menu-bar controls remain available.
7. Reopen the Loop, pause it, and confirm quitting leaves it paused after relaunch.
8. Reopen the direct conversation, then quit from the menu-bar item.

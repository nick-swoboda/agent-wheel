import AppKit
import Foundation

private func requireUI(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    FileHandle.standardError.write(Data("native UI failure: \(message)\n".utf8))
    exit(1)
  }
}

private func descendants(of view: NSView) -> [NSView] {
  [view] + view.subviews.flatMap(descendants)
}

private func writeSnapshot(_ view: NSView, to path: String) {
  guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
  view.cacheDisplay(in: view.bounds, to: bitmap)
  guard let data = bitmap.representation(using: .png, properties: [:]) else { return }
  try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
}

private func decodeLoopPage(_ value: [String: Any]) -> LoopRunPageDTO {
  let data = try! JSONSerialization.data(withJSONObject: value)
  return try! JSONDecoder().decode(LoopRunPageDTO.self, from: data)
}

@main
enum NativeUIContract {
  static func main() {
    setenv("CONVO_UI_TEST", "1", 1)
    _ = NSApplication.shared
    let catalogURL = URL(fileURLWithPath: CommandLine.arguments[1])
    let data = try! Data(contentsOf: catalogURL)
    let catalog = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    let providers = catalog["providers"] as! [[String: Any]]
    let delegate = AppDelegate()
    delegate.providerRows = providers.map { provider in
      let id = provider["id"] as! String
      let routes = (provider["routes"] as! [[String: Any]]).map { route -> [String: Any] in
        var value = route
        value["provider"] = id
        value["installed"] = true
        return value
      }
      return ["id": id, "name": provider["name"] as! String, "routes": routes]
    }
    delegate.projectRows = [[
      "path": "/tmp/convobus-ui-fixture",
      "name": "Convobus UI Fixture",
      "lastUsedAt": "2026-08-31T00:00:00.000Z",
      "providers": ["claude"],
      "routes": ["claude": ["surface": "app", "type": "chat"]],
      "exists": true,
    ]]
    delegate.selectedProviderID = "claude"
    delegate.selectedProjectPath = "/tmp/convobus-ui-fixture"
    delegate.selectedSurface = "app"
    delegate.selectedType = "chat"
    delegate.lastProjectByProvider = ["claude": "/tmp/convobus-ui-fixture"]
    delegate.providerModelLoaded = true
    delegate.loopRows = [[
      "id": "loop_1",
      "name": "Release review",
      "project": "/tmp/convobus-ui-fixture",
      "leader": ["kind": "human"],
      "builder": [
        "kind": "route",
        "route": [
          "provider": "claude",
          "providerName": "Claude",
          "project": "/tmp/convobus-ui-fixture",
          "surface": "app",
          "type": "claude-code",
          "label": "Claude Code",
        ],
      ],
      "defaultCycles": 1,
      "revision": 0,
      "active": false,
    ]]
    delegate.ensureWindow()

    guard let window = delegate.window,
          let split = window.contentViewController as? NSSplitViewController,
          let content = window.contentView
    else {
      requireUI(false, "window and split view")
      return
    }
    content.layoutSubtreeIfNeeded()
    requireUI(split.splitViewItems.count == 2, "sidebar/content hierarchy")
    requireUI(window.contentMinSize == NSSize(width: 720, height: 520), "minimum size")
    requireUI(window.contentLayoutRect.width >= 1000, "default width")
    requireUI(delegate.providerTableView?.numberOfRows == 4, "four provider rows")
    requireUI(delegate.projectTableView?.numberOfRows == 1, "provider project row")
    requireUI(delegate.loopTableView?.numberOfRows == 1, "saved Loop row")
    requireUI(delegate.projectTableView?.focusRingType == NSFocusRingType.none, "project selection has no table-wide focus box")
    requireUI(delegate.loopTableView?.focusRingType == NSFocusRingType.none, "Loop selection has no table-wide focus box")
    requireUI(
      delegate.projectTableView?.enclosingScrollView === delegate.loopTableView?.enclosingScrollView,
      "Projects and Loops share the lower sidebar scroll area"
    )
    requireUI(delegate.providerTableView?.selectedRow == 0, "provider selection")
    requireUI(delegate.projectTableView?.selectedRow == 0, "project selection")
    requireUI(delegate.surfaceControl?.label(forSegment: 0) == "App", "App surface")
    requireUI(delegate.surfaceControl?.label(forSegment: 1) == "CLI", "CLI surface")
    requireUI(delegate.typeControl?.label(forSegment: 0) == "Chat", "exact route type")
    requireUI(delegate.routeTitleField?.stringValue == "Chat", "route heading")
    requireUI(delegate.collectionView is AdaptiveCollectionView, "virtualized conversation")
    requireUI(delegate.sendButton?.title == "Send", "production send action")
    requireUI(delegate.sendButton?.keyEquivalent == "\r", "Command-Return send")
    requireUI(delegate.settingsButton?.title == "Settings", "settings action")
    requireUI(delegate.loopWorkspaceView != nil, "Loop conversation surface")
    let stableSetup = LoopSetupView()
    let setupRoute = LoopRouteChoice(
      provider: "claude",
      providerName: "Claude",
      surface: "app",
      type: "claude-code",
      label: "Claude Code",
      installed: true
    )
    stableSetup.configure(
      project: "/tmp/convobus-ui-fixture",
      routes: [setupRoute],
      currentRoute: setupRoute,
      workspace: nil,
      showsCancel: false
    )
    let stableSetupViews = descendants(of: stableSetup)
    let stableCycles = stableSetupViews.compactMap { $0 as? NSTextField }.first {
      $0.accessibilityLabel() == "Cycles"
    }
    let stablePrompt = stableSetupViews.compactMap { $0 as? LoopPromptTextView }.first
    stableCycles?.stringValue = "7"
    stablePrompt?.string = "Keep this Loop draft"
    stableSetup.configure(
      project: "/tmp/convobus-ui-fixture",
      routes: [setupRoute],
      currentRoute: setupRoute,
      workspace: nil,
      showsCancel: false
    )
    requireUI(stableCycles?.stringValue == "7", "polling does not reset Loop cycles")
    requireUI(stablePrompt?.string == "Keep this Loop draft", "polling does not reset Loop prompt")

    let views = descendants(of: content)
    let sidebarDivider = views.compactMap { $0 as? NSBox }.first { box in
      guard box.boxType == .separator else { return false }
      return box.convert(box.bounds, to: nil).maxX <= 230
    }
    let editorScroll = delegate.bodyView?.enclosingScrollView
    let editorFrame = editorScroll.map { $0.convert($0.bounds, to: nil) }
    let dividerFrame = sidebarDivider.map { $0.convert($0.bounds, to: nil) }
    requireUI(
      abs((dividerFrame?.midY ?? -100) - (editorFrame?.minY ?? 100)) <= 1,
      "sidebar divider aligns with message editor bottom"
    )

    let labels = Set(views.compactMap { $0.accessibilityLabel() })
    requireUI(labels.contains("Add Project"), "Add Project accessibility")
    requireUI(labels.contains("Start Loop"), "Start Loop accessibility")
    requireUI(labels.contains("Message"), "composer accessibility")
    requireUI(labels.contains("Surface"), "surface accessibility")
    requireUI(labels.contains("Provider type"), "type accessibility")

    let newLoopButton = views.compactMap { $0 as? NSButton }.first {
      $0.accessibilityLabel() == "Start Loop"
    }
    requireUI(newLoopButton != nil, "Start Loop button is present")
    requireUI(newLoopButton?.target === delegate, "Start Loop button targets the app coordinator")
    requireUI(newLoopButton?.action == #selector(AppDelegate.newLoop(_:)), "Start Loop button action")
    delegate.bodyView?.string = "Keep this direct draft"
    delegate.newLoop(nil)
    requireUI(window.attachedSheet == nil, "Loop starts in the conversation instead of a sheet")
    requireUI(delegate.loopSetupMode, "Loop composer mode is active")
    requireUI(delegate.directLoopSetupView?.isHidden == false, "Loop composer is visible")
    requireUI(delegate.directComposerView?.isHidden == true, "direct composer is preserved behind Loop composer")
    let setupViews = descendants(of: delegate.directLoopSetupView!)
    let loopPrompt = setupViews.compactMap { $0 as? LoopPromptTextView }.first
    requireUI(loopPrompt?.isEditable == true, "Loop prompt accepts typing")
    requireUI(loopPrompt?.placeholderString == "What should this Loop work on?", "Loop prompt uses plain placeholder copy")
    loopPrompt?.string = "Review this project"
    loopPrompt?.didChangeText()
    let startLoop = setupViews.compactMap { $0 as? NSButton }.first { $0.title == "Start Loop" }
    requireUI(startLoop?.isEnabled == true, "typed Loop prompt can be started")
    requireUI(startLoop?.accessibilityLabel() == "Start Loop", "Loop start action has a stable VoiceOver label")
    if let snapshotDirectory = ProcessInfo.processInfo.environment["CONVO_UI_SNAPSHOT_DIR"] {
      window.appearance = NSAppearance(named: .aqua)
      content.wantsLayer = true
      content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
      content.layoutSubtreeIfNeeded()
      writeSnapshot(content, to: snapshotDirectory + "/loops-light-default.png")
      window.appearance = NSAppearance(named: .darkAqua)
    }
    let cancel = setupViews.compactMap { $0 as? NSButton }.first { $0.title == "Cancel" }
    cancel?.performClick(nil)
    requireUI(!delegate.loopSetupMode, "Cancel returns to direct conversation")
    requireUI(delegate.bodyView?.string == "Keep this direct draft", "direct draft survives Loop mode")
    window.setContentSize(NSSize(width: 720, height: 520))
    delegate.newLoop(nil)
    content.layoutSubtreeIfNeeded()
    requireUI((delegate.directLoopSetupView?.bounds.width ?? 0) >= 420, "Loop composer fits minimum width")
    requireUI((delegate.directLoopSetupView?.bounds.height ?? 0) >= 140, "Loop composer fits minimum height")
    if let snapshotDirectory = ProcessInfo.processInfo.environment["CONVO_UI_SNAPSHOT_DIR"] {
      window.appearance = NSAppearance(named: .aqua)
      content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
      content.layoutSubtreeIfNeeded()
      writeSnapshot(content, to: snapshotDirectory + "/loops-light-minimum.png")
      window.appearance = NSAppearance(named: .darkAqua)
    }
    descendants(of: delegate.directLoopSetupView!).compactMap { $0 as? NSButton }.first { $0.title == "Cancel" }?.performClick(nil)
    window.setContentSize(NSSize(width: 1040, height: 760))
    content.layoutSubtreeIfNeeded()

    delegate.loopTableView?.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
    requireUI(delegate.showingLoop, "Loop opens from sidebar")
    requireUI(delegate.loopContentView?.isHidden == false, "Loop workspace visible")
    requireUI(delegate.selectedProviderID == "claude", "Loop selection preserves direct provider")
    requireUI(delegate.selectedProjectPath == "/tmp/convobus-ui-fixture", "Loop selection preserves direct project")

    let pausedPage = decodeLoopPage([
      "run": [
        "id": "run_1",
        "loopId": "loop_1",
        "name": "Release review",
        "project": "/tmp/convobus-ui-fixture",
        "state": "paused",
        "progress": ["segment": 1, "cycle": 1, "cycles": 3, "step": 1, "steps": 6],
        "nextRole": "builder",
        "pauseRequested": false,
        "stopRequested": false,
        "active": true,
        "revision": 2,
        "definition": [
          "id": "loop_1",
          "name": "Release review",
          "project": "/tmp/convobus-ui-fixture",
          "leader": ["kind": "human"],
          "builder": [
            "kind": "route",
            "route": [
              "provider": "claude",
              "providerName": "Claude",
              "project": "/tmp/convobus-ui-fixture",
              "surface": "app",
              "type": "claude-code",
              "label": "Claude Code",
            ],
          ],
        ],
        "goal": "Prepare the release.",
      ],
      "messages": [[
        "id": "goal:segment_1",
        "kind": "goal",
        "role": "leader",
        "actor": "human",
        "content": "Prepare the release.",
        "segment": 1,
        "cycle": 1,
        "state": "complete",
      ]],
    ])
    delegate.loopWorkspaceView?.apply(run: pausedPage.run, messages: pausedPage.messages)
    let loopViews = descendants(of: delegate.loopWorkspaceView!)
    let loopButtons = Set(loopViews.compactMap { ($0 as? NSButton)?.title })
    requireUI(loopButtons.contains("Continue"), "paused Loop Continue")
    requireUI(loopButtons.contains("Add Correction…"), "paused Loop correction")
    requireUI(loopButtons.contains("Reply as Me"), "paused Loop user turn")
    requireUI(delegate.loopWorkspaceView?.accessibilityLabel() == "Release review, Paused", "Loop state accessibility")

    delegate.providerTableView?.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
    requireUI(!delegate.showingLoop, "provider selection returns to direct conversation")

    delegate.settingsButton?.performClick(nil)
    requireUI(delegate.showingSettings, "settings presentation")
    requireUI(delegate.settingsContentView?.isHidden == false, "settings visible")
    requireUI(delegate.workspaceContentView?.isHidden == true, "workspace preserved behind settings")
    requireUI(!delegate.applicationShouldTerminateAfterLastWindowClosed(NSApplication.shared), "window close keeps process")
    delegate.fullQuitRequested = false
    requireUI(
      delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel,
      "ordinary app termination keeps the menu process"
    )
    delegate.fullQuitRequested = true
    requireUI(
      delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow,
      "explicit status-menu Quit terminates"
    )
    window.orderOut(nil)
    print("native UI ok")
  }
}

import AppKit
import Foundation

struct LoopRouteChoice: Equatable {
  let provider: String
  let providerName: String
  let surface: String
  let type: String
  let label: String
  let installed: Bool

  var key: String { "\(provider)/\(surface)/\(type)" }

  var displayName: String {
    let routeName: String
    if surface == "cli", label.lowercased().hasSuffix(" cli") {
      routeName = String(label.dropLast(4))
    } else if label.localizedCaseInsensitiveContains(providerName) || label == "Codex" || label == "Cursor" {
      routeName = label
    } else {
      routeName = "\(providerName) \(label)"
    }
    return "\(routeName) · \(surface == "cli" ? "CLI" : "App")"
  }

  var json: [String: Any] {
    ["provider": provider, "surface": surface, "type": type]
  }
}

struct LoopSetupDraft {
  let project: String
  let runName: String?
  let prompt: String
  let leader: [String: Any]
  let builder: [String: Any]?
  let reviewer: [String: Any]?
  let cycles: Int
}

final class LoopPromptTextView: NSTextView {
  var placeholderString = "" { didSet { needsDisplay = true } }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    guard string.isEmpty, !placeholderString.isEmpty else { return }
    let origin = NSPoint(x: textContainerInset.width + 4, y: textContainerInset.height)
    placeholderString.draw(
      at: origin,
      withAttributes: [
        .font: font ?? NSFont.systemFont(ofSize: 13),
        .foregroundColor: NSColor.placeholderTextColor,
      ]
    )
  }

  override func didChangeText() {
    super.didChangeText()
    needsDisplay = true
  }
}

final class LoopSetupView: NSView, NSTextViewDelegate, NSTextFieldDelegate {
  private let titleField = NSTextField(labelWithString: "Loop")
  private let addNameButton = NSButton(title: "Add name", target: nil, action: nil)
  private let nameField = NSTextField()
  private let teamButton = NSButton(title: "Team", target: nil, action: nil)
  private let cyclesField = NSTextField(string: "1")
  private let cyclesStepper = NSStepper()
  private let promptView = LoopPromptTextView()
  private let cycleLabel = NSTextField(labelWithString: "cycle")
  private let summaryField = NSTextField(labelWithString: "")
  private let startButton = NSButton(title: "Start Loop", target: nil, action: nil)
  private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
  private var project = ""
  private var routes: [LoopRouteChoice] = []
  private var leader: LoopRouteChoice?
  private var builder: LoopRouteChoice?
  private var reviewer: LoopRouteChoice?
  private var configurationKey = ""
  var onStart: ((LoopSetupDraft) -> Void)?
  var onCancel: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    translatesAutoresizingMaskIntoConstraints = false
    build()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func build() {
    wantsLayer = true
    layer?.cornerRadius = 14
    layer?.cornerCurve = .continuous
    layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.78).cgColor
    layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.5).cgColor
    layer?.borderWidth = 1

    let stack = NSStackView()
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8

    let header = NSStackView()
    header.orientation = .horizontal
    header.alignment = .centerY
    header.spacing = 7
    titleField.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
    addNameButton.target = self
    addNameButton.action = #selector(showName)
    addNameButton.bezelStyle = .inline
    addNameButton.controlSize = .small
    addNameButton.setAccessibilityLabel("Add Loop name")
    nameField.placeholderString = "Optional name"
    nameField.setAccessibilityLabel("Optional Loop name")
    nameField.delegate = self
    nameField.isHidden = true
    nameField.translatesAutoresizingMaskIntoConstraints = false
    nameField.widthAnchor.constraint(greaterThanOrEqualToConstant: 150).isActive = true
    let headerSpacer = NSView()
    headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    cancelButton.target = self
    cancelButton.action = #selector(cancelPressed)
    cancelButton.bezelStyle = .inline
    cancelButton.controlSize = .small
    header.addArrangedSubview(titleField)
    header.addArrangedSubview(addNameButton)
    header.addArrangedSubview(nameField)
    header.addArrangedSubview(headerSpacer)
    header.addArrangedSubview(cancelButton)
    stack.addArrangedSubview(header)
    header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    let controls = NSStackView()
    controls.orientation = .horizontal
    controls.alignment = .centerY
    controls.spacing = 8
    teamButton.target = self
    teamButton.action = #selector(showTeamMenu(_:))
    teamButton.bezelStyle = .rounded
    teamButton.controlSize = .small
    teamButton.image = NSImage(systemSymbolName: "person.2", accessibilityDescription: nil)
    teamButton.imagePosition = .imageLeading
    teamButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    teamButton.cell?.lineBreakMode = .byTruncatingTail
    cyclesField.alignment = .center
    cyclesField.delegate = self
    cyclesField.translatesAutoresizingMaskIntoConstraints = false
    cyclesField.widthAnchor.constraint(equalToConstant: 32).isActive = true
    cyclesField.setAccessibilityLabel("Cycles")
    cyclesStepper.minValue = 1
    cyclesStepper.maxValue = 50
    cyclesStepper.increment = 1
    cyclesStepper.valueWraps = false
    cyclesStepper.target = self
    cyclesStepper.action = #selector(cyclesChanged(_:))
    cyclesStepper.setAccessibilityLabel("Cycles")
    cycleLabel.font = NSFont.systemFont(ofSize: 11)
    cycleLabel.textColor = .secondaryLabelColor
    let controlSpacer = NSView()
    controlSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    controls.addArrangedSubview(teamButton)
    controls.addArrangedSubview(controlSpacer)
    controls.addArrangedSubview(cyclesField)
    controls.addArrangedSubview(cyclesStepper)
    controls.addArrangedSubview(cycleLabel)
    stack.addArrangedSubview(controls)
    controls.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    promptView.isEditable = true
    promptView.isSelectable = true
    promptView.isRichText = false
    promptView.font = NSFont.systemFont(ofSize: 13)
    promptView.autoresizingMask = [.width]
    promptView.textContainerInset = NSSize(width: 8, height: 7)
    promptView.isVerticallyResizable = true
    promptView.isHorizontallyResizable = false
    promptView.textContainer?.widthTracksTextView = true
    promptView.drawsBackground = true
    promptView.backgroundColor = .textBackgroundColor
    promptView.delegate = self
    promptView.placeholderString = "What should this Loop work on?"
    promptView.setAccessibilityLabel("Loop prompt")
    let promptScroll = NSScrollView()
    promptScroll.translatesAutoresizingMaskIntoConstraints = false
    promptScroll.hasVerticalScroller = true
    promptScroll.autohidesScrollers = true
    promptScroll.borderType = .lineBorder
    promptScroll.wantsLayer = true
    promptScroll.layer?.cornerRadius = 8
    promptScroll.layer?.masksToBounds = true
    promptScroll.documentView = promptView
    promptScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 76).isActive = true
    stack.addArrangedSubview(promptScroll)
    promptScroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    let footer = NSStackView()
    footer.orientation = .horizontal
    footer.alignment = .centerY
    footer.spacing = 8
    startButton.target = self
    startButton.action = #selector(startPressed)
    startButton.bezelStyle = .rounded
    startButton.controlSize = .large
    startButton.image = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: nil)
    startButton.imagePosition = .imageLeading
    startButton.setAccessibilityLabel("Start Loop")
    startButton.keyEquivalent = "\r"
    startButton.keyEquivalentModifierMask = .command
    let footerSpacer = NSView()
    footerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    summaryField.font = NSFont.systemFont(ofSize: 11, weight: .medium)
    summaryField.textColor = .secondaryLabelColor
    summaryField.alignment = .right
    summaryField.lineBreakMode = .byTruncatingTail
    summaryField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    footer.addArrangedSubview(startButton)
    footer.addArrangedSubview(footerSpacer)
    footer.addArrangedSubview(summaryField)
    stack.addArrangedSubview(footer)
    footer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 14),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
    ])
    updatePresentation()
  }

  func configure(
    project: String,
    routes: [LoopRouteChoice],
    currentRoute: LoopRouteChoice?,
    workspace: LoopWorkspaceDTO?,
    showsCancel: Bool,
    force: Bool = false
  ) {
    let projectChanged = self.project != project
    self.project = project
    self.routes = routes
    if projectChanged {
      promptView.string = ""
      nameField.stringValue = ""
      nameField.isHidden = true
      addNameButton.isHidden = false
    }
    cancelButton.isHidden = !showsCancel
    let key = "\(project)|\(workspace?.id ?? "new")|\(workspace?.revision ?? -1)|\(currentRoute?.key ?? "")"
    if force || key != configurationKey {
      configurationKey = key
      if let workspace {
        leader = routeChoice(workspace.leader)
        builder = workspace.builder.flatMap(routeChoice)
        reviewer = workspace.reviewer.flatMap(routeChoice)
        cyclesField.stringValue = String(min(50, max(1, workspace.defaultCycles)))
      } else {
        leader = nil
        builder = currentRoute ?? routes.first(where: { $0.installed }) ?? routes.first
        reviewer = nil
        cyclesField.stringValue = "1"
      }
    }
    cyclesStepper.integerValue = cycles
    updatePresentation()
  }

  func focusPrompt() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.window?.makeFirstResponder(self.promptView)
    }
  }

  func clearRunFields() {
    promptView.string = ""
    nameField.stringValue = ""
    nameField.isHidden = true
    addNameButton.isHidden = false
    updatePresentation()
  }

  func setSubmitting(_ submitting: Bool) {
    startButton.isEnabled = !submitting && canStart
    startButton.title = submitting ? "Starting…" : "Start Loop"
    promptView.isEditable = !submitting
    teamButton.isEnabled = !submitting
    cyclesField.isEnabled = !submitting
    cyclesStepper.isEnabled = !submitting
    addNameButton.isEnabled = !submitting
    nameField.isEnabled = !submitting
    cancelButton.isEnabled = !submitting
  }

  private var cycles: Int { min(50, max(1, Int(cyclesField.stringValue) ?? 1)) }

  private var canStart: Bool {
    let keys = [leader, builder, reviewer].compactMap { $0?.key }
    return !project.isEmpty &&
      !promptView.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
      (builder != nil || reviewer != nil) &&
      Set(keys).count == keys.count
  }

  private func routeChoice(_ participant: LoopParticipantDTO) -> LoopRouteChoice? {
    guard participant.kind != "human", let route = participant.route else { return nil }
    return routes.first {
      $0.provider == route.provider && $0.surface == route.surface && $0.type == route.type
    }
  }

  private func participantJSON(_ route: LoopRouteChoice?, role: String) -> [String: Any]? {
    if role == "leader", route == nil { return ["kind": "human"] }
    return route.map { ["kind": "route", "route": $0.json] }
  }

  private func participantName(_ route: LoopRouteChoice?, role: String) -> String {
    if role == "leader", route == nil { return "Me" }
    return route?.displayName ?? "None"
  }

  private func updatePresentation() {
    cyclesField.stringValue = String(cycles)
    cyclesStepper.integerValue = cycles
    cycleLabel.stringValue = cycles == 1 ? "cycle" : "cycles"
    let names = [
      participantName(leader, role: "leader"),
      builder.map { participantName($0, role: "builder") },
      reviewer.map { participantName($0, role: "reviewer") },
    ].compactMap { $0 }
    teamButton.title = names.joined(separator: " → ")
    teamButton.toolTip = teamButton.title
    let aiPerCycle = (leader == nil ? 0 : 1) + (builder == nil ? 0 : 1) + (reviewer == nil ? 0 : 1)
    let humanPerCycle = leader == nil ? 1 : 0
    if humanPerCycle > 0 {
      summaryField.stringValue = "\(cycles) cycle\(cycles == 1 ? "" : "s") · \(cycles * aiPerCycle) AI turn\(cycles * aiPerCycle == 1 ? "" : "s") · \(cycles * humanPerCycle) for you"
    } else {
      summaryField.stringValue = "\(cycles) cycle\(cycles == 1 ? "" : "s") · \(cycles * aiPerCycle) AI turn\(cycles * aiPerCycle == 1 ? "" : "s")"
    }
    startButton.isEnabled = canStart
  }

  @objc private func showName(_ sender: Any?) {
    addNameButton.isHidden = true
    nameField.isHidden = false
    window?.makeFirstResponder(nameField)
  }

  @objc private func cyclesChanged(_ sender: Any?) {
    cyclesField.stringValue = String(cyclesStepper.integerValue)
    updatePresentation()
  }

  func controlTextDidChange(_ obj: Notification) { updatePresentation() }
  func textDidChange(_ notification: Notification) { updatePresentation() }

  @objc private func showTeamMenu(_ sender: NSButton) {
    let menu = NSMenu()
    addRoleMenu("Leader", role: "leader", permitsHuman: true, permitsNone: false, to: menu)
    addRoleMenu("Builder", role: "builder", permitsHuman: false, permitsNone: true, to: menu)
    addRoleMenu("Reviewer", role: "reviewer", permitsHuman: false, permitsNone: true, to: menu)
    menu.popUp(positioning: nil, at: NSPoint(x: sender.bounds.minX, y: sender.bounds.minY), in: sender)
  }

  private func addRoleMenu(
    _ title: String,
    role: String,
    permitsHuman: Bool,
    permitsNone: Bool,
    to menu: NSMenu
  ) {
    let root = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    let submenu = NSMenu(title: title)
    if permitsHuman {
      let item = teamMenuItem("Me", role: role, key: "human")
      item.state = leader == nil ? .on : .off
      submenu.addItem(item)
    }
    if permitsNone {
      let selected = role == "builder" ? builder : reviewer
      let item = teamMenuItem("None", role: role, key: "none")
      item.state = selected == nil ? .on : .off
      submenu.addItem(item)
    }
    if permitsHuman || permitsNone { submenu.addItem(.separator()) }
    for route in routes {
      let item = teamMenuItem(route.displayName, role: role, key: route.key)
      let selected = role == "leader" ? leader : role == "builder" ? builder : reviewer
      item.state = selected?.key == route.key ? .on : .off
      let usedElsewhere = [
        role == "leader" ? nil : leader,
        role == "builder" ? nil : builder,
        role == "reviewer" ? nil : reviewer,
      ].compactMap { $0 }.contains { $0.key == route.key }
      item.isEnabled = route.installed && !usedElsewhere
      submenu.addItem(item)
    }
    root.submenu = submenu
    menu.addItem(root)
  }

  private func teamMenuItem(_ title: String, role: String, key: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: #selector(teamChoice(_:)), keyEquivalent: "")
    item.target = self
    item.representedObject = ["role": role, "key": key]
    return item
  }

  @objc private func teamChoice(_ sender: NSMenuItem) {
    guard let value = sender.representedObject as? [String: String],
          let role = value["role"], let key = value["key"]
    else { return }
    let choice = routes.first { $0.key == key }
    if role == "leader" { leader = key == "human" ? nil : choice }
    else if role == "builder" { builder = key == "none" ? nil : choice }
    else if role == "reviewer" { reviewer = key == "none" ? nil : choice }
    updatePresentation()
  }

  @objc private func startPressed(_ sender: Any?) {
    updatePresentation()
    guard startButton.isEnabled,
          let leaderJSON = participantJSON(leader, role: "leader")
    else { return }
    let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let prompt = promptView.string
    onStart?(
      LoopSetupDraft(
        project: project,
        runName: name.isEmpty ? nil : name,
        prompt: prompt,
        leader: leaderJSON,
        builder: participantJSON(builder, role: "builder"),
        reviewer: participantJSON(reviewer, role: "reviewer"),
        cycles: cycles
      )
    )
  }

  @objc private func cancelPressed(_ sender: Any?) { onCancel?() }
}

final class LoopClosureButton: NSButton {
  var handler: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    target = self
    action = #selector(invoke)
  }

  convenience init(title: String, handler: @escaping () -> Void) {
    self.init(frame: .zero)
    self.title = title
    self.handler = handler
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  @objc private func invoke(_ sender: Any?) { handler?() }
}

final class LoopSidebarCellView: NSTableCellView {
  static let identifier = NSUserInterfaceItemIdentifier("LoopSidebarCellView")
  private let nameField = NSTextField(labelWithString: "")
  private let stateField = NSTextField(labelWithString: "")
  private let dot = NSView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    nameField.translatesAutoresizingMaskIntoConstraints = false
    nameField.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
    nameField.lineBreakMode = .byTruncatingTail
    stateField.translatesAutoresizingMaskIntoConstraints = false
    stateField.font = NSFont.systemFont(ofSize: 10.5, weight: .medium)
    stateField.textColor = .secondaryLabelColor
    stateField.alignment = .right
    stateField.lineBreakMode = .byTruncatingTail
    dot.translatesAutoresizingMaskIntoConstraints = false
    dot.wantsLayer = true
    dot.layer?.cornerRadius = 3
    addSubview(dot)
    addSubview(nameField)
    addSubview(stateField)
    NSLayoutConstraint.activate([
      dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
      dot.centerYAnchor.constraint(equalTo: centerYAnchor),
      dot.widthAnchor.constraint(equalToConstant: 6),
      dot.heightAnchor.constraint(equalToConstant: 6),
      nameField.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8),
      nameField.centerYAnchor.constraint(equalTo: centerYAnchor),
      stateField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      stateField.centerYAnchor.constraint(equalTo: centerYAnchor),
      nameField.trailingAnchor.constraint(lessThanOrEqualTo: stateField.leadingAnchor, constant: -8),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func update(name: String, state: String?, progress: [String: Any]?) {
    nameField.stringValue = name
    let display: String
    if let progress,
       let cycle = progress["cycle"] as? Int,
       let cycles = progress["cycles"] as? Int,
       state == "waiting" || state == "your-turn"
    {
      display = "Cycle \(cycle)/\(cycles)"
    } else {
      display = LoopWorkspaceView.displayState(state)
    }
    stateField.stringValue = display
    dot.layer?.backgroundColor = LoopWorkspaceView.stateColor(state).cgColor
    setAccessibilityLabel(name)
    setAccessibilityValue(display)
  }
}

final class LoopRolePillView: NSView {
  private let label = NSTextField(labelWithString: "")

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    translatesAutoresizingMaskIntoConstraints = false
    wantsLayer = true
    layer?.cornerRadius = 10
    layer?.cornerCurve = .continuous
    layer?.borderWidth = 1
    label.translatesAutoresizingMaskIntoConstraints = false
    label.font = NSFont.systemFont(ofSize: 10.5, weight: .medium)
    addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -9),
      label.topAnchor.constraint(equalTo: topAnchor, constant: 4),
      label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func update(text: String, active: Bool) {
    label.stringValue = text
    label.textColor = active ? .white : .secondaryLabelColor
    layer?.backgroundColor = active
      ? NSColor.controlAccentColor.cgColor
      : NSColor.controlBackgroundColor.withAlphaComponent(0.62).cgColor
    layer?.borderColor = active
      ? NSColor.controlAccentColor.cgColor
      : NSColor.separatorColor.withAlphaComponent(0.55).cgColor
    setAccessibilityLabel(text)
    setAccessibilityValue(active ? "Current role" : "")
  }
}

final class LoopMessageCollectionItem: NSCollectionViewItem {
  static let identifier = NSUserInterfaceItemIdentifier("LoopMessageCollectionItem")
  private let panel = RoundedPanelView(
    fillColor: NSColor.controlBackgroundColor.withAlphaComponent(0.54),
    strokeColor: NSColor.separatorColor.withAlphaComponent(0.38),
    radius: 13
  )
  private let stack = NSStackView()
  private var messageID = ""
  var onToggleDetails: ((String) -> Void)?

  override func loadView() {
    panel.translatesAutoresizingMaskIntoConstraints = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8
    panel.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 14),
      stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -14),
      stack.topAnchor.constraint(equalTo: panel.topAnchor, constant: 12),
      stack.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -11),
    ])
    view = panel
  }

  func configure(message: LoopMessageDTO, expanded: Bool, time: String) {
    messageID = message.id
    for child in stack.arrangedSubviews {
      stack.removeArrangedSubview(child)
      child.removeFromSuperview()
    }
    if message.kind == "run" {
      configureRunBoundary(message)
      return
    }
    panel.strokeColor = NSColor.separatorColor.withAlphaComponent(0.38)
    panel.radius = 13
    panel.fillColor = message.kind == "goal"
      ? NSColor.controlAccentColor.withAlphaComponent(0.10)
      : NSColor.controlBackgroundColor.withAlphaComponent(0.54)
    panel.needsDisplay = true

    let header = NSStackView()
    header.orientation = .horizontal
    header.alignment = .centerY
    header.spacing = 7
    let title = NSTextField(labelWithString: messageTitle(message))
    title.font = NSFont.systemFont(ofSize: 11.5, weight: .semibold)
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let state = NSTextField(labelWithString: message.state == "waiting" ? "Waiting" : time)
    state.font = NSFont.systemFont(ofSize: 10.5)
    state.textColor = message.state == "waiting" ? .systemOrange : .secondaryLabelColor
    header.addArrangedSubview(title)
    header.addArrangedSubview(spacer)
    header.addArrangedSubview(state)
    stack.addArrangedSubview(header)
    header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    let content = NSTextField(wrappingLabelWithString: message.content.isEmpty ? "Waiting for a reply…" : message.content)
    content.font = NSFont.systemFont(ofSize: 13)
    content.textColor = message.content.isEmpty ? .secondaryLabelColor : .labelColor
    content.isSelectable = !message.content.isEmpty
    content.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    stack.addArrangedSubview(content)
    content.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    stack.setCustomSpacing(16, after: content)
    let detailsRow = NSStackView()
    detailsRow.orientation = .horizontal
    let detailsSpacer = NSView()
    detailsSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let details = NSButton(title: expanded ? "Hide Details" : "Details", target: self, action: #selector(toggleDetails))
    details.bezelStyle = .inline
    details.controlSize = .small
    details.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
    details.imagePosition = .imageLeading
    detailsRow.addArrangedSubview(detailsSpacer)
    detailsRow.addArrangedSubview(details)
    stack.addArrangedSubview(detailsRow)
    detailsRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    if expanded {
      let metadata = NSTextField(wrappingLabelWithString: detailText(message))
      metadata.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
      metadata.textColor = .secondaryLabelColor
      metadata.isSelectable = true
      metadata.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      stack.addArrangedSubview(metadata)
      metadata.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    view.setAccessibilityLabel("\(messageTitle(message)), \(message.state)")
  }

  private func messageTitle(_ message: LoopMessageDTO) -> String {
    if message.kind == "goal" { return "Start" }
    if message.kind == "guidance" { return "Guidance" }
    let role = message.role.prefix(1).uppercased() + message.role.dropFirst()
    if message.actor == "human" { return "You · \(role)" }
    let route = message.route?.label ?? message.route?.providerName ?? "Provider"
    return "\(route) · \(role)"
  }

  private func configureRunBoundary(_ message: LoopMessageDTO) {
    panel.fillColor = .clear
    panel.strokeColor = nil
    panel.radius = 0
    panel.needsDisplay = true
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 10
    let leading = NSBox()
    leading.boxType = .separator
    let label = NSTextField(labelWithString: runBoundaryTitle(message))
    label.font = NSFont.systemFont(ofSize: 10.5, weight: .medium)
    label.textColor = .secondaryLabelColor
    let trailing = NSBox()
    trailing.boxType = .separator
    row.addArrangedSubview(leading)
    row.addArrangedSubview(label)
    row.addArrangedSubview(trailing)
    leading.widthAnchor.constraint(greaterThanOrEqualToConstant: 24).isActive = true
    trailing.widthAnchor.constraint(greaterThanOrEqualToConstant: 24).isActive = true
    leading.setContentHuggingPriority(.defaultLow, for: .horizontal)
    trailing.setContentHuggingPriority(.defaultLow, for: .horizontal)
    stack.addArrangedSubview(row)
    row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    view.setAccessibilityLabel(label.stringValue)
  }

  private func runBoundaryTitle(_ message: LoopMessageDTO) -> String {
    if let name = message.runName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
      return name
    }
    guard let raw = message.startedAt else { return "Loop" }
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = iso.date(from: raw) else { return "Loop" }
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter.string(from: date)
  }

  private func detailText(_ message: LoopMessageDTO) -> String {
    var lines: [String] = []
    if let sent = message.sent, !sent.isEmpty { lines.append("Sent message:\n\(sent)") }
    lines.append("Step: \(message.id)")
    if let cardID = message.cardId, !cardID.isEmpty { lines.append("Card: \(cardID)") }
    if let segment = message.segment { lines.append("Segment: \(segment)") }
    if let cycle = message.cycle { lines.append("Cycle: \(cycle)") }
    if let method = message.details?.method, !method.isEmpty { lines.append("Method: \(method)") }
    if let kind = message.details?.kind, !kind.isEmpty { lines.append("Session kind: \(kind)") }
    if let session = message.details?.sessionId, !session.isEmpty { lines.append("Session: \(session)") }
    if let file = message.details?.sessionFile, !file.isEmpty { lines.append("Session file: \(file)") }
    return lines.joined(separator: "\n")
  }

  @objc private func toggleDetails(_ sender: Any?) { onToggleDetails?(messageID) }
}

final class LoopWorkspaceView: NSView, NSCollectionViewDataSource, NSCollectionViewDelegateFlowLayout {
  private let breadcrumb = NSTextField(labelWithString: "Project / Loops")
  private let titleField = NSTextField(labelWithString: "Loops")
  private let statusDot = NSView()
  private let statusField = NSTextField(labelWithString: "Paused")
  private let pauseButton = NSButton(title: "Pause", target: nil, action: nil)
  private let overflowButton = NSButton()
  private let rolesStack = NSStackView()
  private let collection = AdaptiveCollectionView()
  private let segmentActions = NSStackView()
  private let bottomContainer = NSView()
  private let setupView = LoopSetupView()
  private var messages: [LoopMessageDTO] = []
  private var expanded = Set<String>()
  private var projectPath = ""
  private var workspace: LoopWorkspaceDTO?
  private(set) var run: LoopRunDetailSummaryDTO?

  var onAction: ((String, [String: Any]) -> Void)?
  var onStart: ((LoopSetupDraft) -> Void)?
  var onAttention: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    translatesAutoresizingMaskIntoConstraints = false
    build()
    setupView.onStart = { [weak self] draft in self?.onStart?(draft) }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func stateColor(_ state: String?) -> NSColor {
    switch state {
    case "waiting", "running": return .systemOrange
    case "your-turn": return .controlAccentColor
    case "needs-attention": return .systemRed
    case "complete": return .systemGreen
    default: return .secondaryLabelColor
    }
  }

  static func displayState(_ state: String?) -> String {
    switch state {
    case "waiting", "running": return "Waiting"
    case "your-turn": return "Your Turn"
    case "needs-attention": return "Needs Attention"
    case "complete": return "Complete"
    case "paused": return "Paused"
    case "stopped": return "Stopped"
    default: return ""
    }
  }

  private func build() {
    let dragRegion = WindowDragRegionView()
    dragRegion.translatesAutoresizingMaskIntoConstraints = false
    addSubview(dragRegion)

    let stack = NSStackView()
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12

    breadcrumb.font = NSFont.systemFont(ofSize: 11, weight: .medium)
    breadcrumb.textColor = .secondaryLabelColor
    let header = NSStackView()
    header.orientation = .horizontal
    header.alignment = .centerY
    header.spacing = 8
    titleField.font = NSFont.systemFont(ofSize: 22, weight: .semibold)
    titleField.lineBreakMode = .byTruncatingTail
    let headerSpacer = NSView()
    headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    statusDot.translatesAutoresizingMaskIntoConstraints = false
    statusDot.wantsLayer = true
    statusDot.layer?.cornerRadius = 4
    statusDot.widthAnchor.constraint(equalToConstant: 8).isActive = true
    statusDot.heightAnchor.constraint(equalToConstant: 8).isActive = true
    statusField.font = NSFont.systemFont(ofSize: 11, weight: .medium)
    pauseButton.target = self
    pauseButton.action = #selector(pausePressed)
    pauseButton.bezelStyle = .inline
    pauseButton.controlSize = .small
    pauseButton.setAccessibilityLabel("Pause Loop")
    overflowButton.target = self
    overflowButton.action = #selector(showOverflow)
    overflowButton.isBordered = false
    overflowButton.image = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: "More Loop actions")
    overflowButton.imagePosition = .imageOnly
    header.addArrangedSubview(titleField)
    header.addArrangedSubview(headerSpacer)
    header.addArrangedSubview(statusDot)
    header.addArrangedSubview(statusField)
    header.addArrangedSubview(pauseButton)
    header.addArrangedSubview(overflowButton)
    stack.addArrangedSubview(breadcrumb)
    stack.addArrangedSubview(header)
    header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    rolesStack.orientation = .horizontal
    rolesStack.alignment = .centerY
    rolesStack.spacing = 7
    stack.addArrangedSubview(rolesStack)
    rolesStack.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor).isActive = true

    let scroll = NSScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.borderType = .noBorder
    scroll.drawsBackground = false
    let layout = NSCollectionViewFlowLayout()
    layout.sectionInset = NSEdgeInsets(top: 4, left: 0, bottom: 12, right: 4)
    layout.minimumLineSpacing = 10
    collection.collectionViewLayout = layout
    collection.dataSource = self
    collection.delegate = self
    collection.isSelectable = false
    collection.backgroundColors = [.clear]
    collection.register(LoopMessageCollectionItem.self, forItemWithIdentifier: LoopMessageCollectionItem.identifier)
    scroll.documentView = collection
    stack.addArrangedSubview(scroll)
    scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 110).isActive = true
    scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
    scroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)

    segmentActions.orientation = .horizontal
    segmentActions.alignment = .centerY
    segmentActions.isHidden = true
    stack.addArrangedSubview(segmentActions)
    segmentActions.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    bottomContainer.translatesAutoresizingMaskIntoConstraints = false
    stack.addArrangedSubview(bottomContainer)
    bottomContainer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    addSubview(stack)
    NSLayoutConstraint.activate([
      dragRegion.leadingAnchor.constraint(equalTo: leadingAnchor),
      dragRegion.trailingAnchor.constraint(equalTo: trailingAnchor),
      dragRegion.topAnchor.constraint(equalTo: topAnchor),
      dragRegion.heightAnchor.constraint(equalToConstant: 58),
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 66),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -20),
    ])
  }

  func apply(run: LoopRunDetailSummaryDTO, messages: [LoopMessageDTO]) {
    self.run = run
    self.messages = messages
    segmentActions.isHidden = true
    expanded = expanded.intersection(Set(messages.map(\.id)))
    titleField.stringValue = run.name
    breadcrumb.stringValue = "Convobus / Loop"
    let display = Self.displayState(run.state)
    statusField.stringValue = display
    statusField.textColor = Self.stateColor(run.state)
    statusDot.layer?.backgroundColor = Self.stateColor(run.state).cgColor
    pauseButton.isHidden = !run.active || ["paused", "needs-attention"].contains(run.state)
    pauseButton.title = "Pause"
    rebuildRoles(run)
    rebuildBottom(run)
    collection.reloadData()
    setAccessibilityLabel("\(run.name), \(display)")
  }

  func applyProject(
    project: String,
    workspace: LoopWorkspaceDTO?,
    run: LoopRunDetailSummaryDTO?,
    messages: [LoopMessageDTO],
    routes: [LoopRouteChoice],
    currentRoute: LoopRouteChoice?
  ) {
    projectPath = project
    self.workspace = workspace
    self.run = run
    self.messages = messages
    expanded = expanded.intersection(Set(messages.map(\.id)))
    titleField.stringValue = "Loops"
    let projectName = URL(fileURLWithPath: project).lastPathComponent
    breadcrumb.stringValue = "\(projectName) / Loops"
    setupView.configure(
      project: project,
      routes: routes,
      currentRoute: currentRoute,
      workspace: workspace,
      showsCancel: false
    )

    let visibleState = run?.state ?? workspace?.latestRun?.state
    let display = Self.displayState(visibleState)
    statusField.stringValue = display
    statusField.textColor = Self.stateColor(visibleState)
    statusDot.layer?.backgroundColor = Self.stateColor(visibleState).cgColor
    statusDot.isHidden = display.isEmpty
    statusField.isHidden = display.isEmpty
    pauseButton.isHidden = run?.active != true || ["paused", "needs-attention"].contains(run?.state ?? "")
    overflowButton.isHidden = run == nil
    if let run {
      rebuildRoles(run)
      rebuildProjectBottom(run)
    } else if let workspace {
      rebuildRoles(
        leader: workspace.leader,
        builder: workspace.builder,
        reviewer: workspace.reviewer,
        activeRole: nil
      )
      installBottom(setupView)
    } else {
      clearRoles()
      installBottom(setupView)
    }
    collection.reloadData()
    setAccessibilityLabel(display.isEmpty ? "\(projectName), Loops" : "\(projectName), Loops, \(display)")
  }

  func setStartSubmitting(_ submitting: Bool) { setupView.setSubmitting(submitting) }

  func clearStartFields() { setupView.clearRunFields() }

  private func rebuildRoles(_ run: LoopRunDetailSummaryDTO) {
    rebuildRoles(
      leader: run.definition.leader,
      builder: run.definition.builder,
      reviewer: run.definition.reviewer,
      activeRole: run.active && run.state != "paused" ? run.nextRole : nil
    )
  }

  private func rebuildRoles(
    leader: LoopParticipantDTO,
    builder: LoopParticipantDTO?,
    reviewer: LoopParticipantDTO?,
    activeRole: String?
  ) {
    clearRoles()
    let entries: [(String, LoopParticipantDTO?)] = [
      ("Leader", leader),
      ("Builder", builder),
      ("Reviewer", reviewer),
    ]
    for (role, participant) in entries where participant != nil {
      guard let participant else { continue }
      let name: String
      if participant.kind == "human" { name = "Me" }
      else { name = participant.route?.label ?? participant.route?.providerName ?? "Provider" }
      let pill = LoopRolePillView()
      pill.update(text: "\(role) · \(name)", active: activeRole == role.lowercased())
      rolesStack.addArrangedSubview(pill)
    }
  }

  private func clearRoles() {
    for child in rolesStack.arrangedSubviews {
      rolesStack.removeArrangedSubview(child)
      child.removeFromSuperview()
    }
  }

  private func clearBottom() {
    for child in bottomContainer.subviews { child.removeFromSuperview() }
  }

  private func installBottom(_ view: NSView) {
    clearBottom()
    view.translatesAutoresizingMaskIntoConstraints = false
    bottomContainer.addSubview(view)
    NSLayoutConstraint.activate([
      view.leadingAnchor.constraint(equalTo: bottomContainer.leadingAnchor),
      view.trailingAnchor.constraint(equalTo: bottomContainer.trailingAnchor),
      view.topAnchor.constraint(equalTo: bottomContainer.topAnchor),
      view.bottomAnchor.constraint(equalTo: bottomContainer.bottomAnchor),
    ])
  }

  private func rebuildBottom(_ run: LoopRunDetailSummaryDTO) {
    segmentActions.isHidden = true
    if run.state == "your-turn" {
      installBottom(makeHumanComposer(run))
    } else if run.state == "paused" {
      installBottom(makePausedControls(run))
    } else if run.state == "complete" {
      let row = NSStackView()
      row.orientation = .horizontal
      let spacer = NSView()
      spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
      let button = NSButton(title: "Continue Loop…", target: self, action: #selector(continueSegment))
      button.bezelStyle = .rounded
      button.controlSize = .large
      row.addArrangedSubview(spacer)
      row.addArrangedSubview(button)
      installBottom(row)
    } else if run.state == "needs-attention" {
      installBottom(makeAttention(run))
    } else {
      clearBottom()
    }
  }

  private func rebuildProjectBottom(_ run: LoopRunDetailSummaryDTO) {
    if run.state == "complete" {
      for child in segmentActions.arrangedSubviews {
        segmentActions.removeArrangedSubview(child)
        child.removeFromSuperview()
      }
      let spacer = NSView()
      spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
      let continueButton = NSButton(title: "Continue Loop…", target: self, action: #selector(continueSegment))
      continueButton.bezelStyle = .rounded
      segmentActions.addArrangedSubview(spacer)
      segmentActions.addArrangedSubview(continueButton)
      segmentActions.isHidden = false
      installBottom(setupView)
      return
    }
    segmentActions.isHidden = true
    if run.state == "stopped" {
      installBottom(setupView)
      return
    }
    rebuildBottom(run)
  }

  private func makeHumanComposer(_ run: LoopRunDetailSummaryDTO) -> NSView {
    let panel = RoundedPanelView(
      fillColor: NSColor.controlBackgroundColor.withAlphaComponent(0.78),
      strokeColor: NSColor.separatorColor.withAlphaComponent(0.5),
      radius: 14
    )
    let stack = NSStackView()
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8
    let label = NSTextField(labelWithString: "Your turn as Leader")
    label.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
    let scroll = NSScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.hasVerticalScroller = true
    scroll.borderType = .lineBorder
    scroll.wantsLayer = true
    scroll.layer?.cornerRadius = 8
    let text = NSTextView()
    text.isEditable = true
    text.isSelectable = true
    text.isRichText = false
    text.font = NSFont.systemFont(ofSize: 13)
    text.autoresizingMask = [.width]
    text.textContainerInset = NSSize(width: 8, height: 7)
    text.isVerticallyResizable = true
    text.isHorizontallyResizable = false
    text.textContainer?.widthTracksTextView = true
    text.drawsBackground = true
    text.backgroundColor = .textBackgroundColor
    text.setAccessibilityLabel("Loop reply")
    scroll.documentView = text
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 72).isActive = true
    let footer = NSStackView()
    footer.orientation = .horizontal
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let send = LoopClosureButton(title: "Send") { [weak self, weak text] in
      let value = text?.string.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard !value.isEmpty else { return }
      self?.onAction?("human-turn", ["body": value])
    }
    send.bezelStyle = .rounded
    send.controlSize = .large
    send.image = NSImage(systemSymbolName: "paperplane.fill", accessibilityDescription: nil)
    send.imagePosition = .imageLeading
    footer.addArrangedSubview(spacer)
    footer.addArrangedSubview(send)
    stack.addArrangedSubview(label)
    stack.addArrangedSubview(scroll)
    stack.addArrangedSubview(footer)
    scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    footer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    panel.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: panel.topAnchor, constant: 13),
      stack.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -13),
    ])
    return panel
  }

  private func makePausedControls(_ run: LoopRunDetailSummaryDTO) -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 8
    let role = (run.nextRole ?? "role").prefix(1).uppercased() + (run.nextRole ?? "role").dropFirst()
    let label = NSTextField(labelWithString: "Next · \(role)")
    label.font = NSFont.systemFont(ofSize: 11, weight: .medium)
    label.textColor = .secondaryLabelColor
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let resume = actionButton("Continue", action: "resume")
    let correction = actionButton("Add Correction…", action: "prompt-correction")
    let takeover = actionButton("Reply as Me", action: "prompt-takeover")
    row.addArrangedSubview(label)
    row.addArrangedSubview(spacer)
    row.addArrangedSubview(resume)
    row.addArrangedSubview(correction)
    row.addArrangedSubview(takeover)
    return row
  }

  private func makeAttention(_ run: LoopRunDetailSummaryDTO) -> NSView {
    let panel = RoundedPanelView(
      fillColor: NSColor.systemRed.withAlphaComponent(0.09),
      strokeColor: NSColor.systemRed.withAlphaComponent(0.30),
      radius: 11
    )
    let row = NSStackView()
    row.translatesAutoresizingMaskIntoConstraints = false
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 9
    let symbol = NSImageView(image: NSImage(systemSymbolName: "exclamationmark.circle.fill", accessibilityDescription: nil) ?? NSImage())
    symbol.contentTintColor = .systemRed
    let reason = NSTextField(wrappingLabelWithString: run.reason ?? "This Loop needs attention.")
    reason.font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
    reason.setContentHuggingPriority(.defaultLow, for: .horizontal)
    row.addArrangedSubview(symbol)
    row.addArrangedSubview(reason)
    if run.action == "accept-gate" {
      row.addArrangedSubview(actionButton("Accept", action: "accept-gate"))
      row.addArrangedSubview(actionButton("Edit", action: "edit-gate"))
    } else {
      let title: String
      switch run.action {
      case "allow-accessibility": title = "Allow Access"
      case "choose-folder": title = "Choose Folder"
      case "confirm-session": title = "Confirm Session"
      case "open-provider", "switch-surface": title = "Open \(run.nextRoute?.providerName ?? "Provider")"
      default: title = "Check Route"
      }
      let button = NSButton(title: title, target: self, action: #selector(attentionPressed))
      button.bezelStyle = .rounded
      button.controlSize = .small
      row.addArrangedSubview(button)
      if run.action != "confirm-session" && run.action != "check-reply" {
        row.addArrangedSubview(actionButton("Continue", action: "resume"))
      }
    }
    panel.addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 12),
      row.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -10),
      row.topAnchor.constraint(equalTo: panel.topAnchor, constant: 9),
      row.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -9),
    ])
    return panel
  }

  private func actionButton(_ title: String, action: String) -> NSButton {
    let button = LoopClosureButton(title: title) { [weak self] in self?.onAction?(action, [:]) }
    button.bezelStyle = .rounded
    button.controlSize = .small
    return button
  }

  @objc private func pausePressed(_ sender: Any?) { onAction?("pause", [:]) }
  @objc private func continueSegment(_ sender: Any?) { onAction?("prompt-continue-segment", [:]) }
  @objc private func attentionPressed(_ sender: Any?) { onAttention?() }

  @objc private func showOverflow(_ sender: NSButton) {
    let menu = NSMenu()
    if run?.state == "paused" {
      let resume = NSMenuItem(title: "Resume Loop", action: #selector(resumeFromMenu), keyEquivalent: "")
      resume.target = self
      menu.addItem(resume)
    }
    if run?.active == true {
      if !menu.items.isEmpty { menu.addItem(NSMenuItem.separator()) }
      let stop = NSMenuItem(title: "Stop Loop…", action: #selector(stopPressed), keyEquivalent: "")
      stop.target = self
      menu.addItem(stop)
    }
    guard !menu.items.isEmpty else { return }
    menu.popUp(positioning: nil, at: NSPoint(x: sender.bounds.maxX, y: sender.bounds.minY), in: sender)
  }

  @objc private func resumeFromMenu(_ sender: Any?) { onAction?("resume", [:]) }
  @objc private func stopPressed(_ sender: Any?) { onAction?("prompt-stop", [:]) }

  func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int {
    messages.count
  }

  func collectionView(
    _ collectionView: NSCollectionView,
    itemForRepresentedObjectAt indexPath: IndexPath
  ) -> NSCollectionViewItem {
    let item = collectionView.makeItem(
      withIdentifier: LoopMessageCollectionItem.identifier,
      for: indexPath
    ) as! LoopMessageCollectionItem
    let message = messages[indexPath.item]
    item.configure(message: message, expanded: expanded.contains(message.id), time: humanTime(message.completedAt ?? message.t))
    item.onToggleDetails = { [weak self, weak collectionView] id in
      guard let self else { return }
      if self.expanded.contains(id) { self.expanded.remove(id) }
      else { self.expanded.insert(id) }
      collectionView?.reloadData()
      collectionView?.collectionViewLayout?.invalidateLayout()
    }
    return item
  }

  func collectionView(
    _ collectionView: NSCollectionView,
    layout collectionViewLayout: NSCollectionViewLayout,
    sizeForItemAt indexPath: IndexPath
  ) -> NSSize {
    let width = max(320, collectionView.bounds.width - 4)
    let message = messages[indexPath.item]
    if message.kind == "run" { return NSSize(width: width, height: 42) }
    let text = message.content.isEmpty ? "Waiting for a reply…" : message.content
    let rect = (text as NSString).boundingRect(
      with: NSSize(width: max(180, width - 34), height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      attributes: [.font: NSFont.systemFont(ofSize: 13)]
    )
    var height = max(86, ceil(rect.height) + 70)
    if expanded.contains(message.id) {
      let detailLength = Double((message.sent ?? "").count + 180)
      height += max(52, CGFloat(ceil(detailLength / max(30, Double(width / 7)))) * 13)
    }
    return NSSize(width: width, height: height)
  }

  private func humanTime(_ raw: String?) -> String {
    guard let raw, !raw.isEmpty else { return "" }
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = iso.date(from: raw) else { return raw }
    let formatter = DateFormatter()
    formatter.dateStyle = Calendar.current.isDateInToday(date) ? .none : .short
    formatter.timeStyle = .short
    return formatter.string(from: date)
  }
}

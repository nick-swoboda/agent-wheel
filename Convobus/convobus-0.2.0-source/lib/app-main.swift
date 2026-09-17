import AppKit
import ApplicationServices
import Darwin
import Foundation

final class FlippedDocumentView: NSView {
  override var isFlipped: Bool { true }
}

final class WindowDragRegionView: NSView {
  override var mouseDownCanMoveWindow: Bool { true }
}

class StableSelectionTableView: NSTableView {
  var onUserSelection: ((Int) -> Void)?
  private(set) var isHandlingDirectInput = false

  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    let clickedRow = row(at: point)
    isHandlingDirectInput = true
    defer { isHandlingDirectInput = false }
    super.mouseDown(with: event)
    if clickedRow >= 0 {
      onUserSelection?(clickedRow)
    }
  }

  override func keyDown(with event: NSEvent) {
    let previousRow = selectedRow
    isHandlingDirectInput = true
    defer { isHandlingDirectInput = false }
    super.keyDown(with: event)
    if selectedRow != previousRow, selectedRow >= 0 {
      onUserSelection?(selectedRow)
    }
  }
}

final class ProjectTableView: StableSelectionTableView {
  var contextMenuProvider: ((Int) -> NSMenu?)?

  override func menu(for event: NSEvent) -> NSMenu? {
    let point = convert(event.locationInWindow, from: nil)
    let clickedRow = row(at: point)
    guard clickedRow >= 0 else { return nil }
    return contextMenuProvider?(clickedRow)
  }
}

final class RouteStatusButton: NSButton {
  private var actionable = false

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    isBordered = false
    bezelStyle = .inline
    controlSize = .small
    imagePosition = .imageTrailing
    focusRingType = .exterior
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func hitTest(_ point: NSPoint) -> NSView? {
    actionable ? super.hitTest(point) : nil
  }

  override func resetCursorRects() {
    super.resetCursorRects()
    if actionable { addCursorRect(bounds, cursor: .pointingHand) }
  }

  func update(title: String, color: NSColor, actionable: Bool, help: String? = nil) {
    self.actionable = actionable
    attributedTitle = NSAttributedString(
      string: title,
      attributes: [
        .font: NSFont.systemFont(ofSize: 11, weight: .medium),
        .foregroundColor: color,
      ]
    )
    image = actionable
      ? NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)
      : nil
    contentTintColor = color
    toolTip = help
    setAccessibilityLabel(title)
    setAccessibilityHelp(help)
    setAccessibilityRole(actionable ? .button : .staticText)
    setAccessibilityValue(title)
    resetCursorRects()
  }
}

private enum RouteStatusAction {
  case none
  case allowAccessibility
  case chooseFolder
}

class RoundedPanelView: NSView {
  var fillColor: NSColor
  var strokeColor: NSColor?
  var radius: CGFloat

  init(fillColor: NSColor, strokeColor: NSColor? = nil, radius: CGFloat = 12) {
    self.fillColor = fillColor
    self.strokeColor = strokeColor
    self.radius = radius
    super.init(frame: .zero)
    wantsLayer = true
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var wantsUpdateLayer: Bool { true }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsDisplay = true
  }

  override func updateLayer() {
    layer?.cornerRadius = radius
    layer?.backgroundColor = fillColor.cgColor
    layer?.borderColor = strokeColor?.cgColor
    layer?.borderWidth = strokeColor == nil ? 0 : 1
  }
}

final class MessageBubbleView: RoundedPanelView {
  enum Tone { case outgoing, reply }

  init(text: String, tone: Tone) {
    let fill: NSColor = tone == .outgoing
      ? NSColor.controlAccentColor.withAlphaComponent(0.18)
      : NSColor.controlBackgroundColor.withAlphaComponent(0.88)
    super.init(fillColor: fill, strokeColor: nil, radius: 13)
    translatesAutoresizingMaskIntoConstraints = false

    let label = NSTextField(wrappingLabelWithString: text)
    label.translatesAutoresizingMaskIntoConstraints = false
    label.font = NSFont.systemFont(ofSize: 13)
    label.isSelectable = true
    label.textColor = .labelColor
    addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      label.topAnchor.constraint(equalTo: topAnchor, constant: 9),
      label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9),
      widthAnchor.constraint(greaterThanOrEqualToConstant: 180),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }
}

final class ProviderTableCellView: NSTableCellView {
  static let identifier = NSUserInterfaceItemIdentifier("ProviderTableCellView")
  private let iconView = NSImageView()
  private let primaryField = NSTextField(labelWithString: "")
  private let detailField = NSTextField(labelWithString: "")
  private let statusDot = NSView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    iconView.translatesAutoresizingMaskIntoConstraints = false
    iconView.imageScaling = .scaleProportionallyDown
    iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 15, weight: .medium)
    primaryField.translatesAutoresizingMaskIntoConstraints = false
    primaryField.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
    primaryField.lineBreakMode = .byTruncatingTail
    detailField.translatesAutoresizingMaskIntoConstraints = false
    detailField.font = NSFont.systemFont(ofSize: 10.5)
    detailField.textColor = .secondaryLabelColor
    detailField.lineBreakMode = .byTruncatingTail
    statusDot.translatesAutoresizingMaskIntoConstraints = false
    statusDot.wantsLayer = true
    statusDot.layer?.cornerRadius = 3.5
    addSubview(iconView)
    addSubview(primaryField)
    addSubview(detailField)
    addSubview(statusDot)
    NSLayoutConstraint.activate([
      iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
      iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
      iconView.widthAnchor.constraint(equalToConstant: 22),
      iconView.heightAnchor.constraint(equalToConstant: 22),
      primaryField.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 9),
      primaryField.topAnchor.constraint(equalTo: topAnchor, constant: 7),
      primaryField.trailingAnchor.constraint(lessThanOrEqualTo: statusDot.leadingAnchor, constant: -8),
      detailField.leadingAnchor.constraint(equalTo: primaryField.leadingAnchor),
      detailField.topAnchor.constraint(equalTo: primaryField.bottomAnchor, constant: 1),
      detailField.trailingAnchor.constraint(lessThanOrEqualTo: statusDot.leadingAnchor, constant: -8),
      statusDot.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -9),
      statusDot.centerYAnchor.constraint(equalTo: centerYAnchor),
      statusDot.widthAnchor.constraint(equalToConstant: 7),
      statusDot.heightAnchor.constraint(equalToConstant: 7),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var backgroundStyle: NSView.BackgroundStyle {
    didSet {
      let selected = backgroundStyle == .emphasized
      primaryField.textColor = selected ? .alternateSelectedControlTextColor : .labelColor
      detailField.textColor = selected ? .alternateSelectedControlTextColor : .secondaryLabelColor
      iconView.contentTintColor = selected ? .alternateSelectedControlTextColor : .secondaryLabelColor
    }
  }

  func update(providerID: String, name: String, detail: String, status: String) {
    iconView.image = NSImage(systemSymbolName: Self.symbol(for: providerID), accessibilityDescription: nil)
    primaryField.stringValue = name
    detailField.stringValue = detail
    let dotColor: NSColor
    switch status {
    case "attached": dotColor = .systemGreen
    case "waiting", "needs-session", "switching": dotColor = .systemOrange
    case "blocked": dotColor = .systemRed
    default: dotColor = .tertiaryLabelColor
    }
    setAccessibilityLabel(name)
    setAccessibilityValue("\(detail), \(status)")
    statusDot.layer?.backgroundColor = dotColor.cgColor
  }

  private static func symbol(for provider: String) -> String {
    switch provider {
    case "claude": return "sparkles.rectangle.stack"
    case "chatgpt": return "wand.and.stars"
    case "cursor": return "cursorarrow.rays"
    case "grok": return "bolt.horizontal.circle"
    default: return "bubble.left.and.bubble.right"
    }
  }
}

final class ProjectTableCellView: NSTableCellView {
  static let identifier = NSUserInterfaceItemIdentifier("ProjectTableCellView")
  private let iconView = NSImageView()
  private let primaryField = NSTextField(labelWithString: "")
  private let detailField = NSTextField(labelWithString: "")
  private var primaryTopConstraint: NSLayoutConstraint?
  private var primaryCenterConstraint: NSLayoutConstraint?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    iconView.translatesAutoresizingMaskIntoConstraints = false
    iconView.image = NSImage(systemSymbolName: "folder.fill", accessibilityDescription: nil)
    iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
    primaryField.translatesAutoresizingMaskIntoConstraints = false
    primaryField.font = NSFont.systemFont(ofSize: 12, weight: .medium)
    primaryField.lineBreakMode = .byTruncatingTail
    detailField.translatesAutoresizingMaskIntoConstraints = false
    detailField.font = NSFont.systemFont(ofSize: 10)
    detailField.textColor = .secondaryLabelColor
    detailField.lineBreakMode = .byTruncatingMiddle
    addSubview(iconView)
    addSubview(primaryField)
    addSubview(detailField)
    let top = primaryField.topAnchor.constraint(equalTo: topAnchor, constant: 5)
    let center = primaryField.centerYAnchor.constraint(equalTo: centerYAnchor)
    primaryTopConstraint = top
    primaryCenterConstraint = center
    NSLayoutConstraint.activate([
      iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 7),
      iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
      iconView.widthAnchor.constraint(equalToConstant: 18),
      primaryField.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 7),
      primaryField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
      top,
      detailField.leadingAnchor.constraint(equalTo: primaryField.leadingAnchor),
      detailField.trailingAnchor.constraint(equalTo: primaryField.trailingAnchor),
      detailField.topAnchor.constraint(equalTo: primaryField.bottomAnchor, constant: 1),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var backgroundStyle: NSView.BackgroundStyle {
    didSet {
      let selected = backgroundStyle == .emphasized
      primaryField.textColor = selected ? .alternateSelectedControlTextColor : .labelColor
      detailField.textColor = selected ? .alternateSelectedControlTextColor : .secondaryLabelColor
      iconView.contentTintColor = selected ? .alternateSelectedControlTextColor : .secondaryLabelColor
    }
  }

  func update(projectPath: String, name: String, detail: String, exists: Bool) {
    primaryField.stringValue = name
    detailField.stringValue = detail
    detailField.isHidden = detail.isEmpty
    primaryTopConstraint?.isActive = false
    primaryCenterConstraint?.isActive = false
    if detail.isEmpty {
      primaryCenterConstraint?.isActive = true
    } else {
      primaryTopConstraint?.isActive = true
    }
    toolTip = projectPath
    setAccessibilityLabel(name)
    setAccessibilityValue(
      detail.isEmpty
        ? (exists ? "available" : "missing")
        : "\(detail), \(exists ? "available" : "missing")"
    )
    primaryField.textColor = exists ? .labelColor : .tertiaryLabelColor
    detailField.textColor = exists ? .secondaryLabelColor : .tertiaryLabelColor
    iconView.contentTintColor = exists ? .secondaryLabelColor : .tertiaryLabelColor
  }
}

struct ConversationRecord {
  let id: String
  let body: String
  let reply: String
  let timestamp: String
  let status: String
  let details: String
}

final class AdaptiveCollectionView: NSCollectionView {
  override func setFrameSize(_ newSize: NSSize) {
    let widthChanged = abs(frame.size.width - newSize.width) > 0.5
    super.setFrameSize(newSize)
    if widthChanged { collectionViewLayout?.invalidateLayout() }
  }
}

final class ConversationCollectionItem: NSCollectionViewItem {
  static let identifier = NSUserInterfaceItemIdentifier("ConversationCollectionItem")
  private let stack = NSStackView()
  private var cardID = ""
  var onToggleDetails: ((String) -> Void)?

  override func loadView() {
    let panel = RoundedPanelView(
      fillColor: NSColor.controlBackgroundColor.withAlphaComponent(0.62),
      strokeColor: NSColor.separatorColor.withAlphaComponent(0.38),
      radius: 14
    )
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 9
    panel.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: panel.topAnchor, constant: 14),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: panel.bottomAnchor, constant: -14),
    ])
    view = panel
  }

  func configure(record: ConversationRecord, expanded: Bool) {
    cardID = record.id
    for child in stack.arrangedSubviews {
      stack.removeArrangedSubview(child)
      child.removeFromSuperview()
    }

    let header = NSStackView()
    header.orientation = .horizontal
    header.alignment = .centerY
    header.spacing = 7
    let dot = NSView()
    dot.translatesAutoresizingMaskIntoConstraints = false
    dot.wantsLayer = true
    dot.layer?.cornerRadius = 3.5
    dot.layer?.backgroundColor = (record.status == "Waiting" ? NSColor.systemOrange : NSColor.systemGreen).cgColor
    dot.widthAnchor.constraint(equalToConstant: 7).isActive = true
    dot.heightAnchor.constraint(equalToConstant: 7).isActive = true
    let state = NSTextField(labelWithString: record.status)
    state.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let time = NSTextField(labelWithString: record.timestamp)
    time.font = NSFont.systemFont(ofSize: 10.5)
    time.textColor = .secondaryLabelColor
    header.addArrangedSubview(dot)
    header.addArrangedSubview(state)
    header.addArrangedSubview(spacer)
    header.addArrangedSubview(time)
    stack.addArrangedSubview(header)
    header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    let outgoingRow = NSStackView()
    outgoingRow.orientation = .horizontal
    outgoingRow.alignment = .top
    let outgoingSpacer = NSView()
    outgoingSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let outgoing = MessageBubbleView(text: record.body, tone: .outgoing)
    outgoingRow.addArrangedSubview(outgoingSpacer)
    outgoingRow.addArrangedSubview(outgoing)
    outgoing.widthAnchor.constraint(lessThanOrEqualTo: outgoingRow.widthAnchor, multiplier: 0.78).isActive = true
    stack.addArrangedSubview(outgoingRow)
    outgoingRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    var lastMessageView: NSView = outgoingRow
    if !record.reply.isEmpty {
      let replyRow = NSStackView()
      replyRow.orientation = .horizontal
      replyRow.alignment = .top
      let reply = MessageBubbleView(text: record.reply, tone: .reply)
      let replySpacer = NSView()
      replySpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
      replyRow.addArrangedSubview(reply)
      replyRow.addArrangedSubview(replySpacer)
      reply.widthAnchor.constraint(lessThanOrEqualTo: replyRow.widthAnchor, multiplier: 0.78).isActive = true
      stack.addArrangedSubview(replyRow)
      replyRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
      lastMessageView = replyRow
    } else {
      let waiting = NSTextField(labelWithString: "Waiting for a reply…")
      waiting.font = NSFont.systemFont(ofSize: 11)
      waiting.textColor = .secondaryLabelColor
      stack.addArrangedSubview(waiting)
      lastMessageView = waiting
    }

    stack.setCustomSpacing(18, after: lastMessageView)
    let details = NSButton(title: expanded ? "Hide Details" : "Details", target: self, action: #selector(toggleDetails))
    details.bezelStyle = .inline
    details.controlSize = .small
    details.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
    details.imagePosition = .imageLeading
    details.setAccessibilityLabel(expanded ? "Hide technical details" : "Show technical details")
    let detailsFooter = NSStackView()
    detailsFooter.orientation = .horizontal
    detailsFooter.alignment = .centerY
    let detailsSpacer = NSView()
    detailsSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    detailsFooter.addArrangedSubview(detailsSpacer)
    detailsFooter.addArrangedSubview(details)
    stack.addArrangedSubview(detailsFooter)
    detailsFooter.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    if expanded {
      let metadata = NSTextField(wrappingLabelWithString: record.details)
      metadata.font = NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)
      metadata.textColor = .secondaryLabelColor
      metadata.isSelectable = true
      metadata.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      stack.addArrangedSubview(metadata)
      metadata.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    view.setAccessibilityLabel("\(record.status) conversation at \(record.timestamp)")
  }

  @objc private func toggleDetails(_ sender: Any?) { onToggleDetails?(cardID) }
}

private enum StatusItemKeeper {
  static var item: NSStatusItem?
}

final class PillToggleButton: NSButton {
  private var pillTitle: String
  private var isApprovalHighlighted = false

  override var state: NSControl.StateValue {
    didSet { updatePillAppearance() }
  }

  override var isEnabled: Bool {
    didSet { updatePillAppearance() }
  }

  init(title: String, target: AnyObject?, action: Selector?) {
    pillTitle = title
    super.init(frame: .zero)
    self.target = target
    self.action = action
    setButtonType(.toggle)
    isBordered = false
    alignment = .center
    focusRingType = .exterior
    font = NSFont.systemFont(ofSize: 12, weight: .semibold)
    image = nil
    imagePosition = .noImage
    wantsLayer = true
    layer?.cornerRadius = 17
    layer?.cornerCurve = .continuous
    layer?.borderWidth = 1
    updatePillAppearance()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    updatePillAppearance()
  }

  func setApprovalHighlighted(_ highlighted: Bool) {
    isApprovalHighlighted = highlighted
    updatePillAppearance()
  }

  func setPillTitle(_ title: String) {
    pillTitle = title
    updatePillAppearance()
  }

  private func updatePillAppearance() {
    let selected = state == .on
    let foreground: NSColor = isApprovalHighlighted ? .white : .labelColor
    layer?.backgroundColor = isApprovalHighlighted
      ? NSColor.controlAccentColor.cgColor
      : NSColor.controlBackgroundColor.withAlphaComponent(0.52).cgColor
    layer?.borderColor = isApprovalHighlighted
      ? NSColor.controlAccentColor.cgColor
      : NSColor.separatorColor.withAlphaComponent(0.65).cgColor
    alphaValue = isEnabled ? 1 : 0.55
    contentTintColor = foreground
    attributedTitle = NSAttributedString(
      string: pillTitle,
      attributes: [
        .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
        .foregroundColor: foreground,
      ]
    )
    setAccessibilityValue(selected ? "On" : "Off")
  }
}

final class PillActionButton: NSButton {
  private let pillTitle: String
  private var active = false

  init(title: String, target: AnyObject?, action: Selector?) {
    pillTitle = title
    super.init(frame: .zero)
    self.target = target
    self.action = action
    setButtonType(.momentaryPushIn)
    isBordered = false
    alignment = .center
    focusRingType = .exterior
    wantsLayer = true
    layer?.cornerRadius = 17
    layer?.cornerCurve = .continuous
    layer?.borderWidth = 1
    refreshAppearance()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    refreshAppearance()
  }

  func setActive(_ value: Bool) {
    active = value
    refreshAppearance()
  }

  private func refreshAppearance() {
    let foreground: NSColor = active ? .white : .labelColor
    layer?.backgroundColor = active
      ? NSColor.controlAccentColor.cgColor
      : NSColor.controlBackgroundColor.withAlphaComponent(0.52).cgColor
    layer?.borderColor = active
      ? NSColor.controlAccentColor.cgColor
      : NSColor.separatorColor.withAlphaComponent(0.65).cgColor
    attributedTitle = NSAttributedString(
      string: pillTitle,
      attributes: [
        .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
        .foregroundColor: foreground,
      ]
    )
    setAccessibilityValue(active ? "Selected" : "Not selected")
  }
}

final class ProviderAvailabilityRowView: NSView {
  private let nameField = NSTextField(labelWithString: "")
  private let statusField = NSTextField(labelWithString: "")
  private let statusDot = NSView()

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    translatesAutoresizingMaskIntoConstraints = false
    nameField.translatesAutoresizingMaskIntoConstraints = false
    nameField.font = NSFont.systemFont(ofSize: 13, weight: .medium)
    statusField.translatesAutoresizingMaskIntoConstraints = false
    statusField.font = NSFont.systemFont(ofSize: 11, weight: .medium)
    statusField.textColor = .secondaryLabelColor
    statusDot.translatesAutoresizingMaskIntoConstraints = false
    statusDot.wantsLayer = true
    statusDot.layer?.cornerRadius = 3.5
    addSubview(nameField)
    addSubview(statusDot)
    addSubview(statusField)
    NSLayoutConstraint.activate([
      heightAnchor.constraint(equalToConstant: 40),
      nameField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      nameField.centerYAnchor.constraint(equalTo: centerYAnchor),
      statusField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      statusField.centerYAnchor.constraint(equalTo: centerYAnchor),
      statusDot.trailingAnchor.constraint(equalTo: statusField.leadingAnchor, constant: -7),
      statusDot.centerYAnchor.constraint(equalTo: centerYAnchor),
      statusDot.widthAnchor.constraint(equalToConstant: 7),
      statusDot.heightAnchor.constraint(equalToConstant: 7),
      nameField.trailingAnchor.constraint(lessThanOrEqualTo: statusDot.leadingAnchor, constant: -12),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func update(name: String, found: Bool) {
    nameField.stringValue = name
    statusField.stringValue = found ? "Found" : "Not Found"
    statusDot.layer?.backgroundColor = (found ? NSColor.systemGreen : NSColor.systemRed).cgColor
    setAccessibilityLabel(name)
    setAccessibilityValue(statusField.stringValue)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextViewDelegate {
  var window: NSWindow?
  var providerRows: [[String: Any]] = []
  var projectRows: [[String: Any]] = []
  var visibleProjectRows: [[String: Any]] = []
  var loopRows: [[String: Any]] = []
  var lastProjectByProvider: [String: String] = [:]
  var selectedProviderID = "claude"
  var selectedProjectPath = ""
  var selectedSurface = "app"
  var selectedType = "chat"
  var providerTableView: NSTableView?
  var projectTableView: NSTableView?
  var projectEmptyLabel: NSTextField?
  var loopTableView: NSTableView?
  var loopEmptyLabel: NSTextField?
  var loopSidebarAddButton: NSButton?
  var projectTableHeightConstraint: NSLayoutConstraint?
  var loopTableHeightConstraint: NSLayoutConstraint?
  var providerModelLoaded = false
  var providerModelFingerprint = ""
  var projectModelFingerprint = ""
  var loopModelFingerprint = ""
  var bootstrapCacheFingerprint = ""
  var stableProjectOrderByProvider: [String: [String]] = [:]
  var suppressTableSelection = false
  let selectionCoordinator = ContextSelectionCoordinator()
  var confirmedContext: ContextSelection? {
    get { selectionCoordinator.confirmed }
    set { selectionCoordinator.confirmed = newValue }
  }
  var desiredContext: ContextSelection? {
    get { selectionCoordinator.desired }
    set { selectionCoordinator.desired = newValue }
  }
  var writeInFlightContext: ContextSelection? {
    get { selectionCoordinator.writeInFlight }
    set { selectionCoordinator.writeInFlight = newValue }
  }
  var contextWriteInFlight: Bool {
    get { selectionCoordinator.writeIsActive }
    set { selectionCoordinator.writeIsActive = newValue }
  }
  var contextWriteDebounceWorkItem: DispatchWorkItem?
  var providerAwaitingProject: String?
  var missingProjectContext: ContextSelection?
  var hasAdoptedServerContext = false
  var cardsRequestRevision = 0
  var contextSelectionEpoch: Int {
    get { selectionCoordinator.epoch }
    set { selectionCoordinator.epoch = newValue }
  }
  var breadcrumbField: NSTextField?
  var routeTitleField: NSTextField?
  var routeStatusButton: RouteStatusButton?
  var routeStatusDot: NSView?
  private var routeStatusAction: RouteStatusAction = .none
  var routeStatusReason: String?
  var surfaceControl: NSSegmentedControl?
  var typeControl: NSSegmentedControl?
  var routeHelpField: NSTextField?
  var typeRoutes: [[String: Any]] = []
  var workspaceContentView: NSView?
  var settingsContentView: NSView?
  var loopContentView: NSView?
  var loopWorkspaceView: LoopWorkspaceView?
  var settingsButton: PillActionButton?
  var providerAvailabilityRows: [String: ProviderAvailabilityRowView] = [:]
  var showingSettings = false
  var showingLoop = false
  var selectedLoopID: String?
  var selectedLoopRunID: String?
  var loopWorkspaceProjectPath: String?
  var currentLoopWorkspace: LoopWorkspaceDTO?
  var loopWorkspaces: [LoopWorkspaceDTO] = []
  var loopLoadRevision = 0
  var loopHistoryLoadRevision = 0
  var loadedLoopRunRevision = -1
  var loadedLoopRunDetail: LoopRunDetailSummaryDTO?
  var loadedLoopMessages: [LoopMessageDTO] = []
  var loadedLoopMessageRunID: String?
  var loadedLoopHistory: [LoopMessageDTO] = []
  var loadedLoopHistoryProject: String?
  var collectionView: NSCollectionView?
  var conversationSurfaceView: NSView?
  var composerView: NSView?
  var directComposerView: NSView?
  var directLoopSetupView: LoopSetupView?
  var loopComposerButton: NSButton?
  var loopSetupMode = false
  var loopStartInFlight = false
  var conversationRecords: [ConversationRecord] = []
  var expandedCardIDs = Set<String>()
  var conversationEmptyView: NSView?
  var conversationEmptyTitle: NSTextField?
  var conversationEmptyDetail: NSTextField?
  var conversationEmptyAction: NSButton?
  var attachPanel: NSView?
  var attachInstructionField: NSTextField?
  var attachButton: NSButton?
  var copyCommandButton: NSButton?
  var currentAttach: [String: Any]?
  var activeRouteStatus = "loading"
  var contextCardsLoaded = false
  var contextStatusLoaded = false
  var refreshInFlight = false
  var lastProviderModel: [String: Any]?
  var projectsMenu: NSMenu?
  var loopMenuPauseItem: NSMenuItem?
  var loopMenuStopItem: NSMenuItem?
  var activeMenuLoop: [String: Any]?
  var bodyView: NSTextView?
  var statusField: NSTextField?
  var sendButton: NSButton?
  var statusItem: NSStatusItem?
  var statusMenuHeader: NSMenuItem?
  var statusMenuOpenItem: NSMenuItem?
  var refreshTimer: Timer?
  var serverProcess: Process?
  var adoptedServerPID: pid_t?
  var fullQuitRequested = false
  var sending = false
  let serverIdentity = NativeServerIdentity()
  var axBox: NSButton?
  var accessibilityFeedbackPopover: NSPopover?
  var accessibilityFeedbackWorkItem: DispatchWorkItem?
  var accessibilityApprovalPollRevision = 0
  var gateBox: NSView?
  var gateReason: NSTextField?
  var pendingId: String?
  var lastToken = ""
  var iconState = "idle"

  var root: String {
    let args = Array(CommandLine.arguments.dropFirst())
    if let i = args.firstIndex(of: "--root"), i + 1 < args.count { return args[i + 1] }
    if let env = ProcessInfo.processInfo.environment["CONVO_ROOT"], !env.isEmpty { return env }
    return defaultConvobusRoot()
  }

  private func bundledProviderCatalog() -> [[String: Any]] {
    guard let url = Bundle.main.url(forResource: "provider-catalog", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let catalog = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          catalog["catalogVersion"] as? Int == 2,
          let providers = catalog["providers"] as? [[String: Any]],
          providers.count == 4,
          providers.reduce(0, { total, provider in
            total + ((provider["routes"] as? [[String: Any]])?.count ?? 0)
          }) == 11
    else { return [] }
    return providers.compactMap { provider in
      guard let id = provider["id"] as? String,
            let name = provider["name"] as? String,
            let routes = provider["routes"] as? [[String: Any]]
      else { return nil }
      let publicRoutes = routes.map { route -> [String: Any] in
        var value = route
        value["provider"] = id
        value["installed"] = true
        return value
      }
      return ["id": id, "name": name, "routes": publicRoutes]
    }
  }

  private func bootstrapProviderState() {
    providerRows = bundledProviderCatalog()

    guard let ui = UserDefaults.standard.dictionary(forKey: "ConvobusBootstrapState") else { return }

    if let savedLast = ui["lastProjectByProvider"] as? [String: Any] {
      lastProjectByProvider = savedLast.reduce(into: [:]) { result, entry in
        if let path = entry.value as? String, !path.isEmpty { result[entry.key] = path }
      }
    }

    let savedProjects = ui["projects"] as? [[String: Any]] ?? []
    projectRows = savedProjects.compactMap { project in
      guard let path = project["path"] as? String, !path.isEmpty else { return nil }
      let routes = project["routes"] as? [String: Any] ?? [:]
      return [
        "path": path,
        "name": URL(fileURLWithPath: path).lastPathComponent,
        "lastUsedAt": project["lastUsedAt"] as? String ?? "",
        "providers": Array(routes.keys).sorted(),
        "routes": routes,
        "exists": project["exists"] as? Bool ?? true,
      ]
    }.sorted {
      ($0["lastUsedAt"] as? String ?? "") > ($1["lastUsedAt"] as? String ?? "")
    }

    if let provider = ui["selectedProvider"] as? String,
       providerRows.contains(where: { ($0["id"] as? String) == provider })
    {
      selectedProviderID = provider
    }
    selectedProjectPath = (ui["selectedProject"] as? String) ?? lastProjectByProvider[selectedProviderID] ?? ""
    if let project = projectRows.first(where: { ($0["path"] as? String) == selectedProjectPath }),
       let routes = project["routes"] as? [String: Any],
       let route = routes[selectedProviderID] as? [String: Any]
    {
      selectedSurface = route["surface"] as? String ?? selectedSurface
      selectedType = route["type"] as? String ?? selectedType
    } else if let route = routes(for: selectedProviderID).first {
      selectedSurface = route["surface"] as? String ?? selectedSurface
      selectedType = route["type"] as? String ?? selectedType
    }
  }

  private func cacheBootstrapState(_ data: [String: Any]) {
    var cache: [String: Any] = [:]
    if let selection = data["selection"] as? [String: Any] {
      cache["selectedProvider"] = selection["provider"] as? String ?? selectedProviderID
      cache["selectedProject"] = selection["project"] as? String ?? selectedProjectPath
    }
    if let projects = data["projects"] as? [[String: Any]] { cache["projects"] = projects }
    if let last = data["lastProjectByProvider"] as? [String: Any] {
      cache["lastProjectByProvider"] = last
    }
    let fingerprint = jsonFingerprint(cache)
    if !cache.isEmpty, fingerprint != bootstrapCacheFingerprint {
      bootstrapCacheFingerprint = fingerprint
      UserDefaults.standard.set(cache, forKey: "ConvobusBootstrapState")
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    UserDefaults.standard.set(false, forKey: "NSQuitAlwaysKeepsWindows")
    NSWindow.allowsAutomaticWindowTabbing = false
    installBrandIcon()
    setupMenu()
    setupStatusItem()
    bootstrapProviderState()
    ensureWindow()
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }
      self.ensureServer()
      _ = self.httpJSON(
        method: "POST",
        path: "/api/accessibility",
        body: ["granted": AXIsProcessTrusted()]
      )
      self.refreshFeed()
    }
    refreshTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: true) { [weak self] _ in
      DispatchQueue.global(qos: .utility).async { [weak self] in
        guard let self else { return }
        self.refreshFeed()
      }
    }
    DispatchQueue.main.async { [weak self] in
      if let win = self?.window { self?.placeWindow(win) }
      NSApp.activate(ignoringOtherApps: true)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  private func systemRequestedTermination() -> Bool {
    let quitReasonKeyword = AEKeyword(0x7768793F) // 'why?'
    guard let reason = NSAppleEventManager.shared().currentAppleEvent?
      .paramDescriptor(forKeyword: quitReasonKeyword)?
      .typeCodeValue
    else { return false }
    let systemReasons: Set<OSType> = [
      OSType(0x71756961), // 'quia' — quit all
      OSType(0x73687574), // 'shut' — shut down
      OSType(0x72657374), // 'rest' — restart
      OSType(0x726C676F), // 'rlgo' — log out
    ]
    return systemReasons.contains(reason)
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if fullQuitRequested || systemRequestedTermination() { return .terminateNow }
    closeWindowKeepingMenuBar(nil)
    return .terminateCancel
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    NSApp.setActivationPolicy(.regular)
    ensureWindow()
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    return true
  }

  func windowWillClose(_ notification: Notification) {
    DispatchQueue.main.async {
      NSApp.setActivationPolicy(.accessory)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    refreshTimer?.invalidate()
    if let item = statusItem ?? StatusItemKeeper.item {
      NSStatusBar.system.removeStatusItem(item)
    }
    statusItem = nil
    StatusItemKeeper.item = nil
    if let loop = activeMenuLoop,
       let runID = loop["id"] as? String,
       let revision = loop["revision"] as? Int,
       (loop["state"] as? String) != "paused"
    {
      _ = httpJSON(
        method: "POST",
        path: "/api/loop-runs/\(runID)/action",
        body: [
          "requestId": UUID().uuidString.lowercased(),
          "revision": revision,
          "action": "pause",
        ],
        timeout: 1
      )
    }
    if let process = serverProcess, process.isRunning {
      process.terminate()
      let deadline = Date().addingTimeInterval(1.0)
      while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
      }
      if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
    } else if let pid = validatedAdoptedServerPID() {
      Darwin.kill(pid, SIGTERM)
      let deadline = Date().addingTimeInterval(1.0)
      while Darwin.kill(pid, 0) == 0 && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
      }
      if Darwin.kill(pid, 0) == 0 { Darwin.kill(pid, SIGKILL) }
    }
    serverProcess = nil
    adoptedServerPID = nil
  }

  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let menu = NSMenu()
    let show = NSMenuItem(title: "Open window", action: #selector(showWindowMenu), keyEquivalent: "")
    show.target = self
    menu.addItem(show)
    return menu
  }

  private func brandIcon() -> NSImage? {
    guard let path = Bundle.main.path(forResource: "ConvobusIcon", ofType: "png") else { return nil }
    return NSImage(contentsOfFile: path)
  }

  private func installBrandIcon() {
    guard let icon = brandIcon() else { return }
    NSApp.applicationIconImage = icon
  }

  private func menuBarBrandIcon() -> NSImage? {
    let icon: NSImage?
    if let path = Bundle.main.path(forResource: "ConvobusMenuTemplate", ofType: "png") {
      icon = NSImage(contentsOfFile: path)
    } else {
      icon = NSImage(systemSymbolName: "bubble.left.and.bubble.right.fill", accessibilityDescription: "Convobus")
    }
    guard let icon else { return nil }
    icon.isTemplate = true
    icon.size = NSSize(width: 18, height: 18)
    return icon
  }

  private func menuSymbol(_ name: String) -> NSImage? {
    let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)
    let configuration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
    return image?.withSymbolConfiguration(configuration)
  }

  private func setupMenu() {
    let menubar = NSMenu()
    let appItem = NSMenuItem()
    menubar.addItem(appItem)
    let appMenu = NSMenu()
    let show = NSMenuItem(title: "Open window", action: #selector(showWindowMenu), keyEquivalent: "0")
    show.target = self
    show.image = menuSymbol("macwindow")
    appMenu.addItem(show)
    appMenu.addItem(NSMenuItem.separator())
    let close = NSMenuItem(
      title: "Close Window — Keep Convobus Running",
      action: #selector(closeWindowKeepingMenuBar(_:)),
      keyEquivalent: "q"
    )
    close.target = self
    close.image = menuSymbol("macwindow.badge.minus")
    appMenu.addItem(close)
    appItem.submenu = appMenu
    NSApp.mainMenu = menubar
  }

  private func setupStatusItem() {
    let statusName = "ConvobusStatusItem"
    UserDefaults.standard.set(190, forKey: "NSStatusItem Preferred Position \(statusName)")
    UserDefaults.standard.set(true, forKey: "NSStatusItem Visible \(statusName)")
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.autosaveName = statusName
    item.isVisible = true
    if let button = item.button {
      button.image = menuBarBrandIcon()
      button.imagePosition = .imageOnly
      button.imageScaling = .scaleProportionallyDown
      button.title = ""
      button.toolTip = "Convobus"
      button.setAccessibilityLabel("Convobus menu")
    }
    let menu = NSMenu()

    let header = NSMenuItem(title: "Convobus · Stopped", action: nil, keyEquivalent: "")
    header.isEnabled = false
    header.image = menuSymbol("point.3.connected.trianglepath.dotted")
    menu.addItem(header)
    statusMenuHeader = header
    menu.addItem(NSMenuItem.separator())

    let open = NSMenuItem(title: "Open window", action: #selector(showWindowMenu), keyEquivalent: "")
    open.target = self
    open.image = menuSymbol("macwindow")
    menu.addItem(open)
    statusMenuOpenItem = open
    let loopPause = NSMenuItem(title: "Pause Loop", action: #selector(toggleActiveLoopFromMenu(_:)), keyEquivalent: "")
    loopPause.target = self
    loopPause.image = menuSymbol("pause.circle")
    loopPause.isHidden = true
    menu.addItem(loopPause)
    loopMenuPauseItem = loopPause
    let loopStop = NSMenuItem(title: "Stop Loop…", action: #selector(stopActiveLoopFromMenu(_:)), keyEquivalent: "")
    loopStop.target = self
    loopStop.image = menuSymbol("stop.circle")
    loopStop.isHidden = true
    menu.addItem(loopStop)
    loopMenuStopItem = loopStop
    let seats = NSMenuItem(title: "Projects", action: nil, keyEquivalent: "")
    seats.image = menuSymbol("folder")
    let sub = NSMenu()
    seats.submenu = sub
    projectsMenu = sub
    menu.addItem(seats)
    menu.addItem(NSMenuItem.separator())
    let quit = NSMenuItem(title: "Quit Convobus", action: #selector(quitFromStatusMenu(_:)), keyEquivalent: "q")
    quit.target = self
    quit.image = menuSymbol("power")
    menu.addItem(quit)
    item.menu = menu
    statusItem = item
    StatusItemKeeper.item = item
    ensureStatusItemPresentation(statusName: "Stopped")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      let name = self?.iconState == "idle" ? "Stopped" : (self?.iconState.capitalized ?? "Stopped")
      self?.ensureStatusItemPresentation(statusName: name)
    }
  }

  private func statusColor(_ status: String) -> NSColor {
    let normalized = status.lowercased()
    if normalized.contains("allow accessibility") || normalized.contains("folder missing") || normalized == "stopped" {
      return .systemRed
    }
    switch normalized {
    case "attached", "connected", "sent": return .systemGreen
    case "waiting", "running", "needs-session", "switching": return .systemOrange
    case "your turn": return .controlAccentColor
    case "complete": return .systemGreen
    case "blocked", "needs attention": return .systemRed
    default: return .secondaryLabelColor
    }
  }

  private func ensureStatusItemPresentation(statusName: String) {
    guard let item = statusItem ?? StatusItemKeeper.item,
          let button = item.button
    else { return }
    StatusItemKeeper.item = item
    statusItem = item
    item.isVisible = true
    button.isHidden = false
    button.isEnabled = true
    button.alphaValue = 1
    if button.image == nil { button.image = menuBarBrandIcon() }
    button.title = ""
    button.imagePosition = .imageOnly
    button.imageScaling = .scaleProportionallyDown
    button.contentTintColor = statusColor(statusName)
    item.length = NSStatusItem.squareLength
    if button.window == nil {
      item.isVisible = false
      item.isVisible = true
    }
  }

  @objc func showWindowMenu(_ sender: Any?) {
    NSApp.setActivationPolicy(.regular)
    ensureWindow()
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func openActiveLoopFromMenu(_ sender: Any?) {
    showWindowMenu(sender)
    guard let active = activeMenuLoop,
          let loopID = active["loopId"] as? String,
          let runID = active["id"] as? String,
          let project = active["project"] as? String
    else { return }
    selectedLoopID = loopID
    selectedLoopRunID = runID
    loopWorkspaceProjectPath = project
    loadedLoopRunRevision = -1
    loadedLoopRunDetail = nil
    if loadedLoopHistoryProject != project {
      loadedLoopHistory = []
      loadedLoopHistoryProject = nil
    }
    showLoopWorkspace()
    renderLoopWorkspace()
    loadLoopHistory(project: project)
    loadLoopRun(runID)
  }

  @objc private func toggleActiveLoopFromMenu(_ sender: Any?) {
    guard let loop = activeMenuLoop,
          let runID = loop["id"] as? String,
          let revision = loop["revision"] as? Int
    else { return }
    let action = (loop["state"] as? String) == "paused" ? "resume" : "pause"
    sendLoopMenuAction(runID: runID, revision: revision, action: action)
  }

  @objc private func stopActiveLoopFromMenu(_ sender: Any?) {
    guard let loop = activeMenuLoop,
          let runID = loop["id"] as? String,
          let revision = loop["revision"] as? Int,
          let window
    else { return }
    showWindowMenu(sender)
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Stop this Loop?"
    alert.informativeText = "The current message cannot be recalled. No further turns will be sent."
    alert.addButton(withTitle: "Stop Loop")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { [weak self] response in
      if response == .alertFirstButtonReturn {
        self?.sendLoopMenuAction(runID: runID, revision: revision, action: "stop")
      }
    }
  }

  private func sendLoopMenuAction(runID: String, revision: Int, action: String) {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      let result = self.httpJSON(
        method: "POST",
        path: "/api/loop-runs/\(runID)/action",
        body: [
          "requestId": UUID().uuidString.lowercased(),
          "revision": revision,
          "action": action,
        ]
      )
      DispatchQueue.main.async {
        if (result?["ok"] as? Bool) != true {
          self.presentLoopError(result?["error"] as? String ?? "The Loop could not be updated.")
        }
        self.refreshFeed()
      }
    }
  }

  @objc func closeWindowKeepingMenuBar(_ sender: Any?) {
    window?.orderOut(nil)
    DispatchQueue.main.async {
      NSApp.setActivationPolicy(.accessory)
    }
  }

  @objc func quitFromStatusMenu(_ sender: Any?) {
    fullQuitRequested = true
    NSApp.terminate(sender)
  }

  func placeWindow(_ win: NSWindow) {
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 120, y: 80, width: 900, height: 700)
    var frame = NSRect(x: 0, y: 0, width: 1040, height: 760)
    frame.origin.x = screen.midX - frame.width / 2
    frame.origin.y = screen.midY - frame.height / 2
    win.minSize = NSSize(width: 720, height: 520)
    win.contentMinSize = NSSize(width: 720, height: 520)
    win.setContentSize(NSSize(width: 1040, height: 760))
    win.setFrame(frame, display: true, animate: false)
    if ProcessInfo.processInfo.environment["CONVO_UI_TEST"] == "1" {
      win.contentView?.layoutSubtreeIfNeeded()
      return
    }
    win.makeKeyAndOrderFront(nil)
    win.orderFrontRegardless()
  }

  func ensureWindow() {
    if let win = window {
      if win.frame.width < 200 || win.frame.height < 200 {
        placeWindow(win)
      } else {
        win.makeKeyAndOrderFront(nil)
        win.orderFrontRegardless()
      }
      return
    }

    let rect = NSRect(x: 0, y: 0, width: 1040, height: 760)
    let win = NSWindow(
      contentRect: rect,
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    win.title = "Convobus"
    win.titleVisibility = .hidden
    win.titlebarAppearsTransparent = true
    win.toolbarStyle = .unified
    win.isMovableByWindowBackground = true
    win.isReleasedWhenClosed = false
    win.isRestorable = false
    win.setContentSize(NSSize(width: 1040, height: 760))

    let split = NSSplitViewController()
    split.splitView.isVertical = true
    split.splitView.dividerStyle = .thin

    let sidebarController = NSViewController()
    sidebarController.view = makeProviderSidebarView()
    let sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebarController)
    sidebarItem.minimumThickness = 230
    sidebarItem.maximumThickness = 300
    sidebarItem.preferredThicknessFraction = 0.27
    sidebarItem.canCollapse = false

    let contentController = NSViewController()
    contentController.view = makeMainContentContainer()
    let contentItem = NSSplitViewItem(viewController: contentController)
    contentItem.minimumThickness = 480

    split.addSplitViewItem(sidebarItem)
    split.addSplitViewItem(contentItem)
    win.contentViewController = split
    win.delegate = self
    window = win
    placeWindow(win)
    reloadProviderTableIfNeeded()
    updateVisibleProjects()
    refreshLoopSidebarForSelection()
    synchronizeTableSelections()
    configureRouteControls()
    applyLoadingState()
    showConversationEmpty()
  }

  private func makeProviderSidebarView() -> NSView {
    let sidebar = NSVisualEffectView()
    sidebar.material = .sidebar
    sidebar.blendingMode = .behindWindow
    sidebar.state = .active

    let dragRegion = WindowDragRegionView()
    dragRegion.translatesAutoresizingMaskIntoConstraints = false
    sidebar.addSubview(dragRegion)

    let stack = NSStackView()
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 7

    let brandRow = NSStackView()
    brandRow.orientation = .horizontal
    brandRow.alignment = .centerY
    brandRow.spacing = 10
    if let icon = brandIcon() {
      let iconView = NSImageView(image: icon)
      iconView.imageScaling = .scaleProportionallyUpOrDown
      iconView.translatesAutoresizingMaskIntoConstraints = false
      iconView.widthAnchor.constraint(equalToConstant: 36).isActive = true
      iconView.heightAnchor.constraint(equalToConstant: 36).isActive = true
      brandRow.addArrangedSubview(iconView)
    }
    let brandText = NSStackView()
    brandText.orientation = .vertical
    brandText.alignment = .leading
    let title = NSTextField(labelWithString: "Convobus")
    title.font = NSFont.systemFont(ofSize: 17, weight: .semibold)
    brandText.addArrangedSubview(title)
    brandRow.addArrangedSubview(brandText)
    stack.addArrangedSubview(brandRow)
    stack.setCustomSpacing(20, after: brandRow)

    let providersLabel = NSTextField(labelWithString: "PROVIDERS")
    providersLabel.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
    providersLabel.textColor = .secondaryLabelColor
    stack.addArrangedSubview(providersLabel)
    let providersTable = StableSelectionTableView()
    providersTable.translatesAutoresizingMaskIntoConstraints = false
    providersTable.identifier = NSUserInterfaceItemIdentifier("providers")
    providersTable.headerView = nil
    providersTable.rowHeight = 48
    providersTable.intercellSpacing = NSSize(width: 0, height: 2)
    providersTable.selectionHighlightStyle = .regular
    providersTable.style = .sourceList
    providersTable.allowsEmptySelection = false
    providersTable.allowsMultipleSelection = false
    providersTable.focusRingType = .none
    providersTable.dataSource = self
    providersTable.delegate = self
    providersTable.onUserSelection = { [weak self] row in
      self?.handleProviderSelection(row)
    }
    let providerColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("provider"))
    providerColumn.resizingMask = .autoresizingMask
    providersTable.addTableColumn(providerColumn)
    stack.addArrangedSubview(providersTable)
    providersTable.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    providersTable.heightAnchor.constraint(equalToConstant: 198).isActive = true
    providerTableView = providersTable
    stack.setCustomSpacing(15, after: providersTable)

    let projectContainer = NSView()
    projectContainer.translatesAutoresizingMaskIntoConstraints = false
    let lowerScroll = NSScrollView()
    lowerScroll.translatesAutoresizingMaskIntoConstraints = false
    lowerScroll.hasVerticalScroller = true
    lowerScroll.autohidesScrollers = true
    lowerScroll.drawsBackground = false
    lowerScroll.borderType = .noBorder
    let lowerDocument = FlippedDocumentView()
    lowerDocument.translatesAutoresizingMaskIntoConstraints = false
    let lowerStack = NSStackView()
    lowerStack.translatesAutoresizingMaskIntoConstraints = false
    lowerStack.orientation = .vertical
    lowerStack.alignment = .leading
    lowerStack.spacing = 6
    lowerDocument.addSubview(lowerStack)
    lowerScroll.documentView = lowerDocument

    let projectHeader = NSStackView()
    projectHeader.orientation = .horizontal
    projectHeader.alignment = .centerY
    let projectLabel = NSTextField(labelWithString: "PROJECTS")
    projectLabel.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
    projectLabel.textColor = .secondaryLabelColor
    let headerSpacer = NSView()
    headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let add = NSButton(title: "", target: self, action: #selector(addProject))
    add.image = NSImage(systemSymbolName: "plus", accessibilityDescription: "Add Project")
    add.bezelStyle = .inline
    add.toolTip = "Add Project…"
    add.setAccessibilityLabel("Add Project")
    projectHeader.addArrangedSubview(projectLabel)
    projectHeader.addArrangedSubview(headerSpacer)
    projectHeader.addArrangedSubview(add)
    lowerStack.addArrangedSubview(projectHeader)
    projectHeader.widthAnchor.constraint(equalTo: lowerStack.widthAnchor).isActive = true

    let projectsTable = ProjectTableView()
    projectsTable.translatesAutoresizingMaskIntoConstraints = false
    projectsTable.identifier = NSUserInterfaceItemIdentifier("projects")
    projectsTable.headerView = nil
    projectsTable.rowHeight = 43
    projectsTable.intercellSpacing = NSSize(width: 0, height: 2)
    projectsTable.selectionHighlightStyle = .regular
    projectsTable.style = .sourceList
    projectsTable.allowsEmptySelection = true
    projectsTable.allowsMultipleSelection = false
    projectsTable.focusRingType = .none
    projectsTable.dataSource = self
    projectsTable.delegate = self
    projectsTable.onUserSelection = { [weak self] row in
      self?.handleProjectSelection(row)
    }
    projectsTable.contextMenuProvider = { [weak self] row in
      self?.makeProjectContextMenu(row: row)
    }
    let projectColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("project"))
    projectColumn.resizingMask = .autoresizingMask
    projectsTable.addTableColumn(projectColumn)
    lowerStack.addArrangedSubview(projectsTable)
    projectsTable.widthAnchor.constraint(equalTo: lowerStack.widthAnchor).isActive = true
    let projectHeight = projectsTable.heightAnchor.constraint(equalToConstant: 0)
    projectHeight.isActive = true
    let empty = NSTextField(wrappingLabelWithString: "No projects yet. Add a folder to start.")
    empty.font = NSFont.systemFont(ofSize: 11)
    empty.textColor = .tertiaryLabelColor
    empty.alignment = .center
    lowerStack.addArrangedSubview(empty)
    empty.widthAnchor.constraint(equalTo: lowerStack.widthAnchor).isActive = true
    let sectionGap = NSView()
    sectionGap.translatesAutoresizingMaskIntoConstraints = false
    sectionGap.heightAnchor.constraint(equalToConstant: 9).isActive = true
    lowerStack.addArrangedSubview(sectionGap)
    sectionGap.widthAnchor.constraint(equalTo: lowerStack.widthAnchor).isActive = true

    let loopHeader = NSStackView()
    loopHeader.orientation = .horizontal
    loopHeader.alignment = .centerY
    let loopLabel = NSTextField(labelWithString: "LOOPS")
    loopLabel.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
    loopLabel.textColor = .secondaryLabelColor
    let loopHeaderSpacer = NSView()
    loopHeaderSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let addLoop = NSButton(title: "", target: self, action: #selector(newLoop(_:)))
    addLoop.image = NSImage(systemSymbolName: "plus", accessibilityDescription: "Start Loop")
    addLoop.bezelStyle = .inline
    addLoop.toolTip = "Start Loop"
    addLoop.setAccessibilityLabel("Start Loop")
    loopSidebarAddButton = addLoop
    loopHeader.addArrangedSubview(loopLabel)
    loopHeader.addArrangedSubview(loopHeaderSpacer)
    loopHeader.addArrangedSubview(addLoop)
    lowerStack.addArrangedSubview(loopHeader)
    loopHeader.widthAnchor.constraint(equalTo: lowerStack.widthAnchor).isActive = true

    let loopsTable = ProjectTableView()
    loopsTable.translatesAutoresizingMaskIntoConstraints = false
    loopsTable.identifier = NSUserInterfaceItemIdentifier("loops")
    loopsTable.headerView = nil
    loopsTable.rowHeight = 38
    loopsTable.intercellSpacing = NSSize(width: 0, height: 2)
    loopsTable.selectionHighlightStyle = .regular
    loopsTable.style = .sourceList
    loopsTable.allowsEmptySelection = true
    loopsTable.allowsMultipleSelection = false
    loopsTable.focusRingType = .none
    loopsTable.dataSource = self
    loopsTable.delegate = self
    loopsTable.onUserSelection = { [weak self] row in self?.handleLoopSelection(row) }
    loopsTable.contextMenuProvider = { [weak self] row in self?.makeLoopContextMenu(row: row) }
    let loopColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("loop"))
    loopColumn.resizingMask = .autoresizingMask
    loopsTable.addTableColumn(loopColumn)
    lowerStack.addArrangedSubview(loopsTable)
    loopsTable.widthAnchor.constraint(equalTo: lowerStack.widthAnchor).isActive = true
    let loopHeight = loopsTable.heightAnchor.constraint(equalToConstant: CGFloat(loopRows.count) * 40)
    loopHeight.isActive = true
    let noLoops = NSTextField(wrappingLabelWithString: "Select a project to use Loops.")
    noLoops.font = NSFont.systemFont(ofSize: 11)
    noLoops.textColor = .tertiaryLabelColor
    noLoops.alignment = .center
    lowerStack.addArrangedSubview(noLoops)
    noLoops.widthAnchor.constraint(equalTo: lowerStack.widthAnchor).isActive = true

    projectContainer.addSubview(lowerScroll)
    NSLayoutConstraint.activate([
      projectContainer.heightAnchor.constraint(greaterThanOrEqualToConstant: 86),
      lowerScroll.leadingAnchor.constraint(equalTo: projectContainer.leadingAnchor),
      lowerScroll.trailingAnchor.constraint(equalTo: projectContainer.trailingAnchor),
      lowerScroll.topAnchor.constraint(equalTo: projectContainer.topAnchor),
      lowerScroll.bottomAnchor.constraint(equalTo: projectContainer.bottomAnchor),
      lowerDocument.widthAnchor.constraint(equalTo: lowerScroll.contentView.widthAnchor),
      lowerStack.leadingAnchor.constraint(equalTo: lowerDocument.leadingAnchor),
      lowerStack.trailingAnchor.constraint(equalTo: lowerDocument.trailingAnchor, constant: -4),
      lowerStack.topAnchor.constraint(equalTo: lowerDocument.topAnchor),
      lowerStack.bottomAnchor.constraint(equalTo: lowerDocument.bottomAnchor, constant: -4),
    ])
    projectContainer.setContentHuggingPriority(.defaultLow, for: .vertical)
    projectContainer.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    stack.addArrangedSubview(projectContainer)
    projectContainer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    projectTableView = projectsTable
    projectEmptyLabel = empty
    loopTableView = loopsTable
    loopEmptyLabel = noLoops
    projectTableHeightConstraint = projectHeight
    loopTableHeightConstraint = loopHeight

    let divider = NSBox()
    divider.boxType = .separator
    stack.addArrangedSubview(divider)
    divider.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    stack.setCustomSpacing(14, after: divider)

    let settingsContainer = NSView()
    settingsContainer.translatesAutoresizingMaskIntoConstraints = false
    let settings = PillActionButton(title: "Settings", target: self, action: #selector(showSettings(_:)))
    settings.translatesAutoresizingMaskIntoConstraints = false
    settings.setAccessibilityLabel("Settings")
    settingsContainer.addSubview(settings)
    stack.addArrangedSubview(settingsContainer)
    settingsContainer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    NSLayoutConstraint.activate([
      settingsContainer.heightAnchor.constraint(equalToConstant: 40),
      settings.centerXAnchor.constraint(equalTo: settingsContainer.centerXAnchor),
      settings.centerYAnchor.constraint(equalTo: settingsContainer.centerYAnchor),
      settings.widthAnchor.constraint(equalToConstant: 164),
      settings.heightAnchor.constraint(equalToConstant: 34),
    ])
    settingsButton = settings

    sidebar.addSubview(stack)
    NSLayoutConstraint.activate([
      dragRegion.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor),
      dragRegion.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor),
      dragRegion.topAnchor.constraint(equalTo: sidebar.topAnchor),
      dragRegion.heightAnchor.constraint(equalToConstant: 58),
      stack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 64),
      stack.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor, constant: -16),
    ])
    return sidebar
  }

  private func makeMainContentContainer() -> NSView {
    let container = NSView()
    let workspace = makeProviderContentView()
    let settings = makeSettingsView()
    let loopWorkspace = LoopWorkspaceView()
    workspace.translatesAutoresizingMaskIntoConstraints = false
    settings.translatesAutoresizingMaskIntoConstraints = false
    loopWorkspace.translatesAutoresizingMaskIntoConstraints = false
    settings.isHidden = true
    loopWorkspace.isHidden = true
    container.addSubview(workspace)
    container.addSubview(settings)
    container.addSubview(loopWorkspace)
    NSLayoutConstraint.activate([
      workspace.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      workspace.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      workspace.topAnchor.constraint(equalTo: container.topAnchor),
      workspace.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      settings.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      settings.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      settings.topAnchor.constraint(equalTo: container.topAnchor),
      settings.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      loopWorkspace.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      loopWorkspace.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      loopWorkspace.topAnchor.constraint(equalTo: container.topAnchor),
      loopWorkspace.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ])
    workspaceContentView = workspace
    settingsContentView = settings
    loopContentView = loopWorkspace
    loopWorkspaceView = loopWorkspace
    loopWorkspace.onAction = { [weak self] action, values in
      self?.handleLoopWorkspaceAction(action, values: values)
    }
    loopWorkspace.onStart = { [weak self] draft in self?.startProjectLoop(draft) }
    loopWorkspace.onAttention = { [weak self] in self?.handleLoopAttention() }
    return container
  }

  private func makeSettingsView() -> NSView {
    let content = NSView()
    let dragRegion = WindowDragRegionView()
    dragRegion.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(dragRegion)

    let outer = NSStackView()
    outer.translatesAutoresizingMaskIntoConstraints = false
    outer.orientation = .vertical
    outer.alignment = .leading
    outer.spacing = 16
    let heading = NSTextField(labelWithString: "Settings")
    heading.font = NSFont.systemFont(ofSize: 24, weight: .semibold)
    outer.addArrangedSubview(heading)

    let scroll = NSScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.drawsBackground = false
    scroll.borderType = .noBorder
    let document = FlippedDocumentView()
    document.translatesAutoresizingMaskIntoConstraints = false
    let stack = NSStackView()
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    document.addSubview(stack)
    scroll.documentView = document
    outer.addArrangedSubview(scroll)
    scroll.widthAnchor.constraint(equalTo: outer.widthAnchor).isActive = true
    scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
    scroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)

    let accessibilityLabel = NSTextField(labelWithString: "ACCESSIBILITY")
    accessibilityLabel.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
    accessibilityLabel.textColor = .secondaryLabelColor
    stack.addArrangedSubview(accessibilityLabel)

    let accessibilityPanel = RoundedPanelView(
      fillColor: NSColor.controlBackgroundColor.withAlphaComponent(0.62),
      strokeColor: NSColor.separatorColor.withAlphaComponent(0.42),
      radius: 14
    )
    accessibilityPanel.translatesAutoresizingMaskIntoConstraints = false
    let accessibilityRow = NSStackView()
    accessibilityRow.translatesAutoresizingMaskIntoConstraints = false
    accessibilityRow.orientation = .horizontal
    accessibilityRow.alignment = .centerY
    accessibilityRow.spacing = 12
    let accessibilityText = NSStackView()
    accessibilityText.orientation = .vertical
    accessibilityText.alignment = .leading
    accessibilityText.spacing = 2
    let accessibilityTitle = NSTextField(labelWithString: "Control provider apps")
    accessibilityTitle.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
    let accessibilityDetail = NSTextField(labelWithString: "Used only when an App route needs macOS control.")
    accessibilityDetail.font = NSFont.systemFont(ofSize: 11)
    accessibilityDetail.textColor = .secondaryLabelColor
    accessibilityText.addArrangedSubview(accessibilityTitle)
    accessibilityText.addArrangedSubview(accessibilityDetail)
    let accessibilitySpacer = NSView()
    accessibilitySpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let accessibility = PillToggleButton(title: "Allow Access", target: self, action: #selector(axToggled))
    accessibility.translatesAutoresizingMaskIntoConstraints = false
    accessibility.toolTip = "Allow Convobus to control supported provider apps"
    accessibility.setAccessibilityLabel("Accessibility access")
    accessibility.setAccessibilityHelp("Allow Convobus to control supported provider apps")
    accessibility.widthAnchor.constraint(equalToConstant: 132).isActive = true
    accessibility.heightAnchor.constraint(equalToConstant: 34).isActive = true
    accessibilityRow.addArrangedSubview(accessibilityText)
    accessibilityRow.addArrangedSubview(accessibilitySpacer)
    accessibilityRow.addArrangedSubview(accessibility)
    accessibilityPanel.addSubview(accessibilityRow)
    NSLayoutConstraint.activate([
      accessibilityRow.leadingAnchor.constraint(equalTo: accessibilityPanel.leadingAnchor, constant: 16),
      accessibilityRow.trailingAnchor.constraint(equalTo: accessibilityPanel.trailingAnchor, constant: -16),
      accessibilityRow.topAnchor.constraint(equalTo: accessibilityPanel.topAnchor, constant: 13),
      accessibilityRow.bottomAnchor.constraint(equalTo: accessibilityPanel.bottomAnchor, constant: -13),
    ])
    stack.addArrangedSubview(accessibilityPanel)
    accessibilityPanel.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    axBox = accessibility
    stack.setCustomSpacing(20, after: accessibilityPanel)

    let providersLabel = NSTextField(labelWithString: "PROVIDERS")
    providersLabel.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
    providersLabel.textColor = .secondaryLabelColor
    stack.addArrangedSubview(providersLabel)
    let providersPanel = RoundedPanelView(
      fillColor: NSColor.controlBackgroundColor.withAlphaComponent(0.62),
      strokeColor: NSColor.separatorColor.withAlphaComponent(0.42),
      radius: 14
    )
    providersPanel.translatesAutoresizingMaskIntoConstraints = false
    let providersStack = NSStackView()
    providersStack.translatesAutoresizingMaskIntoConstraints = false
    providersStack.orientation = .vertical
    providersStack.alignment = .leading
    providersStack.spacing = 0
    for (index, provider) in providerRows.enumerated() {
      let id = provider["id"] as? String ?? ""
      let row = ProviderAvailabilityRowView()
      row.update(
        name: provider["name"] as? String ?? id.capitalized,
        found: ((provider["routes"] as? [[String: Any]]) ?? []).contains { ($0["installed"] as? Bool) == true }
      )
      providersStack.addArrangedSubview(row)
      row.widthAnchor.constraint(equalTo: providersStack.widthAnchor).isActive = true
      providerAvailabilityRows[id] = row
      if index < providerRows.count - 1 {
        let separator = NSBox()
        separator.boxType = .separator
        providersStack.addArrangedSubview(separator)
        separator.widthAnchor.constraint(equalTo: providersStack.widthAnchor).isActive = true
      }
    }
    providersPanel.addSubview(providersStack)
    NSLayoutConstraint.activate([
      providersStack.leadingAnchor.constraint(equalTo: providersPanel.leadingAnchor),
      providersStack.trailingAnchor.constraint(equalTo: providersPanel.trailingAnchor),
      providersStack.topAnchor.constraint(equalTo: providersPanel.topAnchor, constant: 3),
      providersStack.bottomAnchor.constraint(equalTo: providersPanel.bottomAnchor, constant: -3),
    ])
    stack.addArrangedSubview(providersPanel)
    providersPanel.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    stack.setCustomSpacing(20, after: providersPanel)

    let aboutLabel = NSTextField(labelWithString: "ABOUT CONVOBUS")
    aboutLabel.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
    aboutLabel.textColor = .secondaryLabelColor
    stack.addArrangedSubview(aboutLabel)
    let aboutPanel = RoundedPanelView(
      fillColor: NSColor.controlBackgroundColor.withAlphaComponent(0.62),
      strokeColor: NSColor.separatorColor.withAlphaComponent(0.42),
      radius: 14
    )
    aboutPanel.translatesAutoresizingMaskIntoConstraints = false
    let aboutStack = NSStackView()
    aboutStack.translatesAutoresizingMaskIntoConstraints = false
    aboutStack.orientation = .vertical
    aboutStack.alignment = .leading
    aboutStack.spacing = 4
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.2.0"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "8"
    let aboutTitle = NSTextField(labelWithString: "Convobus \(version) (\(build))")
    aboutTitle.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
    let aboutDescription = NSTextField(labelWithString: "Native routing for supported AI providers.")
    aboutDescription.font = NSFont.systemFont(ofSize: 11)
    aboutDescription.textColor = .secondaryLabelColor
    let license = NSTextField(labelWithString: "Open source · Apache License 2.0")
    license.font = NSFont.systemFont(ofSize: 11, weight: .medium)
    license.textColor = .secondaryLabelColor
    license.isSelectable = true
    aboutStack.addArrangedSubview(aboutTitle)
    aboutStack.addArrangedSubview(aboutDescription)
    aboutStack.addArrangedSubview(license)
    aboutPanel.addSubview(aboutStack)
    NSLayoutConstraint.activate([
      aboutStack.leadingAnchor.constraint(equalTo: aboutPanel.leadingAnchor, constant: 16),
      aboutStack.trailingAnchor.constraint(equalTo: aboutPanel.trailingAnchor, constant: -16),
      aboutStack.topAnchor.constraint(equalTo: aboutPanel.topAnchor, constant: 14),
      aboutStack.bottomAnchor.constraint(equalTo: aboutPanel.bottomAnchor, constant: -14),
    ])
    stack.addArrangedSubview(aboutPanel)
    aboutPanel.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    content.addSubview(outer)
    NSLayoutConstraint.activate([
      document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
      stack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -4),
      stack.topAnchor.constraint(equalTo: document.topAnchor),
      stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -4),
      dragRegion.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      dragRegion.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      dragRegion.topAnchor.constraint(equalTo: content.topAnchor),
      dragRegion.heightAnchor.constraint(equalToConstant: 58),
      outer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
      outer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
      outer.topAnchor.constraint(equalTo: content.topAnchor, constant: 66),
      outer.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -22),
    ])
    let accessibilityAllowed = AXIsProcessTrusted()
    accessibility.state = accessibilityAllowed ? .on : .off
    accessibility.setPillTitle(accessibilityAllowed ? "Allowed" : "Allow Access")
    return content
  }

  private func makeProviderContentView() -> NSView {
    let content = NSView()
    let dragRegion = WindowDragRegionView()
    dragRegion.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(dragRegion)
    let stack = NSStackView()
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.distribution = .fill
    stack.spacing = 12

    let heading = NSStackView()
    heading.orientation = .vertical
    heading.alignment = .leading
    heading.spacing = 3
    let breadcrumb = NSTextField(labelWithString: "Choose a provider and project")
    breadcrumb.font = NSFont.systemFont(ofSize: 11, weight: .medium)
    breadcrumb.textColor = .secondaryLabelColor
    breadcrumb.lineBreakMode = .byTruncatingMiddle
    breadcrumb.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let routeLine = NSStackView()
    routeLine.orientation = .horizontal
    routeLine.alignment = .centerY
    routeLine.spacing = 8
    let routeTitle = NSTextField(labelWithString: "No route selected")
    routeTitle.font = NSFont.systemFont(ofSize: 22, weight: .semibold)
    routeTitle.lineBreakMode = .byTruncatingTail
    let routeSpacer = NSView()
    routeSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let statusDot = NSView()
    statusDot.translatesAutoresizingMaskIntoConstraints = false
    statusDot.wantsLayer = true
    statusDot.layer?.cornerRadius = 4
    statusDot.layer?.backgroundColor = NSColor.tertiaryLabelColor.cgColor
    statusDot.widthAnchor.constraint(equalToConstant: 8).isActive = true
    statusDot.heightAnchor.constraint(equalToConstant: 8).isActive = true
    let routeStatus = RouteStatusButton(frame: .zero)
    routeStatus.target = self
    routeStatus.action = #selector(routeStatusPressed(_:))
    routeStatus.update(title: "Stopped", color: .secondaryLabelColor, actionable: false)
    routeLine.addArrangedSubview(routeTitle)
    routeLine.addArrangedSubview(routeSpacer)
    routeLine.addArrangedSubview(statusDot)
    routeLine.addArrangedSubview(routeStatus)
    heading.addArrangedSubview(breadcrumb)
    heading.addArrangedSubview(routeLine)
    stack.addArrangedSubview(heading)
    heading.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    routeLine.widthAnchor.constraint(equalTo: heading.widthAnchor).isActive = true
    breadcrumbField = breadcrumb
    routeTitleField = routeTitle
    routeStatusButton = routeStatus
    routeStatusDot = statusDot

    let routeControls = NSStackView()
    routeControls.orientation = .horizontal
    routeControls.alignment = .centerY
    routeControls.spacing = 12
    let surface = NSSegmentedControl(labels: ["App", "CLI"], trackingMode: .selectOne, target: self, action: #selector(surfaceChanged(_:)))
    surface.segmentStyle = .texturedRounded
    surface.setAccessibilityLabel("Surface")
    let type = NSSegmentedControl(labels: ["Chat"], trackingMode: .selectOne, target: self, action: #selector(routeTypeChanged(_:)))
    type.segmentStyle = .texturedRounded
    type.setAccessibilityLabel("Provider type")
    let controlSpacer = NSView()
    controlSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    routeControls.addArrangedSubview(surface)
    routeControls.addArrangedSubview(type)
    routeControls.addArrangedSubview(controlSpacer)
    stack.addArrangedSubview(routeControls)
    routeControls.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    surfaceControl = surface
    typeControl = type

    let assist = makeAttachPanel()
    stack.addArrangedSubview(assist)
    assist.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    let gate = makeGateBanner()
    stack.addArrangedSubview(gate)
    gate.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    let conversationHeaderSpacer = NSView()
    conversationHeaderSpacer.translatesAutoresizingMaskIntoConstraints = false
    conversationHeaderSpacer.setAccessibilityElement(false)
    stack.addArrangedSubview(conversationHeaderSpacer)
    conversationHeaderSpacer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    conversationHeaderSpacer.heightAnchor.constraint(equalToConstant: 16).isActive = true

    let conversation = makeConversationCollection()
    conversation.setContentHuggingPriority(.defaultLow, for: .vertical)
    conversation.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    conversation.heightAnchor.constraint(greaterThanOrEqualToConstant: 155).isActive = true
    stack.addArrangedSubview(conversation)
    conversation.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

    let composerHost = NSView()
    composerHost.translatesAutoresizingMaskIntoConstraints = false
    let composer = makeComposer()
    let loopSetup = LoopSetupView()
    composer.translatesAutoresizingMaskIntoConstraints = false
    loopSetup.translatesAutoresizingMaskIntoConstraints = false
    loopSetup.isHidden = true
    loopSetup.onCancel = { [weak self] in self?.leaveLoopSetup() }
    loopSetup.onStart = { [weak self] draft in self?.startProjectLoop(draft) }
    composerHost.addSubview(composer)
    composerHost.addSubview(loopSetup)
    NSLayoutConstraint.activate([
      composer.leadingAnchor.constraint(equalTo: composerHost.leadingAnchor),
      composer.trailingAnchor.constraint(equalTo: composerHost.trailingAnchor),
      composer.topAnchor.constraint(equalTo: composerHost.topAnchor),
      composer.bottomAnchor.constraint(equalTo: composerHost.bottomAnchor),
      loopSetup.leadingAnchor.constraint(equalTo: composerHost.leadingAnchor),
      loopSetup.trailingAnchor.constraint(equalTo: composerHost.trailingAnchor),
      loopSetup.topAnchor.constraint(equalTo: composerHost.topAnchor),
      loopSetup.bottomAnchor.constraint(equalTo: composerHost.bottomAnchor),
    ])
    stack.addArrangedSubview(composerHost)
    composerHost.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    directComposerView = composer
    directLoopSetupView = loopSetup

    content.addSubview(stack)
    NSLayoutConstraint.activate([
      dragRegion.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      dragRegion.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      dragRegion.topAnchor.constraint(equalTo: content.topAnchor),
      dragRegion.heightAnchor.constraint(equalToConstant: 58),
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 66),
      stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
    ])
    return content
  }

  private func makeAttachPanel() -> NSView {
    let panel = RoundedPanelView(
      fillColor: NSColor.controlAccentColor.withAlphaComponent(0.09),
      strokeColor: NSColor.controlAccentColor.withAlphaComponent(0.30),
      radius: 11
    )
    panel.translatesAutoresizingMaskIntoConstraints = false
    let row = NSStackView()
    row.translatesAutoresizingMaskIntoConstraints = false
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 9
    let symbol = NSImageView(image: NSImage(systemSymbolName: "link.badge.plus", accessibilityDescription: nil) ?? NSImage())
    symbol.contentTintColor = .controlAccentColor
    symbol.translatesAutoresizingMaskIntoConstraints = false
    symbol.widthAnchor.constraint(equalToConstant: 22).isActive = true
    let instruction = NSTextField(wrappingLabelWithString: "")
    instruction.font = NSFont.systemFont(ofSize: 11.5)
    instruction.setContentHuggingPriority(.defaultLow, for: .horizontal)
    instruction.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let copy = NSButton(title: "Copy Command", target: self, action: #selector(copyAttachCommand))
    copy.bezelStyle = .rounded
    copy.controlSize = .small
    copy.isHidden = true
    let open = NSButton(title: "Open", target: self, action: #selector(openAttachmentSurface))
    open.bezelStyle = .rounded
    open.controlSize = .small
    row.addArrangedSubview(symbol)
    row.addArrangedSubview(instruction)
    row.addArrangedSubview(copy)
    row.addArrangedSubview(open)
    panel.addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 11),
      row.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -10),
      row.topAnchor.constraint(equalTo: panel.topAnchor, constant: 8),
      row.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -8),
    ])
    panel.isHidden = true
    attachPanel = panel
    attachInstructionField = instruction
    attachButton = open
    copyCommandButton = copy
    return panel
  }

  private func makeConversationCollection() -> NSView {
    let container = NSView()
    container.translatesAutoresizingMaskIntoConstraints = false
    let scroll = NSScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.borderType = .noBorder
    scroll.drawsBackground = false
    let layout = NSCollectionViewFlowLayout()
    layout.sectionInset = NSEdgeInsets(top: 4, left: 0, bottom: 12, right: 4)
    layout.minimumLineSpacing = 12
    let collection = AdaptiveCollectionView()
    collection.collectionViewLayout = layout
    collection.dataSource = self
    collection.delegate = self
    collection.isSelectable = true
    collection.backgroundColors = [.clear]
    collection.register(ConversationCollectionItem.self, forItemWithIdentifier: ConversationCollectionItem.identifier)
    scroll.documentView = collection
    container.addSubview(scroll)
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: container.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ])
    collectionView = collection

    let empty = NSStackView()
    empty.translatesAutoresizingMaskIntoConstraints = false
    empty.orientation = .vertical
    empty.alignment = .centerX
    empty.spacing = 7
    let start = NSButton(
      image: NSImage(systemSymbolName: "plus.circle.fill", accessibilityDescription: "Start") ?? NSImage(),
      target: self,
      action: #selector(emptyStateAction)
    )
    start.translatesAutoresizingMaskIntoConstraints = false
    start.isBordered = false
    start.imagePosition = .imageOnly
    start.imageScaling = .scaleProportionallyUpOrDown
    start.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 34, weight: .regular)
    start.contentTintColor = .controlAccentColor
    start.setAccessibilityLabel("Start a conversation")
    start.widthAnchor.constraint(equalToConstant: 52).isActive = true
    start.heightAnchor.constraint(equalToConstant: 52).isActive = true
    let title = NSTextField(labelWithString: "No messages in this context")
    title.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
    let detail = NSTextField(wrappingLabelWithString: "Choose an exact route or send the first card.")
    detail.font = NSFont.systemFont(ofSize: 11)
    detail.textColor = .secondaryLabelColor
    detail.alignment = .center
    detail.maximumNumberOfLines = 2
    detail.widthAnchor.constraint(lessThanOrEqualToConstant: 360).isActive = true
    empty.addArrangedSubview(start)
    empty.addArrangedSubview(title)
    empty.addArrangedSubview(detail)
    container.addSubview(empty)
    NSLayoutConstraint.activate([
      empty.centerXAnchor.constraint(equalTo: container.centerXAnchor),
      empty.centerYAnchor.constraint(equalTo: container.centerYAnchor),
    ])
    conversationEmptyView = empty
    conversationEmptyTitle = title
    conversationEmptyDetail = detail
    conversationEmptyAction = start
    conversationSurfaceView = container
    return container
  }

  private var effectiveContext: ContextSelection? {
    providerAwaitingProject == nil ? (missingProjectContext ?? desiredContext ?? confirmedContext) : nil
  }

  private func providerRow(_ id: String? = nil) -> [String: Any]? {
    let wanted = id ?? selectedProviderID
    return providerRows.first { ($0["id"] as? String) == wanted }
  }

  private func routes(for provider: String) -> [[String: Any]] {
    (providerRow(provider)?["routes"] as? [[String: Any]]) ?? []
  }

  private func routesForSelectedProvider() -> [[String: Any]] { routes(for: selectedProviderID) }

  private func surfaceHasMultipleTypes(provider: String, surface: String) -> Bool {
    routes(for: provider).filter { ($0["surface"] as? String) == surface }.count > 1
  }

  private func selectedRouteRow() -> [String: Any]? {
    routesForSelectedProvider().first {
      ($0["surface"] as? String) == selectedSurface && ($0["type"] as? String) == selectedType
    }
  }

  private func selectedContextBody() -> [String: Any]? {
    guard !selectedProviderID.isEmpty,
          !selectedProjectPath.isEmpty,
          selectedRouteRow() != nil
    else { return nil }
    return ContextSelection(
      provider: selectedProviderID,
      project: selectedProjectPath,
      surface: selectedSurface,
      type: selectedType
    ).json
  }

  private func savedRoute(project: [String: Any], provider: String) -> [String: String]? {
    guard let routes = project["routes"] as? [String: Any],
          let route = routes[provider] as? [String: Any],
          let surface = route["surface"] as? String,
          let type = route["type"] as? String
    else { return nil }
    return ["surface": surface, "type": type]
  }

  private func projectBelongsToProvider(_ project: [String: Any], provider: String) -> Bool {
    if let routes = project["routes"] as? [String: Any], routes[provider] != nil { return true }
    return (project["providers"] as? [String])?.contains(provider) == true
  }

  private func providerProjects(_ provider: String) -> [[String: Any]] {
    let matching = projectRows.filter { projectBelongsToProvider($0, provider: provider) }
    var byPath: [String: [String: Any]] = [:]
    for project in matching {
      guard let path = project["path"] as? String, !path.isEmpty else { continue }
      byPath[path] = project
    }
    let incomingPaths = matching.compactMap { $0["path"] as? String }
    var order = (stableProjectOrderByProvider[provider] ?? []).filter { byPath[$0] != nil }
    for path in incomingPaths where !order.contains(path) { order.append(path) }
    stableProjectOrderByProvider[provider] = order
    return order.compactMap { byPath[$0] }
  }

  private func contextForProject(
    provider: String,
    projectPath: String,
    preferCurrentRoute: Bool = false
  ) -> ContextSelection? {
    let providerRoutes = routes(for: provider)
    guard !providerRoutes.isEmpty else { return nil }
    let project = projectRows.first { ($0["path"] as? String) == projectPath }
    let saved = project.flatMap { savedRoute(project: $0, provider: provider) }
    var route = saved.flatMap { saved in
      providerRoutes.first {
        ($0["surface"] as? String) == saved["surface"] && ($0["type"] as? String) == saved["type"]
      }
    }
    if route == nil && preferCurrentRoute && provider == selectedProviderID {
      route = providerRoutes.first {
        ($0["surface"] as? String) == selectedSurface && ($0["type"] as? String) == selectedType
      }
    }
    if route == nil {
      route = providerRoutes.first { ($0["installed"] as? Bool) == true } ?? providerRoutes.first
    }
    guard let route,
          let surface = route["surface"] as? String,
          let type = route["type"] as? String
    else { return nil }
    return ContextSelection(provider: provider, project: projectPath, surface: surface, type: type)
  }

  private func contextForProvider(_ provider: String) -> ContextSelection? {
    let projects = providerProjects(provider)
    let preferred = lastProjectByProvider[provider]
    let project =
      projects.first { ($0["path"] as? String) == preferred && ($0["exists"] as? Bool) != false } ??
      projects.first { ($0["exists"] as? Bool) != false }
    guard let path = project?["path"] as? String else { return nil }
    return contextForProject(provider: provider, projectPath: path)
  }

  private func jsonFingerprint(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    else { return String(describing: value) }
    return data.base64EncodedString()
  }

  private func providerDetail(_ provider: [String: Any]) -> String {
    let providerRoutes = provider["routes"] as? [[String: Any]] ?? []
    let installed = providerRoutes.filter { ($0["installed"] as? Bool) == true }
    let surfaces = Set(installed.compactMap { $0["surface"] as? String })
    if installed.isEmpty { return "Unavailable" }
    if surfaces == Set(["app", "cli"]) { return "App · CLI" }
    return surfaces.contains("app") ? "App" : "CLI"
  }

  private func reloadProviderTableIfNeeded() {
    let fingerprint = jsonFingerprint(providerRows)
    if fingerprint != providerModelFingerprint {
      providerModelFingerprint = fingerprint
      let wasSuppressed = suppressTableSelection
      suppressTableSelection = true
      providerTableView?.reloadData()
      suppressTableSelection = wasSuppressed
    }
    refreshVisibleProviderCells()
  }

  private func updateVisibleProjects() {
    visibleProjectRows = providerProjects(selectedProviderID)
    let fingerprintRows: [[String: Any]] = visibleProjectRows.map { project in
      [
        "path": project["path"] as? String ?? "",
        "name": project["name"] as? String ?? "",
        "exists": project["exists"] as? Bool ?? false,
        "route": savedRoute(project: project, provider: selectedProviderID) ?? [:],
      ]
    }
    let fingerprint = selectedProviderID + ":" + jsonFingerprint(fingerprintRows)
    if fingerprint != projectModelFingerprint {
      projectModelFingerprint = fingerprint
      let wasSuppressed = suppressTableSelection
      suppressTableSelection = true
      projectTableView?.reloadData()
      suppressTableSelection = wasSuppressed
    }
    projectEmptyLabel?.stringValue = providerModelLoaded
      ? "No projects yet. Use + to add a folder."
      : "Loading projects…"
    projectEmptyLabel?.isHidden = !visibleProjectRows.isEmpty
    projectTableHeightConstraint?.constant = CGFloat(visibleProjectRows.count) * 45
  }

  private func decodeLoopsSnapshot(_ value: [String: Any]) -> LoopsSnapshotDTO? {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value)
    else { return nil }
    return try? JSONDecoder().decode(LoopsSnapshotDTO.self, from: data)
  }

  private func decodeLoopWorkspace(_ value: [String: Any]) -> LoopWorkspaceDTO? {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value)
    else { return nil }
    return try? JSONDecoder().decode(LoopWorkspaceDTO.self, from: data)
  }

  private func loopRunDisplayName(_ run: LoopRunSummaryDTO?) -> String {
    if let name = run?.runName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
      return name
    }
    guard let raw = run?.startedAt else { return "Start a Loop" }
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = iso.date(from: raw) else { return "Start a Loop" }
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter.string(from: date)
  }

  private func refreshLoopSidebarForSelection() {
    currentLoopWorkspace = loopWorkspaces.first { $0.project == selectedProjectPath }
    var incoming: [[String: Any]] = []
    if !selectedProjectPath.isEmpty {
      let latest = currentLoopWorkspace?.latestRun
      var row: [String: Any] = [
        "id": currentLoopWorkspace?.id ?? "project:\(selectedProjectPath)",
        "name": loopRunDisplayName(latest),
        "project": selectedProjectPath,
      ]
      if let latest {
        row["runId"] = latest.id
        row["state"] = latest.state
        if let progress = latest.progress {
          row["progress"] = [
            "segment": progress.segment,
            "cycle": progress.cycle,
            "cycles": progress.cycles,
            "step": progress.step,
            "steps": progress.steps,
          ]
        }
      }
      incoming = [row]
    }
    loopRows = incoming
    let membership = incoming.map { row in
      [
        "id": row["id"] as? String ?? "",
        "name": row["name"] as? String ?? "",
        "project": row["project"] as? String ?? "",
      ]
    }
    let fingerprint = jsonFingerprint(membership)
    if fingerprint != loopModelFingerprint {
      loopModelFingerprint = fingerprint
      let wasSuppressed = suppressTableSelection
      suppressTableSelection = true
      loopTableView?.reloadData()
      suppressTableSelection = wasSuppressed
    }
    loopTableHeightConstraint?.constant = CGFloat(incoming.count) * 40
    loopEmptyLabel?.stringValue = selectedProjectPath.isEmpty ? "Select a project to use Loops." : ""
    loopEmptyLabel?.isHidden = !incoming.isEmpty
    refreshVisibleLoopCells()
  }

  private func applyLoopModel(_ data: [String: Any]?) {
    guard let data, let snapshot = decodeLoopsSnapshot(data) else { return }
    loopWorkspaces = snapshot.workspaces
    currentLoopWorkspace = snapshot.workspace ?? snapshot.workspaces.first { $0.project == selectedProjectPath }
    refreshLoopSidebarForSelection()
    synchronizeTableSelections()

    guard showingLoop else { return }
    let displayedProject = loopWorkspaceProjectPath ?? selectedProjectPath
    let displayedWorkspace = loopWorkspaces.first { $0.project == displayedProject }
    selectedLoopID = displayedWorkspace?.id ?? selectedLoopID
    let runID = displayedWorkspace?.latestRun?.id
    selectedLoopRunID = runID
    if let run = displayedWorkspace?.latestRun,
       run.revision != loadedLoopRunRevision || loadedLoopMessageRunID != run.id
    {
      loadLoopRun(run.id)
    } else {
      if loadedLoopHistoryProject != displayedProject {
        loadLoopHistory(project: displayedProject)
      }
      renderLoopWorkspace()
    }
  }

  private func refreshVisibleLoopCells() {
    guard let table = loopTableView else { return }
    for row in 0..<loopRows.count {
      guard let cell = table.view(atColumn: 0, row: row, makeIfNecessary: false) as? LoopSidebarCellView else { continue }
      let loop = loopRows[row]
      cell.update(
        name: loop["name"] as? String ?? "Loop",
        state: loop["state"] as? String,
        progress: loop["progress"] as? [String: Any]
      )
    }
  }

  private func synchronizeTableSelections() {
    let wasSuppressed = suppressTableSelection
    suppressTableSelection = true
    defer { suppressTableSelection = wasSuppressed }
    if showingSettings {
      providerTableView?.deselectAll(nil)
      projectTableView?.deselectAll(nil)
      loopTableView?.deselectAll(nil)
      return
    }
    if showingLoop {
      providerTableView?.deselectAll(nil)
      projectTableView?.deselectAll(nil)
      if let id = selectedLoopID,
         let index = loopRows.firstIndex(where: { ($0["id"] as? String) == id })
      {
        loopTableView?.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        loopTableView?.scrollRowToVisible(index)
      } else {
        loopTableView?.deselectAll(nil)
      }
      return
    }
    loopTableView?.deselectAll(nil)
    if let providerIndex = providerRows.firstIndex(where: { ($0["id"] as? String) == selectedProviderID }) {
      providerTableView?.selectRowIndexes(IndexSet(integer: providerIndex), byExtendingSelection: false)
    } else {
      providerTableView?.deselectAll(nil)
    }
    if let projectIndex = visibleProjectRows.firstIndex(where: { ($0["path"] as? String) == selectedProjectPath }) {
      projectTableView?.selectRowIndexes(IndexSet(integer: projectIndex), byExtendingSelection: false)
      projectTableView?.scrollRowToVisible(projectIndex)
    } else {
      projectTableView?.deselectAll(nil)
    }
  }

  private func refreshVisibleProviderCells() {
    guard let table = providerTableView else { return }
    for row in 0..<providerRows.count {
      guard let cell = table.view(atColumn: 0, row: row, makeIfNecessary: false) as? ProviderTableCellView,
            let id = providerRows[row]["id"] as? String
      else { continue }
      cell.update(
        providerID: id,
        name: providerRows[row]["name"] as? String ?? id.capitalized,
        detail: providerDetail(providerRows[row]),
        status: id == selectedProviderID ? displayStatusForSidebar : "idle"
      )
    }
  }

  private func applyLocalContext(
    _ context: ContextSelection,
    pending: Bool,
    loadConversation: Bool = true
  ) {
    let changed =
      selectedProviderID != context.provider ||
      selectedProjectPath != context.project ||
      selectedSurface != context.surface ||
      selectedType != context.type
    selectedProviderID = context.provider
    selectedProjectPath = context.project
    selectedSurface = context.surface
    selectedType = context.type
    providerAwaitingProject = nil
    if changed {
      statusField?.stringValue = ""
      beginContextPresentation()
    }
    updateVisibleProjects()
    refreshLoopSidebarForSelection()
    synchronizeTableSelections()
    configureRouteControls()
    if pending { applySwitchingStatus() }
    if loadConversation {
      loadCards(for: context)
    }
  }

  private func beginContextPresentation() {
    contextCardsLoaded = false
    contextStatusLoaded = false
    activeRouteStatus = "switching"
    routeStatusAction = .none
    routeStatusReason = nil
    routeStatusButton?.isHidden = true
    routeStatusDot?.isHidden = true
    conversationRecords = []
    collectionView?.reloadData()
    conversationEmptyView?.isHidden = true
    attachPanel?.isHidden = true
    currentAttach = nil
    updateComposerAvailability()
  }

  private func finishContextPresentationIfReady() {
    guard contextCardsLoaded, contextStatusLoaded else {
      routeStatusButton?.isHidden = true
      routeStatusDot?.isHidden = true
      conversationEmptyView?.isHidden = true
      return
    }
    routeStatusButton?.isHidden = false
    routeStatusDot?.isHidden = false
    attachPanel?.isHidden = !(activeRouteStatus == "needs-session" && currentAttach != nil)
    refreshRouteStatusPresentation()
    refreshConversationEmptyState()
    refreshVisibleProviderCells()
    updateComposerAvailability()
  }

  @objc private func showSettings(_ sender: Any?) {
    showingSettings = true
    showingLoop = false
    workspaceContentView?.isHidden = true
    loopContentView?.isHidden = true
    settingsContentView?.isHidden = false
    settingsButton?.setActive(false)
    let wasSuppressed = suppressTableSelection
    suppressTableSelection = true
    providerTableView?.allowsEmptySelection = true
    providerTableView?.deselectAll(nil)
    projectTableView?.deselectAll(nil)
    loopTableView?.deselectAll(nil)
    suppressTableSelection = wasSuppressed
    updateAccessibilityPresentation()
    refreshProviderAvailability()
  }

  private func showWorkspace() {
    showingSettings = false
    showingLoop = false
    settingsContentView?.isHidden = true
    loopContentView?.isHidden = true
    workspaceContentView?.isHidden = false
    settingsButton?.setActive(false)
    synchronizeTableSelections()
    providerTableView?.allowsEmptySelection = false
    loopTableView?.deselectAll(nil)
  }

  private func refreshProviderAvailability() {
    for provider in providerRows {
      guard let id = provider["id"] as? String,
            let row = providerAvailabilityRows[id]
      else { continue }
      let found = ((provider["routes"] as? [[String: Any]]) ?? [])
        .contains { ($0["installed"] as? Bool) == true }
      row.update(name: provider["name"] as? String ?? id.capitalized, found: found)
    }
  }

  private func applyLoadingState() {
    beginContextPresentation()
    activeRouteStatus = "loading"
    updateComposerAvailability()
    statusField?.stringValue = ""
    refreshVisibleProviderCells()
  }

  private func applySwitchingStatus() {
    activeRouteStatus = "switching"
    updateComposerAvailability()
    attachPanel?.isHidden = true
    currentAttach = nil
    statusField?.stringValue = ""
    refreshVisibleProviderCells()
  }

  private func selectProvider(_ provider: String) {
    guard providerRows.contains(where: { ($0["id"] as? String) == provider }) else { return }
    showWorkspace()
    if let context = contextForProvider(provider) {
      providerAwaitingProject = nil
      requestContextSwitch(context)
      return
    }
    providerAwaitingProject = provider
    missingProjectContext = nil
    beginContextPresentation()
    desiredContext = nil
    selectedProviderID = provider
    selectedProjectPath = ""
    if let route = routes(for: provider).first {
      selectedSurface = route["surface"] as? String ?? "app"
      selectedType = route["type"] as? String ?? ""
    }
    updateVisibleProjects()
    refreshLoopSidebarForSelection()
    synchronizeTableSelections()
    configureRouteControls()
    applyRouteStatus(["status": "blocked", "reason": "add a project for this provider"])
    showConversationEmpty()
  }

  private func selectProject(_ path: String) {
    guard let project = visibleProjectRows.first(where: { ($0["path"] as? String) == path }),
          let context = contextForProject(provider: selectedProviderID, projectPath: path)
    else { return }
    showWorkspace()
    if (project["exists"] as? Bool) == false {
      contextSelectionEpoch += 1
      providerAwaitingProject = nil
      desiredContext = nil
      missingProjectContext = context
      applyLocalContext(context, pending: false)
      applyRouteStatus([
        "status": "blocked",
        "reason": "project folder is missing",
        "action": "choose-folder",
      ])
      return
    }
    requestContextSwitch(context)
  }

  private func handleProviderSelection(_ row: Int) {
    guard !suppressTableSelection else { return }
    guard row >= 0, row < providerRows.count,
          let provider = providerRows[row]["id"] as? String
    else { return }
    if provider != selectedProviderID || showingSettings || showingLoop { selectProvider(provider) }
  }

  private func handleProjectSelection(_ row: Int) {
    guard !suppressTableSelection else { return }
    guard row >= 0, row < visibleProjectRows.count,
          let path = visibleProjectRows[row]["path"] as? String
    else { return }
    if path != selectedProjectPath || showingSettings || showingLoop { selectProject(path) }
  }

  private func loopRouteChoices() -> [LoopRouteChoice] {
    providerRows.flatMap { provider -> [LoopRouteChoice] in
      let providerID = provider["id"] as? String ?? ""
      let providerName = provider["name"] as? String ?? providerID.capitalized
      return (provider["routes"] as? [[String: Any]] ?? []).compactMap { route in
        guard let surface = route["surface"] as? String,
              let type = route["type"] as? String,
              let label = route["label"] as? String
        else { return nil }
        return LoopRouteChoice(
          provider: providerID,
          providerName: providerName,
          surface: surface,
          type: type,
          label: label,
          installed: (route["installed"] as? Bool) == true
        )
      }
    }
  }

  @objc func newLoop(_ sender: Any?) {
    guard !selectedProjectPath.isEmpty,
          let project = projectRows.first(where: { ($0["path"] as? String) == selectedProjectPath }),
          (project["exists"] as? Bool) != false
    else { return }
    showWorkspace()
    let route = loopRouteChoices().first {
      $0.provider == selectedProviderID && $0.surface == selectedSurface && $0.type == selectedType
    }
    directLoopSetupView?.configure(
      project: selectedProjectPath,
      routes: loopRouteChoices(),
      currentRoute: route,
      workspace: currentLoopWorkspace,
      showsCancel: true,
      force: true
    )
    loopSetupMode = true
    directComposerView?.isHidden = true
    directLoopSetupView?.isHidden = false
    directLoopSetupView?.focusPrompt()
  }

  private func leaveLoopSetup() {
    guard !loopStartInFlight else { return }
    loopSetupMode = false
    directLoopSetupView?.isHidden = true
    directComposerView?.isHidden = false
    window?.makeFirstResponder(bodyView)
  }

  private func startProjectLoop(_ draft: LoopSetupDraft) {
    guard !loopStartInFlight else { return }
    loopStartInFlight = true
    directLoopSetupView?.setSubmitting(true)
    loopWorkspaceView?.setStartSubmitting(true)
    updateComposerAvailability()
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      var profile: [String: Any] = [
        "requestId": UUID().uuidString.lowercased(),
        "action": "save-project-profile",
        "project": draft.project,
        "leader": draft.leader,
        "defaultCycles": draft.cycles,
      ]
      if let builder = draft.builder { profile["builder"] = builder }
      else { profile["builder"] = NSNull() }
      if let reviewer = draft.reviewer { profile["reviewer"] = reviewer }
      else { profile["reviewer"] = NSNull() }
      let saved = self.httpJSON(method: "POST", path: "/api/loops", body: profile)
      guard let saved,
            (saved["ok"] as? Bool) == true,
            let workspace = saved["workspace"] as? [String: Any],
            let loopID = workspace["id"] as? String
      else {
        let message = saved?["error"] as? String ?? "The Loop could not be saved."
        DispatchQueue.main.async { self.finishLoopStart(error: message) }
        return
      }
      var start: [String: Any] = [
        "requestId": UUID().uuidString.lowercased(),
        "loopId": loopID,
        "goal": draft.prompt,
        "cycles": draft.cycles,
      ]
      if let name = draft.runName { start["runName"] = name }
      let result = self.httpJSON(method: "POST", path: "/api/loop-runs", body: start)
      guard let run = result?["run"] as? [String: Any], let runID = run["id"] as? String else {
        DispatchQueue.main.async {
          self.finishLoopStart(error: result?["error"] as? String ?? "The Loop could not start.")
          self.refreshFeed()
        }
        return
      }
      DispatchQueue.main.async {
        self.loopStartInFlight = false
        self.directLoopSetupView?.setSubmitting(false)
        self.loopWorkspaceView?.setStartSubmitting(false)
        self.directLoopSetupView?.clearRunFields()
        self.loopWorkspaceView?.clearStartFields()
        self.loopSetupMode = false
        self.directLoopSetupView?.isHidden = true
        self.directComposerView?.isHidden = false
        if let decoded = self.decodeLoopWorkspace(workspace) {
          self.currentLoopWorkspace = decoded
          self.loopWorkspaces.removeAll { $0.project == decoded.project }
          self.loopWorkspaces.append(decoded)
        }
        self.selectedLoopID = loopID
        self.selectedLoopRunID = runID
        self.loopWorkspaceProjectPath = draft.project
        self.loadedLoopRunRevision = -1
        self.loadedLoopRunDetail = nil
        self.loadedLoopHistoryProject = nil
        self.showLoopWorkspace()
        self.loadLoopRun(runID)
        self.loadLoopHistory(project: draft.project)
        self.refreshFeed()
        self.updateComposerAvailability()
      }
    }
  }

  private func finishLoopStart(error: String) {
    loopStartInFlight = false
    directLoopSetupView?.setSubmitting(false)
    loopWorkspaceView?.setStartSubmitting(false)
    updateComposerAvailability()
    presentLoopError(error)
  }

  private func handleLoopSelection(_ row: Int) {
    guard !suppressTableSelection,
          row >= 0,
          row < loopRows.count,
          let id = loopRows[row]["id"] as? String
    else { return }
    openLoop(id)
  }

  private func openLoop(_ id: String) {
    guard let loop = loopRows.first(where: { ($0["id"] as? String) == id }) else { return }
    selectedLoopID = id
    loopWorkspaceProjectPath = loop["project"] as? String ?? selectedProjectPath
    selectedLoopRunID = loop["runId"] as? String
    loadedLoopRunRevision = -1
    if loadedLoopHistoryProject != loopWorkspaceProjectPath {
      loadedLoopHistory = []
      loadedLoopHistoryProject = nil
      loadedLoopRunDetail = nil
    }
    showLoopWorkspace()
    synchronizeTableSelections()
    renderLoopWorkspace()
    loadLoopHistory(project: loopWorkspaceProjectPath ?? selectedProjectPath)
    if let runID = selectedLoopRunID { loadLoopRun(runID) }
  }

  private func showLoopWorkspace() {
    showingSettings = false
    showingLoop = true
    if loopWorkspaceProjectPath == nil { loopWorkspaceProjectPath = selectedProjectPath }
    workspaceContentView?.isHidden = true
    settingsContentView?.isHidden = true
    loopContentView?.isHidden = false
    settingsButton?.setActive(false)
    providerTableView?.allowsEmptySelection = true
    synchronizeTableSelections()
  }

  private func decodeLoopPage(_ value: [String: Any]) -> LoopRunPageDTO? {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value)
    else { return nil }
    return try? JSONDecoder().decode(LoopRunPageDTO.self, from: data)
  }

  private func decodeLoopHistoryPage(_ value: [String: Any]) -> LoopProjectHistoryPageDTO? {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value)
    else { return nil }
    return try? JSONDecoder().decode(LoopProjectHistoryPageDTO.self, from: data)
  }

  private func loopRunPath(_ runID: String, cursor: String? = nil) -> String? {
    var components = URLComponents()
    components.path = "/api/loop-runs/\(runID)"
    var query = [URLQueryItem(name: "limit", value: "100")]
    if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
    components.queryItems = query
    return components.string
  }

  private func loopHistoryPath(_ project: String, cursor: String? = nil) -> String? {
    var components = URLComponents()
    components.path = "/api/loop-history"
    var query = [
      URLQueryItem(name: "project", value: project),
      URLQueryItem(name: "limit", value: "100"),
    ]
    if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
    components.queryItems = query
    return components.string
  }

  private func loadLoopHistory(project: String) {
    guard !project.isEmpty else { return }
    loopHistoryLoadRevision += 1
    let requestRevision = loopHistoryLoadRevision
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }
      var cursor: String?
      var messages: [LoopMessageDTO] = []
      repeat {
        guard let path = self.loopHistoryPath(project, cursor: cursor),
              let value = self.httpJSON(method: "GET", path: path),
              let page = self.decodeLoopHistoryPage(value),
              page.project == project
        else { return }
        messages.append(contentsOf: page.items)
        cursor = page.nextCursor
      } while cursor != nil
      DispatchQueue.main.async {
        guard requestRevision == self.loopHistoryLoadRevision,
              self.showingLoop,
              self.loopWorkspaceProjectPath == project
        else { return }
        self.loadedLoopHistoryProject = project
        self.loadedLoopHistory = messages
        self.renderLoopWorkspace()
      }
    }
  }

  private func renderLoopWorkspace() {
    guard showingLoop else { return }
    let project = loopWorkspaceProjectPath ?? selectedProjectPath
    guard !project.isEmpty else { return }
    let route = loopRouteChoices().first {
      $0.provider == selectedProviderID && $0.surface == selectedSurface && $0.type == selectedType
    }
    let workspace = loopWorkspaces.first { $0.project == project } ?? (currentLoopWorkspace?.project == project ? currentLoopWorkspace : nil)
    let run = loadedLoopRunDetail?.project == project ? loadedLoopRunDetail : nil
    let messages = loadedLoopHistoryProject == project ? loadedLoopHistory : []
    loopWorkspaceView?.applyProject(
      project: project,
      workspace: workspace,
      run: run,
      messages: messages,
      routes: loopRouteChoices(),
      currentRoute: route
    )
  }

  private func loadLoopRun(_ runID: String?) {
    guard let runID, !runID.isEmpty else { return }
    loopLoadRevision += 1
    let requestRevision = loopLoadRevision
    let existing = loadedLoopMessageRunID == runID ? loadedLoopMessages : []
    let overlapOffset = existing.isEmpty ? 0 : existing.count - 1
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }
      var cursor: String? = overlapOffset == 0 ? nil : String(overlapOffset)
      var summary: LoopRunDetailSummaryDTO?
      var messages: [LoopMessageDTO] = Array(existing.prefix(overlapOffset))
      repeat {
        guard let path = self.loopRunPath(runID, cursor: cursor),
              let value = self.httpJSON(method: "GET", path: path),
              let page = self.decodeLoopPage(value)
        else { return }
        summary = page.run
        messages.append(contentsOf: page.messages)
        cursor = page.nextCursor
      } while cursor != nil
      guard let summary else { return }
      DispatchQueue.main.async {
        guard requestRevision == self.loopLoadRevision,
              self.showingLoop,
              self.selectedLoopRunID == runID
        else { return }
        self.loadedLoopRunRevision = summary.revision
        self.loadedLoopRunDetail = summary
        self.loadedLoopMessageRunID = runID
        self.loadedLoopMessages = messages
        self.renderLoopWorkspace()
        self.loadLoopHistory(project: summary.project)
      }
    }
  }

  private func handleLoopWorkspaceAction(_ action: String, values: [String: Any]) {
    switch action {
    case "prompt-correction":
      promptLoopText(title: "Add Correction", label: "Correction", button: "Continue") { [weak self] text in
        self?.sendLoopAction("add-correction", values: ["body": text])
      }
    case "prompt-takeover":
      promptLoopText(title: "Reply as Me", label: "Reply", button: "Send") { [weak self] text in
        self?.sendLoopAction("reply-as-me", values: ["body": text])
      }
    case "prompt-continue-segment":
      promptContinueLoop()
    case "prompt-stop":
      confirmStopLoop()
    default:
      sendLoopAction(action, values: values)
    }
  }

  private func sendLoopAction(_ action: String, values: [String: Any] = [:]) {
    guard let run = loopWorkspaceView?.run else { return }
    var body = values
    body["requestId"] = UUID().uuidString.lowercased()
    body["revision"] = run.revision
    body["action"] = action
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      let result = self.httpJSON(
        method: "POST",
        path: "/api/loop-runs/\(run.id)/action",
        body: body
      )
      DispatchQueue.main.async {
        if (result?["ok"] as? Bool) != true {
          self.presentLoopError(result?["error"] as? String ?? "The Loop could not be updated.")
        }
        self.loadedLoopRunRevision = -1
        self.loadLoopRun(run.id)
        self.refreshFeed()
      }
    }
  }

  private func promptLoopText(
    title: String,
    label: String,
    button: String,
    completion: @escaping (String) -> Void
  ) {
    guard let window else { return }
    let alert = NSAlert()
    alert.messageText = title
    alert.addButton(withTitle: button)
    alert.addButton(withTitle: "Cancel")
    let field = NSTextField()
    field.placeholderString = label
    field.frame = NSRect(x: 0, y: 0, width: 360, height: 28)
    field.setAccessibilityLabel(label)
    alert.accessoryView = field
    alert.beginSheetModal(for: window) { response in
      let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
      if response == .alertFirstButtonReturn, !text.isEmpty { completion(text) }
    }
  }

  private func promptContinueLoop() {
    guard let window else { return }
    let alert = NSAlert()
    alert.messageText = "Continue Loop"
    alert.informativeText = "Choose another segment."
    alert.addButton(withTitle: "Continue")
    alert.addButton(withTitle: "Cancel")
    let stack = NSStackView(frame: NSRect(x: 0, y: 0, width: 380, height: 70))
    stack.orientation = .vertical
    stack.spacing = 8
    let cycles = NSTextField(string: "1")
    cycles.placeholderString = "Cycles (1–50)"
    cycles.setAccessibilityLabel("Cycles")
    let guidance = NSTextField()
    guidance.placeholderString = "Guidance (optional)"
    guidance.setAccessibilityLabel("Optional guidance")
    stack.addArrangedSubview(cycles)
    stack.addArrangedSubview(guidance)
    alert.accessoryView = stack
    alert.beginSheetModal(for: window) { [weak self] response in
      guard response == .alertFirstButtonReturn else { return }
      let count = min(50, max(1, Int(cycles.stringValue) ?? 1))
      self?.sendLoopAction(
        "continue-segment",
        values: ["cycles": count, "guidance": guidance.stringValue]
      )
    }
  }

  private func confirmStopLoop() {
    guard let window else { return }
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Stop this Loop?"
    alert.informativeText = "The current message cannot be recalled. No further turns will be sent."
    alert.addButton(withTitle: "Stop Loop")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { [weak self] response in
      if response == .alertFirstButtonReturn { self?.sendLoopAction("stop") }
    }
  }

  private func handleLoopAttention() {
    guard let run = loopWorkspaceView?.run else { return }
    switch run.action {
    case "allow-accessibility":
      showSettings(nil)
    case "confirm-session":
      sendLoopAction("confirm-session")
    case "open-provider", "switch-surface":
      if let appPath = run.nextRoute?.appPath, !appPath.isEmpty {
        NSWorkspace.shared.open(URL(fileURLWithPath: appPath))
      } else if run.nextRoute?.surface == "cli" {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open(
          [URL(fileURLWithPath: run.project)],
          withApplicationAt: URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app"),
          configuration: configuration
        )
      }
    case "choose-folder":
      presentLoopError("Restore this project folder, then resume the Loop.")
    default:
      sendLoopAction("resume")
    }
  }

  private func presentLoopError(_ message: String) {
    guard let window else { return }
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.beginSheetModal(for: window)
  }

  private func makeLoopContextMenu(row: Int) -> NSMenu? {
    guard row >= 0, row < loopRows.count, let id = loopRows[row]["id"] as? String else { return nil }
    let menu = NSMenu()
    for (title, action, symbol) in [
      ("Open", #selector(openLoopFromMenu(_:)), "arrow.up.right.square"),
      ("Start Loop", #selector(startLoopFromMenu(_:)), "arrow.triangle.2.circlepath"),
    ] {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
      item.target = self
      item.representedObject = id
      item.image = menuSymbol(symbol)
      menu.addItem(item)
    }
    return menu
  }

  @objc private func openLoopFromMenu(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String { openLoop(id) }
  }

  @objc private func startLoopFromMenu(_ sender: NSMenuItem) { newLoop(sender) }

  private func requestContextSwitch(_ context: ContextSelection) {
    _ = selectionCoordinator.registerIntent(context)
    providerAwaitingProject = nil
    missingProjectContext = nil
    applyLocalContext(context, pending: true)
    scheduleContextWrite()
  }

  private func scheduleContextWrite() {
    contextWriteDebounceWorkItem?.cancel()
    let work = DispatchWorkItem { [weak self] in
      self?.contextWriteDebounceWorkItem = nil
      self?.enqueueContextWriteIfNeeded()
    }
    contextWriteDebounceWorkItem = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
  }

  private func enqueueContextWriteIfNeeded() {
    guard providerModelLoaded, !contextWriteInFlight, let target = desiredContext else { return }
    if target == confirmedContext {
      desiredContext = nil
      refreshFeed()
      return
    }
    guard selectionCoordinator.beginWrite() == target else { return }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      let response = self.httpJSON(method: "POST", path: "/api/context", body: target.json)
      DispatchQueue.main.async {
        self.finishContextWrite(target: target, response: response)
      }
    }
  }

  private func finishContextWrite(target: ContextSelection, response: [String: Any]?) {
    contextSelectionEpoch += 1
    let succeeded = (response?["ok"] as? Bool) == true
    let wasCurrent = desiredContext == target
    if succeeded {
      let confirmed = ContextSelection(response?["context"] as? [String: Any]) ?? target
      _ = selectionCoordinator.finishWrite(target: target, confirmed: confirmed)
      hasAdoptedServerContext = true
      lastProjectByProvider[confirmed.provider] = confirmed.project
      if wasCurrent {
        applyLocalContext(confirmed, pending: false)
        if let status = response?["status"] as? [String: Any] { applyRouteStatus(status) }
      }
    } else {
      _ = selectionCoordinator.finishWrite(target: target, confirmed: nil)
      if wasCurrent {
        let message = response?["error"] as? String ?? "could not switch context"
        if let confirmedContext { applyLocalContext(confirmedContext, pending: false) }
        applyRouteStatus(["status": "blocked", "reason": message])
      }
    }
    if let desiredContext, desiredContext != confirmedContext {
      enqueueContextWriteIfNeeded()
    } else {
      refreshFeed()
    }
  }

  private func loadCards(for context: ContextSelection) {
    guard let path = contextCardsPath(context.json) else { return }
    cardsRequestRevision += 1
    let revision = cardsRequestRevision
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }
      let cards = self.httpJSON(method: "GET", path: path)
      DispatchQueue.main.async {
        guard revision == self.cardsRequestRevision, self.effectiveContext == context else { return }
        self.applyConversationData(cards)
      }
    }
  }

  private func registerProjectLocally(
    path: String,
    provider: String,
    surface: String,
    type: String
  ) {
    let now = ISO8601DateFormatter().string(from: Date())
    if let index = projectRows.firstIndex(where: { ($0["path"] as? String) == path }) {
      var project = projectRows[index]
      var providers = project["providers"] as? [String] ?? []
      if !providers.contains(provider) { providers.append(provider) }
      var savedRoutes = project["routes"] as? [String: Any] ?? [:]
      savedRoutes[provider] = ["surface": surface, "type": type]
      project["providers"] = providers
      project["routes"] = savedRoutes
      project["lastUsedAt"] = now
      project["exists"] = FileManager.default.fileExists(atPath: path)
      projectRows[index] = project
    } else {
      projectRows.insert(
        [
          "path": path,
          "name": URL(fileURLWithPath: path).lastPathComponent,
          "lastUsedAt": now,
          "providers": [provider],
          "routes": [provider: ["surface": surface, "type": type]],
          "exists": FileManager.default.fileExists(atPath: path),
        ],
        at: 0
      )
    }
    var order = stableProjectOrderByProvider[provider] ?? []
    order.removeAll { $0 == path }
    order.insert(path, at: 0)
    stableProjectOrderByProvider[provider] = order
    projectModelFingerprint = ""
  }

  private func projectActionInfo(row: Int) -> [String: Any]? {
    guard row >= 0, row < visibleProjectRows.count,
          let path = visibleProjectRows[row]["path"] as? String,
          let context = contextForProject(provider: selectedProviderID, projectPath: path)
    else { return nil }
    var info = context.json
    info["name"] = visibleProjectRows[row]["name"] as? String ?? URL(fileURLWithPath: path).lastPathComponent
    info["exists"] = (visibleProjectRows[row]["exists"] as? Bool) != false
    return info
  }

  private func makeProjectContextMenu(row: Int) -> NSMenu? {
    guard let info = projectActionInfo(row: row) else { return nil }
    let menu = NSMenu()
    let change = NSMenuItem(
      title: "Change Folder…",
      action: #selector(changeProjectFolderFromMenu(_:)),
      keyEquivalent: ""
    )
    change.target = self
    change.representedObject = info
    change.image = menuSymbol("folder.badge.gearshape")
    menu.addItem(change)
    let reveal = NSMenuItem(
      title: "Show in Finder",
      action: #selector(showProjectInFinder(_:)),
      keyEquivalent: ""
    )
    reveal.target = self
    reveal.representedObject = info["project"]
    reveal.image = menuSymbol("folder")
    reveal.isEnabled = (info["exists"] as? Bool) == true
    menu.addItem(reveal)
    return menu
  }

  @objc private func changeProjectFolderFromMenu(_ sender: NSMenuItem) {
    guard let info = sender.representedObject as? [String: Any] else { return }
    chooseProjectFolder(replacing: info)
  }

  @objc private func showProjectInFinder(_ sender: NSMenuItem) {
    guard let path = sender.representedObject as? String,
          FileManager.default.fileExists(atPath: path)
    else { return }
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
  }

  private func chooseProjectFolder(replacing info: [String: Any]) {
    guard let oldContext = ContextSelection(info) else { return }
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    panel.prompt = "Choose Folder"
    let name = info["name"] as? String ?? URL(fileURLWithPath: oldContext.project).lastPathComponent
    panel.message = "Choose a folder for \(name)."
    let oldURL = URL(fileURLWithPath: oldContext.project)
    panel.directoryURL = oldURL.deletingLastPathComponent()
    guard panel.runModal() == .OK, let url = panel.url else { return }
    let path = url.resolvingSymlinksInPath().path
    registerProjectLocally(
      path: path,
      provider: oldContext.provider,
      surface: oldContext.surface,
      type: oldContext.type
    )
    showWorkspace()
    requestContextSwitch(
      ContextSelection(
        provider: oldContext.provider,
        project: path,
        surface: oldContext.surface,
        type: oldContext.type
      )
    )
  }

  @objc func addProject(_ sender: Any?) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    panel.prompt = "Add Project"
    panel.message = "Choose a project folder shared by your providers."
    guard panel.runModal() == .OK, let url = panel.url else { return }
    let path = url.resolvingSymlinksInPath().path
    let defaultRoute = routesForSelectedProvider().first { ($0["installed"] as? Bool) == true } ?? routesForSelectedProvider().first
    let surface = defaultRoute?["surface"] as? String ?? selectedSurface
    let type = defaultRoute?["type"] as? String ?? selectedType
    registerProjectLocally(
      path: path,
      provider: selectedProviderID,
      surface: surface,
      type: type
    )
    guard let context = contextForProject(
      provider: selectedProviderID,
      projectPath: path,
      preferCurrentRoute: true
    ) else { return }
    showWorkspace()
    requestContextSwitch(context)
  }

  @objc func surfaceChanged(_ sender: Any?) {
    guard let control = sender as? NSSegmentedControl, control.selectedSegment >= 0 else { return }
    let surface = control.selectedSegment == 0 ? "app" : "cli"
    guard let route = routesForSelectedProvider().first(where: { ($0["surface"] as? String) == surface }) else {
      configureRouteControls()
      return
    }
    guard !selectedProjectPath.isEmpty, let type = route["type"] as? String else { return }
    requestContextSwitch(
      ContextSelection(provider: selectedProviderID, project: selectedProjectPath, surface: surface, type: type)
    )
  }

  @objc func routeTypeChanged(_ sender: Any?) {
    guard let control = sender as? NSSegmentedControl,
          control.selectedSegment >= 0,
          control.selectedSegment < typeRoutes.count
    else { return }
    guard !selectedProjectPath.isEmpty,
          let type = typeRoutes[control.selectedSegment]["type"] as? String
    else { return }
    requestContextSwitch(
      ContextSelection(
        provider: selectedProviderID,
        project: selectedProjectPath,
        surface: selectedSurface,
        type: type
      )
    )
  }

  private func configureRouteControls() {
    let routes = routesForSelectedProvider()
    let appRoutes = routes.filter { ($0["surface"] as? String) == "app" }
    let cliRoutes = routes.filter { ($0["surface"] as? String) == "cli" }
    let appAvailable = appRoutes.contains { ($0["installed"] as? Bool) == true }
    let cliAvailable = cliRoutes.contains { ($0["installed"] as? Bool) == true }
    surfaceControl?.setEnabled(appAvailable, forSegment: 0)
    surfaceControl?.setEnabled(cliAvailable, forSegment: 1)
    surfaceControl?.setToolTip(nil, forSegment: 0)
    surfaceControl?.setToolTip(nil, forSegment: 1)
    surfaceControl?.selectedSegment = selectedSurface == "cli" ? 1 : 0

    typeRoutes = routes.filter { ($0["surface"] as? String) == selectedSurface }
    typeControl?.isHidden = typeRoutes.count <= 1
    typeControl?.segmentCount = max(typeRoutes.count, 1)
    if typeRoutes.isEmpty {
      typeControl?.setLabel("Unavailable", forSegment: 0)
      typeControl?.setEnabled(false, forSegment: 0)
      typeControl?.setToolTip(nil, forSegment: 0)
      typeControl?.selectedSegment = 0
    } else {
      for (index, route) in typeRoutes.enumerated() {
        typeControl?.setLabel(route["label"] as? String ?? "Route", forSegment: index)
        typeControl?.setEnabled((route["installed"] as? Bool) == true, forSegment: index)
        typeControl?.setToolTip(nil, forSegment: index)
      }
      let selected = typeRoutes.firstIndex { ($0["type"] as? String) == selectedType } ?? 0
      typeControl?.selectedSegment = selected
    }
    let label = selectedRouteRow()?["label"] as? String ?? "No route selected"
    routeTitleField?.stringValue = label
    routeTitleField?.toolTip = label
    surfaceControl?.setAccessibilityHelp("Choose App or CLI")
    typeControl?.setAccessibilityHelp("Choose the exact provider type")
    updateBreadcrumb()
    refreshConversationEmptyState()
  }

  private func updateBreadcrumb() {
    let provider = providerRow()?["name"] as? String ?? selectedProviderID.capitalized
    let project = projectRows.first { ($0["path"] as? String) == selectedProjectPath }
    let projectName = project?["name"] as? String ?? (selectedProjectPath.isEmpty ? "Choose Project" : URL(fileURLWithPath: selectedProjectPath).lastPathComponent)
    breadcrumbField?.stringValue = "\(provider)  /  \(projectName)"
    breadcrumbField?.toolTip = selectedProjectPath
    breadcrumbField?.setAccessibilityLabel("Provider \(provider), project \(projectName)")
  }

  private func applyProviderModel(_ data: [String: Any]?) {
    guard let data else { return }
    cacheBootstrapState(data)
    providerModelLoaded = true
    lastProviderModel = data
    if let incomingProviders = data["providers"] as? [[String: Any]], !incomingProviders.isEmpty {
      providerRows = incomingProviders
    }
    var incomingProjects = data["projects"] as? [[String: Any]] ?? []
    if let desiredContext,
       !incomingProjects.contains(where: { ($0["path"] as? String) == desiredContext.project }),
       let optimistic = projectRows.first(where: { ($0["path"] as? String) == desiredContext.project })
    {
      incomingProjects.insert(optimistic, at: 0)
    }
    projectRows = incomingProjects
    lastProjectByProvider = data["lastProjectByProvider"] as? [String: String] ?? lastProjectByProvider
    reloadProviderTableIfNeeded()
    refreshProviderAvailability()
    if let awaiting = providerAwaitingProject, let context = contextForProvider(awaiting) {
      providerAwaitingProject = nil
      requestContextSwitch(context)
      return
    }
    let serverContext = ContextSelection(data["selection"] as? [String: Any])
    let canAdoptServer =
      !hasAdoptedServerContext &&
      desiredContext == nil &&
      !contextWriteInFlight &&
      providerAwaitingProject == nil &&
      missingProjectContext == nil
    if canAdoptServer, let serverContext {
      hasAdoptedServerContext = true
      let changed = confirmedContext != serverContext
      confirmedContext = serverContext
      if changed {
        applyLocalContext(serverContext, pending: false, loadConversation: false)
      } else {
        selectedProviderID = serverContext.provider
        selectedProjectPath = serverContext.project
        selectedSurface = serverContext.surface
        selectedType = serverContext.type
        updateVisibleProjects()
        synchronizeTableSelections()
        configureRouteControls()
      }
    } else {
      updateVisibleProjects()
      synchronizeTableSelections()
      configureRouteControls()
    }
    if missingProjectContext == nil,
       desiredContext == nil,
       !contextWriteInFlight,
       serverContext == confirmedContext,
       let status = data["status"] as? [String: Any]
    {
      applyRouteStatus(status)
    }
    if desiredContext != nil,
       !contextWriteInFlight,
       contextWriteDebounceWorkItem == nil
    {
      enqueueContextWriteIfNeeded()
    }
  }

  private func applyRouteStatus(_ status: [String: Any]) {
    let state = status["status"] as? String ?? "blocked"
    activeRouteStatus = state
    contextStatusLoaded = true
    routeStatusReason = status["reason"] as? String
    let backendAction = status["action"] as? String
    let normalizedReason = routeStatusReason?.lowercased() ?? ""
    if backendAction == "allow-accessibility" || normalizedReason.contains("accessibility") {
      routeStatusAction = .allowAccessibility
    } else if backendAction == "choose-folder" || normalizedReason.contains("folder is missing") {
      routeStatusAction = .chooseFolder
    } else {
      routeStatusAction = .none
    }
    updateComposerAvailability()
    if state == "needs-session", let attach = status["attach"] as? [String: Any] {
      currentAttach = attach
      attachInstructionField?.stringValue = attach["instruction"] as? String ?? "Open the selected route and choose a session."
      attachButton?.title = attach["title"] as? String ?? "Open"
      copyCommandButton?.isHidden = (attach["mode"] as? String) != "cli"
      attachPanel?.isHidden = !contextCardsLoaded
    } else {
      currentAttach = nil
      attachPanel?.isHidden = true
    }
    finishContextPresentationIfReady()
  }

  private func refreshRouteStatusPresentation() {
    let title: String
    let color: NSColor
    let actionable: Bool
    switch routeStatusAction {
    case .allowAccessibility:
      title = "Allow Accessibility"
      color = .systemRed
      actionable = true
    case .chooseFolder:
      title = "Folder Missing"
      color = .systemRed
      actionable = true
    case .none:
      actionable = false
      if activeRouteStatus == "waiting" || conversationRecords.first?.status == "Waiting" {
        title = "Waiting"
        color = .systemOrange
      } else if activeRouteStatus == "blocked" {
        title = "Stopped"
        color = .systemRed
      } else if conversationRecords.first?.status == "Sent" {
        title = "Sent"
        color = .systemGreen
      } else if activeRouteStatus == "needs-session" {
        title = "Stopped"
        color = .systemRed
      } else {
        title = "Stopped"
        color = .secondaryLabelColor
      }
    }
    routeStatusButton?.update(
      title: title,
      color: color,
      actionable: actionable,
      help: actionable ? routeStatusReason : nil
    )
    routeStatusDot?.layer?.backgroundColor = color.cgColor
    routeStatusDot?.setAccessibilityLabel(title)
  }

  private var displayStatusForSidebar: String {
    if routeStatusAction != .none || activeRouteStatus == "blocked" { return "blocked" }
    if activeRouteStatus == "waiting" || conversationRecords.first?.status == "Waiting" { return "waiting" }
    if conversationRecords.first?.status == "Sent" { return "attached" }
    return "idle"
  }

  @objc private func routeStatusPressed(_ sender: Any?) {
    switch routeStatusAction {
    case .allowAccessibility:
      showSettings(sender)
    case .chooseFolder:
      guard let context = effectiveContext else { return }
      let project = projectRows.first { ($0["path"] as? String) == context.project }
      var info = context.json
      info["name"] = project?["name"] as? String ?? URL(fileURLWithPath: context.project).lastPathComponent
      info["exists"] = false
      chooseProjectFolder(replacing: info)
    case .none:
      break
    }
  }

  @objc func openAttachmentSurface(_ sender: Any?) {
    guard let attach = currentAttach,
          let appPath = attach["appPath"] as? String,
          !appPath.isEmpty
    else { return }
    let appURL = URL(fileURLWithPath: appPath)
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    if (attach["mode"] as? String) == "cli", !selectedProjectPath.isEmpty {
      NSWorkspace.shared.open(
        [URL(fileURLWithPath: selectedProjectPath)],
        withApplicationAt: appURL,
        configuration: configuration
      ) { [weak self] _, error in
        DispatchQueue.main.async {
          self?.statusField?.stringValue = error == nil ? "Terminal opened. Run the shown command when ready." : (error?.localizedDescription ?? "Could not open Terminal")
        }
      }
    } else {
      NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { [weak self] _, error in
        DispatchQueue.main.async {
          self?.statusField?.stringValue = error == nil ? "Provider opened. Select the exact page or session." : (error?.localizedDescription ?? "Could not open provider")
        }
      }
    }
  }

  @objc func copyAttachCommand(_ sender: Any?) {
    guard let command = currentAttach?["command"] as? String, !command.isEmpty else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(command, forType: .string)
    statusField?.stringValue = "Command copied. Convobus did not run it."
  }

  private func contextCardsPath(_ selection: [String: Any]) -> String? {
    guard let provider = selection["provider"] as? String,
          let project = selection["project"] as? String,
          let surface = selection["surface"] as? String,
          let type = selection["type"] as? String,
          !project.isEmpty
    else { return nil }
    var components = URLComponents()
    components.path = "/api/cards"
    components.queryItems = [
      URLQueryItem(name: "provider", value: provider),
      URLQueryItem(name: "project", value: project),
      URLQueryItem(name: "surface", value: surface),
      URLQueryItem(name: "type", value: type),
    ]
    return components.string
  }

  private func humanTimestamp(_ value: String) -> String {
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = iso.date(from: value) ?? {
      iso.formatOptions = [.withInternetDateTime]
      return iso.date(from: value)
    }()
    guard let date else { return value }
    let formatter = DateFormatter()
    formatter.dateStyle = Calendar.current.isDateInToday(date) ? .none : .medium
    formatter.timeStyle = .short
    return formatter.string(from: date)
  }

  private func applyConversationData(_ data: [String: Any]?) {
    let rows = data?["records"] as? [[String: Any]] ?? []
    conversationRecords = rows.compactMap { record in
      guard let card = record["card"] as? [String: Any],
            let id = card["id"] as? String
      else { return nil }
      let body = card["body"] as? String ?? ""
      let reply = card["reply"] as? String ?? ""
      let state = reply.isEmpty ? "Waiting" : "Sent"
      let timestamp = humanTimestamp(record["t"] as? String ?? "")
      var lines = ["Card: \(id)"]
      if let method = card["method"] as? String, !method.isEmpty { lines.append("Method: \(method)") }
      if let session = record["sessionId"] as? String, !session.isEmpty { lines.append("Session: \(session)") }
      if let file = record["sessionFile"] as? String, !file.isEmpty { lines.append("Session file: \(file)") }
      if let kind = record["kind"] as? String, !kind.isEmpty { lines.append("Attach kind: \(kind)") }
      if (record["inferred"] as? Bool) == true { lines.append("Legacy classification: inferred") }
      return ConversationRecord(
        id: id,
        body: body,
        reply: reply,
        timestamp: timestamp,
        status: state,
        details: lines.joined(separator: "\n")
      )
    }
    expandedCardIDs = expandedCardIDs.intersection(Set(conversationRecords.map(\.id)))
    collectionView?.reloadData()
    if conversationRecords.first?.status == "Sent", statusField?.stringValue == "Waiting for reply…" {
      statusField?.stringValue = "Sent"
    }
    contextCardsLoaded = true
    finishContextPresentationIfReady()
  }

  private func showConversationEmpty() {
    conversationRecords = []
    collectionView?.reloadData()
    contextCardsLoaded = true
    finishContextPresentationIfReady()
  }

  private func refreshConversationEmptyState() {
    guard contextCardsLoaded, contextStatusLoaded else {
      conversationEmptyView?.isHidden = true
      return
    }
    guard conversationRecords.isEmpty else {
      conversationEmptyView?.isHidden = true
      return
    }
    conversationEmptyView?.isHidden = false
    let providerName = providerRow()?["name"] as? String ?? selectedProviderID.capitalized
    let routeName = selectedRouteRow()?["label"] as? String ?? "this route"
    let action = conversationEmptyAction
    action?.isHidden = false
    action?.isEnabled = true

    if !providerModelLoaded && selectedProjectPath.isEmpty {
      conversationEmptyTitle?.stringValue = "Opening your workspace…"
      conversationEmptyDetail?.stringValue = "Providers are ready. Projects are loading."
      action?.isHidden = true
    } else if selectedProjectPath.isEmpty || providerAwaitingProject != nil {
      conversationEmptyTitle?.stringValue = "Add a project for \(providerName)"
      conversationEmptyDetail?.stringValue = "Choose a folder, then Convobus will restore this provider’s exact route."
      action?.setAccessibilityLabel("Add a project for \(providerName)")
    } else if routeStatusAction == .allowAccessibility || routeStatusAction == .chooseFolder {
      conversationEmptyTitle?.stringValue = "No messages in this context"
      conversationEmptyDetail?.stringValue = ""
      action?.isHidden = true
    } else {
      switch activeRouteStatus {
      case "loading", "switching":
        conversationEmptyView?.isHidden = true
        action?.isHidden = true
      case "needs-session":
        conversationEmptyTitle?.stringValue = "Start \(routeName)"
        conversationEmptyDetail?.stringValue = "Open the provider and select or create the session for this project."
        action?.isEnabled = currentAttach != nil
        action?.setAccessibilityLabel("Open \(routeName)")
      case "attached":
        conversationEmptyTitle?.stringValue = "Start the conversation"
        conversationEmptyDetail?.stringValue = "Write the first message below."
        action?.setAccessibilityLabel("Focus the message composer")
      default:
        conversationEmptyTitle?.stringValue = "Start \(routeName)"
        conversationEmptyDetail?.stringValue = routeStatusButton?.attributedTitle.string ?? "This route is not ready yet."
        action?.isEnabled = currentAttach != nil
        action?.setAccessibilityLabel("Start \(routeName)")
      }
    }
  }

  @objc private func emptyStateAction(_ sender: Any?) {
    if selectedProjectPath.isEmpty || providerAwaitingProject != nil {
      addProject(sender)
      return
    }
    if activeRouteStatus == "needs-session", currentAttach != nil {
      openAttachmentSurface(sender)
      return
    }
    if activeRouteStatus == "attached", let bodyView {
      bodyView.window?.makeFirstResponder(bodyView)
      statusField?.stringValue = "Ready for your first message."
      return
    }
    statusField?.stringValue = "Checking the selected route…"
    refreshFeed()
  }

  private func makeGateBanner() -> NSView {
    let gate = RoundedPanelView(
      fillColor: NSColor.systemOrange.withAlphaComponent(0.12),
      strokeColor: NSColor.systemOrange.withAlphaComponent(0.42),
      radius: 11
    )
    gate.translatesAutoresizingMaskIntoConstraints = false
    let stack = NSStackView()
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .horizontal
    stack.alignment = .centerY
    stack.spacing = 8

    let symbol = NSImageView(image: NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: nil) ?? NSImage())
    symbol.contentTintColor = .systemOrange
    symbol.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
    symbol.translatesAutoresizingMaskIntoConstraints = false
    symbol.widthAnchor.constraint(equalToConstant: 22).isActive = true

    let reason = NSTextField(wrappingLabelWithString: "")
    reason.font = NSFont.systemFont(ofSize: 12, weight: .medium)
    reason.setContentHuggingPriority(.defaultLow, for: .horizontal)
    reason.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let accept = NSButton(title: "Accept", target: self, action: #selector(acceptGate))
    accept.bezelStyle = .rounded
    let edit = NSButton(title: "Edit", target: self, action: #selector(editGate))
    edit.bezelStyle = .rounded
    stack.addArrangedSubview(symbol)
    stack.addArrangedSubview(reason)
    stack.addArrangedSubview(accept)
    stack.addArrangedSubview(edit)
    gate.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: gate.leadingAnchor, constant: 12),
      stack.trailingAnchor.constraint(equalTo: gate.trailingAnchor, constant: -10),
      stack.topAnchor.constraint(equalTo: gate.topAnchor, constant: 8),
      stack.bottomAnchor.constraint(equalTo: gate.bottomAnchor, constant: -8),
    ])
    gate.isHidden = true
    gateBox = gate
    gateReason = reason
    return gate
  }

  private func updateComposerAvailability() {
    let routeReady = activeRouteStatus == "attached" && !sending
    let hasMessage = !(bodyView?.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    let folderMissing = routeStatusAction == .chooseFolder
    bodyView?.isEditable = routeReady
    sendButton?.isEnabled = routeReady && hasMessage
    loopComposerButton?.isEnabled = !selectedProjectPath.isEmpty && !folderMissing && !loopStartInFlight
    loopSidebarAddButton?.isEnabled = !selectedProjectPath.isEmpty && !folderMissing && !loopStartInFlight
    conversationSurfaceView?.alphaValue = folderMissing ? 0.5 : 1
    composerView?.alphaValue = folderMissing ? 0.5 : 1
  }

  func textDidChange(_ notification: Notification) {
    guard notification.object as? NSTextView === bodyView else { return }
    updateComposerAvailability()
  }

  private func makeComposer() -> NSView {
    let composer = RoundedPanelView(
      fillColor: NSColor.controlBackgroundColor.withAlphaComponent(0.78),
      strokeColor: NSColor.separatorColor.withAlphaComponent(0.5),
      radius: 14
    )
    composer.translatesAutoresizingMaskIntoConstraints = false
    let stack = NSStackView()
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8

    let labelRow = NSStackView()
    labelRow.orientation = .horizontal
    labelRow.alignment = .centerY
    let label = NSTextField(labelWithString: "Message")
    label.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
    let labelSpacer = NSView()
    labelSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let loopButton = NSButton(title: "Loop", target: self, action: #selector(newLoop(_:)))
    loopButton.bezelStyle = .inline
    loopButton.controlSize = .small
    loopButton.image = menuSymbol("arrow.triangle.2.circlepath")
    loopButton.imagePosition = .imageLeading
    loopButton.toolTip = "Start a Loop for this project"
    loopButton.setAccessibilityLabel("Start Loop")
    labelRow.addArrangedSubview(label)
    labelRow.addArrangedSubview(labelSpacer)
    labelRow.addArrangedSubview(loopButton)
    stack.addArrangedSubview(labelRow)
    labelRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    loopComposerButton = loopButton

    let (bodyScroll, body) = makeText(editable: true, minHeight: 76)
    body.string = ""
    body.delegate = self
    body.setAccessibilityLabel("Message")
    stack.addArrangedSubview(bodyScroll)
    bodyScroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    bodyView = body

    let footer = NSStackView()
    footer.orientation = .horizontal
    footer.alignment = .centerY
    footer.spacing = 8
    let status = NSTextField(labelWithString: "")
    status.textColor = .secondaryLabelColor
    status.font = NSFont.systemFont(ofSize: 11)
    status.lineBreakMode = .byTruncatingTail
    status.alignment = .right
    status.setContentHuggingPriority(.defaultHigh, for: .horizontal)
    status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let send = NSButton(title: "Send", target: self, action: #selector(sendMessage))
    send.image = menuSymbol("paperplane.fill")
    send.imagePosition = .imageLeading
    send.bezelStyle = .rounded
    send.controlSize = .large
    send.keyEquivalent = "\r"
    send.keyEquivalentModifierMask = .command
    send.toolTip = "Send message (⌘Return)"
    send.isEnabled = false
    body.isEditable = false
    footer.addArrangedSubview(send)
    let footerSpacer = NSView()
    footerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    footer.addArrangedSubview(footerSpacer)
    footer.addArrangedSubview(status)
    stack.addArrangedSubview(footer)
    footer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    statusField = status
    sendButton = send

    composer.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: composer.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: composer.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: composer.topAnchor, constant: 14),
      stack.bottomAnchor.constraint(equalTo: composer.bottomAnchor, constant: -14),
    ])
    composerView = composer
    return composer
  }

  private func makeText(editable: Bool, minHeight: CGFloat) -> (NSScrollView, NSTextView) {
    let tv = NSTextView()
    tv.isEditable = editable
    tv.isSelectable = true
    tv.isRichText = false
    tv.font = NSFont.systemFont(ofSize: 13)
    tv.autoresizingMask = [.width]
    tv.textContainerInset = NSSize(width: 8, height: 7)
    tv.isVerticallyResizable = true
    tv.isHorizontallyResizable = false
    tv.textContainer?.widthTracksTextView = true
    tv.drawsBackground = true
    tv.backgroundColor = .textBackgroundColor
    let sp = NSScrollView()
    sp.hasVerticalScroller = true
    sp.autohidesScrollers = true
    sp.borderType = .lineBorder
    sp.wantsLayer = true
    sp.layer?.cornerRadius = 8
    sp.layer?.masksToBounds = true
    sp.documentView = tv
    sp.translatesAutoresizingMaskIntoConstraints = false
    sp.heightAnchor.constraint(greaterThanOrEqualToConstant: minHeight).isActive = true
    return (sp, tv)
  }

  private func updateAccessibilityPresentation(_ trusted: Bool? = nil) {
    let allowed = trusted ?? AXIsProcessTrusted()
    axBox?.state = allowed ? .on : .off
    (axBox as? PillToggleButton)?.setPillTitle(allowed ? "Allowed" : "Allow Access")
  }

  @objc func axToggled(_ sender: Any?) {
    let wasTrusted = AXIsProcessTrusted()
    accessibilityApprovalPollRevision += 1
    let revision = accessibilityApprovalPollRevision
    if wasTrusted {
      finishAccessibilityApproval(granted: true, message: "Already approved")
      return
    }
    updateAccessibilityPresentation(false)
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
      guard revision == self.accessibilityApprovalPollRevision,
            !AXIsProcessTrusted(),
            let url = URL(
              string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            )
      else { return }
      NSWorkspace.shared.open(url)
    }
    pollForAccessibilityApproval(revision: revision, attempt: 0)
  }

  private func pollForAccessibilityApproval(revision: Int, attempt: Int) {
    guard revision == accessibilityApprovalPollRevision else { return }
    let trusted = AXIsProcessTrusted()
    if trusted {
      finishAccessibilityApproval(granted: true, message: "Accessibility approved")
      return
    }
    updateAccessibilityPresentation(false)
    if attempt >= 39 {
      finishAccessibilityApproval(granted: false, message: nil)
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      self?.pollForAccessibilityApproval(revision: revision, attempt: attempt + 1)
    }
  }

  private func finishAccessibilityApproval(granted: Bool, message: String?) {
    updateAccessibilityPresentation(granted)
    DispatchQueue.global(qos: .utility).async { [weak self] in
      _ = self?.httpJSON(method: "POST", path: "/api/accessibility", body: ["granted": granted])
      self?.refreshFeed()
    }
    if granted, let message, let anchor = axBox {
      showAccessibilityFeedback(message, above: anchor)
    }
  }

  private func showAccessibilityFeedback(_ message: String, above anchor: NSButton) {
    accessibilityFeedbackWorkItem?.cancel()
    accessibilityFeedbackPopover?.close()
    (anchor as? PillToggleButton)?.setApprovalHighlighted(true)

    let label = NSTextField(labelWithString: message)
    label.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
    label.alignment = .center
    label.textColor = .labelColor
    label.translatesAutoresizingMaskIntoConstraints = false
    label.setAccessibilityLabel(message)

    let content = NSView(frame: NSRect(x: 0, y: 0, width: 156, height: 38))
    content.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: content.centerYAnchor),
      label.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 12),
      label.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -12),
    ])

    let controller = NSViewController()
    controller.view = content
    controller.preferredContentSize = content.frame.size
    let popover = NSPopover()
    popover.behavior = .transient
    popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    popover.contentViewController = controller
    accessibilityFeedbackPopover = popover
    popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .maxY)

    let work = DispatchWorkItem { [weak self, weak anchor] in
      self?.accessibilityFeedbackPopover?.close()
      self?.accessibilityFeedbackPopover = nil
      (anchor as? PillToggleButton)?.setApprovalHighlighted(false)
    }
    accessibilityFeedbackWorkItem = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: work)
  }

  @objc func sendMessage(_ sender: Any?) {
    if sending { return }
    guard activeRouteStatus == "attached", let route = selectedContextBody() else {
      showWindowMenu(sender)
      statusField?.stringValue = "Attach this exact route before sending."
      return
    }
    let body = bodyView?.string.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !body.isEmpty else {
      statusField?.stringValue = "Write a message first."
      updateComposerAvailability()
      return
    }
    sending = true
    updateComposerAvailability()
    statusField?.stringValue = "sending…"
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let payload: [String: Any] = ["route": route, "body": body]
      let data = self?.httpJSON(method: "POST", path: "/api/send", body: payload)
      DispatchQueue.main.async {
        self?.sending = false
        self?.applySendResult(data)
      }
    }
  }

  @objc func acceptGate(_ sender: Any?) {
    let id = pendingId
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var body: [String: Any] = ["action": "accept"]
      if let id { body["pendingId"] = id }
      let data = self?.httpJSON(method: "POST", path: "/api/gate", body: body)
      DispatchQueue.main.async { self?.applySendResult(data) }
    }
  }

  @objc func editGate(_ sender: Any?) {
    let id = pendingId
    DispatchQueue.global(qos: .utility).async { [weak self] in
      var body: [String: Any] = ["action": "edit"]
      if let id { body["pendingId"] = id }
      _ = self?.httpJSON(method: "POST", path: "/api/gate", body: body)
      DispatchQueue.main.async {
        self?.pendingId = nil
        self?.gateBox?.isHidden = true
        self?.statusField?.stringValue = "edit"
        self?.updateComposerAvailability()
      }
    }
  }

  func applySendResult(_ data: [String: Any]?) {
    refreshFeed()
    updateComposerAvailability()
    guard let data else {
      statusField?.stringValue = "no response"
      return
    }
    if let gate = data["gate"] as? [String: Any] {
      pendingId = data["pendingId"] as? String
      let reason = gate["reason"] as? String ?? "gate"
      gateReason?.stringValue = "\(reason) — Accept / Edit"
      gateBox?.isHidden = false
      statusField?.stringValue = reason
      return
    }
    gateBox?.isHidden = true
    pendingId = nil
    if data["error"] == nil, (data["proceed"] as? Bool) != false {
      bodyView?.string = ""
      updateComposerAvailability()
    }
    if let token = data["token"] as? String, !token.isEmpty { lastToken = token }
    if let err = data["error"] as? String {
      statusField?.stringValue = err
      if let routeStatus = data["status"] as? [String: Any] { applyRouteStatus(routeStatus) }
    } else if let card = data["card"] as? [String: Any],
              ["out", "waiting"].contains(card["state"] as? String ?? "")
    {
      statusField?.stringValue = "Waiting for reply…"
    } else {
      statusField?.stringValue = "Sent"
    }
  }

  private func newServerToken() -> String {
    var generator = SystemRandomNumberGenerator()
    return (0..<32).map { _ in
      String(format: "%02x", UInt8.random(in: UInt8.min...UInt8.max, using: &generator))
    }.joined()
  }

  private func guiRegistry() -> [String: Any]? {
    let file = root + "/.convobus/gui.json"
    var info = stat()
    guard lstat(file, &info) == 0,
          (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
          info.st_uid == getuid(),
          Int(info.st_mode) & 0o077 == 0,
          let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return value
  }

  private func adoptGuiRegistry(
    expectedRoot: String,
    expectedInstance: String? = nil
  ) -> Bool {
    guard let registry = guiRegistry(),
          let port = registry["port"] as? Int,
          (1...65535).contains(port),
          let token = registry["token"] as? String,
          token.count == 64,
          let instance = registry["instanceId"] as? String,
          !instance.isEmpty,
          let pid = registry["pid"] as? Int,
          pid > 1,
          registry["protocolVersion"] as? Int == 3,
          registry["root"] as? String == expectedRoot,
          expectedInstance == nil || expectedInstance == instance
    else { return false }
    let baseURL = "http://127.0.0.1:\(port)"
    guard let health = NativeAPIClient(baseURL: baseURL, token: token)
      .requestJSON(method: "GET", path: "/api/health"),
          health["ok"] as? Bool == true,
          health["protocolVersion"] as? Int == 3,
          health["root"] as? String == expectedRoot,
          health["instanceId"] as? String == instance,
          health["pid"] as? Int == pid
    else { return false }
    serverIdentity.replace(baseURL: baseURL, token: token, instanceID: instance)
    adoptedServerPID = pid_t(pid)
    return true
  }

  private func validatedAdoptedServerPID() -> pid_t? {
    let identity = serverIdentity.snapshot()
    guard let registry = guiRegistry(),
          let pid = registry["pid"] as? Int,
          pid > 1,
          registry["instanceId"] as? String == identity.instanceID,
          registry["token"] as? String == identity.token,
          registry["protocolVersion"] as? Int == 3,
          registry["root"] as? String == URL(fileURLWithPath: root)
            .resolvingSymlinksInPath().standardizedFileURL.path
    else { return nil }
    return pid_t(pid)
  }

  func ensureServer() {
    try? FileManager.default.createDirectory(
      atPath: root,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let expectedRoot = URL(fileURLWithPath: root).resolvingSymlinksInPath().standardizedFileURL.path
    // A backend is reusable only when its private launch identity and canonical root match.
    if adoptGuiRegistry(expectedRoot: expectedRoot) { return }
    guard let nodePath = findNode(), let repo = findRepo() else { return }
    let token = newServerToken()
    let instance = UUID().uuidString.lowercased()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: nodePath)
    p.arguments = [repo + "/convobus", "--root", root, "gui", "--port", "7421"]
    p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
    p.environment = ProcessInfo.processInfo.environment.merging([
      "PATH": "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/.local/bin:\(NSHomeDirectory())/.grok/bin:/usr/bin:/bin",
      "CONVO_ROOT": root,
      "CONVO_GUI_TOKEN": token,
      "CONVO_GUI_INSTANCE": instance,
      "CONVO_APP_BUNDLE_PATH": Bundle.main.bundlePath,
    ]) { _, n in n }
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return }
    serverProcess = p
    for _ in 0..<40 {
      Thread.sleep(forTimeInterval: 0.15)
      if adoptGuiRegistry(expectedRoot: expectedRoot, expectedInstance: instance) { return }
    }
  }

  private func reconnectServerFromRegistryIfNeeded() {
    guard serverIdentity.snapshot().token.isEmpty else { return }
    let expectedRoot = URL(fileURLWithPath: root)
      .resolvingSymlinksInPath().standardizedFileURL.path
    _ = adoptGuiRegistry(expectedRoot: expectedRoot)
  }

  func refreshFeed() {
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.refreshInFlight else { return }
      self.refreshInFlight = true
      let selectionEpoch = self.contextSelectionEpoch
      let requestedContext = self.effectiveContext
      DispatchQueue.global(qos: .utility).async { [weak self] in
        guard let self else { return }
        self.reconnectServerFromRegistryIfNeeded()
        var snapshotPath = "/api/native-snapshot"
        if let requestedContext, let query = self.contextCardsPath(requestedContext.json),
           let marker = query.firstIndex(of: "?")
        {
          snapshotPath += String(query[marker...])
        }
        let snapshot = NativeSnapshotEnvelope(self.httpJSON(method: "GET", path: snapshotPath))
        let providers = snapshot?.providers
        let menu = snapshot?.menu
        let snapshotCards = snapshot?.cards
        let loops = snapshot?.loops
        let serverContext = snapshot?.selection
        let cardsContext = requestedContext ?? serverContext
        let cards: [String: Any]? = cardsContext == nil ? nil : snapshotCards
        DispatchQueue.main.async {
          guard selectionEpoch == self.contextSelectionEpoch else {
            self.refreshInFlight = false
            self.refreshFeed()
            return
          }
          self.applyProviderModel(providers)
          self.applyMenu(menu)
          self.applyLoopModel(loops)
          if let cardsContext, self.effectiveContext == cardsContext {
            if cards == nil { self.showConversationEmpty() }
            else { self.applyConversationData(cards) }
          } else if self.effectiveContext == nil {
            self.showConversationEmpty()
          }
          self.refreshInFlight = false
        }
      }
    }
  }

  func applyMenu(_ data: [String: Any]?) {
    let icon = (data?["icon"] as? String) ?? iconState
    iconState = icon
    let routeStatus = data?["routeStatus"] as? [String: Any]
    let routeAction = routeStatus?["action"] as? String
    var statusName: String
    switch icon {
    case "attached":
      statusName = "Sent"
    case "waiting":
      statusName = "Waiting"
    case "blocked":
      if routeAction == "allow-accessibility" {
        statusName = "Allow Accessibility"
      } else if routeAction == "choose-folder" {
        statusName = "Folder Missing"
      } else {
        statusName = "Stopped"
      }
    default:
      statusName = "Stopped"
    }
    let activeLoop = data?["loop"] as? [String: Any]
    activeMenuLoop = activeLoop
    if let state = activeLoop?["state"] as? String {
      statusName = LoopWorkspaceView.displayState(state)
    }
    statusItem?.isVisible = true
    if let button = statusItem?.button {
      if button.image == nil { button.image = menuBarBrandIcon() }
      button.title = ""
      button.toolTip = "Convobus · \(statusName)"
      button.setAccessibilityValue(statusName)
    }
    ensureStatusItemPresentation(statusName: statusName)
    updateAccessibilityPresentation()
    if let board = data?["board"] as? [String: Any], let token = board["lastToken"] as? String {
      lastToken = token
    }

    if let activeLoop {
      let name = activeLoop["name"] as? String ?? "Loop"
      let progress = activeLoop["progress"] as? [String: Any]
      let cycle = progress?["cycle"] as? Int ?? 1
      let cycles = progress?["cycles"] as? Int ?? 1
      let route = activeLoop["nextRoute"] as? [String: Any]
      let next = route?["label"] as? String ?? (activeLoop["nextRole"] as? String ?? "Reply").capitalized
      let state = activeLoop["state"] as? String ?? "waiting"
      let tail: String
      if state == "waiting" { tail = "Waiting for \(next)" }
      else { tail = LoopWorkspaceView.displayState(state) }
      statusMenuHeader?.title = "\(name) · Cycle \(cycle)/\(cycles) · \(tail)"
      statusMenuHeader?.toolTip = activeLoop["project"] as? String
      statusMenuOpenItem?.title = "Open Loop"
      statusMenuOpenItem?.action = #selector(openActiveLoopFromMenu(_:))
      statusMenuOpenItem?.image = menuSymbol("arrow.up.right.square")
      loopMenuPauseItem?.isHidden = false
      loopMenuPauseItem?.title = state == "paused" ? "Resume Loop" : "Pause Loop"
      loopMenuPauseItem?.image = menuSymbol(state == "paused" ? "play.circle" : "pause.circle")
      loopMenuStopItem?.isHidden = false
    } else {
      let route = routeStatus?["route"] as? [String: Any]
      let providerName = route?["providerName"] as? String ?? selectedProviderID.capitalized
      let routeLabel = route?["label"] as? String ?? selectedType
      let projectPath = route?["project"] as? String ?? selectedProjectPath
      let projectName = projectPath.isEmpty ? "No Project" : URL(fileURLWithPath: projectPath).lastPathComponent
      statusMenuHeader?.title = "\(providerName) · \(projectName) · \(routeLabel) · \(statusName)"
      statusMenuHeader?.toolTip = projectPath
      statusMenuOpenItem?.title = "Open window"
      statusMenuOpenItem?.action = #selector(showWindowMenu)
      statusMenuOpenItem?.image = menuSymbol("macwindow")
      loopMenuPauseItem?.isHidden = true
      loopMenuStopItem?.isHidden = true
    }

    guard let sub = projectsMenu else { return }
    sub.removeAllItems()
    guard let groups = data?["projectsByProvider"] as? [[String: Any]], !groups.isEmpty else {
      let empty = NSMenuItem(title: "No projects", action: nil, keyEquivalent: "")
      empty.isEnabled = false
      sub.addItem(empty)
      return
    }
    for group in groups {
      let provider = NSMenuItem(title: group["name"] as? String ?? "Provider", action: nil, keyEquivalent: "")
      let providerSubmenu = NSMenu()
      let projects = group["projects"] as? [[String: Any]] ?? []
      if projects.isEmpty {
        let empty = NSMenuItem(title: "No projects", action: nil, keyEquivalent: "")
        empty.isEnabled = false
        providerSubmenu.addItem(empty)
      }
      for project in projects {
        guard let projectRoute = project["route"] as? [String: Any] else { continue }
        let name = project["name"] as? String ?? "Project"
        let label = projectRoute["label"] as? String ?? "Route"
        let state = project["status"] as? String ?? "idle"
        let item = NSMenuItem(title: "\(name) · \(label) · \(state.replacingOccurrences(of: "-", with: " ").capitalized)", action: #selector(pickProjectFromMenu(_:)), keyEquivalent: "")
        item.representedObject = projectRoute
        item.target = self
        item.state = (project["selected"] as? Bool) == true ? .on : .off
        switch state {
        case "attached": item.image = menuSymbol("checkmark.circle.fill")
        case "waiting", "needs-session": item.image = menuSymbol("clock.fill")
        case "blocked": item.image = menuSymbol("exclamationmark.triangle.fill")
        default: item.image = menuSymbol("circle")
        }
        providerSubmenu.addItem(item)
      }
      provider.submenu = providerSubmenu
      sub.addItem(provider)
    }
  }

  @objc func pickProjectFromMenu(_ sender: NSMenuItem) {
    guard let route = sender.representedObject as? [String: Any],
          let context = ContextSelection(route)
    else { return }
    showWindowMenu(sender)
    showWorkspace()
    requestContextSwitch(context)
  }

  func httpJSON(
    method: String,
    path: String,
    body: [String: Any]? = nil,
    timeout: TimeInterval = 120
  ) -> [String: Any]? {
    let identity = serverIdentity.snapshot()
    return NativeAPIClient(baseURL: identity.baseURL, token: identity.token, requestTimeout: timeout)
      .requestJSON(method: method, path: path, body: body)
  }
}

extension AppDelegate: NSTableViewDataSource, NSTableViewDelegate {
  func numberOfRows(in tableView: NSTableView) -> Int {
    if tableView === providerTableView { return providerRows.count }
    if tableView === loopTableView { return loopRows.count }
    return visibleProjectRows.count
  }

  func tableViewSelectionDidChange(_ notification: Notification) {
    guard let tableView = notification.object as? NSTableView else { return }
    if let stableTable = tableView as? StableSelectionTableView,
       stableTable.isHandlingDirectInput
    {
      return
    }
    if tableView === providerTableView {
      handleProviderSelection(tableView.selectedRow)
    } else if tableView === projectTableView {
      handleProjectSelection(tableView.selectedRow)
    } else if tableView === loopTableView {
      handleLoopSelection(tableView.selectedRow)
    }
  }

  func tableView(
    _ tableView: NSTableView,
    viewFor tableColumn: NSTableColumn?,
    row: Int
  ) -> NSView? {
    if tableView === providerTableView {
      guard row >= 0, row < providerRows.count else { return nil }
      let cell =
        tableView.makeView(withIdentifier: ProviderTableCellView.identifier, owner: self)
          as? ProviderTableCellView ?? ProviderTableCellView(frame: .zero)
      cell.identifier = ProviderTableCellView.identifier
      let provider = providerRows[row]
      let id = provider["id"] as? String ?? ""
      cell.update(
        providerID: id,
        name: provider["name"] as? String ?? id.capitalized,
        detail: providerDetail(provider),
        status: id == selectedProviderID ? displayStatusForSidebar : "idle"
      )
      return cell
    }
    if tableView === loopTableView {
      guard row >= 0, row < loopRows.count else { return nil }
      let cell =
        tableView.makeView(withIdentifier: LoopSidebarCellView.identifier, owner: self)
          as? LoopSidebarCellView ?? LoopSidebarCellView(frame: .zero)
      cell.identifier = LoopSidebarCellView.identifier
      let loop = loopRows[row]
      cell.update(
        name: loop["name"] as? String ?? "Loop",
        state: loop["state"] as? String,
        progress: loop["progress"] as? [String: Any]
      )
      return cell
    }
    guard row >= 0, row < visibleProjectRows.count else { return nil }
    let cell =
      tableView.makeView(withIdentifier: ProjectTableCellView.identifier, owner: self)
        as? ProjectTableCellView ?? ProjectTableCellView(frame: .zero)
    cell.identifier = ProjectTableCellView.identifier
    let project = visibleProjectRows[row]
    let path = project["path"] as? String ?? ""
    let saved = savedRoute(project: project, provider: selectedProviderID)
    let matchingRoute = routesForSelectedProvider().first {
      ($0["surface"] as? String) == saved?["surface"] && ($0["type"] as? String) == saved?["type"]
    }
    let savedSurface = saved?["surface"] ?? ""
    let exists = (project["exists"] as? Bool) != false
    let detail = !exists
      ? "Folder Missing"
      : surfaceHasMultipleTypes(provider: selectedProviderID, surface: savedSurface)
        ? (matchingRoute?["label"] as? String ?? "Choose route")
        : ""
    cell.update(
      projectPath: path,
      name: project["name"] as? String ?? URL(fileURLWithPath: path).lastPathComponent,
      detail: detail,
      exists: exists
    )
    return cell
  }

  func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
    if tableView === projectTableView { return row >= 0 && row < visibleProjectRows.count }
    if tableView === loopTableView { return row >= 0 && row < loopRows.count }
    return row >= 0 && row < providerRows.count
  }

}

extension AppDelegate: NSCollectionViewDataSource, NSCollectionViewDelegateFlowLayout {
  func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int {
    conversationRecords.count
  }

  func collectionView(
    _ collectionView: NSCollectionView,
    itemForRepresentedObjectAt indexPath: IndexPath
  ) -> NSCollectionViewItem {
    let item = collectionView.makeItem(
      withIdentifier: ConversationCollectionItem.identifier,
      for: indexPath
    ) as! ConversationCollectionItem
    let record = conversationRecords[indexPath.item]
    item.configure(record: record, expanded: expandedCardIDs.contains(record.id))
    item.onToggleDetails = { [weak self] id in
      guard let self else { return }
      if self.expandedCardIDs.contains(id) {
        self.expandedCardIDs.remove(id)
      } else {
        self.expandedCardIDs.insert(id)
      }
      collectionView.reloadData()
      collectionView.collectionViewLayout?.invalidateLayout()
    }
    return item
  }

  func collectionView(
    _ collectionView: NSCollectionView,
    shouldSelectItemsAt indexPaths: Set<IndexPath>
  ) -> Set<IndexPath> {
    []
  }

  private func estimatedTextHeight(_ text: String, width: CGFloat) -> CGFloat {
    guard !text.isEmpty else { return 0 }
    let rect = (text as NSString).boundingRect(
      with: NSSize(width: max(width, 120), height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      attributes: [.font: NSFont.systemFont(ofSize: 13)]
    )
    return ceil(rect.height)
  }

  func collectionView(
    _ collectionView: NSCollectionView,
    layout collectionViewLayout: NSCollectionViewLayout,
    sizeForItemAt indexPath: IndexPath
  ) -> NSSize {
    let width = max(320, collectionView.bounds.width - 4)
    let record = conversationRecords[indexPath.item]
    let bubbleWidth = max(180, width * 0.72 - 36)
    var height: CGFloat = 73 + max(36, estimatedTextHeight(record.body, width: bubbleWidth) + 18)
    if record.reply.isEmpty {
      height += 28
    } else {
      height += max(36, estimatedTextHeight(record.reply, width: bubbleWidth) + 18) + 8
    }
    height += 42
    if expandedCardIDs.contains(record.id) {
      height += max(42, estimatedTextHeight(record.details, width: width - 36) + 12)
    }
    return NSSize(width: width, height: height)
  }
}

func existingLaunchDirectory(for requestedRoot: String) -> URL {
  let manager = FileManager.default
  var candidate = URL(fileURLWithPath: requestedRoot).standardizedFileURL
  var isDirectory: ObjCBool = false
  if manager.fileExists(atPath: candidate.path, isDirectory: &isDirectory), !isDirectory.boolValue {
    candidate.deleteLastPathComponent()
  }
  while candidate.path != "/" {
    isDirectory = false
    if manager.fileExists(atPath: candidate.path, isDirectory: &isDirectory), isDirectory.boolValue {
      return candidate
    }
    candidate.deleteLastPathComponent()
  }
  return URL(fileURLWithPath: NSHomeDirectory())
}

func findNode() -> String? {
  if let resources = Bundle.main.resourcePath {
    let bundled = resources + "/Runtime/node"
    if FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
    if Bundle.main.bundlePath.hasSuffix(".app") { return nil }
  }
  for p in [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    NSHomeDirectory() + "/.local/share/fnm/aliases/default/bin/node",
  ] {
    if FileManager.default.isExecutableFile(atPath: p) { return p }
  }
  return nil
}

func findRepo() -> String? {
  let fm = FileManager.default
  if let resources = Bundle.main.resourcePath {
    let bundled = resources + "/Backend"
    if fm.isExecutableFile(atPath: bundled + "/convobus") { return bundled }
  }
  let bundle = Bundle.main.bundlePath
  let appDir = (bundle as NSString).deletingLastPathComponent
  let repoFromApp = (appDir as NSString).deletingLastPathComponent
  if fm.isExecutableFile(atPath: repoFromApp + "/convobus") { return repoFromApp }
  let home = NSHomeDirectory() + "/Documents/convobus"
  if fm.isExecutableFile(atPath: home + "/convobus") { return home }
  return nil
}

func defaultConvobusRoot() -> String {
  NSHomeDirectory() + "/Library/Application Support/Convobus"
}

func isCli(_ args: [String]) -> Bool {
  let cmds: Set<String> = [
    "seats", "loop", "inflight", "reply", "next", "check", "stage", "turn", "bind", "log", "gui", "--help", "-h",
  ]
  return args.contains { cmds.contains($0) && !$0.hasPrefix("-psn_") }
}

func runCli(_ args: [String]) {
  guard let nodePath = findNode(), let repo = findRepo() else {
    FileHandle.standardError.write(Data("convobus: node or repo not found\n".utf8))
    exit(2)
  }
  var root = ProcessInfo.processInfo.environment["CONVO_ROOT"] ?? defaultConvobusRoot()
  var rest: [String] = []
  var i = 0
  while i < args.count {
    if args[i] == "--" {
      rest.append(contentsOf: args[i...])
      break
    }
    if args[i] == "--root", i + 1 < args.count {
      root = args[i + 1]
      i += 2
      continue
    }
    rest.append(args[i])
    i += 1
  }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: nodePath)
  p.arguments = [repo + "/convobus", "--root", root] + rest
  p.standardOutput = FileHandle.standardOutput
  p.standardError = FileHandle.standardError
  p.environment = ProcessInfo.processInfo.environment.merging([
    "PATH": "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/.local/bin:\(NSHomeDirectory())/.grok/bin:/usr/bin:/bin",
    "CONVO_ROOT": root,
  ]) { _, n in n }
  p.currentDirectoryURL = existingLaunchDirectory(for: root)
  do {
    try p.run()
    p.waitUntilExit()
    exit(p.terminationStatus)
  } catch {
    FileHandle.standardError.write(Data("convobus: \(error)\n".utf8))
    exit(2)
  }
}

func bootGui() {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(.regular)
  app.run()
}

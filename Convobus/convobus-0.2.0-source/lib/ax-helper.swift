import ApplicationServices
import AppKit
import Foundation

func out(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func str(_ el: AXUIElement, _ key: String) -> String {
  var v: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(el, key as CFString, &v)
  guard err == .success, let v else { return "" }
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return ""
}

func attrNames(_ el: AXUIElement) -> [String] {
  var v: CFArray?
  guard AXUIElementCopyAttributeNames(el, &v) == .success, let arr = v as? [String] else { return [] }
  return arr
}

func actionNames(_ el: AXUIElement) -> [String] {
  var v: CFArray?
  guard AXUIElementCopyActionNames(el, &v) == .success, let arr = v as? [String] else { return [] }
  return arr
}

func isSettable(_ el: AXUIElement, _ key: String) -> Bool {
  var s: DarwinBoolean = false
  let err = AXUIElementIsAttributeSettable(el, key as CFString, &s)
  return err == .success && s.boolValue
}

func kids(_ el: AXUIElement) -> [AXUIElement] {
  var v: CFTypeRef?
  var err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v)
  if err != .success {
    Thread.sleep(forTimeInterval: 0.05)
    err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v)
  }
  guard err == .success else { return [] }
  return (v as? [AXUIElement]) ?? []
}

func kidsRetry(_ el: AXUIElement, tries: Int, timeout: Float) -> [AXUIElement] {
  AXUIElementSetMessagingTimeout(el, timeout)
  for i in 0..<tries {
    let list = kids(el)
    if !list.isEmpty { return list }
    var contents: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXContentsAttribute as CFString, &contents) == .success,
       let arr = contents as? [AXUIElement], !arr.isEmpty {
      return arr
    }
    if i + 1 < tries { Thread.sleep(forTimeInterval: 0.35) }
  }
  return []
}

func press(_ el: AXUIElement) -> Bool {
  AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
}

func frameOf(_ el: AXUIElement) -> CGRect? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, "AXFrame" as CFString, &v) == .success, let v else {
    return nil
  }
  var r = CGRect.zero
  if AXValueGetValue(v as! AXValue, .cgRect, &r) { return r }
  return nil
}

func elementAt(_ app: AXUIElement, _ x: Float, _ y: Float) -> AXUIElement? {
  var el: AXUIElement?
  let err = AXUIElementCopyElementAtPosition(app, x, y, &el)
  return err == .success ? el : nil
}

func hitBottom(_ app: AXUIElement, _ hits: [Hit], xRatio: CGFloat, yFromBottom: CGFloat) -> AXUIElement? {
  let target =
    hits.first(where: { $0.desc == "Primary pane" })
    ?? hits.first(where: { $0.subrole == "AXLandmarkMain" || $0.roleDesc == "main" })
    ?? hits.first(where: { $0.role == "AXWindow" })
  guard let t = target, let fr = frameOf(t.el), fr.height > 80 else { return nil }
  let x = Float(fr.minX + fr.width * xRatio)
  let y = Float(fr.maxY - yFromBottom)
  return elementAt(app, x, y)
}

func confirm(_ el: AXUIElement) -> Bool {
  let acts = actionNames(el)
  if acts.contains(kAXConfirmAction as String) {
    return AXUIElementPerformAction(el, kAXConfirmAction as CFString) == .success
  }
  return false
}

func setValue(_ el: AXUIElement, _ text: String) -> Bool {
  AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFString) == .success
}

let chatGPTBundleIdentifiers: Set<String> = ["com.openai.chat", "com.openai.codex"]

func isChatGPTSelector(_ name: String) -> Bool {
  name == "ChatGPT" || chatGPTBundleIdentifiers.contains(name)
}

func runningApplicationNamed(_ name: String) -> NSRunningApplication? {
  let apps = NSWorkspace.shared.runningApplications
  if chatGPTBundleIdentifiers.contains(name) {
    return apps.first { $0.bundleIdentifier == name }
  }
  if name == "ChatGPT" {
    return apps.first { $0.bundleIdentifier == "com.openai.codex" }
      ?? apps.first { $0.bundleIdentifier == "com.openai.chat" }
      ?? apps.first { $0.localizedName == name }
  }
  return apps.first { $0.localizedName == name }
}

func pidNamed(_ name: String) -> pid_t? {
  runningApplicationNamed(name)?.processIdentifier
}

func activateNamed(_ name: String) {
  guard let running = runningApplicationNamed(name) else { return }
  running.unhide()
  _ = running.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
}

func enableTree(_ app: AXUIElement) {
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
}

struct Hit {
  var el: AXUIElement
  var role: String
  var title: String
  var desc: String
  var value: String
  var subrole: String
  var roleDesc: String
  var placeholder: String
  var valueSettable: Bool
  var acts: [String]
  var frame: CGRect
}

func walk(_ el: AXUIElement, depth: Int, limit: Int, acc: inout [Hit], count: inout Int, deep: Bool = false) {
  if depth > 24 || count > limit { return }
  let role = str(el, kAXRoleAttribute as String)
  if role == "AXMenuBar" || role == "AXMenu" || role == "AXMenuBarItem" || role == "AXMenuItem" {
    return
  }
  count += 1
  let title = str(el, kAXTitleAttribute as String)
  let desc = str(el, kAXDescriptionAttribute as String)
  var value = str(el, kAXValueAttribute as String)
  let nChars = Int(str(el, kAXNumberOfCharactersAttribute as String)) ?? 0
  if nChars > 0 {
    let ranged = stringForRange(el)
    if !ranged.isEmpty { value = ranged }
  }
  let subrole = str(el, kAXSubroleAttribute as String)
  let roleDesc = str(el, kAXRoleDescriptionAttribute as String)
  let placeholder = str(el, kAXPlaceholderValueAttribute as String)
  if !role.isEmpty {
    acc.append(
      Hit(
        el: el,
        role: role,
        title: title,
        desc: desc,
        value: value,
        subrole: subrole,
        roleDesc: roleDesc,
        placeholder: placeholder,
        valueSettable: isSettable(el, kAXValueAttribute as String),
        acts: actionNames(el),
        frame: frameOf(el) ?? .null
      )
    )
  }
  if role == "AXWebArea" {
    AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  }
  let nextDeep = deep || roleDesc == "feed" || desc == "Chat messages" || desc.hasPrefix("Message ")
  let children: [AXUIElement]
  if role == "AXWebArea" {
    children = kidsRetry(el, tries: 3, timeout: 2.0)
    let doc = stringForRange(el)
    fputs("webAreaKids=\(children.count) docChars=\(doc.count) attrs=\(attrNames(el).joined(separator: ","))\n", stderr)
  } else if nextDeep {
    children = kidsRetry(el, tries: 2, timeout: 1.0)
  } else {
    children = kids(el)
  }
  for c in children {
    walk(c, depth: depth + 1, limit: limit, acc: &acc, count: &count, deep: nextDeep)
  }
}

func appElement(_ name: String) -> AXUIElement? {
  guard let pid = pidNamed(name) else { return nil }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 3.0)
  enableTree(app)
  return app
}

func appElementPid(_ pid: pid_t) -> AXUIElement {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 3.0)
  enableTree(app)
  return app
}

func pidsMatching(_ needle: String) -> [pid_t] {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/bin/ps")
  p.arguments = ["-axo", "pid=,command="]
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = FileHandle.nullDevice
  do { try p.run() } catch { return [] }
  p.waitUntilExit()
  let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  var out: [pid_t] = []
  for line in text.split(separator: "\n") {
    let s = line.trimmingCharacters(in: .whitespaces)
    guard s.contains(needle) else { continue }
    let pidStr = s.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
    if let pid = Int32(pidStr) { out.append(pid) }
  }
  return out
}

func walkApp(_ app: AXUIElement, acc: inout [Hit], count: inout Int, limit: Int, skipStubWalk: Bool = false) {
  var windows: CFTypeRef?
  let werr = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
  fputs("windowsErr=\(werr.rawValue)\n", stderr)
  var realWindows: [AXUIElement] = []
  if werr == .success, let list = windows as? [AXUIElement], !list.isEmpty {
    fputs("windowCount=\(list.count)\n", stderr)
    for w in list {
      let role = str(w, kAXRoleAttribute as String)
      if role == "AXApplication" || role == "AXMenuBar" || role == "AXMenu" { continue }
      realWindows.append(w)
    }
  }
  if realWindows.isEmpty {
    for key in [kAXFocusedWindowAttribute as String, kAXMainWindowAttribute as String] {
      var wref: CFTypeRef?
      if AXUIElementCopyAttributeValue(app, key as CFString, &wref) == .success, let wref {
        let w = unsafeBitCast(wref, to: AXUIElement.self)
        let role = str(w, kAXRoleAttribute as String)
        if role == "AXApplication" || role == "AXMenuBar" { continue }
        realWindows.append(w)
      }
    }
  }
  var walkedReal = false
  for w in realWindows {
    AXUIElementSetMessagingTimeout(w, 3.0)
    enableTree(w)
    walk(w, depth: 0, limit: limit, acc: &acc, count: &count)
    walkedReal = true
  }
  if !walkedReal && !skipStubWalk {
    walk(app, depth: 0, limit: limit, acc: &acc, count: &count)
  }
  var focused: CFTypeRef?
  if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
     let fe = focused {
    let fel = unsafeBitCast(fe, to: AXUIElement.self)
    fputs(
      "focused=\(str(fel, kAXRoleAttribute as String)) | \(str(fel, kAXTitleAttribute as String)) | \(str(fel, kAXDescriptionAttribute as String)) | \(str(fel, kAXRoleDescriptionAttribute as String))\n",
      stderr
    )
    acc.append(makeHit(fel))
    if !skipStubWalk {
      walk(fel, depth: 0, limit: 120, acc: &acc, count: &count)
    }
  }
}

func collect(_ name: String) -> [Hit] {
  guard let app = appElement(name) else { return [] }
  var acc: [Hit] = []
  var n = 0
  let chatgpt = isChatGPTSelector(name)
  walkApp(app, acc: &acc, count: &n, limit: chatgpt ? 800 : 800, skipStubWalk: chatgpt)
  if chatgpt {
    acc.removeAll { $0.role == "AXApplication" || $0.role == "AXMenuBar" || $0.role == "AXMenu" }
    if lastComposer(acc) == nil, let hit = hitChatGPTComposer(app, acc, selector: name) {
      acc.append(hit)
    }
  }
  return acc
}

@discardableResult
func focusEl(_ el: AXUIElement) -> Bool {
  AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
}

func normalizedComposerText(_ text: String) -> String {
  text
    .replacingOccurrences(of: "\r\n", with: "\n")
    .replacingOccurrences(of: "\r", with: "\n")
    .replacingOccurrences(of: "\u{2028}", with: "\n")
    .replacingOccurrences(of: "\u{2029}", with: "\n")
}

func composerTextEquals(_ actual: String, _ expected: String) -> Bool {
  normalizedComposerText(actual) == normalizedComposerText(expected)
}

func composerValue(_ el: AXUIElement) -> String {
  let ranged = stringForRange(el)
  return ranged.isEmpty ? str(el, kAXValueAttribute as String) : ranged
}

func composerTextMatchesSoon(_ el: AXUIElement, _ expected: String) -> Bool {
  for attempt in 0..<8 {
    if composerTextEquals(composerValue(el), expected) { return true }
    if attempt < 7 { Thread.sleep(forTimeInterval: 0.05) }
  }
  return false
}

func insertTextTree(_ el: AXUIElement, _ text: String) -> Bool {
  var ok = insertText(el, text)
  if composerTextEquals(composerValue(el), text) { return true }
  for c in kids(el) {
    if insertTextTree(c, text) { ok = true }
    if composerTextEquals(composerValue(c), text) { return true }
  }
  return ok
}

func insertText(_ el: AXUIElement, _ text: String, focus: Bool = true, mustEcho: Bool = false) -> Bool {
  if focus { focusEl(el) }
  _ = setValue(el, text)
  if composerTextMatchesSoon(el, text) { return true }
  var range = CFRange(location: 0, length: 0)
  if let axRange = AXValueCreate(.cfRange, &range) {
    AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, axRange)
  }
  _ = AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, text as CFString)
  if composerTextMatchesSoon(el, text) { return true }
  let n = Int(str(el, kAXNumberOfCharactersAttribute as String)) ?? 0
  if n > 0 {
    var full = CFRange(location: 0, length: n)
    if let axFull = AXValueCreate(.cfRange, &full) {
      AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, axFull)
      _ = AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, text as CFString)
    }
  }
  if composerTextMatchesSoon(el, text) { return true }
  // Chromium contenteditable: AXValue set is a no-op; AXReplaceRangeWithText writes.
  let n2 = max(Int(str(el, kAXNumberOfCharactersAttribute as String)) ?? 0, 1)
  var full2 = CFRange(location: 0, length: n2)
  if let axFull2 = AXValueCreate(.cfRange, &full2) {
    let dict = ["AXRange": axFull2, "AXValue": text] as CFDictionary
    var out: CFTypeRef?
    let err = AXUIElementCopyParameterizedAttributeValue(
      el,
      "AXReplaceRangeWithText" as CFString,
      dict,
      &out
    )
    if composerTextMatchesSoon(el, text) { return true }
    _ = err
  }
  _ = mustEcho
  return false
}

func pressTitled(_ hits: [Hit], _ title: String) -> Bool {
  if let b = hits.first(where: { $0.role == "AXButton" && $0.title == title }) {
    return press(b.el)
  }
  if let b = hits.first(where: { $0.role == "AXButton" && $0.desc == title }) {
    return press(b.el)
  }
  return false
}

func pressMain(_ hits: [Hit]) -> Bool {
  if let m = hits.first(where: { $0.subrole == "AXLandmarkMain" || $0.roleDesc == "main" }) {
    return press(m.el)
  }
  return false
}

func makeHit(_ el: AXUIElement) -> Hit {
  let role = str(el, kAXRoleAttribute as String)
  let title = str(el, kAXTitleAttribute as String)
  let desc = str(el, kAXDescriptionAttribute as String)
  var value = str(el, kAXValueAttribute as String)
  let nChars = Int(str(el, kAXNumberOfCharactersAttribute as String)) ?? 0
  if nChars > 0 {
    let ranged = stringForRange(el)
    if !ranged.isEmpty { value = ranged }
  }
  return Hit(
    el: el,
    role: role,
    title: title,
    desc: desc,
    value: value,
    subrole: str(el, kAXSubroleAttribute as String),
    roleDesc: str(el, kAXRoleDescriptionAttribute as String),
    placeholder: str(el, kAXPlaceholderValueAttribute as String),
    valueSettable: isSettable(el, kAXValueAttribute as String),
    acts: actionNames(el),
    frame: frameOf(el) ?? .null
  )
}

func parentElement(_ el: AXUIElement) -> AXUIElement? {
  var p: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &p) == .success, let p else {
    return nil
  }
  return unsafeBitCast(p, to: AXUIElement.self)
}

func parentKids(_ el: AXUIElement) -> [AXUIElement] {
  guard let p = parentElement(el) else { return [] }
  return kids(p)
}

func isChatGPTComposerEl(_ el: AXUIElement) -> Bool {
  let role = str(el, kAXRoleAttribute as String)
  let rd = str(el, kAXRoleDescriptionAttribute as String).lowercased()
  let desc = str(el, kAXDescriptionAttribute as String).lowercased()
  if role == "AXTextArea" || role == "AXTextField" { return true }
  if rd.contains("text entry") || rd.contains("text area") || rd.contains("text field") { return true }
  if desc.contains("message chatgpt") || desc.contains("work with chatgpt") { return true }
  return false
}

func cgOnscreenFrames(pid: pid_t) -> [CGRect] {
  guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]]
  else {
    return []
  }
  var out: [CGRect] = []
  for w in info {
    let owner = (w[kCGWindowOwnerPID as String] as? Int) ?? Int((w[kCGWindowOwnerPID as String] as? pid_t) ?? 0)
    guard owner == Int(pid) else { continue }
    guard let b = w[kCGWindowBounds as String] as? [String: Any] else { continue }
    let x = CGFloat((b["X"] as? NSNumber)?.doubleValue ?? 0)
    let y = CGFloat((b["Y"] as? NSNumber)?.doubleValue ?? 0)
    let width = CGFloat((b["Width"] as? NSNumber)?.doubleValue ?? 0)
    let height = CGFloat((b["Height"] as? NSNumber)?.doubleValue ?? 0)
    if width > 200 && height > 200 {
      out.append(CGRect(x: x, y: y, width: width, height: height))
    }
  }
  return out
}

func hitChatGPTComposer(_ app: AXUIElement, _ hits: [Hit], selector: String = "ChatGPT") -> Hit? {
  var frames: [CGRect] = []
  let target =
    hits.first(where: { $0.subrole == "AXLandmarkMain" || $0.roleDesc == "main" })
    ?? hits.first(where: { $0.role == "AXWindow" && $0.frame.height > 80 })
  if let t = target {
    let fr = t.frame.isNull ? (frameOf(t.el) ?? .null) : t.frame
    if fr.height > 80 && fr.width > 80 && fr.origin.x.isFinite { frames.append(fr) }
  }
  if frames.isEmpty, let pid = pidNamed(selector) {
    frames = cgOnscreenFrames(pid: pid)
  }
  guard let fr = frames.max(by: { $0.width * $0.height < $1.width * $1.height }), fr.height > 80 else {
    return nil
  }
  let yOffs: [CGFloat] = [50, 60, 70, 80, 90, 100, 110]
  let xRatios: [CGFloat] = [0.42, 0.50, 0.55, 0.60, 0.68, 0.75, 0.82]
  let ys: [CGFloat] = yOffs.flatMap { off in [fr.maxY - off, fr.minY + fr.height - off] }
  for yOff in ys {
    for xRatio in xRatios {
      let x = Float(fr.minX + fr.width * xRatio)
      let y = Float(yOff)
      guard let el = elementAt(app, x, y) else { continue }
      if isChatGPTComposerEl(el) { return makeHit(el) }
    }
  }
  return nil
}

func chatGPTComposer(_ app: AXUIElement, _ hits: [Hit], selector: String) -> Hit? {
  if selector == "com.openai.chat", let classic = hits.last(where: { hit in
    (hit.role == "AXTextArea" || hit.role == "AXTextField") && hit.valueSettable
  }) {
    return classic
  }
  let semantic = hits.last { hit in
    let role = hit.role
    let editableRole =
      role == "AXTextArea" || role == "AXTextField" || role == "AXComboBox"
        || hit.roleDesc.lowercased().contains("text entry")
    let blob = (hit.placeholder + " " + hit.desc).lowercased()
    return editableRole
      && (blob.contains("message") || blob.contains("prompt") || blob.contains("ask")
        || blob.contains("work with chatgpt"))
  }
  return semantic ?? hitChatGPTComposer(app, hits, selector: selector)
}

func chatGPTMode(_ selector: String, composer: Hit?, hits: [Hit]) -> String {
  if selector == "com.openai.chat" { return "classic" }
  guard selector == "com.openai.codex" else { return "unknown" }
  let composerText = composer.map {
    ($0.placeholder + " " + $0.desc + " " + $0.value).lowercased()
  } ?? ""
  if composerText.contains("message chatgpt") { return "chat" }
  if composerText.contains("work with chatgpt") { return "work" }
  let visibleText = hits.map { ($0.title + " " + $0.desc + " " + $0.placeholder).lowercased() }
    .joined(separator: "\n")
  if visibleText.contains("message chatgpt") { return "chat" }
  if visibleText.contains("work with chatgpt") { return "work" }
  return "unknown"
}

func chatGPTSend(_ composer: Hit) -> Hit? {
  for c in parentKids(composer.el) {
    let role = str(c, kAXRoleAttribute as String)
    let blob = str(c, kAXTitleAttribute as String) + " " + str(c, kAXDescriptionAttribute as String)
    let isSend = blob.range(of: "send|发送", options: [.regularExpression, .caseInsensitive]) != nil
    let mint = blob.range(of: "new chat|start new", options: [.regularExpression, .caseInsensitive]) != nil
    if role == "AXButton" && isSend && !mint { return makeHit(c) }
  }
  return nil
}

func chatGPTBar(_ composer: Hit) -> [Hit] {
  parentKids(composer.el).map(makeHit)
}

func ancestorHits(_ el: AXUIElement, levels: Int) -> [Hit] {
  var acc: [Hit] = []
  var cur = el
  for _ in 0..<levels {
    guard let p = parentElement(cur) else { break }
    acc.append(makeHit(p))
    for c in kids(p) { acc.append(makeHit(c)) }
    cur = p
  }
  return acc
}

func cursorSend(_ hits: [Hit], composer: Hit) -> Hit? {
  let fr = composer.frame
  let small = hits.filter { h in
    h.acts.contains(kAXPressAction as String) &&
      h.frame.width > 0 && h.frame.width <= 32 &&
      h.frame.height > 0 && h.frame.height <= 32 &&
      h.frame.midY >= fr.maxY - 12 &&
      h.frame.midY <= fr.maxY + 140 &&
      h.frame.minX >= fr.minX - 24
  }
  return small.max(by: { $0.frame.maxX < $1.frame.maxX })
}

func lastComposer(_ hits: [Hit], forClaude: Bool = false, forCursor: Bool = false) -> Hit? {
  let roles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"]
  if let h = hits.last(where: { roles.contains($0.role) }) { return h }
  if let h = hits.last(where: {
    $0.subrole == "AXTextArea" || $0.subrole == "AXSearchField" || $0.subrole == "AXTextField"
  }) { return h }
  if let h = hits.last(where: {
    let rd = $0.roleDesc.lowercased()
    return rd.contains("text field") || rd.contains("text area") || rd.contains("edit text")
      || rd.contains("text box") || rd.contains("text entry") || rd == "combo box" || rd == "search text field"
  }) { return h }
  if let h = hits.last(where: {
    let ph = $0.placeholder.lowercased()
    let d = $0.desc.lowercased()
    return ph.contains("ask") || ph.contains("message") || ph.contains("prompt")
      || d.contains("work with chatgpt")
  }) { return h }
  if forCursor {
    if let h = hits.last(where: {
      $0.roleDesc.lowercased().contains("text entry") || $0.desc.lowercased().contains("plan")
        || $0.placeholder.lowercased().contains("plan") || $0.placeholder.lowercased().contains("agent")
        || $0.placeholder.lowercased().contains("ask")
    }) { return h }
    if let h = hits.last(where: { $0.role == "AXWebArea" && $0.title.contains("Convo") }) { return h }
  }
  if forClaude {
    if let h = claudeComposer(hits) { return h }
    if let h = hits.last(where: {
      $0.role == "AXWebArea" && !$0.title.isEmpty && $0.title.range(of: "New chat", options: .caseInsensitive) == nil
    }) { return h }
    if let h = hits.last(where: { $0.role == "AXWebArea" }) { return h }
  }
  return nil
}

func claudeComposer(_ hits: [Hit]) -> Hit? {
  let pane = hits.first(where: { $0.desc == "Primary pane" })?.frame
    ?? hits.first(where: { $0.role == "AXWindow" })?.frame
    ?? .null
  let lower = pane.isNull ? 400.0 : pane.midY
  let groups = hits.filter { h in
    h.role == "AXGroup" &&
      h.frame.width >= 400 &&
      h.frame.height >= 28 &&
      h.frame.height <= 180 &&
      h.frame.minY >= lower &&
      h.desc != "Notifications" &&
      h.desc != "Session activity panel"
  }
  if let p = groups.last(where: { $0.acts.contains(kAXPressAction as String) && $0.frame.height >= 50 }) {
    return p
  }
  if let p = groups.last(where: { $0.acts.contains(kAXPressAction as String) }) { return p }
  return groups.max(by: { $0.frame.minY < $1.frame.minY })
}

func claudeSend(_ hits: [Hit], composer: Hit) -> Hit? {
  let fr = composer.frame
  let chrome = "add folder|auto|model|dictate|progress|outputs|context|close|minimize"
  let inBar = hits.filter { h in
    h.acts.contains(kAXPressAction as String) &&
      h.frame.maxX <= fr.maxX + 8 &&
      h.frame.minX >= fr.minX - 8 &&
      h.frame.midY >= fr.minY - 8 &&
      h.frame.midY <= fr.maxY + 8 &&
      h.frame.width <= 80 &&
      h.frame.height <= 48
  }
  if let s = inBar.last(where: { h in
    let blob = (h.title + " " + h.desc + " " + h.roleDesc).lowercased()
    return blob.range(of: chrome, options: .regularExpression) == nil
  }) { return s }
  return sendHit(hits)
}

func exactSendHit(_ hits: [Hit]) -> Hit? {
  let exact = ["send", "send message", "submit", "发送"]
  return hits.last(where: { h in
    guard h.role == "AXButton" else { return false }
    let labels = [h.title, h.desc, h.roleDesc]
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
      .filter { !$0.isEmpty }
    return labels.contains(where: { exact.contains($0) })
  })
}

func nearbyComposerHits(_ app: AXUIElement, _ composer: Hit) -> [Hit] {
  let fr = composer.frame
  guard !fr.isNull, fr.width > 20, fr.height > 8 else { return [] }
  let xOffsets: [CGFloat] = [-96, -72, -48, -32, -24, -16, -8, 0, 8, 16, 24, 32, 48, 64, 80, 96]
  let yOffsets: [CGFloat] = [-24, -12, 0, fr.height * 0.25, fr.height * 0.5, fr.height * 0.75, fr.height, fr.height + 12, fr.height + 24]
  var seen = Set<String>()
  var out: [Hit] = []
  for xo in xOffsets {
    for yo in yOffsets {
      guard let el = elementAt(app, Float(fr.maxX + xo), Float(fr.minY + yo)) else { continue }
      let hit = makeHit(el)
      let key = "\(hit.role)|\(hit.title)|\(hit.desc)|\(hit.frame)"
      if seen.insert(key).inserted { out.append(hit) }
    }
  }
  return out
}

func sendHit(_ hits: [Hit]) -> Hit? {
  let buttons = hits.filter { $0.role == "AXButton" }
  if let exact = exactSendHit(hits) { return exact }
  if let s = buttons.first(where: { b in
    let blob = (b.title + " " + b.desc + " " + b.roleDesc)
    let isSend =
      blob.range(of: "send|发送|paper plane|submit", options: [.regularExpression, .caseInsensitive]) != nil
    let chrome =
      blob.range(
        of: "close|minimize|zoom|full screen|hide sidebar|back|forward|share|send feedback",
        options: [.regularExpression, .caseInsensitive]
      ) != nil
    return isSend && !chrome
  }) { return s }
  return nil
}

func composerStillContains(_ hits: [Hit], _ text: String) -> Bool {
  let roles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox"]
  return hits.contains { h in
    (roles.contains(h.role) || h.roleDesc.lowercased().contains("text entry")) &&
      h.value.contains(text)
  }
}

func composerElementStillContains(_ element: AXUIElement, _ text: String) -> Bool {
  let ranged = stringForRange(element)
  let value = ranged.isEmpty ? str(element, kAXValueAttribute as String) : ranged
  return value.contains(text)
}

func isClock(_ s: String) -> Bool {
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  return t.range(of: #"^\d{1,2}:\d{2}(\s?[APMapm]{2})?$"#, options: .regularExpression) != nil
}

func lastStatic(_ hits: [Hit]) -> String {
  hits.last { $0.role == "AXStaticText" && !$0.value.isEmpty && !isClock($0.value) }?.value ?? ""
}

func staticTextValues(_ hits: [Hit]) -> [String] {
  hits.compactMap { hit in
    guard hit.role == "AXStaticText" else { return nil }
    let raw = !hit.value.isEmpty ? hit.value : !hit.desc.isEmpty ? hit.desc : hit.title
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty || isClock(value) ? nil : value
  }
}

func addedStaticTexts(_ before: [String], _ after: [String]) -> [String] {
  var remaining: [String: Int] = [:]
  for value in before { remaining[value, default: 0] += 1 }
  var added: [String] = []
  for value in after {
    if let count = remaining[value], count > 0 {
      remaining[value] = count - 1
    } else {
      added.append(value)
    }
  }
  return added
}

func classicReplyAfterBody(_ before: [String], _ hits: [Hit], body: String) -> String {
  let added = addedStaticTexts(before, staticTextValues(hits))
  guard let bodyIndex = added.firstIndex(where: { $0 == body || $0.contains(body) }) else { return "" }
  for value in added.dropFirst(bodyIndex + 1) {
    let candidate = value
      .replacingOccurrences(of: "\u{FFFC}", with: "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let chrome = ["Ask ChatGPT", "Share", "Toggle Sidebar"]
    if !candidate.isEmpty && candidate != body && !isClock(candidate) && !chrome.contains(candidate) {
      return candidate
    }
  }
  return ""
}

func generating(_ hits: [Hit]) -> Bool {
  hits.contains {
    $0.role == "AXButton" &&
      ($0.title + " " + $0.desc + " " + $0.roleDesc).range(of: "Stop generating|停止生成") != nil
  }
}

func claudeFinished(_ hits: [Hit]) -> Bool {
  hits.contains {
    $0.role == "AXStaticText" && $0.value.range(of: "Claude finished the response") != nil
  }
}

func claudeSaidCount(_ hits: [Hit]) -> Int {
  hits.filter {
    ($0.title + " " + $0.desc + " " + $0.value).range(
      of: "Claude responded:",
      options: [.regularExpression, .caseInsensitive]
    ) != nil
  }.count
}

func stringForRange(_ el: AXUIElement) -> String {
  var num: CFTypeRef?
  AXUIElementCopyAttributeValue(el, kAXNumberOfCharactersAttribute as CFString, &num)
  let n = (num as? NSNumber)?.intValue ?? 0
  var range = CFRange(location: 0, length: n)
  if n > 0, let axRange = AXValueCreate(.cfRange, &range) {
    var v: CFTypeRef?
    let err = AXUIElementCopyParameterizedAttributeValue(
      el,
      kAXStringForRangeParameterizedAttribute as CFString,
      axRange,
      &v
    )
    if err == .success, let s = v as? String, !s.isEmpty { return s }
  }
  return str(el, kAXValueAttribute as String)
}

func stringForTextMarkers(_ el: AXUIElement) -> String {
  var start: CFTypeRef?
  var end: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, "AXStartTextMarker" as CFString, &start) == .success,
        AXUIElementCopyAttributeValue(el, "AXEndTextMarker" as CFString, &end) == .success,
        let start,
        let end
  else {
    return ""
  }

  let markers = [start, end] as CFArray
  var markerRange: CFTypeRef?
  guard AXUIElementCopyParameterizedAttributeValue(
    el,
    "AXTextMarkerRangeForUnorderedTextMarkers" as CFString,
    markers,
    &markerRange
  ) == .success,
        let markerRange
  else {
    return ""
  }

  var text: CFTypeRef?
  guard AXUIElementCopyParameterizedAttributeValue(
    el,
    "AXStringForTextMarkerRange" as CFString,
    markerRange,
    &text
  ) == .success
  else {
    return ""
  }
  return text as? String ?? ""
}

func documentText(_ hits: [Hit]) -> String {
  if let web = hits.first(where: { $0.role == "AXWebArea" }) {
    let s = stringForRange(web.el)
    if !s.isEmpty { return s }
    let marked = stringForTextMarkers(web.el)
    if !marked.isEmpty { return marked }
  }
  return ""
}

func stripSaidPrefix(_ s: String) -> String {
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  for p in ["Claude responded: ", "Claude said: ", "ChatGPT said: ", "GPT said: ", "You said: "] {
    if t.lowercased().hasPrefix(p.lowercased()) {
      return String(t.dropFirst(p.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }
  return t
}

func assistantBlock(_ hits: [Hit]) -> String {
  if let h = hits.last(where: {
    $0.role == "AXHeading" && ($0.title + " " + $0.desc + " " + $0.value).range(
      of: "Claude responded:|Claude said:",
      options: [.regularExpression, .caseInsensitive]
    ) != nil
  }) {
    let raw = [h.title, h.desc, h.value].first { !$0.isEmpty && $0.range(of: "Claude") != nil } ?? h.value
    return stripSaidPrefix(raw)
  }
  guard let i = hits.lastIndex(where: {
    $0.role == "AXHeading" && ($0.title + $0.desc).range(of: "ChatGPT said|GPT said") != nil
  }) else { return "" }
  var parts: [String] = []
  for h in hits.suffix(from: i + 1) {
    if h.role == "AXHeading" { break }
    if h.role == "AXButton" || h.role == "AXCheckBox" || h.role == "AXPopUpButton" { continue }
    if h.role == "AXStaticText" {
      if isClock(h.value) { continue }
      if !h.value.isEmpty { parts.append(h.value) }
      continue
    }
    if !h.value.isEmpty { parts.append(h.value) }
    else if !h.desc.isEmpty && h.role == "AXGroup" { parts.append(h.desc) }
  }
  return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

func occurrenceCount(_ text: String, needle: String) -> Int {
  guard !needle.isEmpty else { return 0 }
  var count = 0
  var cursor = text.startIndex
  while cursor < text.endIndex,
        let range = text.range(of: needle, range: cursor..<text.endIndex)
  {
    count += 1
    cursor = range.upperBound
  }
  return count
}

func chatGPTDocumentReply(_ document: String, afterSaidCount: Int) -> String {
  let marker = "ChatGPT said:"
  guard occurrenceCount(document, needle: marker) > afterSaidCount,
        let last = document.range(of: marker, options: .backwards)
  else {
    return ""
  }

  var candidate = String(document[last.upperBound...])
  let boundaries = ["\u{FFFC}\u{FFFC}", "\nMessage ChatGPT", "\nYou said:"]
  let end = boundaries.compactMap { candidate.range(of: $0)?.lowerBound }.min()
  if let end { candidate = String(candidate[..<end]) }
  return candidate
    .replacingOccurrences(of: "\u{FFFC}", with: "")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

func addedAfter(_ before: String, _ after: String) -> String {
  if after.hasPrefix(before) {
    return String(after.dropFirst(before.count)).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  return ""
}

func usableReply(_ raw: String, body: String, snap: String) -> String {
  var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  if s.isEmpty || s == snap || isClock(s) { return "" }
  if s.hasPrefix(body) {
    s = String(s.dropFirst(body.count)).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  if s.isEmpty || isClock(s) { return "" }
  return s
}

func dumpLine(_ h: Hit) -> String {
  "\(h.role) | \(h.title) | \(h.desc) | \(h.value.prefix(80))"
}

func feedHits(_ hits: [Hit]) -> [Hit] {
  guard let feed = hits.first(where: { $0.desc == "Chat messages" }) else { return [] }
  var acc: [Hit] = []
  var n = 0
  walk(feed.el, depth: 0, limit: 300, acc: &acc, count: &n, deep: true)
  return acc
}

func findDesc(_ el: AXUIElement, _ want: String, depth: Int) -> AXUIElement? {
  if depth > 20 { return nil }
  if str(el, kAXDescriptionAttribute as String) == want { return el }
  for c in kids(el) {
    if let hit = findDesc(c, want, depth: depth + 1) { return hit }
  }
  return nil
}

func dumpFeed(_ name: String) {
  let trusted = AXIsProcessTrustedWithOptions(
    [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  )
  print("trusted=\(trusted)")
  guard let app = appElement(name) else {
    print("\(name): not running")
    return
  }
  enableTree(app)
  Thread.sleep(forTimeInterval: 0.8)
  var windows: CFTypeRef?
  AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
  var feedEl: AXUIElement?
  for w in (windows as? [AXUIElement]) ?? [] {
    feedEl = findDesc(w, "Chat messages", depth: 0)
    if feedEl != nil { break }
  }
  guard let feed = feedEl else {
    print("feedHits=0")
    return
  }
  var acc: [Hit] = []
  var n = 0
  walk(feed, depth: 0, limit: 300, acc: &acc, count: &n, deep: true)
  print("feedHits=\(acc.count)")
  for h in acc { print(dumpLine(h)) }
}

func dump(_ name: String) {
  let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  let trusted = AXIsProcessTrustedWithOptions(opts)
  let pid = pidNamed(name)
  print("trusted=\(trusted) pid=\(pid as Any)")
  if let app = appElement(name) {
    enableTree(app)
    Thread.sleep(forTimeInterval: 1.2)
  }
  let hits = collect(name)
  print("hits=\(hits.count)")
  if hits.isEmpty {
    print("\(name): not running or no AX")
    return
  }
  print(name)
  for h in hits {
    print(dumpLine(h))
    fputs(
      "  settable=\(h.valueSettable) sub=\(h.subrole) rd=\(h.roleDesc) ph=\(h.placeholder) acts=\(h.acts.joined(separator: ","))\n",
      stderr
    )
  }
}

func probe(_ name: String) {
  let trusted = AXIsProcessTrusted()
  guard let app = appElement(name) else {
    out(["ok": true, "running": false, "composer": false, "trusted": trusted, "tcc": !trusted])
    return
  }
  guard trusted else {
    out(["ok": true, "running": true, "composer": false, "trusted": false, "tcc": true])
    return
  }
  let hits = collect(name)
  let composer = isChatGPTSelector(name)
    ? chatGPTComposer(app, hits, selector: name)
    : lastComposer(hits, forClaude: name == "Claude", forCursor: name == "Cursor")
  var controls = hits
  if name == "Claude", let composer {
    controls += ancestorHits(composer.el, levels: 4)
    controls += nearbyComposerHits(app, composer)
  }
  let sendControl = exactSendHit(controls)
  let mode: Any = isChatGPTSelector(name)
    ? chatGPTMode(name, composer: composer, hits: hits)
    : NSNull()
  out([
    "ok": true,
    "pid": pidNamed(name) as Any,
    "running": true,
    "composer": composer != nil,
    "mode": mode,
    "send": sendControl != nil,
    "nearby": controls.suffix(24).map { dumpLine($0) }.joined(separator: "\n"),
    "trusted": true,
    "tcc": false,
    "hits": hits.count,
  ])
}

func failNoComposer(trusted: Bool, name: String, hits: [Hit]) {
  let lines = hits.prefix(40).map { dumpLine($0) }
  out([
    "ok": false,
    "fragile": true,
    "trusted": trusted,
    "pid": pidNamed(name) as Any,
    "hits": hits.count,
    "dump": lines.joined(separator: "\n"),
    "error": "dump has not returned a composer role",
  ])
}

func send(
  name: String,
  text: String,
  timeoutMs: Int,
  attachNeedle: String = "",
  expectedMode: String = ""
) {
  // Prove the surface/session, replace and verify exactly, submit once, then capture only post-snapshot text.
  let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  let trusted = AXIsProcessTrustedWithOptions(opts)
  let claude = name == "Claude"
  let cursor = name == "Cursor"
  let chatgpt = isChatGPTSelector(name)
  let previousFrontmost = NSWorkspace.shared.frontmostApplication
  var restoredPrevious = false
  func restorePreviousApplication() {
    guard !restoredPrevious else { return }
    restoredPrevious = true
    guard let previousFrontmost,
          previousFrontmost.processIdentifier != getpid(),
          previousFrontmost.processIdentifier != runningApplicationNamed(name)?.processIdentifier
    else { return }
    _ = previousFrontmost.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
  }
  defer { restorePreviousApplication() }
  if claude || cursor || chatgpt { activateNamed(name) }
  guard let app = appElement(name) else {
    out(["ok": false, "error": "\(name): not running", "trusted": trusted])
    return
  }
  enableTree(app)
  Thread.sleep(forTimeInterval: 1.2)
  var t0 = collect(name)
  if chatgpt && !attachNeedle.isEmpty {
    let blob = t0.map { $0.title + " " + $0.desc + " " + $0.value }.joined(separator: "\n")
    if blob.range(of: attachNeedle, options: .caseInsensitive) == nil {
      out([
        "ok": false,
        "submitted": false,
        "fragile": true,
        "trusted": trusted,
        "pid": pidNamed(name) as Any,
        "hits": t0.count,
        "dump": t0.prefix(40).map { dumpLine($0) }.joined(separator: "\n"),
        "error": "attached session not visible in ChatGPT window",
      ])
      return
    }
  }
  if chatgpt, let hit = chatGPTComposer(app, t0, selector: name) {
    t0.append(hit)
  } else if lastComposer(t0, forClaude: claude, forCursor: cursor) == nil {
    if chatgpt, let hit = chatGPTComposer(app, t0, selector: name) {
      t0.append(hit)
    } else {
      _ = pressMain(t0)
      Thread.sleep(forTimeInterval: 0.6)
      t0 = collect(name)
      if chatgpt, let hit = chatGPTComposer(app, t0, selector: name) { t0.append(hit) }
    }
  }
  let selectedComposer = chatgpt
    ? chatGPTComposer(app, t0, selector: name)
    : lastComposer(t0, forClaude: claude, forCursor: cursor)
  guard var composer = selectedComposer else {
    failNoComposer(trusted: trusted, name: name, hits: t0)
    return
  }
  if chatgpt && !expectedMode.isEmpty {
    let detectedMode = chatGPTMode(name, composer: composer, hits: t0)
    if detectedMode != expectedMode {
      out([
        "ok": false,
        "submitted": false,
        "fragile": false,
        "mode": detectedMode,
        "error": "expected ChatGPT \(expectedMode) surface; found \(detectedMode)",
      ])
      return
    }
  }
  if cursor, let ta = t0.last(where: { $0.role == "AXTextArea" || $0.roleDesc.lowercased().contains("text entry") }) {
    composer = ta
  }
  var composerEl = composer.el
  if composer.role == "AXWebArea", let hit = hitBottom(app, t0, xRatio: 0.38, yFromBottom: 80) {
    composerEl = hit
    fputs(
      "hitComposer=\(str(hit, kAXRoleAttribute as String)) | \(str(hit, kAXTitleAttribute as String)) | \(str(hit, kAXDescriptionAttribute as String)) | \(str(hit, kAXRoleDescriptionAttribute as String))\n",
      stderr
    )
  }
  fputs(
    "composer=\(composer.role) | \(composer.title) | \(composer.desc) | \(composer.roleDesc) frame=\(composer.frame)\n",
    stderr
  )
  if !chatgpt { _ = press(composerEl) }
  Thread.sleep(forTimeInterval: 0.2)
  var inserted = insertText(composerEl, text, focus: !chatgpt, mustEcho: cursor)
  if claude && !composerTextEquals(str(composerEl, kAXValueAttribute as String), text) {
    inserted = insertTextTree(composerEl, text) || inserted
  }
  if chatgpt && !inserted {
    focusEl(composerEl)
    Thread.sleep(forTimeInterval: 0.2)
    let focusedHits = collect(name)
    if let focusedComposer = chatGPTComposer(app, focusedHits, selector: name) {
      let focusedMode = chatGPTMode(name, composer: focusedComposer, hits: focusedHits)
      if !expectedMode.isEmpty && focusedMode != expectedMode {
        out([
          "ok": false,
          "submitted": false,
          "fragile": false,
          "mode": focusedMode,
          "error": "expected ChatGPT \(expectedMode) surface; found \(focusedMode)",
        ])
        return
      }
      composer = focusedComposer
      composerEl = focusedComposer.el
    }
    inserted = insertText(composerEl, text, focus: true)
  }
  if !inserted {
    out(["ok": false, "fragile": true, "error": "could not set composer value"])
    return
  }
  guard composerTextEquals(composerValue(composerEl), text) else {
    out(["ok": false, "submitted": false, "fragile": true, "error": "composer did not exactly match message"])
    return
  }
  Thread.sleep(forTimeInterval: 0.4)
  if chatgpt {
    composer = makeHit(composerEl)
  }
  var t1 = collect(name)
  if claude {
    t1 += feedHits(t1)
    t1 += ancestorHits(composerEl, levels: 4)
    t1 += nearbyComposerHits(app, composer)
  }
  if chatgpt { t1 += chatGPTBar(composer) }
  if cursor { t1 += ancestorHits(composerEl, levels: 8) }
  let snapDoc = documentText(t1)
  let snapStatic = lastStatic(t1)
  let snapStaticTexts = staticTextValues(t1)
  let snap = snapDoc.isEmpty ? snapStatic : snapDoc
  let gptDocumentSaid0 = occurrenceCount(snapDoc, needle: "ChatGPT said:")
  let idleAtSend = claudeFinished(t1)
  let said0 = claudeSaidCount(t1)
  let gptSaid0 = t1.filter { $0.role == "AXHeading" && ($0.title + $0.desc).contains("ChatGPT said") }.count
  let sent: Bool
  var sendB = exactSendHit(t1)
    ?? (claude ? claudeSend(t1, composer: composer) : nil)
    ?? (chatgpt ? chatGPTSend(composer) : nil)
    ?? (cursor ? cursorSend(t1, composer: composer) : nil)
    ?? sendHit(t1)
    ?? sendHit(t0)
  if claude && sendB == nil {
    for _ in 0..<8 {
      Thread.sleep(forTimeInterval: 0.25)
      var refreshedHits = collect(name)
      refreshedHits += feedHits(refreshedHits)
      refreshedHits += ancestorHits(composerEl, levels: 6)
      refreshedHits += nearbyComposerHits(app, composer)
      sendB = exactSendHit(refreshedHits) ?? claudeSend(refreshedHits, composer: composer)
      if sendB != nil {
        t1 = refreshedHits
        break
      }
    }
  }
  if chatgpt && sendB == nil {
    for _ in 0..<8 {
      Thread.sleep(forTimeInterval: 0.25)
      sendB = chatGPTSend(composer)
      if sendB != nil { break }
    }
  }
  if let sendB {
    sent = press(sendB.el)
    if !sent {
      out(["ok": false, "fragile": true, "error": "AXPress failed"])
      return
    }
  } else if confirm(composerEl) {
    sent = true
  } else if let sendHitEl = elementAt(
    app,
    Float(composer.frame.maxX - 24),
    Float(composer.frame.minY + min(composer.frame.height * 0.35, 36))
  ), press(sendHitEl) {
    fputs(
      "hitSend=\(str(sendHitEl, kAXRoleAttribute as String)) | \(str(sendHitEl, kAXTitleAttribute as String)) | \(str(sendHitEl, kAXDescriptionAttribute as String))\n",
      stderr
    )
    sent = true
  } else {
    failNoComposer(trusted: trusted, name: name, hits: t1)
    return
  }
  _ = sent
  if claude {
    Thread.sleep(forTimeInterval: 0.5)
    var verifyHits = collect(name)
    if let current = lastComposer(verifyHits, forClaude: true) {
      verifyHits += ancestorHits(current.el, levels: 4)
      verifyHits += nearbyComposerHits(app, current)
    }
    if composerElementStillContains(composerEl, text) || composerStillContains(verifyHits, text) {
      if let exact = exactSendHit(verifyHits) ?? sendB, press(exact.el) {
        Thread.sleep(forTimeInterval: 0.5)
        verifyHits = collect(name)
        if let current = lastComposer(verifyHits, forClaude: true) {
          verifyHits += ancestorHits(current.el, levels: 4)
          verifyHits += nearbyComposerHits(app, current)
        }
      }
      if composerElementStillContains(composerEl, text) || composerStillContains(verifyHits, text) {
        out([
          "ok": false,
          "submitted": false,
          "fragile": true,
          "error": "send control did not clear composer",
        ])
        return
      }
    }
  }
  // The provider may need a moment of activation for reliable AX submission,
  // but the user's foreground app is restored before reply polling begins.
  restorePreviousApplication()
  let waitStart = Date()
  let deadline = waitStart.addingTimeInterval(Double(timeoutMs) / 1000.0)
  var seenGen = false
  var strongNewReply = false
  var reply = ""
  var lastHits = t1
  var headingAt: Date?
  var genGoneAt: Date?
  while Date() < deadline {
    Thread.sleep(forTimeInterval: 0.2)
    var nowHits = collect(name)
    if claude { nowHits += feedHits(nowHits) }
    if chatgpt { nowHits += chatGPTBar(composer) }
    lastHits = nowHits
    let gen = generating(nowHits) || (chatgpt && generating(chatGPTBar(composer)))
    let finished = claudeFinished(nowHits)
    if gen || (idleAtSend && !finished) { seenGen = true }
    if chatgpt && gen { seenGen = true }
    let doc = documentText(nowHits)
    let saidN = claudeSaidCount(nowHits)
    let gptSaidN = nowHits.filter { $0.role == "AXHeading" && ($0.title + $0.desc).contains("ChatGPT said") }.count
    // Very short Claude replies can finish between two 200 ms polls, so the
    // Stop generating control is never observed.  A new, route-local Claude
    // response heading is the stronger completion signal in that case.
    if claude && saidN > said0 {
      seenGen = true
      strongNewReply = true
    }
    if chatgpt && gptSaidN > gptSaid0 {
      seenGen = true
      strongNewReply = true
    }
    let block =
      claude && saidN <= said0 ? "" : assistantBlock(nowHits)
    let delta = addedAfter(snap, doc)
    let classicBlock = chatgpt && name == "com.openai.chat"
      ? classicReplyAfterBody(snapStaticTexts, nowHits, body: text)
      : ""
    let documentBlock = chatgpt && name == "com.openai.codex"
      ? chatGPTDocumentReply(doc, afterSaidCount: gptDocumentSaid0)
      : ""
    if !classicBlock.isEmpty {
      seenGen = true
      strongNewReply = true
    }
    if !documentBlock.isEmpty {
      seenGen = true
      strongNewReply = true
    }
    let rawCandidate = !classicBlock.isEmpty
      ? classicBlock
      : !documentBlock.isEmpty ? documentBlock : block.isEmpty ? delta : block
    let candidate = usableReply(rawCandidate, body: text, snap: snapStatic)
    let said = nowHits.contains(where: {
      $0.role == "AXHeading" && ($0.title + $0.desc).contains("ChatGPT said")
    })
    if (said || (claude && saidN > said0) || (chatgpt && gptSaidN > gptSaid0)) && headingAt == nil { headingAt = Date() }
    if (chatgpt || cursor) && !seenGen && Date().timeIntervalSince(waitStart) > 6 {
      break
    }
    if gen {
      genGoneAt = nil
      continue
    }
    if chatgpt && seenGen && genGoneAt == nil { genGoneAt = Date() }
    if chatgpt && seenGen, let g = genGoneAt, Date().timeIntervalSince(g) > 0.8 {
      if !candidate.isEmpty {
        reply = candidate
        break
      }
      if Date().timeIntervalSince(g) > 8.0 { break }
      continue
    }
    if seenGen {
      if !candidate.isEmpty {
        reply = candidate
        break
      }
      if claude && saidN > said0 && finished {
        let saidText = assistantBlock(nowHits)
        if !saidText.isEmpty {
          reply = saidText
          break
        }
      }
      if finished && idleAtSend && !claude { break }
      if let t = headingAt, Date().timeIntervalSince(t) > 2.0 { break }
      continue
    }
    if !candidate.isEmpty && said {
      reply = candidate
      break
    }
    if let t = headingAt, Date().timeIntervalSince(t) > 2.5 { break }
  }
  if reply.isEmpty {
    let saidN = claudeSaidCount(lastHits)
    if claude && saidN > said0 { strongNewReply = true }
    let block = claude && saidN <= said0 ? "" : assistantBlock(lastHits)
    let delta = addedAfter(snap, documentText(lastHits))
    let classicBlock = chatgpt && name == "com.openai.chat"
      ? classicReplyAfterBody(snapStaticTexts, lastHits, body: text)
      : ""
    if !classicBlock.isEmpty { strongNewReply = true }
    let documentBlock = chatgpt && name == "com.openai.codex"
      ? chatGPTDocumentReply(documentText(lastHits), afterSaidCount: gptDocumentSaid0)
      : ""
    if !documentBlock.isEmpty { strongNewReply = true }
    let rawCandidate = !classicBlock.isEmpty
      ? classicBlock
      : !documentBlock.isEmpty ? documentBlock : block.isEmpty ? delta : block
    reply = usableReply(rawCandidate, body: text, snap: snapStatic)
  }
  if reply.isEmpty || (reply == snap && !strongNewReply) || isClock(reply) {
    out([
      "ok": seenGen,
      "submitted": true,
      "reply": NSNull(),
      "snapshot": String(snap.prefix(200)),
      "error": seenGen ? "no new reply after snapshot" : "generating control never appeared",
      "docChars": documentText(lastHits).count,
      "assistant": assistantBlock(lastHits),
    ])
    return
  }
  out(["ok": true, "submitted": true, "reply": reply, "fragile": false, "snapshot": String(snap.prefix(200))])
}

func axHelperMain() {
  let args = Array(CommandLine.arguments.dropFirst())
  if args.first == "--ax-probe" || args.first == "probe" {
    let name = args.count > 1 ? args[1] : "ChatGPT"
    probe(name)
    return
  }
  if args.first == "--ax-feed" {
    let name = args.count > 1 ? args[1] : "Claude"
    dumpFeed(name)
    return
  }
  if args.first == "--ax-send" || args.first == "send" {
    let payloadPath = ProcessInfo.processInfo.environment["CONVO_AX_PAYLOAD"] ?? (args.count > 1 ? args[1] : "")
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: payloadPath)),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      out(["ok": false, "error": "no payload"])
      exit(2)
    }
    let name = (obj["processName"] as? String) ?? "ChatGPT"
    let text = (obj["text"] as? String) ?? ""
    let timeoutMs = (obj["timeoutMs"] as? Int) ?? 90000
    let needle = (obj["attachNeedle"] as? String) ?? ""
    let expectedMode = (obj["expectedMode"] as? String) ?? ""
    send(
      name: name,
      text: text,
      timeoutMs: timeoutMs,
      attachNeedle: needle,
      expectedMode: expectedMode
    )
    return
  }
  let name: String
  if let i = args.firstIndex(of: "--ax-dump"), i + 1 < args.count {
    name = args[i + 1]
  } else if args.first == "dump", args.count > 1 {
    name = args[1]
  } else {
    name = "ChatGPT"
  }
  dump(name)
}

import AppKit
import ApplicationServices
import Foundation
import Security
import WebKit

// Native shell; the helper receives its launch token over stdin.

let appDisplayName = "Agent Wheel"
let keychainService = "Agent Wheel"
let providerAccounts = ["anthropic", "openai", "xai"]
let recoveryRequiredText =
  "Agent Wheel recovered an interrupted turn. Review the last durable state, then Retry, Resume, "
  + "Discard the late result, or Stop."

func appSupportHome() -> String {
  NSHomeDirectory() + "/Library/Application Support/Agent Wheel"
}

func shellLog(_ line: String) {
  let home = appSupportHome()
  try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
  let file = home + "/shell.log"
  let stamp = ISO8601DateFormatter().string(from: Date())
  let data = Data("\(stamp) \(line)\n".utf8)
  if let handle = FileHandle(forWritingAtPath: file) {
    handle.seekToEndOfFile()
    handle.write(data)
    handle.closeFile()
  } else {
    FileManager.default.createFile(atPath: file, contents: data)
  }
}

// Installed apps must use the bundled runtime; source builds may use system Node.
func findNode() -> String? {
  if let resources = Bundle.main.resourcePath {
    let bundled = resources + "/runtime/bin/node"
    if FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
    if Bundle.main.bundlePath.hasSuffix(".app") { return nil }
  }
  for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
    if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
  }
  return nil
}

func findPayload() -> String? {
  let fm = FileManager.default
  if let resources = Bundle.main.resourcePath {
    let bundled = resources + "/payload/agentwheel"
    if fm.fileExists(atPath: bundled + "/bin/agentwheel.js") { return bundled }
    if Bundle.main.bundlePath.hasSuffix(".app") { return nil }
  }
  var dir = URL(fileURLWithPath: Bundle.main.executablePath ?? Bundle.main.bundlePath).deletingLastPathComponent()
  for _ in 0..<6 {
    let candidate = dir.appendingPathComponent("agentwheel").path
    if fm.fileExists(atPath: candidate + "/bin/agentwheel.js") { return candidate }
    dir.deleteLastPathComponent()
  }
  return nil
}

func newLaunchToken() -> String {
  var bytes = [UInt8](repeating: 0, count: 32)
  let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
  if status != errSecSuccess {
    for i in 0..<bytes.count { bytes[i] = UInt8.random(in: 0...255) }
  }
  return bytes.map { String(format: "%02x", $0) }.joined()
}


func keychainQuery(_ account: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: keychainService,
    kSecAttrAccount as String: account,
  ]
}

func keychainRead(_ account: String) -> String? {
  var query = keychainQuery(account)
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  guard status == errSecSuccess, let data = item as? Data else { return nil }
  return String(data: data, encoding: .utf8)
}

func keychainWrite(_ account: String, _ value: String) -> Bool {
  SecItemDelete(keychainQuery(account) as CFDictionary)
  var attrs = keychainQuery(account)
  attrs[kSecValueData as String] = Data(value.utf8)
  attrs[kSecAttrLabel as String] = "\(appDisplayName) \(account) API key"
  return SecItemAdd(attrs as CFDictionary, nil) == errSecSuccess
}

func keychainDelete(_ account: String) -> Bool {
  let status = SecItemDelete(keychainQuery(account) as CFDictionary)
  return status == errSecSuccess || status == errSecItemNotFound
}

// Run Keychain calls off the main thread because access prompts can block.
let keychainQueue = DispatchQueue(label: "agent-wheel.keychain")

func keychainPresent(_ account: String) -> Bool {
  var query = keychainQuery(account)
  query[kSecReturnAttributes as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var item: CFTypeRef?
  return SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess
}

@discardableResult
func requestAccessibility() -> Bool {
  AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
}

func openAccessibilityPane() {
  guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
  else { return }
  NSWorkspace.shared.open(url)
}

// Revalidate application paths in the native bridge before launching them.
func openInstalledApp(_ path: String, at project: String?) -> Bool {
  guard path.hasSuffix(".app") else { return false }
  let url = URL(fileURLWithPath: path).standardizedFileURL
  let roots = ["/Applications", NSHomeDirectory() + "/Applications"]
  guard roots.contains(where: { url.path.hasPrefix($0 + "/") }) else { return false }
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue
  else { return false }
  if let project, !project.isEmpty {
    let folder = URL(fileURLWithPath: project).standardizedFileURL
    var folderIsDirectory: ObjCBool = false
    if FileManager.default.fileExists(atPath: folder.path, isDirectory: &folderIsDirectory),
       folderIsDirectory.boolValue
    {
      NSWorkspace.shared.open([folder], withApplicationAt: url,
                              configuration: NSWorkspace.OpenConfiguration())
      return true
    }
  }
  NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
  return true
}


final class HelperProcess {
  let process = Process()
  let stdinPipe = Pipe()
  let stdoutPipe = Pipe()
  let stderrPipe = Pipe()
  let token: String
  var port: Int = 0
  var pid: Int32 = 0
  private var stdoutBuffer = Data()
  var onReady: ((Int) -> Void)?
  var onExit: ((Int32) -> Void)?
  private var ready = false

  init(token: String) {
    self.token = token
  }

  func launch(node: String, payload: String) throws {
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = [payload + "/bin/agentwheel.js", "helper"]
    process.currentDirectoryURL = URL(fileURLWithPath: appSupportHome())
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "\(NSHomeDirectory())/.local/bin:\(NSHomeDirectory())/.grok/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    env["AGENT_WHEEL_HOME"] = appSupportHome()
    env["AGENT_WHEEL_APP_BUNDLE"] = Bundle.main.bundlePath
    env.removeValue(forKey: "AGENT_WHEEL_STORE")
    // Do not propagate a host agent’s nested-session environment to seats.
    for key in env.keys where key == "CLAUDECODE" || key.hasPrefix("CLAUDE_") || key.hasPrefix("MCP_") {
      env.removeValue(forKey: key)
    }
    process.environment = env
    process.standardInput = stdinPipe
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty { return }
      self?.consumeStdout(data)
    }
    stderrPipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      if data.isEmpty { return }
      if let text = String(data: data, encoding: .utf8) {
        for line in text.split(separator: "\n") { shellLog("helper stderr: \(line)") }
      }
    }
    process.terminationHandler = { [weak self] p in
      self?.stdoutPipe.fileHandleForReading.readabilityHandler = nil
      self?.stderrPipe.fileHandleForReading.readabilityHandler = nil
      let status = p.terminationStatus
      DispatchQueue.main.async { self?.onExit?(status) }
    }
    try process.run()
    pid = process.processIdentifier
    // Keep stdin open: EOF tells the helper its parent exited.
    let launch: [String: Any] = ["token": token, "home": appSupportHome()]
    let line = try JSONSerialization.data(withJSONObject: launch)
    stdinPipe.fileHandleForWriting.write(line)
    stdinPipe.fileHandleForWriting.write(Data("\n".utf8))
  }

  private func consumeStdout(_ data: Data) {
    stdoutBuffer.append(data)
    while let newline = stdoutBuffer.firstIndex(of: 0x0A) {
      let lineData = stdoutBuffer.subdata(in: 0..<newline)
      stdoutBuffer.removeSubrange(0...newline)
      guard let line = String(data: lineData, encoding: .utf8) else { continue }
      if !ready,
         let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
         obj["ready"] as? Bool == true,
         let port = obj["port"] as? Int
      {
        ready = true
        self.port = port
        DispatchQueue.main.async { self.onReady?(port) }
        continue
      }
      shellLog("helper: \(line)")
    }
  }

  func stop() {
    if process.isRunning {
      process.terminate()
      let deadline = Date().addingTimeInterval(3)
      while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
      }
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
  }
}


final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate,
  WKUIDelegate, WKScriptMessageHandler
{
  var statusItem: NSStatusItem?
  var window: NSWindow?
  var webView: WKWebView?
  var helper: HelperProcess?
  var helperPort: Int = 0
  var quitting = false
  var restarts = 0
  var pollTimer: Timer?
  var lastStatus = "starting"
  var recoveryPending = false
  var pollFailures = 0
  var accessibilityTrusted = false  // last seen state of the switch, so only a change is reported
  // 15 failed two-second polls trigger recovery.
  let pollFailureLimit = 15

  // MARK: lifecycle

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSWindow.allowsAutomaticWindowTabbing = false
    setupMenu()
    setupStatusItem()
    startHelper()
    ensureWindow()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
      self?.pollStatus()
    }
    watchAccessibility()
    NSApp.activate(ignoringOtherApps: true)
  }

  // MARK: accessibility, watched

  // Recheck Accessibility after a system notification or app activation.
  private func watchAccessibility() {
    accessibilityTrusted = AXIsProcessTrusted()
    DistributedNotificationCenter.default().addObserver(
      forName: NSNotification.Name("com.apple.accessibility.api"), object: nil, queue: .main
    ) { [weak self] _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self?.accessibilityMayHaveChanged() }
    }
    NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.accessibilityMayHaveChanged() }
  }

  private func accessibilityMayHaveChanged() {
    let now = AXIsProcessTrusted()
    guard now != accessibilityTrusted else { return }
    accessibilityTrusted = now
    shellLog("accessibility \(now ? "granted" : "revoked")")
    tellHelperAccessibility(now)
    guard let view = webView else { return }
    view.evaluateJavaScript("window.__awAccessibility && window.__awAccessibility(\(now));", completionHandler: nil)
  }

  // Only the shell can read macOS Accessibility trust; relay it to Core.
  func tellHelperAccessibility(_ granted: Bool) {
    helperRequest("POST", "/api/accessibility", body: ["granted": granted]) { _ in }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    quitting = true
    pollTimer?.invalidate()
    helper?.stop()
    return .terminateNow
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showWindow()
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let item = statusItem { NSStatusBar.system.removeStatusItem(item) }
    statusItem = nil
  }

  func windowWillClose(_ notification: Notification) {
    DispatchQueue.main.async { NSApp.setActivationPolicy(.accessory) }
  }

  // MARK: menus and status item

  private func setupMenu() {
    let menubar = NSMenu()
    let appItem = NSMenuItem()
    menubar.addItem(appItem)
    let appMenu = NSMenu()
    let open = NSMenuItem(title: "Open \(appDisplayName)", action: #selector(showWindowAction(_:)), keyEquivalent: "o")
    open.target = self
    appMenu.addItem(open)
    appMenu.addItem(NSMenuItem.separator())
    let quit = NSMenuItem(title: "Quit \(appDisplayName)", action: #selector(quitAction(_:)), keyEquivalent: "q")
    quit.target = self
    appMenu.addItem(quit)
    appItem.submenu = appMenu
    let editItem = NSMenuItem()
    menubar.addItem(editItem)
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    NSApp.mainMenu = menubar
  }

  private func setupStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.autosaveName = "AgentWheelStatusItem"
    item.isVisible = true
    if let button = item.button {
      button.image = statusImage()
      button.imagePosition = .imageOnly
      button.toolTip = appDisplayName
      button.setAccessibilityLabel("\(appDisplayName) menu")
    }
    let menu = NSMenu()
    let header = NSMenuItem(title: "\(appDisplayName) · starting", action: nil, keyEquivalent: "")
    header.isEnabled = false
    menu.addItem(header)
    menu.addItem(NSMenuItem.separator())
    let open = NSMenuItem(title: "Open window", action: #selector(showWindowAction(_:)), keyEquivalent: "")
    open.target = self
    menu.addItem(open)
    menu.addItem(NSMenuItem.separator())
    let quit = NSMenuItem(title: "Quit \(appDisplayName)", action: #selector(quitAction(_:)), keyEquivalent: "")
    quit.target = self
    menu.addItem(quit)
    item.menu = menu
    statusItem = item
    applyStatus("starting", project: nil)
  }

  private func statusImage() -> NSImage {
    if let symbol = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: appDisplayName) {
      symbol.isTemplate = true
      return symbol
    }
    let size = NSSize(width: 12, height: 12)
    let image = NSImage(size: size, flipped: false) { rect in
      NSColor.black.setFill()
      NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).fill()
      return true
    }
    image.isTemplate = true
    return image
  }

  private func statusColor(_ status: String) -> NSColor {
    switch status {
    case "green": return .systemGreen
    case "yellow": return .systemYellow
    case "red": return .systemRed
    case "purple": return .systemPurple
    default: return .secondaryLabelColor
    }
  }

  func applyStatus(_ status: String, project: String?) {
    if status != lastStatus { shellLog("status \(lastStatus) -> \(status)") }
    lastStatus = status
    guard let item = statusItem, let button = item.button else { return }
    button.contentTintColor = statusColor(status)
    let label = project.map { "\($0) · \(status)" } ?? "\(appDisplayName) · \(status)"
    button.toolTip = label
    item.menu?.items.first?.title = label
  }

  @objc func showWindowAction(_ sender: Any?) {
    showWindow()
  }

  @objc func quitAction(_ sender: Any?) {
    NSApp.terminate(nil)
  }

  func showWindow() {
    NSApp.setActivationPolicy(.regular)
    ensureWindow()
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  // MARK: the helper

  func startHelper() {
    guard let node = findNode() else {
      fatal("The bundled Node.js runtime is missing. Re-download the Agent Wheel disk image.")
      return
    }
    guard let payload = findPayload() else {
      fatal("The Agent Wheel helper payload is missing from the app bundle.")
      return
    }
    let child = HelperProcess(token: newLaunchToken())
    child.onReady = { [weak self] port in
      guard let self else { return }
      self.helperPort = port
      shellLog("helper ready on 127.0.0.1:\(port) (pid \(child.pid))")
      self.pushKeychainSecrets()
      self.tellHelperAccessibility(AXIsProcessTrusted())
      self.loadPage()
      if self.recoveryPending {
        self.recoveryPending = false
        self.showRecoveryRequired()
      }
    }
    child.onExit = { [weak self] status in
      guard let self else { return }
      shellLog("helper exited with status \(status)")
      self.helperPort = 0
      if self.quitting { return }
      self.applyStatus("red", project: nil)
      self.restarts += 1
      if self.restarts > 25 {
        self.fatal("The Agent Wheel helper stopped repeatedly. Quit and relaunch \(appDisplayName).")
        return
      }
      self.recoveryPending = true
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
        guard let self, !self.quitting else { return }
        self.startHelper()
      }
    }
    do {
      try child.launch(node: node, payload: payload)
      helper = child
      shellLog("helper launched (pid \(child.pid)) from \(payload)")
    } catch {
      fatal("The Agent Wheel helper could not start: \(error)")
    }
  }

  private func fatal(_ message: String) {
    shellLog("fatal: \(message)")
    applyStatus("red", project: nil)
    let alert = NSAlert()
    alert.messageText = "\(appDisplayName) could not start"
    alert.informativeText = message
    alert.alertStyle = .critical
    alert.addButton(withTitle: "Quit")
    alert.runModal()
    NSApp.terminate(nil)
  }

  private func helperRequest(_ method: String, _ path: String, body: [String: Any]?,
                             completion: @escaping ([String: Any]?) -> Void)
  {
    guard let helper, helperPort > 0, let url = URL(string: "http://127.0.0.1:\(helperPort)\(path)") else {
      completion(nil)
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 5
    request.setValue("Bearer \(helper.token)", forHTTPHeaderField: "Authorization")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    URLSession.shared.dataTask(with: request) { data, _, _ in
      let parsed = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      DispatchQueue.main.async { completion(parsed) }
    }.resume()
  }

  func pollStatus() {
    if helperPort == 0 {
      if lastStatus != "red" { applyStatus(quitting ? lastStatus : "starting", project: nil) }
      return
    }
    helperRequest("GET", "/api/status", body: nil) { [weak self] reply in
      guard let self else { return }
      guard let reply else {
        self.pollFailures += 1
        self.applyStatus("red", project: nil)
        if self.pollFailures >= self.pollFailureLimit, let helper = self.helper, helper.process.isRunning {
          shellLog("helper unresponsive for \(self.pollFailures) polls; terminating it for recovery")
          self.pollFailures = 0
          kill(helper.pid, SIGKILL)
        }
        return
      }
      self.pollFailures = 0
      let status = (reply["status"] as? String) ?? "unspooled"
      let project = reply["project"] as? String
      self.applyStatus(status, project: project)
    }
  }

  // Read Keychain off the main thread; send keys to the helper in memory only.
  func pushKeychainSecrets() {
    keychainQueue.async {
      let found = providerAccounts.compactMap { account -> (String, String)? in
        guard let key = keychainRead(account) else { return nil }
        return (account, key)
      }
      DispatchQueue.main.async {
        for (account, key) in found {
          self.helperRequest("POST", "/api/secrets", body: ["provider": account, "key": key]) { _ in }
        }
      }
    }
  }

  // MARK: the window and its single WKWebView

  func ensureWindow() {
    if let win = window {
      if let screen = win.screen ?? NSScreen.main { win.setFrame(screen.visibleFrame, display: true) }
      if win.isMiniaturized { win.deminiaturize(nil) }
      win.makeKeyAndOrderFront(nil)
      return
    }
    let screen = NSScreen.main
    let frame = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
    let win = NSWindow(
      contentRect: NSRect(origin: .zero, size: frame.size),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    win.title = appDisplayName
    win.appearance = NSAppearance(named: .darkAqua)
    win.backgroundColor = NSColor(srgbRed: 23 / 255, green: 23 / 255, blue: 26 / 255, alpha: 1)
    win.isReleasedWhenClosed = false
    win.isRestorable = false
    win.minSize = NSSize(width: 720, height: 480)
    win.delegate = self
    win.setFrame(frame, display: false)

    let config = WKWebViewConfiguration()
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    config.userContentController.add(self, name: "aw")
    let view = WKWebView(frame: win.contentView?.bounds ?? .zero, configuration: config)
    view.navigationDelegate = self
    view.uiDelegate = self
    view.autoresizingMask = [.width, .height]
    view.setValue(false, forKey: "drawsBackground")
    win.contentView = view
    webView = view
    window = win
    win.makeKeyAndOrderFront(nil)
    if helperPort > 0 { loadPage() }
  }

  private func bundledPage() -> String? {
    guard let payload = findPayload() else { return nil }
    return try? String(contentsOfFile: payload + "/surfaces/ui/main.html", encoding: .utf8)
  }

  // Use the tokened loopback origin for the bundled page’s API requests.
  func loadPage() {
    guard let view = webView, let helper, helperPort > 0 else { return }
    guard let html = bundledPage() else {
      fatal("The Agent Wheel window page is missing from the app bundle.")
      return
    }
    let controller = view.configuration.userContentController
    controller.removeAllUserScripts()
    let bootstrap = "window.__AW = { port: \(helperPort), token: \"\(helper.token)\", shell: true };"
    controller.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    guard let base = URL(string: "http://127.0.0.1:\(helperPort)/") else { return }
    view.loadHTMLString(html, baseURL: base)
  }

  private func isTokenedLoopbackBase(_ url: URL) -> Bool {
    guard helperPort > 0, url.scheme == "http", url.host == "127.0.0.1", url.port == helperPort else { return false }
    return url.path == "/" || url.path.isEmpty
  }

  private func isBundleFile(_ url: URL) -> Bool {
    guard url.isFileURL else { return false }
    let bundle = URL(fileURLWithPath: Bundle.main.bundlePath).standardizedFileURL.path
    let target = url.standardizedFileURL.path
    return target == bundle || target.hasPrefix(bundle + "/")
  }

  // Allow only bundled files and the tokened loopback API.
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void)
  {
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    if url.absoluteString == "about:blank" || isTokenedLoopbackBase(url) || isBundleFile(url) {
      decisionHandler(.allow)
      return
    }
    shellLog("navigation refused: \(url.absoluteString)")
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView?
  {
    shellLog("new window refused: \(navigationAction.request.url?.absoluteString ?? "-")")
    return nil
  }

  // MARK: the page bridge (Keychain, reveal, quit)

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "aw", let body = message.body as? [String: Any] else { return }
    let op = (body["op"] as? String) ?? ""
    let requestId = (body["id"] as? String) ?? ""
    switch op {
    case "keychain.list":
      keychainQueue.async {
        let present = providerAccounts.filter { keychainPresent($0) }
        DispatchQueue.main.async { self.replyToPage(requestId, ["providers": present]) }
      }
    case "keychain.set":
      guard let provider = body["provider"] as? String, providerAccounts.contains(provider),
            let key = body["key"] as? String, !key.isEmpty
      else {
        replyToPage(requestId, ["ok": false, "error": "unknown provider or empty key"])
        return
      }
      keychainQueue.async {
        let ok = keychainWrite(provider, key)
        DispatchQueue.main.async {
          if ok {
            self.helperRequest("POST", "/api/secrets", body: ["provider": provider, "key": key]) { _ in }
          }
          self.replyToPage(requestId, ["ok": ok])
        }
      }
    case "keychain.delete":
      guard let provider = body["provider"] as? String, providerAccounts.contains(provider) else {
        replyToPage(requestId, ["ok": false])
        return
      }
      keychainQueue.async {
        let ok = keychainDelete(provider)
        DispatchQueue.main.async {
          self.helperRequest("POST", "/api/secrets", body: ["provider": provider, "key": ""]) { _ in }
          self.replyToPage(requestId, ["ok": ok])
        }
      }
    case "accessibility.status":
      replyToPage(requestId, ["ok": true, "trusted": AXIsProcessTrusted()])
    case "accessibility.open":
      let already = requestAccessibility()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { openAccessibilityPane() }
      replyToPage(requestId, ["ok": true, "trusted": already])
    case "app.open":
      replyToPage(requestId, ["ok": openInstalledApp((body["path"] as? String) ?? "",
                                                     at: body["project"] as? String)])
    case "reveal":
      if let path = body["path"] as? String, FileManager.default.fileExists(atPath: path) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        replyToPage(requestId, ["ok": true])
      } else {
        replyToPage(requestId, ["ok": false])
      }
    case "quit":
      NSApp.terminate(nil)
    default:
      replyToPage(requestId, ["ok": false, "error": "unknown op"])
    }
  }

  private func replyToPage(_ requestId: String, _ payload: [String: Any]) {
    guard !requestId.isEmpty, let view = webView,
          let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8)
    else { return }
    let idData = try? JSONSerialization.data(withJSONObject: [requestId])
    let idJson = idData.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    view.evaluateJavaScript("window.__awReply && window.__awReply(\(idJson)[0], \(json));", completionHandler: nil)
  }

  func showRecoveryRequired() {
    showWindow()
    guard let view = webView,
          let data = try? JSONSerialization.data(withJSONObject: [recoveryRequiredText]),
          let json = String(data: data, encoding: .utf8)
    else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      view.evaluateJavaScript("window.__awRecovery && window.__awRecovery(\(json)[0]);", completionHandler: nil)
    }
  }
}

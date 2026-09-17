import AppKit

@main
enum ConvobusAccessibilityHelper {
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    axHelperMain()
  }
}

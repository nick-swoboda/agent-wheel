import AppKit

@main
enum ConvobusMain {
  static func main() {
    let cliArgs = Array(CommandLine.arguments.dropFirst())
    if cliArgs.first == "--ax-send" || cliArgs.first == "--ax-dump" || cliArgs.first == "--ax-feed"
      || cliArgs.first == "--ax-probe"
      || cliArgs.first == "send" || cliArgs.first == "dump" {
      let app = NSApplication.shared
      app.setActivationPolicy(.prohibited)
      axHelperMain()
      exit(0)
    }
    if isCli(cliArgs) {
      runCli(cliArgs)
    }
    if Thread.isMainThread {
      bootGui()
    } else {
      DispatchQueue.main.sync { bootGui() }
    }
  }
}

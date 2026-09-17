import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    FileHandle.standardError.write(Data("native model failure: \(message)\n".utf8))
    exit(1)
  }
}

@main
enum NativeModelsContract {
  static func main() {
    let claude = ContextSelection(provider: "claude", project: "/one", surface: "app", type: "chat")
    let cursor = ContextSelection(provider: "cursor", project: "/two", surface: "cli", type: "cursor-cli")
    let coordinator = ContextSelectionCoordinator()
    let firstEpoch = coordinator.registerIntent(claude)
    require(firstEpoch == 1, "first intent epoch")
    require(coordinator.beginWrite() == claude, "first write target")
    let secondEpoch = coordinator.registerIntent(cursor)
    require(secondEpoch == 2, "second intent epoch")
    require(!coordinator.acceptsResponse(epoch: firstEpoch), "stale poll rejected")
    require(coordinator.finishWrite(target: claude, confirmed: claude), "stale write can persist")
    require(coordinator.confirmed == claude, "confirmed server state retained")
    require(coordinator.desired == cursor, "newest user intent remains authoritative")
    require(coordinator.beginWrite() == cursor, "newest target follows stale success")
    require(!coordinator.finishWrite(target: cursor, confirmed: nil), "current failure reported")
    require(coordinator.desired == nil, "failed current intent clears")
    require(coordinator.confirmed == claude, "failure preserves last confirmed context")

    let app = ContextSelection(provider: "chatgpt", project: "/app", surface: "app", type: "chat")
    let cli = ContextSelection(provider: "chatgpt", project: "/cli", surface: "cli", type: "codex")
    let returnCoordinator = ContextSelectionCoordinator()
    returnCoordinator.confirmed = app
    _ = returnCoordinator.registerIntent(cli)
    require(returnCoordinator.beginWrite() == cli, "different project write begins")
    _ = returnCoordinator.registerIntent(app)
    require(returnCoordinator.finishWrite(target: cli, confirmed: cli), "intermediate project persists")
    require(returnCoordinator.desired == app, "return to prior project remains newest intent")
    require(returnCoordinator.beginWrite() == app, "return intent follows intermediate success")

    let snapshot: [String: Any] = [
      "revision": "one",
      "providers": [
        "providers": [[
          "id": "claude",
          "name": "Claude",
          "routes": [[
            "provider": "claude",
            "surface": "app",
            "type": "chat",
            "label": "Chat",
            "seat": "claude-app",
          ]],
        ]],
        "projects": [["path": "/one", "futureProjectField": true]],
        "selection": claude.json,
        "status": ["status": "attached", "futureStatusField": "keep"],
        "futureProviderField": 7,
      ],
      "menu": [
        "icon": "attached",
        "board": ["lastCard": "card_1", "lastToken": "convobus ready"],
        "context": claude.json,
        "routeStatus": ["status": "attached"],
        "futureMenuField": ["ignored": true],
      ],
      "cards": ["futureCardsField": true],
      "loops": [
        "loops": [[
          "id": "loop_1",
          "name": "Release review",
          "project": "/one",
          "leader": ["kind": "human"],
          "builder": [
            "kind": "route",
            "route": [
              "provider": "claude",
              "providerName": "Claude",
              "project": "/one",
              "surface": "app",
              "type": "claude-code",
              "label": "Claude Code",
            ],
          ],
          "defaultCycles": 10,
          "revision": 1,
          "state": "waiting",
          "progress": ["segment": 1, "cycle": 4, "cycles": 10, "step": 10, "steps": 20],
          "active": true,
          "runId": "run_1",
        ]],
        "workspaces": [[
          "id": "loop_1",
          "project": "/one",
          "leader": ["kind": "human"],
          "builder": [
            "kind": "route",
            "route": [
              "provider": "claude",
              "providerName": "Claude",
              "project": "/one",
              "surface": "app",
              "type": "claude-code",
              "label": "Claude Code",
            ],
          ],
          "defaultCycles": 10,
          "revision": 2,
          "active": true,
          "state": "waiting",
        ]],
        "workspace": [
          "id": "loop_1",
          "project": "/one",
          "leader": ["kind": "human"],
          "builder": [
            "kind": "route",
            "route": [
              "provider": "claude",
              "project": "/one",
              "surface": "app",
              "type": "claude-code",
            ],
          ],
          "defaultCycles": 10,
          "revision": 2,
          "active": true,
          "state": "waiting",
        ],
        "activeRun": [
          "id": "run_1",
          "loopId": "loop_1",
          "name": "Release review",
          "runName": "Release review",
          "project": "/one",
          "state": "waiting",
          "internalState": "running",
          "progress": ["segment": 1, "cycle": 4, "cycles": 10, "step": 10, "steps": 20],
          "nextRole": "builder",
          "pauseRequested": false,
          "stopRequested": false,
          "active": true,
          "revision": 7,
          "startedAt": "2026-08-31T12:00:00.000Z",
        ],
      ],
      "futureSnapshotField": true,
    ]
    guard let decoded = NativeSnapshotDTO.decode(snapshot) else {
      require(false, "tolerant snapshot decoding")
      return
    }
    require(decoded.providers.projects.first?.exists == true, "historical project defaults to existing")
    require(decoded.providers.lastProjectByProvider.isEmpty, "missing additive map defaults empty")
    require(decoded.providers.status.status == .attached, "typed route status")
    require(decoded.cards.records.isEmpty, "historical cards fields default empty")
    require(decoded.menu.icon == "attached", "menu model decoded")
    require(decoded.loops.loops.count == 1, "saved Loop decoded")
    require(decoded.loops.activeRun?.progress?.cycle == 4, "active Loop progress decoded")
    require(decoded.loops.workspace?.defaultCycles == 10, "project Loop workspace decoded")
    require(decoded.loops.workspaces.count == 1, "project Loop workspace list decoded")
    require(decoded.loops.activeRun?.runName == "Release review", "optional run name decoded")
    require(decoded.loops.loops[0].builder?.route?.type == "claude-code", "exact Loop route decoded")

    let historyData = try! JSONSerialization.data(withJSONObject: [
      "project": "/one",
      "items": [[
        "id": "run:run_1",
        "kind": "run",
        "runId": "run_1",
        "runName": NSNull(),
        "startedAt": "2026-08-31T12:00:00.000Z",
        "state": "complete",
      ]],
      "nextCursor": NSNull(),
    ])
    let history = try! JSONDecoder().decode(LoopProjectHistoryPageDTO.self, from: historyData)
    require(history.items.first?.kind == "run", "project history run boundary decoded")
    require(history.items.first?.role == "", "additive run boundary defaults message fields")

    var additiveHistoricalSnapshot = snapshot
    additiveHistoricalSnapshot["cards"] = [
      "records": [["futureMalformedRecord": ["unexpected": true]]],
      "futureCardsField": true,
    ]
    guard let envelope = NativeSnapshotEnvelope(additiveHistoricalSnapshot) else {
      require(false, "atomic snapshot envelope tolerates historical subrecords")
      return
    }
    require(envelope.selection == claude, "raw revision preserves typed selection fallback")
    require(envelope.providers["futureProviderField"] as? Int == 7, "provider revision stays available")
    require(envelope.menu["icon"] as? String == "attached", "menu revision stays available")

    var capturedRequest: URLRequest?
    let client = NativeAPIClient(baseURL: "http://127.0.0.1:7421", token: "private-token") { request in
      capturedRequest = request
      let response = try! JSONSerialization.data(withJSONObject: ["ok": true])
      return (response, nil, nil)
    }
    let response = client.requestJSON(method: "POST", path: "/api/context", body: claude.json)
    require(response?["ok"] as? Bool == true, "API JSON response")
    require(capturedRequest?.value(forHTTPHeaderField: "X-Convobus-Token") == "private-token", "native token header")
    require(capturedRequest?.value(forHTTPHeaderField: "Content-Type") == "application/json", "native JSON content type")
    require(capturedRequest?.url?.path == "/api/context", "API path preserved")

    let identity = NativeServerIdentity()
    let identityQueue = DispatchQueue(label: "identity-test", attributes: .concurrent)
    let identityGroup = DispatchGroup()
    for index in 0..<32 {
      identityGroup.enter()
      identityQueue.async {
        identity.replace(
          baseURL: "http://127.0.0.1:\(7400 + index)",
          token: "token-\(index)",
          instanceID: "instance-\(index)"
        )
        identityGroup.leave()
      }
    }
    identityGroup.wait()
    let identityValue = identity.snapshot()
    let suffix = identityValue.token.replacingOccurrences(of: "token-", with: "")
    require(identityValue.instanceID == "instance-\(suffix)", "server identity is never torn")
    require(identityValue.baseURL.hasSuffix(":\(7400 + (Int(suffix) ?? -7400))"), "server URL matches identity")
    print("native models ok")
  }
}

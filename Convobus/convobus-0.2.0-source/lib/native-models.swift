import Foundation

final class NativeAPIClient {
  typealias Transport = (URLRequest) -> (Data?, URLResponse?, Error?)

  let baseURL: String
  let token: String
  let requestTimeout: TimeInterval
  private let transport: Transport?

  init(
    baseURL: String,
    token: String,
    requestTimeout: TimeInterval = 120,
    transport: Transport? = nil
  ) {
    self.baseURL = baseURL
    self.token = token
    self.requestTimeout = requestTimeout
    self.transport = transport
  }

  func requestJSON(method: String, path: String, body: [String: Any]? = nil) -> [String: Any]? {
    guard let url = URL(string: baseURL + path) else { return nil }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = requestTimeout
    if !token.isEmpty { request.setValue(token, forHTTPHeaderField: "X-Convobus-Token") }
    if let body {
      guard JSONSerialization.isValidJSONObject(body) else { return nil }
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }

    let result: (Data?, URLResponse?, Error?)
    if let transport {
      result = transport(request)
    } else {
      let semaphore = DispatchSemaphore(value: 0)
      var received: (Data?, URLResponse?, Error?) = (nil, nil, nil)
      let task = URLSession.shared.dataTask(with: request) { data, response, error in
        received = (data, response, error)
        semaphore.signal()
      }
      task.resume()
      if semaphore.wait(timeout: .now() + requestTimeout) == .timedOut {
        task.cancel()
        received = (nil, nil, URLError(.timedOut))
      }
      result = received
    }
    guard result.2 == nil,
          let data = result.0,
          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return value
  }

  func request<T: Decodable>(
    _ type: T.Type,
    method: String,
    path: String,
    body: [String: Any]? = nil
  ) -> T? {
    guard let value = requestJSON(method: method, path: path, body: body),
          JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value)
    else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }
}

struct NativeServerIdentityValue: Equatable {
  let baseURL: String
  let token: String
  let instanceID: String
}

final class NativeServerIdentity {
  private let lock = NSLock()
  private var value = NativeServerIdentityValue(
    baseURL: "http://127.0.0.1:7421",
    token: "",
    instanceID: ""
  )

  func replace(baseURL: String, token: String, instanceID: String) {
    lock.lock()
    value = NativeServerIdentityValue(baseURL: baseURL, token: token, instanceID: instanceID)
    lock.unlock()
  }

  func clear() {
    replace(baseURL: "http://127.0.0.1:7421", token: "", instanceID: "")
  }

  func snapshot() -> NativeServerIdentityValue {
    lock.lock()
    let result = value
    lock.unlock()
    return result
  }
}

struct ContextSelection: Codable, Equatable {
  let provider: String
  let project: String
  let surface: String
  let type: String

  init(provider: String, project: String, surface: String, type: String) {
    self.provider = provider
    self.project = project
    self.surface = surface
    self.type = type
  }

  init?(_ value: [String: Any]?) {
    guard let value,
          let provider = value["provider"] as? String,
          let project = value["project"] as? String,
          let surface = value["surface"] as? String,
          let type = value["type"] as? String,
          !provider.isEmpty,
          !project.isEmpty,
          !surface.isEmpty,
          !type.isEmpty
    else { return nil }
    self.init(provider: provider, project: project, surface: surface, type: type)
  }

  var json: [String: Any] {
    ["provider": provider, "project": project, "surface": surface, "type": type]
  }
}

final class ContextSelectionCoordinator {
  // desired is the newest UI intent; confirmed is persisted; only the current epoch may repaint.
  var desired: ContextSelection?
  var confirmed: ContextSelection?
  var writeInFlight: ContextSelection?
  var writeIsActive = false
  var epoch = 0

  @discardableResult
  func registerIntent(_ context: ContextSelection) -> Int {
    epoch += 1
    desired = context
    return epoch
  }

  func acceptsResponse(epoch responseEpoch: Int) -> Bool {
    responseEpoch == epoch
  }

  func beginWrite() -> ContextSelection? {
    guard !writeIsActive, let target = desired, target != confirmed else { return nil }
    writeIsActive = true
    writeInFlight = target
    return target
  }

  func finishWrite(target: ContextSelection, confirmed result: ContextSelection?) -> Bool {
    writeIsActive = false
    writeInFlight = nil
    guard let result else {
      if desired == target { desired = nil }
      return false
    }
    confirmed = result
    if desired == target { desired = nil }
    return true
  }
}

struct ProviderRouteDTO: Codable {
  let provider: String
  let providerName: String?
  let surface: String
  let type: String
  let label: String
  let seat: String
  let variant: String?
  let appPath: String?
  let command: String?
  let bundleIdentifier: String?
  let projectBound: Bool?
  let installed: Bool?
}

struct ProviderDTO: Codable {
  let id: String
  let name: String
  let routes: [ProviderRouteDTO]
}

struct SavedRouteDTO: Codable {
  let surface: String
  let type: String
}

struct ProjectDTO: Codable {
  let path: String
  let name: String
  let lastUsedAt: String?
  let providers: [String]
  let routes: [String: SavedRouteDTO]
  let exists: Bool

  enum CodingKeys: String, CodingKey {
    case path, name, lastUsedAt, providers, routes, exists
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    path = try values.decode(String.self, forKey: .path)
    name = try values.decodeIfPresent(String.self, forKey: .name) ?? URL(fileURLWithPath: path).lastPathComponent
    lastUsedAt = try values.decodeIfPresent(String.self, forKey: .lastUsedAt)
    providers = try values.decodeIfPresent([String].self, forKey: .providers) ?? []
    routes = try values.decodeIfPresent([String: SavedRouteDTO].self, forKey: .routes) ?? [:]
    exists = try values.decodeIfPresent(Bool.self, forKey: .exists) ?? true
  }
}

struct AttachDTO: Codable {
  let mode: String?
  let appPath: String?
  let title: String?
  let command: String?
  let instruction: String?
}

struct RouteStatusKind: Codable, Equatable {
  let rawValue: String

  init(_ rawValue: String) { self.rawValue = rawValue }

  init(from decoder: Decoder) throws {
    rawValue = try decoder.singleValueContainer().decode(String.self)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  static let attached = RouteStatusKind("attached")
  static let waiting = RouteStatusKind("waiting")
  static let needsSession = RouteStatusKind("needs-session")
  static let blocked = RouteStatusKind("blocked")
}

struct RouteStatusDTO: Codable {
  let status: RouteStatusKind
  let reason: String?
  let action: String?
  let route: ProviderRouteDTO?
  let sessionId: String?
  let sessionFile: String?
  let kind: String?
  let method: String?
  let attach: AttachDTO?
}

struct ProviderModelDTO: Codable {
  let providers: [ProviderDTO]
  let projects: [ProjectDTO]
  let selection: ContextSelection?
  let lastProjectByProvider: [String: String]
  let unassigned: Bool
  let status: RouteStatusDTO

  enum CodingKeys: String, CodingKey {
    case providers, projects, selection, lastProjectByProvider, unassigned, status
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    providers = try values.decode([ProviderDTO].self, forKey: .providers)
    projects = try values.decodeIfPresent([ProjectDTO].self, forKey: .projects) ?? []
    selection = try values.decodeIfPresent(ContextSelection.self, forKey: .selection)
    lastProjectByProvider = try values.decodeIfPresent([String: String].self, forKey: .lastProjectByProvider) ?? [:]
    unassigned = try values.decodeIfPresent(Bool.self, forKey: .unassigned) ?? false
    status = try values.decode(RouteStatusDTO.self, forKey: .status)
  }
}

struct CardDTO: Codable {
  let id: String
  let seat: String
  let method: String
  let from: String
  let body: String
  let state: String
  let reply: String?
  let cwd: String?
}

struct ConversationRouteDTO: Codable {
  let provider: String
  let providerName: String?
  let project: String?
  let surface: String
  let type: String
  let label: String?
  let seat: String?
  let variant: String?
  let inferred: Bool?
}

struct CardRecordDTO: Codable {
  let id: String
  let card: CardDTO
  let t: String?
  let route: ConversationRouteDTO
  let sessionId: String?
  let sessionFile: String?
  let kind: String?
  let inferred: Bool?
}

struct CardsDTO: Codable {
  let cards: [CardDTO]
  let records: [CardRecordDTO]
  let inflight: [CardDTO]

  enum CodingKeys: String, CodingKey { case cards, records, inflight }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    cards = try values.decodeIfPresent([CardDTO].self, forKey: .cards) ?? []
    records = try values.decodeIfPresent([CardRecordDTO].self, forKey: .records) ?? []
    inflight = try values.decodeIfPresent([CardDTO].self, forKey: .inflight) ?? []
  }
}

struct LoopRouteDTO: Codable, Equatable {
  let provider: String
  let providerName: String?
  let project: String
  let surface: String
  let type: String
  let label: String?
  let seat: String?
  let variant: String?
  let appPath: String?
  let command: String?
  let bundleIdentifier: String?
  let projectBound: Bool?
}

struct LoopParticipantDTO: Codable, Equatable {
  let kind: String
  let route: LoopRouteDTO?
}

struct LoopProgressDTO: Codable, Equatable {
  let segment: Int
  let cycle: Int
  let cycles: Int
  let step: Int
  let steps: Int
}

struct LoopRunSummaryDTO: Codable, Equatable {
  let id: String
  let loopId: String
  let name: String
  let runName: String?
  let project: String
  let state: String
  let internalState: String?
  let reason: String?
  let action: String?
  let progress: LoopProgressDTO?
  let nextRole: String?
  let nextRoute: LoopRouteDTO?
  let pauseRequested: Bool
  let stopRequested: Bool
  let active: Bool
  let revision: Int
  let startedAt: String?
  let updatedAt: String?
  let completedAt: String?

  enum CodingKeys: String, CodingKey {
    case id, loopId, name, runName, project, state, internalState, reason, action, progress
    case nextRole, nextRoute, pauseRequested, stopRequested, active, revision, startedAt, updatedAt, completedAt
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    loopId = try values.decode(String.self, forKey: .loopId)
    name = try values.decode(String.self, forKey: .name)
    runName = try values.decodeIfPresent(String.self, forKey: .runName)
    project = try values.decode(String.self, forKey: .project)
    state = try values.decode(String.self, forKey: .state)
    internalState = try values.decodeIfPresent(String.self, forKey: .internalState)
    reason = try values.decodeIfPresent(String.self, forKey: .reason)
    action = try values.decodeIfPresent(String.self, forKey: .action)
    progress = try values.decodeIfPresent(LoopProgressDTO.self, forKey: .progress)
    nextRole = try values.decodeIfPresent(String.self, forKey: .nextRole)
    nextRoute = try values.decodeIfPresent(LoopRouteDTO.self, forKey: .nextRoute)
    pauseRequested = try values.decodeIfPresent(Bool.self, forKey: .pauseRequested) ?? false
    stopRequested = try values.decodeIfPresent(Bool.self, forKey: .stopRequested) ?? false
    active = try values.decodeIfPresent(Bool.self, forKey: .active) ?? false
    revision = try values.decodeIfPresent(Int.self, forKey: .revision) ?? 0
    startedAt = try values.decodeIfPresent(String.self, forKey: .startedAt)
    updatedAt = try values.decodeIfPresent(String.self, forKey: .updatedAt)
    completedAt = try values.decodeIfPresent(String.self, forKey: .completedAt)
  }
}

struct SavedLoopDTO: Codable, Equatable {
  let id: String
  let name: String
  let project: String
  let leader: LoopParticipantDTO
  let builder: LoopParticipantDTO?
  let reviewer: LoopParticipantDTO?
  let defaultCycles: Int
  let revision: Int
  let state: String?
  let progress: LoopProgressDTO?
  let active: Bool
  let runId: String?

  enum CodingKeys: String, CodingKey {
    case id, name, project, leader, builder, reviewer, defaultCycles, revision
    case state, progress, active, runId
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    name = try values.decode(String.self, forKey: .name)
    project = try values.decode(String.self, forKey: .project)
    leader = try values.decode(LoopParticipantDTO.self, forKey: .leader)
    builder = try values.decodeIfPresent(LoopParticipantDTO.self, forKey: .builder)
    reviewer = try values.decodeIfPresent(LoopParticipantDTO.self, forKey: .reviewer)
    defaultCycles = try values.decodeIfPresent(Int.self, forKey: .defaultCycles) ?? 1
    revision = try values.decodeIfPresent(Int.self, forKey: .revision) ?? 0
    state = try values.decodeIfPresent(String.self, forKey: .state)
    progress = try values.decodeIfPresent(LoopProgressDTO.self, forKey: .progress)
    active = try values.decodeIfPresent(Bool.self, forKey: .active) ?? false
    runId = try values.decodeIfPresent(String.self, forKey: .runId)
  }
}

struct LoopsSnapshotDTO: Codable {
  let loops: [SavedLoopDTO]
  let workspaces: [LoopWorkspaceDTO]
  let workspace: LoopWorkspaceDTO?
  let activeRun: LoopRunSummaryDTO?

  enum CodingKeys: String, CodingKey { case loops, workspaces, workspace, activeRun }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    loops = try values.decodeIfPresent([SavedLoopDTO].self, forKey: .loops) ?? []
    workspaces = try values.decodeIfPresent([LoopWorkspaceDTO].self, forKey: .workspaces) ?? []
    workspace = try values.decodeIfPresent(LoopWorkspaceDTO.self, forKey: .workspace)
    activeRun = try values.decodeIfPresent(LoopRunSummaryDTO.self, forKey: .activeRun)
  }

  static let empty = LoopsSnapshotDTO(loops: [], workspaces: [], workspace: nil, activeRun: nil)

  init(
    loops: [SavedLoopDTO],
    workspaces: [LoopWorkspaceDTO] = [],
    workspace: LoopWorkspaceDTO? = nil,
    activeRun: LoopRunSummaryDTO?
  ) {
    self.loops = loops
    self.workspaces = workspaces
    self.workspace = workspace
    self.activeRun = activeRun
  }
}

struct LoopWorkspaceDTO: Codable, Equatable {
  let id: String
  let project: String
  let leader: LoopParticipantDTO
  let builder: LoopParticipantDTO?
  let reviewer: LoopParticipantDTO?
  let defaultCycles: Int
  let revision: Int
  let active: Bool
  let state: String?
  let progress: LoopProgressDTO?
  let latestRun: LoopRunSummaryDTO?
}

struct LoopMessageDetailsDTO: Codable, Equatable {
  let method: String?
  let turn: Int?
  let sessionId: String?
  let sessionFile: String?
  let kind: String?
}

struct LoopMessageDTO: Codable, Equatable {
  let id: String
  let cardId: String?
  let kind: String
  let role: String
  let actor: String
  let replacedRole: String?
  let route: LoopRouteDTO?
  let content: String
  let sent: String?
  let t: String?
  let completedAt: String?
  let segment: Int?
  let cycle: Int?
  let state: String
  let details: LoopMessageDetailsDTO?
  let runId: String?
  let runName: String?
  let name: String?
  let startedAt: String?
  let progress: LoopProgressDTO?

  enum CodingKeys: String, CodingKey {
    case id, cardId, kind, role, actor, replacedRole, route, content, sent, t, completedAt
    case segment, cycle, state, details, runId, runName, name, startedAt, progress
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    cardId = try values.decodeIfPresent(String.self, forKey: .cardId)
    kind = try values.decode(String.self, forKey: .kind)
    role = try values.decodeIfPresent(String.self, forKey: .role) ?? ""
    actor = try values.decodeIfPresent(String.self, forKey: .actor) ?? ""
    replacedRole = try values.decodeIfPresent(String.self, forKey: .replacedRole)
    route = try values.decodeIfPresent(LoopRouteDTO.self, forKey: .route)
    content = try values.decodeIfPresent(String.self, forKey: .content) ?? ""
    sent = try values.decodeIfPresent(String.self, forKey: .sent)
    t = try values.decodeIfPresent(String.self, forKey: .t)
    completedAt = try values.decodeIfPresent(String.self, forKey: .completedAt)
    segment = try values.decodeIfPresent(Int.self, forKey: .segment)
    cycle = try values.decodeIfPresent(Int.self, forKey: .cycle)
    state = try values.decodeIfPresent(String.self, forKey: .state) ?? ""
    details = try values.decodeIfPresent(LoopMessageDetailsDTO.self, forKey: .details)
    runId = try values.decodeIfPresent(String.self, forKey: .runId)
    runName = try values.decodeIfPresent(String.self, forKey: .runName)
    name = try values.decodeIfPresent(String.self, forKey: .name)
    startedAt = try values.decodeIfPresent(String.self, forKey: .startedAt)
    progress = try values.decodeIfPresent(LoopProgressDTO.self, forKey: .progress)
  }
}

struct FrozenLoopDefinitionDTO: Codable, Equatable {
  let id: String
  let name: String
  let project: String
  let leader: LoopParticipantDTO
  let builder: LoopParticipantDTO?
  let reviewer: LoopParticipantDTO?
}

struct LoopRunDetailSummaryDTO: Codable {
  let id: String
  let loopId: String
  let name: String
  let runName: String?
  let project: String
  let state: String
  let internalState: String?
  let reason: String?
  let action: String?
  let progress: LoopProgressDTO?
  let nextRole: String?
  let nextRoute: LoopRouteDTO?
  let pauseRequested: Bool
  let stopRequested: Bool
  let active: Bool
  let revision: Int
  let startedAt: String?
  let updatedAt: String?
  let completedAt: String?
  let definition: FrozenLoopDefinitionDTO
  let goal: String?
}

struct LoopRunPageDTO: Codable {
  let run: LoopRunDetailSummaryDTO
  let messages: [LoopMessageDTO]
  let nextCursor: String?
}

struct LoopProjectHistoryPageDTO: Codable {
  let project: String
  let items: [LoopMessageDTO]
  let nextCursor: String?
}

struct MenuSeatDTO: Codable {
  let handle: String
  let name: String
  let attached: String
  let method: String
}

struct MenuBoardDTO: Codable {
  let lastCard: String?
  let lastToken: String?
  let method: String?
  let sessionId: String?
}

struct MenuProjectDTO: Codable {
  let path: String
  let name: String
  let selected: Bool
  let route: ConversationRouteDTO
  let status: String
  let reason: String?
}

struct MenuProviderProjectsDTO: Codable {
  let id: String
  let name: String
  let projects: [MenuProjectDTO]
}

struct MenuDTO: Codable {
  let icon: String
  let seats: [MenuSeatDTO]
  let currentSeat: String?
  let lastToken: String?
  let board: MenuBoardDTO
  let accessibility: Bool
  let context: ContextSelection?
  let routeStatus: RouteStatusDTO
  let projectsByProvider: [MenuProviderProjectsDTO]
  let open: [String]
  let items: [String]
  let loop: LoopRunSummaryDTO?
  let loops: [SavedLoopDTO]

  enum CodingKeys: String, CodingKey {
    case icon, seats, currentSeat, lastToken, board, accessibility, context, routeStatus
    case projectsByProvider, open, items, loop, loops
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    icon = try values.decode(String.self, forKey: .icon)
    seats = try values.decodeIfPresent([MenuSeatDTO].self, forKey: .seats) ?? []
    currentSeat = try values.decodeIfPresent(String.self, forKey: .currentSeat)
    lastToken = try values.decodeIfPresent(String.self, forKey: .lastToken)
    board = try values.decode(MenuBoardDTO.self, forKey: .board)
    accessibility = try values.decodeIfPresent(Bool.self, forKey: .accessibility) ?? false
    context = try values.decodeIfPresent(ContextSelection.self, forKey: .context)
    routeStatus = try values.decode(RouteStatusDTO.self, forKey: .routeStatus)
    projectsByProvider = try values.decodeIfPresent([MenuProviderProjectsDTO].self, forKey: .projectsByProvider) ?? []
    open = try values.decodeIfPresent([String].self, forKey: .open) ?? []
    items = try values.decodeIfPresent([String].self, forKey: .items) ?? []
    loop = try values.decodeIfPresent(LoopRunSummaryDTO.self, forKey: .loop)
    loops = try values.decodeIfPresent([SavedLoopDTO].self, forKey: .loops) ?? []
  }
}

struct NativeSnapshotDTO: Codable {
  let revision: String
  let providers: ProviderModelDTO
  let menu: MenuDTO
  let cards: CardsDTO
  let loops: LoopsSnapshotDTO

  enum CodingKeys: String, CodingKey { case revision, providers, menu, cards, loops }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    revision = try values.decode(String.self, forKey: .revision)
    providers = try values.decode(ProviderModelDTO.self, forKey: .providers)
    menu = try values.decode(MenuDTO.self, forKey: .menu)
    cards = try values.decode(CardsDTO.self, forKey: .cards)
    loops = try values.decodeIfPresent(LoopsSnapshotDTO.self, forKey: .loops) ?? .empty
  }

  static func decode(_ value: [String: Any]) -> NativeSnapshotDTO? {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value)
    else { return nil }
    return try? JSONDecoder().decode(NativeSnapshotDTO.self, from: data)
  }

  static func validates(_ value: [String: Any]) -> Bool {
    decode(value) != nil
  }
}

struct NativeSnapshotEnvelope {
  let providers: [String: Any]
  let menu: [String: Any]
  let cards: [String: Any]
  let loops: [String: Any]
  let typed: NativeSnapshotDTO?

  init?(_ value: [String: Any]?) {
    guard let value,
          let providers = value["providers"] as? [String: Any],
          let menu = value["menu"] as? [String: Any],
          let cards = value["cards"] as? [String: Any]
    else { return nil }
    self.providers = providers
    self.menu = menu
    self.cards = cards
    loops = value["loops"] as? [String: Any] ?? ["loops": [], "activeRun": NSNull()]
    typed = NativeSnapshotDTO.decode(value)
  }

  var selection: ContextSelection? {
    typed?.providers.selection ?? ContextSelection(providers["selection"] as? [String: Any])
  }
}

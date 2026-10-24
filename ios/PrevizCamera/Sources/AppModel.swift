// Join → Track → See. The native side is the room's phone: it alone talks to the relay (Hello,
// PhonePose at ≤ 30 Hz, commands) and feeds the web page poses and relay messages.
import Foundation
import Observation
import PrevizCore
import UIKit
import os

private let log = Logger(subsystem: "dev.previz.camera", category: "app")

@MainActor
@Observable
final class AppModel {
  enum Phase { case join, stage }

  struct PendingTrust: Identifiable {
    let id = UUID()
    let target: JoinTarget
    let sha256Hex: String
    let changed: Bool
    var fingerprint: String { CertPin.displayFingerprint(sha256Hex) }
  }

  // MARK: observed by the views (each changes only when its value does)

  var phase = Phase.join
  var hostInput: String
  var roomInput: String
  var joinError: String?
  var isJoining = false
  var pendingTrust: PendingTrust?

  private(set) var target: JoinTarget?
  private(set) var web: WebStage?
  private(set) var tracking = TrackingQuality.notAvailable
  private(set) var interrupted = false
  private(set) var conn = RelayConnection.State.idle
  private(set) var peers = Peers(laptop: false, phones: 0)
  private(set) var recording = false
  private(set) var scenePlaying = false
  private(set) var toast: String?
  private(set) var banner: String?
  private(set) var flashCount = 0
  /// "Scan room" is running: planes are being collected into the room footprint.
  private(set) var scanning = false
  /// Floor area of the scanned room so far (m²), nil before any.
  private(set) var roomArea: Double?
  var showDebug = false {
    didSet { if showDebug { publishDebug() } }
  }
  private(set) var debugText = ""

  // MARK: per-frame state (not observed)

  @ObservationIgnored private let trust = DevTrust()
  @ObservationIgnored private let defaults = UserDefaults.standard
  @ObservationIgnored private var relay: RelayConnection?
  @ObservationIgnored private var tracker: ARTracker?
  @ObservationIgnored private var poses = PoseTracker()
  @ObservationIgnored private var throttle = PoseThrottle()
  @ObservationIgnored private var scene: SceneState?
  @ObservationIgnored private var manifest: ManifestStart?
  @ObservationIgnored private var manifestURL: String?
  @ObservationIgnored private var anchor = Anchor.none
  @ObservationIgnored private var lastPeersText: String?
  @ObservationIgnored private var lastSceneText: String?
  @ObservationIgnored private var lastPose: PhonePose?
  @ObservationIgnored private var lastFrameAt = 0.0
  @ObservationIgnored private var debug = DebugSnapshot()
  @ObservationIgnored private var timers: [Timer] = []
  @ObservationIgnored private var toastTask: Task<Void, Never>?
  /// The scanned room (ARKit world); re-sent in the offset frame after every Recentre.
  @ObservationIgnored private var room: RoomFootprint?
  @ObservationIgnored private var roomSentForRecentre = -1
  @ObservationIgnored private var lastRoomText: String?
  @ObservationIgnored private var scanTimer: Timer?

  init() {
    hostInput = defaults.string(forKey: "previz.lastHost") ?? ""
    roomInput = defaults.string(forKey: "previz.lastRoom") ?? ""
  }

  // MARK: - Join

  /// Fill the fields from a scanned QR. False when it is not a phone link.
  func useScanned(_ text: String) -> Bool {
    guard let t = JoinLink.parse(text) else { return false }
    hostInput = t.hostPort
    roomInput = t.room
    return true
  }

  func join() async {
    joinError = nil
    guard let t = JoinLink.target(host: hostInput, room: roomInput) else {
      joinError = "Enter the laptop's address (e.g. 192.168.1.20:5173) and the 4-letter room code."
      return
    }
    guard ARTracker.isSupported else {
      joinError = "This device does not support ARKit world tracking."
      return
    }
    isJoining = true
    defer { isJoining = false }
    do {
      switch try await prepareRetrying(t) {
      case .ready(let how):
        debug.trust = how
        start(t)
      case .confirm(let hex, let changed):
        pendingTrust = PendingTrust(target: t, sha256Hex: hex, changed: changed)
      }
    } catch {
      joinError = "Can't reach https://\(t.hostPort): \(error.localizedDescription)"
    }
  }

  /// The probe is the app's first LAN connection, so it is what raises iOS's Local Network
  /// prompt, and it fails while the prompt is up. Retry network errors for about 10 s.
  private func prepareRetrying(_ t: JoinTarget) async throws -> DevTrust.Preparation {
    for attempt in 0..<5 {
      do {
        return try await trust.prepare(t)
      } catch let error as URLError where attempt < 4 && error.code != .cancelled {
        log.info("probe attempt \(attempt + 1) failed: \(error.localizedDescription, privacy: .public)")
        try await Task.sleep(for: .seconds(2))
      }
    }
    return try await trust.prepare(t)
  }

  func confirmTrust(_ pending: PendingTrust) {
    pendingTrust = nil
    trust.setPin(pending.sha256Hex, for: pending.target.hostPort)
    debug.trust = "pinned"
    start(pending.target)
  }

  private func start(_ t: JoinTarget) {
    target = t
    hostInput = t.hostPort
    roomInput = t.room
    defaults.set(t.hostPort, forKey: "previz.lastHost")
    defaults.set(t.room, forKey: "previz.lastRoom")

    let trustState = debug.trust
    debug = DebugSnapshot()
    debug.trust = trustState
    debug.room = t.room
    debug.host = t.hostPort
    poses = PoseTracker(anchorYaw: Anchor.none.yaw)
    throttle = PoseThrottle()
    scene = nil
    manifest = nil
    manifestURL = nil
    anchor = .none
    lastPeersText = nil
    lastSceneText = nil
    lastPose = nil
    banner = nil
    recording = false
    scenePlaying = false
    tracking = .notAvailable
    room = nil
    roomArea = nil
    roomSentForRecentre = -1
    lastRoomText = nil

    let web = WebStage(trust: trust)
    web.onPageMessage = { [weak self] in self?.onPage($0) }
    web.onProblem = { [weak self] in self?.banner = $0 }
    web.load(t.pageURL(voice: false))
    self.web = web

    let relay = RelayConnection(target: t, trust: trust)
    relay.onState = { [weak self] state in
      guard let self else { return }
      self.conn = state
      if state == .open {
        self.banner = nil
        // a scan made while offline (or before a relay restart) still reaches the laptop
        if let text = self.lastRoomText { self.relay?.send(text) }
      }
    }
    relay.onText = { [weak self] in self?.onRelay($0) }
    relay.onError = { [weak self] in self?.banner = $0 }
    relay.start()
    self.relay = relay

    let tracker = ARTracker()
    tracker.orientation = { [weak web] in
      web?.webView.window?.windowScene?.effectiveGeometry.interfaceOrientation ?? .unknown
    }
    tracker.viewportSize = { [weak web] in web?.webView.bounds.size ?? .zero }
    tracker.onFrame = { [weak self] in self?.onFrame($0) }
    tracker.onError = { [weak self] in self?.banner = $0 }
    tracker.onInterrupted = { [weak self] in self?.interrupted = $0 }
    tracker.start()
    self.tracker = tracker

    UIApplication.shared.isIdleTimerDisabled = true
    timers = [
      // Keepalive while frames stop (interruption): the laptop hands the gizmo to another phone
      // after 1 s of silence, and the relay drops peers silent for 30 s.
      Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
        Task { @MainActor in self?.keepalive() }
      },
      Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
        Task { @MainActor in self?.publishDebug() }
      },
    ]
    phase = .stage
    log.info("joined \(t.hostPort, privacy: .public) room \(t.room, privacy: .public)")
  }

  func leave() {
    stopScan()
    timers.forEach { $0.invalidate() }
    timers = []
    tracker?.pause()
    tracker = nil
    relay?.stop()
    relay = nil
    web?.tearDown()
    web = nil
    UIApplication.shared.isIdleTimerDisabled = false
    conn = .idle
    showDebug = false
    phase = .join
  }

  func foreground() {
    relay?.reconnectNow()
  }

  // MARK: - Controls

  func recentre() {
    poses.recentre(toYaw: anchor.yaw)
    show("Recentred to \(anchor.name)")
  }

  func shutter() {
    relay?.send(PhoneCommand(.shutter))
    flashCount += 1
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
  }

  func toggleRecord() {
    recording.toggle()
    relay?.send(PhoneCommand(recording ? .recordStart : .recordStop))
  }

  /// ACTION / CUT: the laptop owns the scene clock and the dialogue.
  func action() {
    guard scene != nil, peers.laptop else {
      show("No scene yet. Open one on the laptop")
      return
    }
    relay?.send(PhoneCommand(.playScene))
  }

  // MARK: - Room scan

  /// Start: walk the room sweeping the floor; the outline grows. Done: send it to the laptop.
  func toggleScan() {
    if scanning {
      stopScan()
      updateRoom()
      if let area = roomArea {
        sendRoom()
        show(String(format: "Room scanned: %.1f m²", area))
      } else {
        show("No floor found yet. Point the phone at the floor and scan again")
      }
    } else {
      scanning = true
      show("Walk around the room, pointing at the floor")
      scanTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
        Task { @MainActor in self?.updateRoom() }
      }
    }
  }

  private func stopScan() {
    scanTimer?.invalidate()
    scanTimer = nil
    scanning = false
  }

  private func updateRoom() {
    guard let planes = tracker?.detectedPlanes(), let next = RoomFootprint.from(planes) else { return }
    room = next
    roomArea = next.area
  }

  /// The room in the current Recentre's offset frame, to the laptop and to the page.
  private func sendRoom() {
    guard let room, !scanning else { return }
    let msg = room.message(source: ARTracker.hasLiDAR ? .lidar : .planes, toScene: poses.toScene)
    guard let text = try? Wire.encode(msg) else { return }
    roomSentForRecentre = poses.recentres
    lastRoomText = text
    relay?.send(text)
    web?.forward(relayText: text)
  }

  // MARK: - Frames → poses

  private func onFrame(_ f: FrameData) {
    if tracking != f.sample.quality { tracking = f.sample.quality }
    if interrupted { interrupted = false }
    let pose = poses.update(f.sample, orientation: f.orientation)
    // a Recentre moved the offset frame: the room follows it
    if room != nil, poses.recentres != roomSentForRecentre { sendRoom() }
    let size = web?.webView.bounds.size ?? .zero
    let aspect = size.width > 0 && size.height > 0 ? Double(size.width / size.height) : nil
    let fov = Lens.verticalFovDegrees(f.intrinsics, orientation: f.orientation, viewAspect: aspect ?? .nan)
    let p = PhonePose(t: f.sample.timestamp * 1000, pose: pose, fovDeg: fov, aspect: aspect, recording: recording)
    guard p.isFinite else { return }
    lastPose = p
    lastFrameAt = ProcessInfo.processInfo.systemUptime
    web?.push(p)
    send(p)

    debug.framesTracked += 1
    debug.held = pose.held
    debug.orientation = f.orientation.rawValue
    if let check = f.check { debug.check = check }
  }

  private func send(_ p: PhonePose) {
    guard let relay, relay.state == .open, throttle.shouldSend(now: p.t, key: PoseThrottle.key(p)),
      let text = try? Wire.encode(p), relay.send(text)
    else { return }
    debug.posesSent += 1
    debug.lastPose = p
  }

  /// No frames for 300 ms: resend the last (held) pose so the laptop keeps this phone.
  private func keepalive() {
    let now = ProcessInfo.processInfo.systemUptime
    guard var p = lastPose, now - lastFrameAt > 0.3 else { return }
    p.t = (now * 1000).rounded()
    p.recording = recording
    send(p)
  }

  // MARK: - Relay → native + page

  private func onRelay(_ text: String) {
    let msg: ServerMessage
    do {
      msg = try ServerMessage.decode(text)
    } catch {
      log.warning("dropped relay frame: \(error.localizedDescription, privacy: .public)")
      return
    }
    switch msg {
    case .peers(let p):
      peers = p
      lastPeersText = text
    case .scene(let s):
      lastSceneText = text
      onScene(s)
    case .cmd(let c):
      onCommand(c)
    case .pose, .unknown:
      return
    }
    web?.forward(relayText: text)
  }

  private func onScene(_ s: SceneState) {
    scene = s
    if scenePlaying != s.playing { scenePlaying = s.playing }
    if s.manifestUrl != manifestURL {
      manifestURL = s.manifestUrl
      manifest = nil
      fetchManifest(s.manifestUrl)
    }
    refreshAnchor()
  }

  private func onCommand(_ c: CommandName) {
    switch c {
    case .recenter:
      poses.recentre(toYaw: anchor.yaw)
      show("Director recentred you")
    case .shutter:
      flashCount += 1
    case .recordStart:
      recording = true
    case .recordStop:
      recording = false
    case .nextCamera, .playScene, .nextLine:
      break
    }
  }

  /// A new attached camera (or the first scene) re-centres onto it, as the web page does.
  private func refreshAnchor() {
    let next = anchorFor(scene: scene, manifest: manifest)
    let changed = next.key != anchor.key
    anchor = next
    debug.anchor.name = next.name
    debug.anchor.key = next.key
    debug.anchor.yaw = next.yaw
    if changed { poses.recentre(toYaw: next.yaw) }
  }

  private func fetchManifest(_ reference: String) {
    guard let url = target?.resolve(reference) else { return }
    Task { [weak self] in
      guard let self else { return }
      do {
        let (data, response) = try await self.trust.dataSession.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        let start = try JSONDecoder().decode(ManifestStart.self, from: data)
        guard self.manifestURL == reference else { return }  // the scene changed meanwhile
        self.manifest = start
        self.refreshAnchor()
      } catch {
        log.warning("manifest fetch failed: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  // MARK: - Page → native

  private func onPage(_ msg: PageMessage) {
    switch msg {
    case .ready:
      // A (re)loaded page starts blank: replay what the relay told us so far.
      if let lastPeersText { web?.forward(relayText: lastPeersText) }
      if let lastSceneText { web?.forward(relayText: lastSceneText) }
      if let lastRoomText { web?.forward(relayText: lastRoomText) }
      if let lastPose { web?.push(lastPose) }
      publishDebug()
    case .cmd(let c):
      if c == .recenter {
        recentre()
      } else {
        relay?.send(PhoneCommand(c))
      }
    case .log(let line):
      log.info("page: \(line, privacy: .public)")
    }
  }

  // MARK: - HUD helpers

  private func show(_ text: String) {
    toast = text
    toastTask?.cancel()
    toastTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(2))
      guard !Task.isCancelled else { return }
      self?.toast = nil
    }
  }

  private func publishDebug() {
    debug.conn = conn.rawValue
    debug.peers = peers
    debug.trackingState = interrupted ? "notAvailable" : tracking.debugName
    debug.recentreYaw = poses.recentreYaw
    debug.recentres = poses.recentres
    debug.error = banner
    if let web { debug.web = web.info }
    web?.publish(debug)
    if showDebug {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      debugText = (try? encoder.encode(debug)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
  }
}

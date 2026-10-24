// Validates what PrevizCore encodes against the real zod schemas in shared/protocol.ts (and the
// web page's poseKey), by running ios/scripts/protocol-harness.ts with the repo's tsx. macOS only
// (Process); skipped when node_modules/.bin/tsx is missing (run `pnpm install` at the repo root).
#if os(macOS)
  import Foundation
  import Testing
  import simd

  @testable import PrevizCore

  enum Harness {
    /// ios/PrevizCore/Tests/PrevizCoreTests/<this file> → repo root.
    static let repoRoot: URL = {
      var u = URL(fileURLWithPath: #filePath)
      for _ in 0..<5 { u.deleteLastPathComponent() }
      return u
    }()
    static let tsx = repoRoot.appendingPathComponent("node_modules/.bin/tsx")
    static let script = repoRoot.appendingPathComponent("ios/scripts/protocol-harness.ts")
    static var available: Bool { FileManager.default.isExecutableFile(atPath: tsx.path) }

    static func run(_ mode: String, stdin: Data = Data()) throws -> Data {
      let p = Process()
      p.executableURL = tsx
      p.arguments = [script.path, mode]
      p.currentDirectoryURL = repoRoot
      let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
      p.standardInput = inPipe
      p.standardOutput = outPipe
      p.standardError = errPipe
      try p.run()
      inPipe.fileHandleForWriting.write(stdin)
      try inPipe.fileHandleForWriting.close()
      let out = outPipe.fileHandleForReading.readDataToEndOfFile()
      let err = errPipe.fileHandleForReading.readDataToEndOfFile()
      p.waitUntilExit()
      guard p.terminationStatus == 0 else {
        throw HarnessError.failed(String(decoding: err, as: UTF8.self))
      }
      return out
    }

    enum HarnessError: Error { case failed(String) }
  }

  private struct CheckRequest: Encodable {
    var client: [String]
    var scripts: [String]
  }

  private struct CheckResponse: Decodable {
    struct Client: Decodable {
      var ok: Bool
      var dropped: [String]?
      var key: String?
      var error: String?
    }
    struct Script: Decodable {
      var ok: Bool
      var fn: String?
      var error: String?
    }
    var client: [Client]
    var scripts: [Script]
  }

  /// Poses the app really produces: from the tracker, held, rounded, in every orientation.
  private func appPoses() -> [PhonePose] {
    var out: [PhonePose] = []
    var tracker = PoseTracker(anchorYaw: 0.7)
    let k = CameraIntrinsics(fx: 1450, fy: 1450, imageWidth: 1920, imageHeight: 1440)
    var rng = Lcg(state: 7)
    for (i, o) in InterfaceOrientation.allCases.enumerated() {
      let q = simd_quatd(angle: rng.range(-3, 3), axis: simd_normalize([rng.range(-1, 1), 1, rng.range(-1, 1)]))
      let quality: TrackingQuality = i == 2 ? .excessiveMotion : .normal
      let s = CameraSample(
        transform: transform(q, [rng.range(-2, 2), rng.range(0, 2), rng.range(-2, 2)]), quality: quality,
        timestamp: Double(i) / 60)
      let aspect = o.isLandscape ? 852.0 / 393 : 393.0 / 852
      out.append(
        PhonePose(
          t: s.timestamp * 1000, pose: tracker.update(s, orientation: o),
          fovDeg: Lens.verticalFovDegrees(k, orientation: o, viewAspect: aspect), aspect: aspect,
          recording: i % 2 == 0))
    }
    // the minimal shape: no offset / aspect
    out.append(PhonePose(t: 0, q: [0, 0, 0, 1], offset: nil, fovDeg: 50, aspect: nil, recording: false))
    return out
  }

  @Suite("zod contract (shared/protocol.ts)", .enabled(if: Harness.available, "run pnpm install at the repo root"))
  struct ZodContractTests {
    @Test func everyFrameTheAppSendsIsAValidClientMessage() throws {
      let poses = appPoses()
      var frames = try poses.map { try Wire.encode($0) }
      frames.append(try Wire.encode(Hello(room: "ABCD")))
      frames += try CommandName.allCases.map { try Wire.encode(PhoneCommand($0)) }
      // negative control: the harness must really validate
      let bogus = #"{"type":"pose","source":"unity","t":1,"q":[0,0,0,1],"nudge":[0,0,0],"fovDeg":50}"#
      frames.append(bogus)

      let req = CheckRequest(client: frames, scripts: [])
      let res = try JSONDecoder().decode(
        CheckResponse.self, from: Harness.run("check", stdin: JSONEncoder().encode(req)))
      #expect(res.client.count == frames.count)
      for (frame, r) in zip(frames.dropLast(), res.client) {
        #expect(r.ok, "\(frame): \(r.error ?? "")")
        #expect(r.dropped == [], "zod stripped \(r.dropped ?? []) from \(frame)")
      }
      #expect(res.client.last?.ok == false)
      // the web page's change key and the Swift port agree on every pose
      for (pose, r) in zip(poses, res.client) {
        #expect(r.key == PoseThrottle.key(pose))
      }
    }

    @Test func bridgeScriptsCallThePageWithValidMessages() throws {
      let samples = try JSONDecoder().decode([String].self, from: Harness.run("samples"))
      var scripts = try appPoses().map(WebBridge.poseScript)
      scripts += try samples.map { try WebBridge.messageScript(relayText: $0) }
      let req = CheckRequest(client: [], scripts: scripts)
      let res = try JSONDecoder().decode(
        CheckResponse.self, from: Harness.run("check", stdin: JSONEncoder().encode(req)))
      #expect(res.scripts.count == scripts.count)
      for (s, r) in zip(scripts, res.scripts) {
        #expect(r.ok, "\(s.prefix(80)): \(r.error ?? "invalid argument")")
      }
    }

    @Test func decodesWhatTheRelaySends() throws {
      let samples = try JSONDecoder().decode([String].self, from: Harness.run("samples"))
      let decoded = try samples.map(ServerMessage.decode)
      #expect(decoded.count == 6)
      #expect(decoded[0] == .peers(Peers(laptop: true, phones: 2)))
      guard case .scene(let s) = decoded[1], case .scene(let s2) = decoded[2] else {
        Issue.record("expected scenes")
        return
      }
      #expect(s.activeCamera?.id == "c1" && s.cameras.count == 2 && s.editsRevision == 3 && s.playing)
      #expect(near(anchorFor(scene: s, manifest: nil).yaw, .pi / 4, tol: 1e-6))
      #expect(s2.activeCameraId == nil && s2.speakingLineId == "l3" && s2.cameras.isEmpty)
      #expect(decoded[3] == .cmd(.recenter))
      #expect(decoded[4] == .cmd(.recordStart))
      #expect(decoded[5] == .pose)
    }
  }
#endif

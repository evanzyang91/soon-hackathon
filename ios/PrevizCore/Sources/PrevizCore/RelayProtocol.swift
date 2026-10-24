// Swift mirror of shared/protocol.ts (the source of truth, owned by the lead). JSON text frames
// on wss://<host>/ws. ZodContractTests validates what this encodes against the real zod schemas.
import Foundation

// MARK: - Phone → relay

/// `PhonePose` (≤ 30 Hz). Field names and meaning exactly as in shared/protocol.ts.
public struct PhonePose: Codable, Sendable, Equatable {
  public var type = "pose"
  /// Always `arkit` from this app (`browser` is the web page's default).
  public var source: String? = "arkit"
  /// Monotonic milliseconds on the phone (ARFrame.timestamp × 1000).
  public var t: Double
  /// Camera orientation in the scene world after Recentre, `[x, y, z, w]` (three.js camera:
  /// looks along −Z out of the back of the phone, +Y = up on the screen).
  public var q: [Double]
  /// Handheld nudge: always `[0, 0, 0]` here (ARKit's position already contains the sway).
  public var nudge: [Double] = [0, 0, 0]
  /// ARKit position since the last Recentre, metres, scene world frame (camera = anchor + offset).
  public var offset: [Double]?
  /// Vertical field of view of the real lens in this viewport (degrees).
  public var fovDeg: Double
  /// Viewport width / height of the web view.
  public var aspect: Double?
  public var recording: Bool = false
  /// Stamped by the relay; never sent.
  public var phoneId: String?

  public init(
    t: Double, q: [Double], offset: [Double]?, fovDeg: Double, aspect: Double?, recording: Bool
  ) {
    self.t = t
    self.q = q
    self.offset = offset
    self.fovDeg = fovDeg
    self.aspect = aspect
    self.recording = recording
  }

  /// Rounded for the wire: q to 1e-6, metres to 0.01 mm, degrees to 0.001, ms to 0.1.
  public init(
    t: Double, pose: TrackedPose, fovDeg: Double, aspect: Double?, recording: Bool
  ) {
    let o = pose.offset
    self.init(
      t: Wire.round(t, 10),
      q: PoseMath.array(pose.q).map { Wire.round($0, 1e6) },
      offset: [o.x, o.y, o.z].map { Wire.round($0, 1e5) },
      fovDeg: Wire.round(fovDeg, 1e3),
      aspect: aspect.map { Wire.round($0, 1e3) },
      recording: recording)
  }

  /// Every number is finite (zod rejects NaN / ±Infinity, JSONEncoder throws on them).
  public var isFinite: Bool {
    t.isFinite && fovDeg.isFinite && (aspect?.isFinite ?? true)
      && (q + nudge + (offset ?? [])).allSatisfy(\.isFinite)
  }
}

/// `RoomScan`: the physical room, in the pose `offset` frame (see RoomFootprint).
public struct RoomScan: Codable, Sendable, Equatable {
  public enum Source: String, Codable, Sendable { case lidar, planes }
  public var type = "room"
  public var source: Source
  /// [[x, z], …] metres, counter-clockwise, not closed (3…64 points).
  public var outline: [[Double]]
  public var floorY: Double
  public var ceiling: Double?
  public var area: Double

  public init(source: Source, outline: [[Double]], floorY: Double, ceiling: Double?, area: Double) {
    self.source = source
    self.outline = outline
    self.floorY = floorY
    self.ceiling = ceiling
    self.area = area
  }
}

public struct Hello: Codable, Sendable, Equatable {
  public var type = "hello"
  public var role = "phone"
  public var room: String

  public init(room: String) { self.room = room }
}

/// `PhoneCommand.cmd` values.
public enum CommandName: String, Codable, Sendable, CaseIterable {
  case recenter
  case shutter
  case recordStart = "record-start"
  case recordStop = "record-stop"
  case nextCamera = "next-camera"
  case playScene = "play-scene"
  case nextLine = "next-line"
}

public struct PhoneCommand: Codable, Sendable, Equatable {
  public var type = "cmd"
  public var cmd: CommandName

  public init(_ cmd: CommandName) { self.cmd = cmd }
}

// MARK: - Relay → phone

public struct DropCamera: Codable, Sendable, Equatable {
  public var id: String
  public var name: String
  public var position: [Double]
  public var quaternion: [Double]
  public var fovDeg: Double
}

/// The parts of `SceneState` the native side needs (unknown fields, e.g. `look`, are ignored here
/// and reach the web page untouched through the raw JSON).
public struct SceneState: Codable, Sendable, Equatable {
  public var type = "scene"
  public var projectId: String
  public var sceneIndex: Int
  public var manifestUrl: String
  public var time: Double
  public var playing: Bool
  public var cameras: [DropCamera]
  public var activeCameraId: String?
  public var speakingLineId: String?
  public var editsRevision: Int?

  public var activeCamera: DropCamera? {
    guard let id = activeCameraId else { return nil }
    return cameras.first { $0.id == id }
  }
}

public struct Peers: Codable, Sendable, Equatable {
  public var type = "peers"
  public var laptop: Bool
  public var phones: Int

  public init(laptop: Bool, phones: Int) {
    self.laptop = laptop
    self.phones = phones
  }
}

public enum ServerMessage: Sendable, Equatable {
  case peers(Peers)
  case scene(SceneState)
  case cmd(CommandName)
  /// Phones never receive poses; kept so a decode does not count as a failure.
  case pose
  /// A type this build does not know (newer server); ignored.
  case unknown(String)

  private struct Envelope: Decodable { var type: String }

  /// Decode one relay text frame. Throws on non-JSON or a known type with a bad shape.
  public static func decode(_ text: String) throws -> ServerMessage {
    let data = Data(text.utf8)
    let decoder = JSONDecoder()
    let type = try decoder.decode(Envelope.self, from: data).type
    switch type {
    case "peers": return .peers(try decoder.decode(Peers.self, from: data))
    case "scene": return .scene(try decoder.decode(SceneState.self, from: data))
    case "cmd": return .cmd(try decoder.decode(PhoneCommand.self, from: data).cmd)
    case "pose": return .pose
    default: return .unknown(type)
    }
  }
}

// MARK: - Encoding

public enum Wire {
  /// Compact JSON with stable key order (tests and change detection rely on it).
  public static func encode<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  static func round(_ v: Double, _ scale: Double) -> Double {
    let r = (v * scale).rounded() / scale
    return r == 0 ? 0 : r  // no "-0"
  }
}

// MARK: - Anchor (web/src/phone/scene-sync.ts `anchorFor`)

/// The camera the phone is attached to: what Recentre aligns with and what `offset` is relative to.
public struct Anchor: Sendable, Equatable {
  public var position: [Double]
  /// Heading the phone maps to on Recentre (yaw of the camera's quaternion).
  public var yaw: Double
  public var fovDeg: Double
  public var name: String
  /// Changes whenever the phone should Recentre (camera switched / first scene).
  public var key: String

  public static let none = Anchor(position: [0, 1.6, 0], yaw: 0, fovDeg: 50, name: "No camera", key: "none")
}

/// The `startCamera` of a scene manifest (only the fields the anchor needs).
public struct ManifestStart: Decodable, Sendable, Equatable {
  public struct Plan: Decodable, Sendable, Equatable { public var index: Int }
  public struct Camera: Decodable, Sendable, Equatable {
    public var position: [Double]
    public var quaternion: [Double]
    public var fovDeg: Double
  }

  public var projectId: String
  public var plan: Plan
  public var startCamera: Camera
}

/// Active drop camera → else the manifest's start camera → else a standing eye height at origin.
public func anchorFor(scene: SceneState?, manifest: ManifestStart?) -> Anchor {
  if let cam = scene?.activeCamera {
    return Anchor(
      position: cam.position, yaw: PoseMath.yaw(of: PoseMath.quaternion(cam.quaternion)),
      fovDeg: cam.fovDeg, name: cam.name, key: "cam:\(cam.id)")
  }
  if let m = manifest {
    let s = m.startCamera
    return Anchor(
      position: s.position, yaw: PoseMath.yaw(of: PoseMath.quaternion(s.quaternion)),
      fovDeg: s.fovDeg, name: "Start camera", key: "start:\(m.projectId):\(m.plan.index)")
  }
  return .none
}

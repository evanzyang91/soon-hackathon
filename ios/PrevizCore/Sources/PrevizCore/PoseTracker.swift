// ARKit samples → the pose the phone streams (q + offset), with Recentre and hold-when-limited.
//
// Recentre = "I am standing on the attached camera, looking where it looks":
//   ψ  = wrap(anchorYaw − yaw(q_web(now)))      (only the heading; pitch and roll stay the phone's)
//   p₀ = ARKit camera position now
// and from then on
//   q      = Ry(ψ) · q_web                       (camera orientation in the scene world)
//   offset = Ry(ψ) · (p − p₀)                    (metres, scene world frame)
// so the scene camera sits at anchor + offset and walking moves it 1:1. This is one rigid map of
// ARKit's world onto the scene (rotate by ψ about +Y, then translate p₀ onto the anchor), so
// position and orientation always agree.
//
// Unlike the web page (whose joystick walk survives a Recentre), a Recentre here also rebases the
// position: with true 6DoF tracking, "you are at the camera again" is the useful meaning.
// Recentres requested while tracking is not normal wait for the next normal sample.
import simd

/// ARKit's `ARCamera.TrackingState`, flattened (ARKit itself stays in the app target).
public enum TrackingQuality: String, Sendable, Codable, CaseIterable {
  case normal
  case initializing
  case relocalizing
  case excessiveMotion
  case insufficientFeatures
  case notAvailable

  /// Only `.normal` poses are streamed live; anything else holds the last good pose.
  public var isGood: Bool { self == .normal }

  /// Debug / HUD id: `normal`, `limited:initializing`, …, `notAvailable`.
  public var debugName: String {
    switch self {
    case .normal, .notAvailable: rawValue
    default: "limited:\(rawValue)"
    }
  }

  /// Short HUD badge text.
  public var label: String {
    switch self {
    case .normal: "Tracking"
    case .initializing: "Starting…"
    case .relocalizing: "Relocalizing…"
    case .excessiveMotion: "Slow down"
    case .insufficientFeatures: "Need more detail"
    case .notAvailable: "No tracking"
    }
  }

  /// One-line coaching hint (nil when tracking is fine).
  public var hint: String? {
    switch self {
    case .normal: nil
    case .initializing: "Move the phone slowly side to side"
    case .relocalizing: "Point the phone where it was before the interruption"
    case .excessiveMotion: "Moving too fast. Holding the last good pose"
    case .insufficientFeatures: "Aim at a textured, well-lit area. Holding the last good pose"
    case .notAvailable: "Tracking unavailable. Holding the last good pose"
    }
  }
}

/// One `ARFrame` worth of camera data.
public struct CameraSample: Sendable, Equatable {
  /// `ARCamera.transform` (camera → ARKit world), double precision.
  public var transform: simd_double4x4
  public var quality: TrackingQuality
  /// `ARFrame.timestamp` (seconds, system uptime clock).
  public var timestamp: Double

  public init(transform: simd_double4x4, quality: TrackingQuality, timestamp: Double) {
    self.transform = transform
    self.quality = quality
    self.timestamp = timestamp
  }
}

/// What the scene camera does, in the scene world: orientation and the offset from the anchor.
public struct TrackedPose: Sendable, Equatable {
  public var q: simd_quatd
  public var offset: SIMD3<Double>
  /// True when tracking is not normal and this is the last good pose (or the level default).
  public var held: Bool

  public init(q: simd_quatd, offset: SIMD3<Double>, held: Bool) {
    self.q = q
    self.offset = offset
    self.held = held
  }
}

public struct PoseTracker: Sendable {
  /// ψ: yaw added to ARKit's heading (radians).
  public private(set) var recentreYaw: Double = 0
  /// p₀: ARKit position at the last Recentre.
  public private(set) var origin = SIMD3<Double>(0, 0, 0)
  /// Target yaw of a Recentre waiting for the next normal sample.
  public private(set) var pendingRecentre: Double?
  public private(set) var lastGood: TrackedPose?
  /// Recentres applied so far (debug).
  public private(set) var recentres = 0

  /// Starts with a pending Recentre to `anchorYaw`, so the first good sample faces the anchor.
  public init(anchorYaw: Double = 0) {
    pendingRecentre = anchorYaw
  }

  /// Ask for a Recentre onto `anchorYaw`; it applies on the next normal sample.
  public mutating func recentre(toYaw anchorYaw: Double) {
    pendingRecentre = anchorYaw
  }

  public mutating func update(_ sample: CameraSample, orientation: InterfaceOrientation) -> TrackedPose {
    guard sample.quality.isGood else {
      if var held = lastGood {
        held.held = true
        return held
      }
      // Nothing good yet: level, facing the heading the first Recentre will give.
      return TrackedPose(
        q: PoseMath.yawQuaternion(pendingRecentre ?? recentreYaw), offset: .zero, held: true)
    }
    let raw = PoseMath.webCamera(arkit: PoseMath.rotation(of: sample.transform), orientation: orientation)
    let p = PoseMath.position(of: sample.transform)
    if let target = pendingRecentre {
      recentreYaw = PoseMath.recentreYaw(current: raw, target: target)
      origin = p
      pendingRecentre = nil
      recentres += 1
    }
    let yawQ = PoseMath.yawQuaternion(recentreYaw)
    let pose = TrackedPose(q: (yawQ * raw).normalized, offset: yawQ.act(p - origin), held: false)
    lastGood = pose
    return pose
  }
}

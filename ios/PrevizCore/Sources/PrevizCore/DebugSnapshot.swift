// The native app's debug state as JSON: published to the page as `window.__previzNative`
// (readable from Safari's Web Inspector) and shown by the in-app debug overlay.
import Foundation

public struct DebugSnapshot: Codable, Sendable, Equatable {
  public var app = "PrevizCamera"
  public var bridge = WebBridge.version
  public var room = ""
  public var host = ""
  /// `idle | connecting | open | reconnecting | closed`
  public var conn = "idle"
  public var peers = Peers(laptop: false, phones: 0)
  /// `normal`, `limited:initializing`, `limited:relocalizing`, `limited:excessiveMotion`,
  /// `limited:insufficientFeatures`, `notAvailable`
  public var trackingState = TrackingQuality.notAvailable.debugName
  /// The pose being streamed is the last good one (tracking not normal).
  public var held = true
  public var posesSent = 0
  public var framesTracked = 0
  public var lastPose: PhonePose?
  public var orientation = InterfaceOrientation.portrait.rawValue
  /// ψ (radians) and how many Recentres were applied.
  public var recentreYaw = 0.0
  public var recentres = 0
  public var anchor = AnchorInfo()
  /// Trust used for this host: `pinned`, `system`, `mismatch`, `none`.
  public var trust = "none"
  public var web = WebInfo()
  /// On-device cross-checks against ARKit's own matrices (nil until measured).
  public var check = Check()
  public var error: String?

  public struct AnchorInfo: Codable, Sendable, Equatable {
    public var name = Anchor.none.name
    public var key = Anchor.none.key
    public var yaw = 0.0
    public init() {}
  }

  public struct WebInfo: Codable, Sendable, Equatable {
    public var url = ""
    /// The page called `postMessage({type:'ready'})`.
    public var ready = false
    public var loads = 0
    public var processTerminations = 0
    public var posesPushed = 0
    public var lastError: String?
    public init() {}
  }

  public struct Check: Codable, Sendable, Equatable {
    /// Angle (deg) between PrevizCore's oriented camera and ARKit's
    /// `viewMatrix(for: orientation).inverse` rotation (expect < 0.01).
    public var rotationErrorDeg: Double?
    /// PrevizCore's FOV minus the FOV of `projectionMatrix(for:viewportSize:…)` (deg).
    public var fovErrorDeg: Double?
    public init() {}
  }

  public init() {}
}

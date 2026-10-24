// The scanned room the app uploads so the laptop can turn it into the set (server/pipeline/
// room-world.ts RoomCapture): the room outline, where the camera was at the scan video's first
// frame (position + heading), and the video's length, all in the scan's own pose `offset` frame.
import Foundation
import simd

public struct RoomCapture: Codable, Sendable, Equatable {
  public struct Start: Codable, Sendable, Equatable {
    /// Metres, pose offset frame of the scan.
    public var position: [Double]
    /// Heading of the camera (Blocking.yaw convention: rotation.y of a −Z-facing camera).
    public var yaw: Double

    public init(position: [Double], yaw: Double) {
      self.position = position
      self.yaw = yaw
    }
  }

  public struct Video: Codable, Sendable, Equatable {
    public var seconds: Double
    public var bytes: Int

    public init(seconds: Double, bytes: Int) {
      self.seconds = seconds
      self.bytes = bytes
    }
  }

  public var schema = "previz.room-capture/1"
  public var room: RoomScan
  public var start: Start
  public var video: Video
  public var createdAt: String

  public init(room: RoomScan, start: Start, video: Video, createdAt: String) {
    self.room = room
    self.start = start
    self.video = video
    self.createdAt = createdAt
  }

  /// The camera at the video's first frame, mapped with the scan's frame.
  public static func start(
    camera transform: simd_double4x4, orientation: InterfaceOrientation, frame: SceneFrame
  ) -> Start {
    let p = frame.toScene(PoseMath.position(of: transform))
    let raw = PoseMath.webCamera(arkit: PoseMath.rotation(of: transform), orientation: orientation)
    let yaw = PoseMath.yaw(of: (PoseMath.yawQuaternion(frame.recentreYaw) * raw).normalized)
    return Start(position: [p.x, p.y, p.z].map { Wire.round($0, 1e4) }, yaw: Wire.round(yaw, 1e5))
  }
}

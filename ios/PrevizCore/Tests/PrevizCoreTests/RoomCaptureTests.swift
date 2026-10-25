import Foundation
import Testing
import simd

@testable import PrevizCore

@Suite("RoomCapture: scan frame, first-frame camera, upload payload")
struct RoomCaptureTests {
  @Test func adoptingTheScanFramePutsThePhoneBackInIt() {
    var t = PoseTracker(anchorYaw: 0.6)
    _ = t.update(
      CameraSample(transform: transform(ry(0.2), [1, 1.4, 2]), quality: .normal, timestamp: 0),
      orientation: .landscapeRight)
    let scan = t.frame
    // later: another camera, another Recentre somewhere else
    t.recentre(toYaw: -1)
    _ = t.update(
      CameraSample(transform: transform(ry(1.1), [3, 1.5, -1]), quality: .normal, timestamp: 1),
      orientation: .landscapeRight)
    #expect(t.frame != scan)
    // a scanned-room scene: back to the scan's frame, and the offset is measured in it again
    t.adopt(scan)
    let p = t.update(
      CameraSample(transform: transform(ry(0.2), [1, 1.4, 2]), quality: .normal, timestamp: 2),
      orientation: .landscapeRight)
    #expect(near(p.offset, .zero, tol: 1e-9))
    #expect(near(PoseMath.yaw(of: p.q), 0.6, tol: 1e-9))
  }

  @Test func startIsTheFirstFrameCameraInTheScanFrame() {
    var t = PoseTracker(anchorYaw: .pi / 2)
    _ = t.update(
      CameraSample(transform: transform(ry(0), [0, 1.5, 0]), quality: .normal, timestamp: 0),
      orientation: .landscapeRight)
    // first video frame: 1 m in front (ARKit −Z) and 0.1 m lower, heading unchanged
    let s = RoomCapture.start(camera: transform(ry(0), [0, 1.4, -1]), orientation: .landscapeRight, frame: t.frame)
    // the scan frame faces scene yaw +90° (−X): ARKit −Z maps to scene −X
    #expect(near(SIMD3(s.position[0], s.position[1], s.position[2]), [-1, -0.1, 0], tol: 1e-4))
    #expect(near(s.yaw, .pi / 2, tol: 1e-4))
  }

  @Test func payloadIsAValidServerRoomCapture() throws {
    guard Harness.available else { return }
    var t = PoseTracker(anchorYaw: 0)
    _ = t.update(
      CameraSample(transform: transform(ry(0.4), [0.2, 1.3, 0.1]), quality: .normal, timestamp: 0),
      orientation: .landscapeRight)
    let floor = DetectedPlane(kind: .floor, boundary: [[-2, 0, -3], [2, 0, -3], [2, 0, 1], [-2, 0, 1]])
    let room = try #require(RoomFootprint.from([floor])).message(source: .lidar, toScene: t.toScene)
    let capture = RoomCapture(
      room: room,
      start: RoomCapture.start(camera: transform(ry(0.4), [0.2, 1.3, 0.1]), orientation: .landscapeRight, frame: t.frame),
      video: .init(seconds: 21.5, bytes: 31_000_000), createdAt: "2026-10-24T18:00:00.000Z")
    let good = try Wire.encode(capture)
    var bad = capture
    bad.schema = "previz.room-capture/0"  // negative control
    let lines = [good, try Wire.encode(bad)].joined(separator: "\n")
    struct R: Decodable { var ok: Bool; var dropped: [String]?; var error: String? }
    let res = try JSONDecoder().decode([R].self, from: Harness.run("capture", stdin: Data(lines.utf8)))
    #expect(res[0].ok, "\(res[0].error ?? "")")
    #expect(res[0].dropped == [])
    #expect(!res[1].ok)
  }

  @Test func manifestTellsARoomScanApart() throws {
    let json = #"{"projectId":"p","plan":{"index":0},"startCamera":{"position":[0,1.4,0],"quaternion":[0,0,0,1],"fovDeg":50},"world":{"source":"room-scan","spz":{}}}"#
    let m = try JSONDecoder().decode(ManifestStart.self, from: Data(json.utf8))
    #expect(m.isRoomScan)
    let plain = #"{"projectId":"p","plan":{"index":0},"startCamera":{"position":[0,1.6,0],"quaternion":[0,0,0,1],"fovDeg":50}}"#
    #expect(try !JSONDecoder().decode(ManifestStart.self, from: Data(plain.utf8)).isRoomScan)
  }
}

import Testing
import simd

@testable import PrevizCore

/// A horizontal rectangle at height y, as ARKit plane boundary vertices.
private func rect(_ x0: Double, _ z0: Double, _ x1: Double, _ z1: Double, y: Double) -> [SIMD3<Double>] {
  [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]]
}

@Suite("RoomFootprint: floor planes → room outline")
struct RoomFootprintTests {
  @Test func hullIsCounterClockwiseAndDropsInteriorPoints() {
    let pts: [SIMD2<Double>] = [[0, 0], [4, 0], [4, 3], [0, 3], [2, 1.5], [1, 1], [4, 1.5]]
    let hull = RoomFootprint.convexHull(pts)
    #expect(hull.count == 4)
    #expect(RoomFootprint.signedArea(hull) > 0)
    #expect(near(RoomFootprint.signedArea(hull), 12))
  }

  @Test func simplifyKeepsTheShapeWithinMaxPoints() {
    // a 64-gon of radius 2: simplified to 12 points, area within 6 %
    let circle = (0..<64).map { i -> SIMD2<Double> in
      let a = Double(i) / 64 * 2 * .pi
      return [2 * cos(a), 2 * sin(a)]
    }
    let s = RoomFootprint.simplify(circle, maxPoints: 12)
    #expect(s.count == 12)
    #expect(abs(RoomFootprint.signedArea(s) / RoomFootprint.signedArea(circle) - 1) < 0.06)
  }

  @Test func twoFloorPatchesAndACeilingMakeOneRoom() throws {
    let planes = [
      DetectedPlane(kind: .floor, boundary: rect(-2, -3, 0.5, 1, y: -1.40)),
      DetectedPlane(kind: .floor, boundary: rect(0, -3, 2, 1, y: -1.42)),
      DetectedPlane(kind: .ceiling, boundary: rect(-1, -1, 1, 1, y: 1.10)),
      DetectedPlane(kind: .otherHorizontal, boundary: rect(0, 0, 0.6, 0.6, y: -0.65)),  // a table
    ]
    let f = try #require(RoomFootprint.from(planes))
    #expect(near(f.area, 16, tol: 1e-9))
    #expect(near(f.floorY, -1.41, tol: 1e-9))
    #expect(near(try #require(f.ceiling), 2.51, tol: 1e-9))
  }

  @Test func withoutClassificationTheLowestPlanesAreTheFloor() throws {
    let planes = [
      DetectedPlane(kind: .otherHorizontal, boundary: rect(-2, -2, 2, 2, y: -1.5)),
      DetectedPlane(kind: .otherHorizontal, boundary: rect(0, 0, 0.8, 0.8, y: -0.75)),
    ]
    let f = try #require(RoomFootprint.from(planes))
    #expect(near(f.floorY, -1.5))
    #expect(near(f.area, 16))
    #expect(f.ceiling == nil)
  }

  @Test func tooLittleFloorIsNoRoomYet() {
    #expect(RoomFootprint.from([DetectedPlane(kind: .floor, boundary: rect(0, 0, 0.5, 0.5, y: 0))]) == nil)
    #expect(RoomFootprint.from([]) == nil)
  }

  @Test func messageIsInThePoseOffsetFrame() throws {
    // The phone Recentres at ARKit (1, 1.4, 2) facing ARKit heading 0 onto a scene yaw of +90°.
    var t = PoseTracker(anchorYaw: .pi / 2)
    _ = t.update(
      CameraSample(transform: transform(ry(0), [1, 1.4, 2]), quality: .normal, timestamp: 0),
      orientation: .landscapeRight)
    let f = try #require(
      RoomFootprint.from([DetectedPlane(kind: .floor, boundary: rect(0, 0, 2, 4, y: 0))]))
    let msg = f.message(source: .lidar, toScene: t.toScene)
    #expect(msg.type == "room" && msg.source == .lidar)
    #expect(near(msg.floorY, -1.4))
    #expect(near(msg.area, 8))
    // still counter-clockwise, and the Recentre point maps to the scene origin like the camera
    let pts = msg.outline.map { SIMD2($0[0], $0[1]) }
    #expect(RoomFootprint.signedArea(pts) > 0)
    let corner = t.toScene([1, 1.4, 2])
    #expect(near(corner, .zero))
    // ARKit (1, 0, 0) is 2 m in front (−Z) of the Recentre point; the scene heading is +90°
    // (facing −X), so it lands 2 m along −X.
    #expect(near(t.toScene([1, 1.4, 0]), [-2, 0, 0], tol: 1e-9))
  }
}

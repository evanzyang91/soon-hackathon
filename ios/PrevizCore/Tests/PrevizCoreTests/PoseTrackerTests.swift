import Testing
import simd

@testable import PrevizCore

private func sample(
  _ q: simd_quatd, _ p: SIMD3<Double> = .zero, _ quality: TrackingQuality = .normal
) -> CameraSample {
  CameraSample(transform: transform(q, p), quality: quality, timestamp: 0)
}

/// ARKit camera of a phone held upright in landscape right (Home button right) facing heading h.
private func landscape(heading h: Double) -> simd_quatd { ry(h) }

@Suite("PoseTracker: recentre, offset, hold")
struct PoseTrackerTests {
  @Test func firstGoodSampleFacesTheAnchor() {
    var t = PoseTracker(anchorYaw: 1.0)
    let pose = t.update(sample(landscape(heading: -0.4), [0.3, 1.2, -2]), orientation: .landscapeRight)
    #expect(near(PoseMath.yaw(of: pose.q), 1.0))
    #expect(near(pose.offset, .zero))
    #expect(!pose.held)
    #expect(t.recentres == 1)
  }

  @Test func walkingMovesTheCameraOneToOneAlongTheSceneHeading() {
    // ARKit heading 0 (facing −Z); the anchor faces scene yaw +90° (−X).
    var t = PoseTracker(anchorYaw: .pi / 2)
    _ = t.update(sample(landscape(heading: 0), [0, 1.5, 0]), orientation: .landscapeRight)
    // one metre forward (ARKit −Z), half a metre up, 0.2 m to the right (ARKit +X)
    let pose = t.update(sample(landscape(heading: 0), [0.2, 2.0, -1]), orientation: .landscapeRight)
    // scene forward for yaw ψ is (−sin ψ, 0, −cos ψ) = (−1, 0, 0); right is (cos ψ, 0, −sin ψ) = (0, 0, −1)
    #expect(near(pose.offset, [-1, 0.5, -0.2], tol: 1e-12))
  }

  @Test func offsetAndOrientationAreOneRigidMap() {
    // A point 2 m in front of the camera must land in the same scene spot from two poses that
    // both look at it: anchor + offset + q·(0,0,−d).
    var t = PoseTracker(anchorYaw: 0.8)
    let target = SIMD3<Double>(1, 1.5, -3)  // ARKit world
    func look(from p: SIMD3<Double>) -> simd_quatd {
      let d = simd_normalize(target - p)
      return simd_quatd(from: forward, to: d)
    }
    let p1 = SIMD3<Double>(0, 1.5, 0), p2 = SIMD3<Double>(-1.5, 1.2, -1)
    let a = t.update(sample(look(from: p1), p1), orientation: .landscapeRight)
    let b = t.update(sample(look(from: p2), p2), orientation: .landscapeRight)
    let hitA = a.offset + a.q.act(forward) * simd_length(target - p1)
    let hitB = b.offset + b.q.act(forward) * simd_length(target - p2)
    #expect(near(hitA, hitB, tol: 1e-9))
  }

  @Test func limitedTrackingHoldsTheLastGoodPose() {
    var t = PoseTracker(anchorYaw: 0)
    _ = t.update(sample(landscape(heading: 0)), orientation: .landscapeRight)
    let good = t.update(sample(landscape(heading: 0.2), [0.1, 0, -0.3]), orientation: .landscapeRight)
    for quality in [TrackingQuality.excessiveMotion, .insufficientFeatures, .relocalizing, .notAvailable] {
      let held = t.update(sample(landscape(heading: 2.5), [9, 9, 9], quality), orientation: .landscapeRight)
      #expect(held.held)
      #expect(sameRotation(held.q, good.q))
      #expect(near(held.offset, good.offset))
    }
    let back = t.update(sample(landscape(heading: 0.25), [0.1, 0, -0.4]), orientation: .landscapeRight)
    #expect(!back.held)
    #expect(near(back.offset, [0.1, 0, -0.4], tol: 1e-12))
  }

  @Test func beforeAnyGoodSampleTheCameraIsLevelFacingTheAnchor() {
    var t = PoseTracker(anchorYaw: -0.6)
    let pose = t.update(sample(landscape(heading: 1), [1, 1, 1], .initializing), orientation: .portrait)
    #expect(pose.held)
    #expect(sameRotation(pose.q, ry(-0.6)))
    #expect(near(pose.offset, .zero))
    #expect(t.recentres == 0)
  }

  @Test func recentreRebasesYawAndPosition() {
    var t = PoseTracker(anchorYaw: 0)
    _ = t.update(sample(landscape(heading: 0)), orientation: .landscapeRight)
    _ = t.update(sample(landscape(heading: 0.9), [2, 0, -2]), orientation: .landscapeRight)
    t.recentre(toYaw: -1.0)
    let at = t.update(sample(landscape(heading: 0.9), [2, 0, -2]), orientation: .landscapeRight)
    #expect(near(PoseMath.yaw(of: at.q), -1.0))
    #expect(near(at.offset, .zero))
    // a step forward along the current heading moves the camera along the new scene heading
    let step = SIMD3<Double>(-sin(0.9), 0, -cos(0.9)) * 0.5
    let moved = t.update(sample(landscape(heading: 0.9), [2, 0, -2] + step), orientation: .landscapeRight)
    #expect(near(moved.offset, [sin(1.0), 0, -cos(1.0)] * 0.5, tol: 1e-12))
  }

  @Test func recentreWhileLimitedWaitsForGoodTracking() {
    var t = PoseTracker(anchorYaw: 0)
    _ = t.update(sample(landscape(heading: 0)), orientation: .landscapeRight)
    t.recentre(toYaw: 2.0)
    _ = t.update(sample(landscape(heading: 0.3), .zero, .excessiveMotion), orientation: .landscapeRight)
    #expect(t.pendingRecentre == 2.0)
    let pose = t.update(sample(landscape(heading: 0.3), [0.5, 0, 0]), orientation: .landscapeRight)
    #expect(t.pendingRecentre == nil)
    #expect(near(PoseMath.yaw(of: pose.q), 2.0))
    #expect(near(pose.offset, .zero))
  }

  @Test func rotatingTheUIKeepsHeadingAndOffset() {
    var t = PoseTracker(anchorYaw: 0.3)
    let device = ry(0.5) * rx(-0.2)
    _ = t.update(sample(arkitCamera(device: device), [0, 1, 0]), orientation: .portrait)
    let a = t.update(sample(arkitCamera(device: device), [0, 1, -1]), orientation: .portrait)
    let b = t.update(sample(arkitCamera(device: device), [0, 1, -1]), orientation: .landscapeRight)
    #expect(near(PoseMath.yaw(of: a.q), PoseMath.yaw(of: b.q)))
    #expect(near(a.q.act(forward), b.q.act(forward)))
    #expect(near(a.offset, b.offset))
  }

  @Test func trackingQualityNames() {
    #expect(TrackingQuality.normal.debugName == "normal")
    #expect(TrackingQuality.excessiveMotion.debugName == "limited:excessiveMotion")
    #expect(TrackingQuality.notAvailable.debugName == "notAvailable")
    #expect(TrackingQuality.allCases.filter(\.isGood) == [.normal])
    #expect(TrackingQuality.allCases.allSatisfy { ($0.hint == nil) == $0.isGood })
  }
}

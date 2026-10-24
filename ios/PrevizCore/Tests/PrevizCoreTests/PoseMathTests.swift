import Testing
import simd

@testable import PrevizCore

/// ARKit's camera axes in the W3C device frame (x = right edge, y = top edge, z = out of the
/// screen), straight from the `ARCamera.transform` documentation: +X along the long axis from the
/// front camera toward the Home button (= device −y), +Y up in that landscape (= device +x), +Z
/// out of the screen.
let arkitCameraInDevice = simd_quatd(simd_double3x3(columns: ([0, -1, 0], [1, 0, 0], [0, 0, 1])))

/// ARKit camera rotation for a device attitude (device frame → ARKit world).
func arkitCamera(device: simd_quatd) -> simd_quatd { device * arkitCameraInDevice }

@Suite("ARKit → web camera convention")
struct ConventionTests {
  @Test func arkitCameraFrameIsTheDeviceFrameRolledMinus90() {
    #expect(sameRotation(arkitCameraInDevice, rz(-90 * deg)))
  }

  @Test func webReadmeIdentity() {
    // web/src/phone/README.md: "Phone upright in portrait, alpha=0, beta=90, gamma=0, gives the
    // identity quaternion (camera faces −Z)."
    let device = webDeviceToWorld(alpha: 0, beta: 90, gamma: 0)
    #expect(sameRotation(device * rz(0), simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)))
  }

  @Test("upright, facing ARKit −Z, in every UI orientation", arguments: InterfaceOrientation.allCases)
  func uprightIsIdentity(_ o: InterfaceOrientation) {
    // Device attitude (W3C frame → world) of a phone held upright facing −Z in UI orientation `o`:
    // portrait = screen facing +Z with the top edge up; each UI rotation rolls the device about
    // the view axis the opposite way (landscape right = top edge pointing left).
    let device = rz(o.screenAngleDegrees * deg)
    let q = PoseMath.webCamera(arkit: arkitCamera(device: device), orientation: o)
    #expect(sameRotation(q, simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)))
    #expect(near(q.act(forward), forward))  // looks out of the back of the phone, along −Z
    #expect(near(q.act(up), up))  // screen up = world up
    #expect(near(q.act(right), right))  // screen right = world +X
  }

  @Test func landscapeRightNeedsNoRoll() {
    // Upright landscape, Home button on the right: ARKit's camera.transform is the identity.
    let q = PoseMath.webCamera(arkit: simd_quatd(ix: 0, iy: 0, iz: 0, r: 1), orientation: .landscapeRight)
    #expect(sameRotation(q, simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)))
  }

  @Test func portraitTurnedRightFacesPlusX() {
    let device = ry(-90 * deg)  // portrait, turned 90° to the right (clockwise from above)
    let q = PoseMath.webCamera(arkit: arkitCamera(device: device), orientation: .portrait)
    #expect(near(q.act(forward), [1, 0, 0]))
    #expect(near(q.act(up), up))
    #expect(near(PoseMath.yaw(of: q), -.pi / 2))
  }

  @Test func portraitTiltedDown30() {
    let device = rx(-30 * deg)  // top edge tipped away: the back camera looks at the floor
    let q = PoseMath.webCamera(arkit: arkitCamera(device: device), orientation: .portrait)
    #expect(near(q.act(forward), [0, -0.5, -0.75.squareRoot()]))
    #expect(near(q.act(up), [0, 0.75.squareRoot(), -0.5]))
    #expect(near(PoseMath.yaw(of: q), 0))
  }

  @Test("matches the web page's deviceorientation formula", arguments: InterfaceOrientation.allCases)
  func matchesWebFormula(_ o: InterfaceOrientation) {
    // The page computes q = Ry(ψ) · deviceToWorld(α, β, γ) · Rz(−screenAngle). For the same
    // physical attitude ARKit reports device · arkitCameraInDevice in a world that differs by an
    // unknown heading φ; after a Recentre onto the same target both must agree exactly.
    var rng = Lcg(state: 42)
    for _ in 0..<200 {
      let device = webDeviceToWorld(
        alpha: rng.range(0, 360), beta: rng.range(-170, 170), gamma: rng.range(-85, 85))
      let phi = rng.range(-.pi, .pi)
      let target = rng.range(-.pi, .pi)
      let arkit = ry(phi) * arkitCamera(device: device)
      var tracker = PoseTracker(anchorYaw: target)
      let pose = tracker.update(
        CameraSample(transform: transform(arkit), quality: .normal, timestamp: 0), orientation: o)
      let web = webTrackerQuaternion(device: device, screenAngle: o.screenAngleDegrees, target: target)
      #expect(sameRotation(pose.q, web, tol: 1e-5))
    }
  }

  @Test func uiRotationOnlyRolls() {
    // Same physical attitude, different UI orientation: same view direction and heading.
    let arkit = ry(0.4) * rx(-0.2) * arkitCameraInDevice
    let a = PoseMath.webCamera(arkit: arkit, orientation: .portrait)
    let b = PoseMath.webCamera(arkit: arkit, orientation: .landscapeLeft)
    #expect(near(a.act(forward), b.act(forward)))
    #expect(near(PoseMath.yaw(of: a), PoseMath.yaw(of: b)))
    #expect(!near(a.act(up), b.act(up), tol: 1e-3))
  }
}

@Suite("yaw / wrap (three.js parity)")
struct YawTests {
  @Test func yawOfPureYaw() {
    #expect(near(PoseMath.yaw(of: ry(0.7)), 0.7))
    #expect(near(PoseMath.yaw(of: ry(-2.5)), -2.5))
  }

  @Test func yawIgnoresPitchAndRoll() {
    #expect(near(PoseMath.yaw(of: ry(0.7) * rx(0.3) * rz(0.2)), 0.7, tol: 1e-12))
    #expect(near(PoseMath.yaw(of: ry(-1.2) * rx(-1.1) * rz(2.9)), -1.2, tol: 1e-12))
  }

  @Test func yawLookingStraightDownUsesTheGimbalBranch() {
    // three.js YXZ: |m23| ≥ 0.9999999 → y = atan2(−m31, m11), z = 0.
    #expect(near(PoseMath.yaw(of: ry(0.5) * rx(-.pi / 2)), 0.5, tol: 1e-6))
    #expect(near(PoseMath.yaw(of: ry(-0.5) * rx(.pi / 2)), -0.5, tol: 1e-6))
  }

  @Test func wrapMatchesJavaScript() {
    #expect(near(PoseMath.wrapAngle(0), 0))
    #expect(near(PoseMath.wrapAngle(.pi), .pi))
    #expect(near(PoseMath.wrapAngle(-.pi), .pi))  // (−π, π]
    #expect(near(PoseMath.wrapAngle(1.5 * .pi), -0.5 * .pi))
    #expect(near(PoseMath.wrapAngle(-7 * .pi / 2), .pi / 2))
  }

  @Test func recentreYawLandsOnTarget() {
    let q = ry(2.8) * rx(0.4) * rz(-0.3)
    for target in [-3.0, -1, 0, 0.5, 3.1] {
      let psi = PoseMath.recentreYaw(current: q, target: target)
      #expect(near(PoseMath.wrapAngle(PoseMath.yaw(of: PoseMath.yawQuaternion(psi) * q) - target), 0, tol: 1e-9))
      #expect(abs(psi) <= .pi)
    }
  }

  @Test func arrayIsXYZWWithCanonicalSign() {
    let q = simd_quatd(ix: -0.1, iy: 0.2, iz: -0.3, r: -0.927_361_849_549_570_4)
    let a = PoseMath.array(q)
    #expect(a.count == 4)
    #expect(a[3] > 0)
    #expect(near(a[0], 0.1) && near(a[1], -0.2) && near(a[2], 0.3))
  }

  @Test func floatTransformsConvert() {
    let f = simd_float4x4(simd_quatf(angle: 0.3, axis: [0, 1, 0]))
    let d = PoseMath.double(f)
    #expect(near(PoseMath.yaw(of: PoseMath.rotation(of: d)), 0.3, tol: 1e-6))
  }
}

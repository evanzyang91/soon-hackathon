// ARKit camera → the web phone page's three.js camera convention (pure math, no ARKit).
//
// Frames (all right-handed, metres):
//
// - ARKit world (`worldAlignment = .gravity`): +Y up (against gravity); −Z is the direction the
//   back camera faced when the session started, projected onto the floor; origin = where the
//   device was then.
// - ARKit camera space (`ARCamera.transform`, camera → world): fixed to the device whatever the UI
//   orientation. +X runs along the long axis from the front camera toward the Home button (the
//   bottom edge), +Y is the device's right edge (in portrait), +Z points out of the screen, and
//   the camera looks along −Z. That is exactly the camera of a UI in
//   `UIInterfaceOrientation.landscapeRight` (Home button / bottom edge on the right).
// - Web phone camera (web/src/phone/sensors.ts): a three.js camera that looks along −Z out of
//   the back of the phone, +Y = up on the screen as the UI is drawn, +X = screen right. Identity =
//   phone upright in portrait facing heading 0. With `screen.orientation.angle` = a it is the
//   device frame rolled by Rz(−a): `q = deviceToWorld · Rz(−a)`.
// - Scene world (three.js, Y up, metres): ARKit's world up to a yaw and a translation, which
//   Recentre fixes (PoseTracker).
//
// ARKit camera = device frame · Rz(−90°) and web camera = device frame · Rz(−a), so
//
//     q_web = q_arkit · Rz(90° − a)        (a = screenAngleDegrees of the UI orientation)
//
// Landscape right (a = 90) needs no roll at all; portrait (a = 0) rolls +90°; landscape left
// (a = 270) rolls −180°. Rolling about the view axis never changes the heading, so a UI rotation
// does not need a Recentre.
import simd

/// The UI orientation the web view is drawn in (`UIInterfaceOrientation` semantics: landscapeRight
/// = Home button / bottom edge on the right).
public enum InterfaceOrientation: String, Sendable, Codable, CaseIterable {
  case portrait
  case portraitUpsideDown
  case landscapeLeft
  case landscapeRight

  /// What `screen.orientation.angle` reports in Safari for this orientation (degrees).
  public var screenAngleDegrees: Double {
    switch self {
    case .portrait: 0
    case .landscapeRight: 90
    case .portraitUpsideDown: 180
    case .landscapeLeft: 270
    }
  }

  public var isLandscape: Bool { self == .landscapeLeft || self == .landscapeRight }
}

public enum PoseMath {
  static let deg = Double.pi / 180
  static let xAxis = SIMD3<Double>(1, 0, 0)
  static let yAxis = SIMD3<Double>(0, 1, 0)
  static let zAxis = SIMD3<Double>(0, 0, 1)

  /// `ARCamera.transform` (Float) in double precision.
  public static func double(_ m: simd_float4x4) -> simd_double4x4 {
    simd_double4x4(columns: (
      SIMD4<Double>(m.columns.0), SIMD4<Double>(m.columns.1),
      SIMD4<Double>(m.columns.2), SIMD4<Double>(m.columns.3)
    ))
  }

  /// Rotation part of a rigid transform (camera → world) as a unit quaternion.
  public static func rotation(of transform: simd_double4x4) -> simd_quatd {
    let c = transform.columns
    let m = simd_double3x3(columns: (
      SIMD3(c.0.x, c.0.y, c.0.z), SIMD3(c.1.x, c.1.y, c.1.z), SIMD3(c.2.x, c.2.y, c.2.z)
    ))
    return simd_quatd(m).normalized
  }

  /// Translation part of a rigid transform: the camera's position in the ARKit world.
  public static func position(of transform: simd_double4x4) -> SIMD3<Double> {
    let t = transform.columns.3
    return SIMD3(t.x, t.y, t.z)
  }

  /// Roll about the view axis from ARKit's camera frame to the web camera frame for `orientation`.
  public static func screenRoll(_ orientation: InterfaceOrientation) -> simd_quatd {
    simd_quatd(angle: (90 - orientation.screenAngleDegrees) * deg, axis: zAxis)
  }

  /// The web page's camera quaternion (before Recentre) for an ARKit camera rotation.
  public static func webCamera(arkit: simd_quatd, orientation: InterfaceOrientation) -> simd_quatd {
    (arkit * screenRoll(orientation)).normalized
  }

  /// Heading of a camera quaternion: three.js `Euler.setFromQuaternion(q, 'YXZ').y`, i.e. the
  /// rotation about +Y of the view direction (−Z); 0 = facing −Z, counter-clockwise from above
  /// positive. Matches `yawOf` in web/src/phone/sensors.ts, including the gimbal-lock branch.
  public static func yaw(of q: simd_quatd) -> Double {
    let x = q.imag.x, y = q.imag.y, z = q.imag.z, w = q.real
    let m23 = 2 * (y * z - x * w)
    if abs(m23) < 0.9999999 {
      return atan2(2 * (x * z + y * w), 1 - 2 * (x * x + y * y))  // atan2(m13, m33)
    }
    return atan2(-2 * (x * z - y * w), 1 - 2 * (y * y + z * z))  // atan2(−m31, m11)
  }

  /// Wrap into (−π, π] exactly like `wrapAngle` in sensors.ts.
  public static func wrapAngle(_ a: Double) -> Double {
    let t = (a + .pi).truncatingRemainder(dividingBy: 2 * .pi)
    return (t <= 0 ? t + 2 * .pi : t) - .pi
  }

  /// Rotation about +Y (world up) by `yaw` radians.
  public static func yawQuaternion(_ yaw: Double) -> simd_quatd {
    simd_quatd(angle: yaw, axis: yAxis)
  }

  /// Yaw to pre-multiply so that `q`'s heading becomes `targetYaw` (sensors.ts `recenterOffset`).
  public static func recentreYaw(current q: simd_quatd, target targetYaw: Double) -> Double {
    wrapAngle(targetYaw - yaw(of: q))
  }

  /// Angle (degrees) of the rotation between two orientations (0 = identical, sign-agnostic).
  public static func angleDegrees(_ a: simd_quatd, _ b: simd_quatd) -> Double {
    let d = min(1, abs(simd_dot(a.normalized.vector, b.normalized.vector)))
    return 2 * acos(d) / deg
  }

  /// Canonical sign (w ≥ 0) so equal rotations always serialise the same way.
  public static func canonical(_ q: simd_quatd) -> simd_quatd {
    q.real < 0 ? simd_quatd(vector: -q.vector) : q
  }

  /// `[x, y, z, w]`, the order three.js and shared/schema.ts `Quat` use.
  public static func array(_ q: simd_quatd) -> [Double] {
    let c = canonical(q)
    return [c.imag.x, c.imag.y, c.imag.z, c.real]
  }

  /// A `[x, y, z, w]` quaternion from the protocol (normalised; identity if degenerate).
  public static func quaternion(_ xyzw: [Double]) -> simd_quatd {
    guard xyzw.count == 4 else { return simd_quatd(ix: 0, iy: 0, iz: 0, r: 1) }
    let q = simd_quatd(ix: xyzw[0], iy: xyzw[1], iz: xyzw[2], r: xyzw[3])
    return q.length > 1e-9 ? q.normalized : simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)
  }
}

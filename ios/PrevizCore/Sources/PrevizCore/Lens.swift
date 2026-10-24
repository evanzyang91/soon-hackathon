// Real lens → three.js vertical field of view for the phone's viewport (pure math).
//
// ARKit's `ARCamera.intrinsics` K = [[fx, 0, ox], [0, fy, oy], [0, 0, 1]] is in pixels of
// `ARCamera.imageResolution`, which is always in the sensor's native landscape orientation
// (width > height). Full-frame half angles: tan(h/2) = (W/2)/fx along the long axis and
// tan(v/2) = (H/2)/fy along the short axis; landscape vertical FOV = 2·atan(H / (2·fy)).
//
// The web view fills the screen, whose aspect is not the sensor's 4:3, so we report the FOV of the
// camera image *aspect-filled* into the viewport (what ARSCNView / ARKit's
// `projectionMatrix(for:viewportSize:zNear:zFar:)` show): the image is scaled until it covers the
// view and the overflow is cropped. With A = view width / height and the image's half-angle
// tangents along the view's horizontal (tH) and vertical (tV) axes:
//
//     tan(vfov/2) = min(tV, tH / A)
//
// e.g. iPhone wide camera (1920×1440, fx ≈ fy ≈ 1450 px): landscape 19.5:9 → ~34° vertical
// (horizontal = the full 67° of the sensor's long axis), portrait 9:19.5 → ~67°.
import Foundation

public struct CameraIntrinsics: Sendable, Equatable {
  public var fx: Double
  public var fy: Double
  /// `ARCamera.imageResolution` (native sensor orientation, landscape).
  public var imageWidth: Double
  public var imageHeight: Double

  public init(fx: Double, fy: Double, imageWidth: Double, imageHeight: Double) {
    self.fx = fx
    self.fy = fy
    self.imageWidth = imageWidth
    self.imageHeight = imageHeight
  }

  var isUsable: Bool {
    fx > 0 && fy > 0 && imageWidth > 0 && imageHeight > 0 && fx.isFinite && fy.isFinite
  }
}

public enum Lens {
  static let deg = Double.pi / 180

  /// Vertical FOV (degrees) of the full camera image held in landscape: 2·atan(H / 2fy).
  public static func landscapeVerticalFovDegrees(_ k: CameraIntrinsics) -> Double {
    2 * atan(k.imageHeight / 2 / k.fy) / deg
  }

  /// three.js `PerspectiveCamera.fov` (vertical, degrees) of the real lens as it would fill a
  /// viewport of aspect `viewAspect` (width / height) drawn in `orientation`.
  public static func verticalFovDegrees(
    _ k: CameraIntrinsics, orientation: InterfaceOrientation, viewAspect: Double
  ) -> Double {
    guard k.isUsable else { return 60 }
    let tLong = k.imageWidth / 2 / k.fx
    let tShort = k.imageHeight / 2 / k.fy
    let (tH, tV) = orientation.isLandscape ? (tLong, tShort) : (tShort, tLong)
    let a = viewAspect.isFinite && viewAspect > 0 ? viewAspect : tH / tV
    return 2 * atan(min(tV, tH / a)) / deg
  }

  /// Vertical FOV (degrees) from a perspective projection matrix (`P[1][1] = 1 / tan(vfov/2)`),
  /// e.g. ARKit's `projectionMatrix(for:viewportSize:zNear:zFar:)` — used as an on-device check.
  public static func verticalFovDegrees(projectionYScale: Double) -> Double {
    2 * atan(1 / projectionYScale) / deg
  }
}

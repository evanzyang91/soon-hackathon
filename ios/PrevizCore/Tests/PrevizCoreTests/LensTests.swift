import Foundation
import Testing

@testable import PrevizCore

/// Roughly an iPhone wide camera as ARKit reports it (1920×1440, ~26 mm equivalent).
private let wide = CameraIntrinsics(fx: 1450, fy: 1450, imageWidth: 1920, imageHeight: 1440)
private func fov(_ halfTan: Double) -> Double { 2 * atan(halfTan) * 180 / .pi }

@Suite("Lens: intrinsics → vertical FOV")
struct LensTests {
  @Test func landscapeFullFrameIsTwoAtanHalfHeightOverFy() {
    #expect(near(Lens.landscapeVerticalFovDegrees(wide), fov(720.0 / 1450), tol: 1e-12))
    #expect(near(Lens.landscapeVerticalFovDegrees(wide), 52.81, tol: 0.01))
  }

  @Test func landscapeAtTheSensorAspectShowsTheFullFrame() {
    let v = Lens.verticalFovDegrees(wide, orientation: .landscapeRight, viewAspect: 4.0 / 3)
    #expect(near(v, Lens.landscapeVerticalFovDegrees(wide), tol: 1e-9))
  }

  @Test func wideLandscapeScreenCropsTopAndBottom() {
    // 19.5:9 landscape: the full sensor width fills the screen width, so hFOV = sensor long axis.
    let a = 852.0 / 393
    let v = Lens.verticalFovDegrees(wide, orientation: .landscapeLeft, viewAspect: a)
    #expect(near(v, fov(960.0 / 1450 / a), tol: 1e-9))
    #expect(near(v, 33.9, tol: 0.1))
    let hfov = fov(tan(v / 2 * .pi / 180) * a)
    #expect(near(hfov, fov(960.0 / 1450), tol: 1e-9))  // 67.0°
  }

  @Test func tallPortraitScreenShowsTheSensorsLongAxisVertically() {
    let v = Lens.verticalFovDegrees(wide, orientation: .portrait, viewAspect: 393.0 / 852)
    #expect(near(v, fov(960.0 / 1450), tol: 1e-9))
    #expect(near(v, 67.0, tol: 0.1))
  }

  @Test func squarePortraitViewCropsTheLongAxis() {
    // A view wider (1:1) than the portrait image (3:4) fits the image's short axis to the width.
    let v = Lens.verticalFovDegrees(wide, orientation: .portraitUpsideDown, viewAspect: 1)
    #expect(near(v, fov(720.0 / 1450), tol: 1e-9))
  }

  @Test func degenerateInputsStaySane() {
    let bad = CameraIntrinsics(fx: 0, fy: 0, imageWidth: 0, imageHeight: 0)
    #expect(Lens.verticalFovDegrees(bad, orientation: .portrait, viewAspect: 0.5) == 60)
    let v = Lens.verticalFovDegrees(wide, orientation: .landscapeRight, viewAspect: .nan)
    #expect(near(v, Lens.landscapeVerticalFovDegrees(wide), tol: 1e-9))
  }

  @Test func projectionMatrixCheck() {
    // P[1][1] of a perspective projection = 1 / tan(vfov / 2)
    #expect(near(Lens.verticalFovDegrees(projectionYScale: 1 / tan(25 * Double.pi / 180)), 50, tol: 1e-9))
  }
}

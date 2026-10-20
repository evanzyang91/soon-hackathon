// ARSession → per-frame camera samples (pose math lives in PrevizCore). No camera passthrough
// is drawn: the session runs headless behind the web view, which renders the virtual scene.
import ARKit
import PrevizCore
import UIKit
import os

private let log = Logger(subsystem: "dev.previz.camera", category: "ar")

/// What one ARFrame contributes (no ARFrame is retained past the delegate call).
struct FrameData {
  var sample: CameraSample
  var intrinsics: CameraIntrinsics
  var orientation: InterfaceOrientation
  /// Every 30th frame: PrevizCore vs ARKit's own oriented matrices (see DebugSnapshot.Check).
  var check: DebugSnapshot.Check?
}

@MainActor
final class ARTracker: NSObject, ARSessionDelegate {
  let session = ARSession()
  var onFrame: ((FrameData) -> Void)?
  var onError: ((String) -> Void)?
  /// Frames stopped (another app took the camera, Split View, …) or resumed.
  var onInterrupted: ((Bool) -> Void)?
  /// UI orientation the web view is drawn in, and its size in points (main actor).
  var orientation: () -> UIInterfaceOrientation = { .portrait }
  var viewportSize: () -> CGSize = { .zero }
  private var frameCount = 0
  private var lastOrientation = InterfaceOrientation.portrait

  static var isSupported: Bool { ARWorldTrackingConfiguration.isSupported }

  func start() {
    let config = ARWorldTrackingConfiguration()
    config.worldAlignment = .gravity  // +Y up, −Z = initial heading (the default, stated for clarity)
    config.planeDetection = []
    config.isLightEstimationEnabled = false
    session.delegate = self  // delegateQueue nil = main queue
    session.run(config, options: [.resetTracking, .removeExistingAnchors])
    log.info("AR session started")
  }

  func pause() {
    session.pause()
  }

  // MARK: - ARSessionDelegate (called on the main queue: delegateQueue is nil)

  nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
    MainActor.assumeIsolated { handle(frame) }
  }

  nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
    let message: String
    if let ar = error as? ARError, ar.code == .cameraUnauthorized {
      message = "Camera access is off. Settings → Previz Camera → Camera, then reopen."
    } else {
      message = "Tracking failed: \(error.localizedDescription)"
    }
    MainActor.assumeIsolated { onError?(message) }
  }

  nonisolated func sessionWasInterrupted(_ session: ARSession) {
    MainActor.assumeIsolated { onInterrupted?(true) }
  }

  nonisolated func sessionInterruptionEnded(_ session: ARSession) {
    MainActor.assumeIsolated { onInterrupted?(false) }
  }

  /// Keep the world (and the Recentre) across interruptions: ARKit relocalizes against the map
  /// it had, reporting `.limited(.relocalizing)` meanwhile (we hold the last good pose).
  nonisolated func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { true }

  // MARK: -

  private func handle(_ frame: ARFrame) {
    let camera = frame.camera
    let ui = orientation()
    if let o = InterfaceOrientation(ui) { lastOrientation = o }
    let k = camera.intrinsics  // column-major: columns.0.x = fx, columns.1.y = fy
    let sample = CameraSample(
      transform: PoseMath.double(camera.transform), quality: TrackingQuality(camera.trackingState),
      timestamp: frame.timestamp)
    let intrinsics = CameraIntrinsics(
      fx: Double(k.columns.0.x), fy: Double(k.columns.1.y),
      imageWidth: Double(camera.imageResolution.width), imageHeight: Double(camera.imageResolution.height))
    frameCount += 1
    var check: DebugSnapshot.Check?
    let size = viewportSize()
    if frameCount % 30 == 0, sample.quality.isGood, ui != .unknown, size.width > 0, size.height > 0 {
      check = crossCheck(camera, ui: ui, size: size, sample: sample, intrinsics: intrinsics)
    }
    onFrame?(FrameData(sample: sample, intrinsics: intrinsics, orientation: lastOrientation, check: check))
  }

  /// PrevizCore's oriented camera and lens against ARKit's `viewMatrix(for:)` and
  /// `projectionMatrix(for:viewportSize:zNear:zFar:)` for the same UI orientation and viewport.
  private func crossCheck(
    _ camera: ARCamera, ui: UIInterfaceOrientation, size: CGSize, sample: CameraSample,
    intrinsics: CameraIntrinsics
  ) -> DebugSnapshot.Check {
    var check = DebugSnapshot.Check()
    let reference = PoseMath.rotation(of: PoseMath.double(camera.viewMatrix(for: ui)).inverse)
    let ours = PoseMath.webCamera(arkit: PoseMath.rotation(of: sample.transform), orientation: lastOrientation)
    check.rotationErrorDeg = PoseMath.angleDegrees(reference, ours)
    let projection = camera.projectionMatrix(for: ui, viewportSize: size, zNear: 0.05, zFar: 500)
    let theirs = Lens.verticalFovDegrees(projectionYScale: Double(projection.columns.1.y))
    let mine = Lens.verticalFovDegrees(
      intrinsics, orientation: lastOrientation, viewAspect: Double(size.width / size.height))
    check.fovErrorDeg = mine - theirs
    return check
  }
}

extension TrackingQuality {
  init(_ state: ARCamera.TrackingState) {
    switch state {
    case .normal: self = .normal
    case .notAvailable: self = .notAvailable
    case .limited(let reason):
      switch reason {
      case .initializing: self = .initializing
      case .relocalizing: self = .relocalizing
      case .excessiveMotion: self = .excessiveMotion
      case .insufficientFeatures: self = .insufficientFeatures
      @unknown default: self = .insufficientFeatures
      }
    }
  }
}

extension InterfaceOrientation {
  init?(_ o: UIInterfaceOrientation) {
    switch o {
    case .portrait: self = .portrait
    case .portraitUpsideDown: self = .portraitUpsideDown
    case .landscapeLeft: self = .landscapeLeft
    case .landscapeRight: self = .landscapeRight
    case .unknown: return nil
    @unknown default: return nil
    }
  }
}

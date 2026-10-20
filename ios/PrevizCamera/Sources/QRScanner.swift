// Scan the laptop's pairing QR (AVFoundation metadata output: every ARKit-capable iPhone, unlike
// VisionKit's DataScannerViewController, which needs A12+). Runs only on the join screen, before
// the AR session takes the camera.
// AVCaptureSession is documented thread-safe for start/stopRunning on a private queue.
@preconcurrency import AVFoundation
import SwiftUI
import UIKit

struct QRScannerView: UIViewControllerRepresentable {
  var onCode: (String) -> Void
  var onFailure: (String) -> Void

  func makeUIViewController(context: Context) -> QRScannerController {
    let c = QRScannerController()
    c.onCode = onCode
    c.onFailure = onFailure
    return c
  }

  func updateUIViewController(_ controller: QRScannerController, context: Context) {}
}

final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var onCode: ((String) -> Void)?
  var onFailure: ((String) -> Void)?
  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "dev.previz.camera.qr")
  private var preview: AVCaptureVideoPreviewLayer?
  private var delivered = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      configure()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        Task { @MainActor [weak self] in
          if granted { self?.configure() } else { self?.onFailure?("Camera access was denied.") }
        }
      }
    default:
      onFailure?("Camera access is off. Settings → Previz Camera → Camera.")
    }
  }

  private func configure() {
    guard let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input)
    else {
      onFailure?("No camera available for scanning.")
      return
    }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else {
      onFailure?("This camera cannot scan QR codes.")
      return
    }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    view.layer.addSublayer(layer)
    preview = layer
    view.setNeedsLayout()
    let session = self.session
    sessionQueue.async { session.startRunning() }  // blocking call: never on the main thread
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
    // Back camera: 0° = landscape right; keep the preview upright for the current UI orientation.
    if let connection = preview?.connection, let scene = view.window?.windowScene {
      let angle: CGFloat =
        switch scene.effectiveGeometry.interfaceOrientation {
        case .landscapeRight: 0
        case .portraitUpsideDown: 270
        case .landscapeLeft: 180
        default: 90
        }
      if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    let session = self.session
    sessionQueue.async { session.stopRunning() }
  }

  nonisolated func metadataOutput(
    _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    // Delivered on the main queue (setMetadataObjectsDelegate(_:queue: .main)).
    let text = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }.first
    guard let text else { return }
    MainActor.assumeIsolated {
      guard !delivered else { return }
      delivered = true
      UINotificationFeedbackGenerator().notificationOccurred(.success)
      onCode?(text)
    }
  }
}

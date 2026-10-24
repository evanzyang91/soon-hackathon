// Records the room scan's camera feed (ARFrame.capturedImage) to an H.264 .mp4 for the laptop to
// turn into a Marble world of the real room (server/pipeline/room-world.ts). At most 30 s, 30 fps
// and well under Marble's 100 MB video limit.
import AVFoundation
import CoreVideo
import os

private let log = Logger(subsystem: "dev.previz.camera", category: "scan")

@MainActor
final class ScanRecorder {
  static let maxSeconds = 30.0
  static let maxBytes = 95 * 1024 * 1024
  private static let minFrameInterval = 1.0 / 30

  let url: URL
  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  private var firstTime: Double?
  private var lastTime = -Double.infinity
  private(set) var frames = 0
  private(set) var failed: String?

  init() {
    url = FileManager.default.temporaryDirectory.appendingPathComponent("room-scan-\(UUID().uuidString).mp4")
  }

  /// Seconds recorded so far.
  var seconds: Double { firstTime.map { lastTime - $0 } ?? 0 }
  /// True once the 30 s budget is used (further frames are ignored).
  var full: Bool { seconds >= Self.maxSeconds }

  /// Appends one camera image (ARFrame timestamp, seconds). Returns true when it was the first.
  @discardableResult
  func append(_ image: CVPixelBuffer, at time: Double, portrait: Bool) -> Bool {
    guard failed == nil, !full, time - lastTime >= Self.minFrameInterval * 0.9 else { return false }
    if writer == nil, !start(image, portrait: portrait) { return false }
    guard let input, let adaptor, input.isReadyForMoreMediaData else { return false }
    let first = firstTime == nil
    if first { firstTime = time }
    let pts = CMTime(seconds: time - (firstTime ?? time), preferredTimescale: 600)
    if adaptor.append(image, withPresentationTime: pts) {
      lastTime = time
      frames += 1
    } else {
      failed = writer?.error?.localizedDescription ?? "append failed"
    }
    return first
  }

  private func start(_ image: CVPixelBuffer, portrait: Bool) -> Bool {
    let w = CVPixelBufferGetWidth(image)
    let h = CVPixelBufferGetHeight(image)
    do {
      let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
      let input = AVAssetWriterInput(
        mediaType: .video,
        outputSettings: [
          AVVideoCodecKey: AVVideoCodecType.h264,
          AVVideoWidthKey: w,
          AVVideoHeightKey: h,
          // ~8 Mbit/s: 30 s ≈ 30 MB, far under Marble's 100 MB
          AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000, AVVideoMaxKeyFrameIntervalKey: 30],
        ])
      input.expectsMediaDataInRealTime = true
      // capturedImage is in the sensor's landscape orientation; tag portrait holds upright
      if portrait { input.transform = CGAffineTransform(rotationAngle: .pi / 2) }
      let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: CVPixelBufferGetPixelFormatType(image)])
      guard writer.canAdd(input) else { throw NSError(domain: "scan", code: 1) }
      writer.add(input)
      guard writer.startWriting() else { throw writer.error ?? NSError(domain: "scan", code: 2) }
      writer.startSession(atSourceTime: .zero)
      self.writer = writer
      self.input = input
      self.adaptor = adaptor
      log.info("scan video \(w)x\(h) → \(self.url.lastPathComponent, privacy: .public)")
      return true
    } catch {
      failed = "can't record the scan video: \(error.localizedDescription)"
      return false
    }
  }

  /// Finishes the file: (seconds, bytes), or nil when nothing usable was recorded.
  func finish() async -> (seconds: Double, bytes: Int)? {
    guard let writer, let input, frames > 1 else {
      self.writer?.cancelWriting()
      return nil
    }
    input.markAsFinished()
    await writer.finishWriting()
    guard writer.status == .completed else {
      failed = writer.error?.localizedDescription ?? "the scan video did not finish"
      return nil
    }
    let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    guard bytes > 0, bytes <= Self.maxBytes else {
      failed = "the scan video is \(bytes / 1_000_000) MB; Marble takes ≤ 100 MB"
      return nil
    }
    return (seconds, bytes)
  }
}

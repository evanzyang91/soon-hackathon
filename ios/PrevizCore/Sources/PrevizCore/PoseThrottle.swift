// Pose stream rate limiter: port of web/src/phone/throttle.ts (same numbers, same key).
// At most `hz` sends per second; an unchanged pose is resent only as a keepalive every
// `keepaliveMs`, which is what the laptop uses to tell a live phone (it hands the gizmo over to
// another phone after 1 s of silence) and what keeps the relay's idle timer happy.
import Foundation

public struct PoseThrottle: Sendable {
  private var last = -Double.infinity
  private var lastKey = ""
  public let minGapMs: Double
  public let keepaliveMs: Double

  public init(hz: Double = 30, keepaliveMs: Double = 250) {
    // 2 ms tolerance so a 60 Hz ARFrame stream (16.7 ms) reliably yields every other frame.
    minGapMs = 1000 / hz - 2
    self.keepaliveMs = keepaliveMs
  }

  /// `now` in ms. Returns true (and records the send) when this pose should go out.
  public mutating func shouldSend(now: Double, key: String) -> Bool {
    let gap = now - last
    if gap < minGapMs { return false }
    if key == lastKey && gap < keepaliveMs { return false }
    last = now
    lastKey = key
    return true
  }

  /// Compact change key: ~0.001 rad / 1 mm / 0.1° / 0.01 aspect, as throttle.ts `poseKey`.
  public static func key(_ p: PhonePose) -> String {
    // JavaScript Math.round: halves go up (−1.5 → −1), unlike Swift's .rounded().
    func r(_ v: Double, _ s: Double) -> String {
      let x = (v * s + 0.5).rounded(.down)
      return x.isFinite ? String(Int(x)) : "nan"
    }
    let q = p.q.map { r($0, 2000) }.joined(separator: ",")
    let n = p.nudge.map { r($0, 1000) }.joined(separator: ",")
    let o = (p.offset ?? [0, 0, 0]).map { r($0, 1000) }.joined(separator: ",")
    return "\(q)|\(n)|\(o)|\(r(p.fovDeg, 10))|\(r(p.aspect ?? 0, 100))|\(p.recording ? 1 : 0)"
  }
}

/// Reconnect delays: 0.5 s, 1 s, 2 s, 4 s, then 5 s (relay-client.ts `scheduleReconnect`).
public enum Backoff {
  public static func delay(attempt: Int) -> Double {
    min(5, 0.5 * pow(2, Double(max(0, min(attempt, 16)))))
  }
}

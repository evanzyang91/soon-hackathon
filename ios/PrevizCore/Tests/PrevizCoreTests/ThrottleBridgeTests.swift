import Foundation
import Testing

@testable import PrevizCore

private func pose(_ yaw: Double, recording: Bool = false) -> PhonePose {
  PhonePose(t: 0, q: [0, sin(yaw / 2), 0, cos(yaw / 2)], offset: [0, 0, 0], fovDeg: 50, aspect: 2, recording: recording)
}

@Suite("Pose throttle (throttle.ts parity)")
struct ThrottleTests {
  @Test func sixtyHertzFramesGoOutAtThirty() {
    var th = PoseThrottle()
    var sent = 0
    for i in 0..<60 where th.shouldSend(now: Double(i) * 1000 / 60, key: PoseThrottle.key(pose(Double(i) * 0.01))) {
      sent += 1
    }
    #expect(sent == 30)
  }

  @Test func stillPhoneKeepalivesEvery250ms() {
    var th = PoseThrottle()
    let key = PoseThrottle.key(pose(0))
    var times: [Double] = []
    for i in 0..<60 {
      let now = Double(i) * 1000 / 60
      if th.shouldSend(now: now, key: key) { times.append(now) }
    }
    #expect(times.count == 4)  // 0, 250, 500, 750
    #expect(times.first == 0)
  }

  @Test func keyMatchesThrottleTs() {
    // poseKey({ q: [0, 0.1, 0, 0.995], nudge: [0,0,0], offset: [0.0015, 0, -1], fovDeg: 33.94,
    //           aspect: 2.168, recording: true }) in web/src/phone/throttle.ts
    let p = PhonePose(t: 0, q: [0, 0.1, 0, 0.995], offset: [0.0015, 0, -1], fovDeg: 33.94, aspect: 2.168, recording: true)
    #expect(PoseThrottle.key(p) == "0,200,0,1990|0,0,0|2,0,-1000|339|217|1")
  }

  @Test func backoff() {
    #expect((0..<6).map { Backoff.delay(attempt: $0) } == [0.5, 1, 2, 4, 5, 5])
    #expect(Backoff.delay(attempt: 1000) == 5)
  }
}

@Suite("Web bridge")
struct WebBridgeTests {
  @Test func poseScript() throws {
    let s = try WebBridge.poseScript(pose(0))
    #expect(s.hasPrefix("window.__previzPose&&window.__previzPose({"))
    #expect(s.hasSuffix("});0"))
  }

  @Test func messageScriptOnlyCarriesJSONObjects() throws {
    let s = try WebBridge.messageScript(relayText: #"{"type":"peers","laptop":true,"phones":1}"#)
    #expect(s.hasPrefix("window.__previzMessage&&window.__previzMessage({"))
    #expect(throws: (any Error).self) { try WebBridge.messageScript(relayText: "alert(1)") }
    #expect(throws: (any Error).self) { try WebBridge.messageScript(relayText: "[1,2]") }
    #expect(throws: (any Error).self) { try WebBridge.messageScript(relayText: #"{"a":1});alert(1);({"#) }
  }

  @Test func debugScript() throws {
    var snap = DebugSnapshot()
    snap.trackingState = TrackingQuality.excessiveMotion.debugName
    let s = try WebBridge.debugScript(snap)
    #expect(s.hasPrefix("window.__previzNative={"))
    #expect(s.contains(#""trackingState":"limited:excessiveMotion""#))
  }

  @Test func pageMessages() {
    #expect(PageMessage.parse(["type": "ready"]) == .ready)
    #expect(PageMessage.parse(["type": "cmd", "cmd": "shutter"]) == .cmd(.shutter))
    #expect(PageMessage.parse(["type": "cmd", "cmd": "nope"]) == nil)
    #expect(PageMessage.parse(["type": "log", "message": "hi"]) == .log("hi"))
    #expect(PageMessage.parse("ready") == nil)
  }
}

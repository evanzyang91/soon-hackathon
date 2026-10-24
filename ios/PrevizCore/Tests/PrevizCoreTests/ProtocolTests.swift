import Foundation
import Testing
import simd

@testable import PrevizCore

@Suite("Relay protocol (shared/protocol.ts mirror)")
struct ProtocolTests {
  @Test func poseEncodesExactly() throws {
    let pose = PhonePose(
      t: 1234.5, q: [0, 0.5, 0, 0.8660254], offset: [0.1, 0, -0.25], fovDeg: 33.9, aspect: 2.168,
      recording: true)
    #expect(
      try Wire.encode(pose)
        == #"{"aspect":2.168,"fovDeg":33.9,"nudge":[0,0,0],"offset":[0.1,0,-0.25],"q":[0,0.5,0,0.8660254],"recording":true,"source":"arkit","t":1234.5,"type":"pose"}"#
    )
  }

  @Test func poseFromTrackedPoseRoundsForTheWire() throws {
    let tracked = TrackedPose(
      q: simd_quatd(ix: 0, iy: -sin(0.35), iz: 0, r: -cos(0.35)), offset: [1e-7, -0.123456789, 2],
      held: false)
    let pose = PhonePose(t: 16.6666666, pose: tracked, fovDeg: 52.80912, aspect: 2.16793, recording: false)
    #expect(pose.q == [0, 0.342898, 0, 0.939373])  // canonical sign (w > 0), 1e-6
    #expect(pose.offset == [0, -0.12346, 2])  // 0.01 mm; no "-0"
    #expect(pose.fovDeg == 52.809)
    #expect(pose.aspect == 2.168)
    #expect(pose.t == 16.7)
    #expect(pose.nudge == [0, 0, 0])
    #expect(pose.source == "arkit")
    #expect(!(try Wire.encode(pose)).contains("-0,"))
  }

  @Test func nonFinitePosesAreFlagged() {
    var pose = PhonePose(t: 1, q: [0, 0, 0, 1], offset: [0, 0, 0], fovDeg: 50, aspect: 1, recording: false)
    #expect(pose.isFinite)
    pose.offset = [.nan, 0, 0]
    #expect(!pose.isFinite)
  }

  @Test func helloAndCommands() throws {
    #expect(try Wire.encode(Hello(room: "ABCD")) == #"{"role":"phone","room":"ABCD","type":"hello"}"#)
    #expect(try Wire.encode(PhoneCommand(.playScene)) == #"{"cmd":"play-scene","type":"cmd"}"#)
    #expect(CommandName.allCases.map(\.rawValue) == [
      "recenter", "shutter", "record-start", "record-stop", "next-camera", "play-scene", "next-line",
    ])
  }

  @Test func decodesServerMessages() throws {
    #expect(try ServerMessage.decode(#"{"type":"peers","laptop":true,"phones":1}"#) == .peers(Peers(laptop: true, phones: 1)))
    #expect(try ServerMessage.decode(#"{"type":"cmd","cmd":"recenter"}"#) == .cmd(.recenter))
    #expect(try ServerMessage.decode(#"{"type":"pose","t":1,"q":[0,0,0,1],"nudge":[0,0,0],"fovDeg":50}"#) == .pose)
    #expect(try ServerMessage.decode(#"{"type":"future","x":1}"#) == .unknown("future"))
    #expect(throws: (any Error).self) { try ServerMessage.decode("not json") }
    #expect(throws: (any Error).self) { try ServerMessage.decode(#"{"type":"cmd","cmd":"explode"}"#) }
  }

  @Test func decodesSceneStateIgnoringLook() throws {
    let text = #"""
      {"type":"scene","projectId":"p","sceneIndex":2,"manifestUrl":"/projects/p/scene-2/manifest.json",
       "time":3.5,"playing":false,"cameras":[{"id":"c1","name":"Cam 1","position":[0,1.6,0],
       "quaternion":[0,0.38268343,0,0.92387953],"fovDeg":40}],"activeCameraId":"c1",
       "speakingLineId":null,"look":{"exposure":1}}
      """#
    guard case .scene(let s) = try ServerMessage.decode(text) else {
      Issue.record("not a scene")
      return
    }
    #expect(s.sceneIndex == 2 && s.activeCamera?.name == "Cam 1" && s.speakingLineId == nil)
    #expect(s.editsRevision == nil)
    let anchor = anchorFor(scene: s, manifest: nil)
    #expect(anchor.key == "cam:c1")
    #expect(near(anchor.yaw, .pi / 4, tol: 1e-6))
  }

  @Test func anchorFallsBackToTheManifestThenTheDefault() throws {
    let manifest = try JSONDecoder().decode(
      ManifestStart.self,
      from: Data(#"""
        {"version":1,"projectId":"p","plan":{"index":4,"slug":"s"},"characters":[],
         "startCamera":{"position":[1,1.7,2],"quaternion":[0,-0.70710678,0,0.70710678],"fovDeg":45}}
        """#.utf8))
    let a = anchorFor(scene: nil, manifest: manifest)
    #expect(a.key == "start:p:4" && a.name == "Start camera")
    #expect(near(a.yaw, -.pi / 2, tol: 1e-6))
    #expect(anchorFor(scene: nil, manifest: nil) == .none)
  }
}

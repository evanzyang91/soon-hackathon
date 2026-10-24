import Foundation
import simd

@testable import PrevizCore

let deg = Double.pi / 180

func rx(_ a: Double) -> simd_quatd { simd_quatd(angle: a, axis: [1, 0, 0]) }
func ry(_ a: Double) -> simd_quatd { simd_quatd(angle: a, axis: [0, 1, 0]) }
func rz(_ a: Double) -> simd_quatd { simd_quatd(angle: a, axis: [0, 0, 1]) }

/// Same rotation (q and −q are equal) within `tol` degrees.
func sameRotation(_ a: simd_quatd, _ b: simd_quatd, tol: Double = 1e-6) -> Bool {
  PoseMath.angleDegrees(a, b) < tol
}

func near(_ a: SIMD3<Double>, _ b: SIMD3<Double>, tol: Double = 1e-9) -> Bool {
  simd_length(a - b) < tol
}

func near(_ a: Double, _ b: Double, tol: Double = 1e-9) -> Bool { abs(a - b) < tol }

/// A rigid camera → world transform from a rotation and a position.
func transform(_ q: simd_quatd, _ p: SIMD3<Double> = .zero) -> simd_double4x4 {
  var m = simd_double4x4(q)
  m.columns.3 = SIMD4(p.x, p.y, p.z, 1)
  return m
}

/// web/src/phone/sensors.ts `deviceToWorld`: Euler(β, α, −γ, 'YXZ') · Rx(−90°), i.e. the W3C
/// device frame (x = right edge, y = top edge, z = out of the screen) → three.js world.
func webDeviceToWorld(alpha: Double, beta: Double, gamma: Double) -> simd_quatd {
  ry(alpha * deg) * rx(beta * deg) * rz(-gamma * deg) * rx(-90 * deg)
}

/// What the web page's OrientationTracker outputs after `recenter(target)` on this sample.
func webTrackerQuaternion(device: simd_quatd, screenAngle: Double, target: Double) -> simd_quatd {
  let cam = device * rz(-screenAngle * deg)
  return PoseMath.yawQuaternion(PoseMath.recentreYaw(current: cam, target: target)) * cam
}

/// Deterministic pseudo-random numbers (tests must not flake).
struct Lcg {
  var state: UInt64
  mutating func next() -> Double {
    state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
    return Double(state >> 11) / Double(1 << 53)
  }
  mutating func range(_ lo: Double, _ hi: Double) -> Double { lo + (hi - lo) * next() }
}

let forward = SIMD3<Double>(0, 0, -1)
let up = SIMD3<Double>(0, 1, 0)
let right = SIMD3<Double>(1, 0, 0)

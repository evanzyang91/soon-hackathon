// DeviceOrientation → three.js camera quaternion (pure math, no DOM).
//
// W3C device frame: x = right edge, y = top edge, z = out of the screen. The earth frame
// (x East, y North, z Up) maps to three.js (x East, y Up, z South) by a −90° turn about X, so the
// device rotation R = Rz(α)·Rx'(β)·Ry''(γ) becomes Ry(α)·Rx(β)·Rz(−γ) — Euler(β, α, −γ, 'YXZ').
// Post-multiplying by Rx(−90°) maps device-frame vectors into the world (camera then looks out of
// the BACK of the phone along −Z), and Rz(−screenAngle) keeps the image upright when the UI is
// rotated (same derivation as three.js DeviceOrientationControls / WebXR polyfill).
import { Euler, Quaternion, Vector3 } from 'three';
import type { Quat, Vec3 } from '@shared/schema';

const DEG = Math.PI / 180;
const Q_BACK = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const Z = new Vector3(0, 0, 1);
const Y = new Vector3(0, 1, 0);

export interface OrientationSample {
  /** Degrees, as delivered by `deviceorientation`. */
  alpha: number;
  beta: number;
  gamma: number;
}

/** Quaternion that maps device-frame vectors (W3C axes) into the three.js world (no recenter). */
export function deviceToWorld(s: OrientationSample, out = new Quaternion()): Quaternion {
  const e = new Euler(s.beta * DEG, s.alpha * DEG, -s.gamma * DEG, 'YXZ');
  return out.setFromEuler(e).multiply(Q_BACK);
}

/** Camera quaternion (looks along −Z, out of the back of the phone) for a given screen angle. */
export function orientationToQuaternion(
  s: OrientationSample,
  screenAngleDeg: number,
  out = new Quaternion(),
): Quaternion {
  deviceToWorld(s, out);
  return out.multiply(new Quaternion().setFromAxisAngle(Z, -screenAngleDeg * DEG));
}

/** Heading (rotation about +Y) of a camera quaternion; 0 = facing −Z, CCW from above positive. */
export function yawOf(q: Quaternion | Quat): number {
  const qq = Array.isArray(q) ? new Quaternion(q[0], q[1], q[2], q[3]) : q;
  return new Euler().setFromQuaternion(qq, 'YXZ').y;
}

/** Wrap an angle into (−π, π]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t <= 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/** Offset to pre-multiply (as a yaw about +Y) so that `q`'s heading becomes `targetYaw`. */
export function recenterOffset(q: Quaternion, targetYaw: number): number {
  return wrapAngle(targetYaw - yawOf(q));
}

export function yawQuaternion(yaw: number, out = new Quaternion()): Quaternion {
  return out.setFromAxisAngle(Y, yaw);
}

export const toQuat = (q: Quaternion): Quat => [q.x, q.y, q.z, q.w];
export const toVec3 = (v: Vector3): Vec3 => [v.x, v.y, v.z];

/** Current screen orientation angle in degrees (0, 90, 180, 270), with old-iOS fallback. */
export function screenAngle(): number {
  if (typeof window === 'undefined') return 0;
  const a = window.screen?.orientation?.angle;
  if (typeof a === 'number') return a;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? (legacy + 360) % 360 : 0;
}

/**
 * Stateful orientation tracker: latest sensor sample + yaw re-centering. The output quaternion is
 * `yaw(offset) · deviceCamera`, i.e. the phone camera orientation in the scene's world frame.
 */
export class OrientationTracker {
  /** Camera orientation before recenter. */
  private readonly device = new Quaternion();
  /** Device frame (W3C axes) → world, before recenter. */
  private readonly frame = new Quaternion();
  private readonly cam = new Quaternion();
  private readonly frameOut = new Quaternion();
  private readonly offsetQ = new Quaternion();
  private offset = 0;
  /** true once any orientation sample (real or synthetic) has been applied. */
  hasSample = false;
  /** 'sensor' after a deviceorientation reading, 'manual' after drag input. */
  source: 'none' | 'sensor' | 'manual' = 'none';
  /** Recenter on the next sample (set at start, and when the active camera changes). */
  private pendingRecenter: number | null = null;

  /** Feed a `deviceorientation` reading. Returns false when the reading is unusable (nulls). */
  setSample(s: Partial<OrientationSample>, screenAngleDeg: number): boolean {
    if (!isFiniteNum(s.alpha) || !isFiniteNum(s.beta) || !isFiniteNum(s.gamma)) return false;
    deviceToWorld({ alpha: s.alpha, beta: s.beta, gamma: s.gamma }, this.frame);
    this.device
      .copy(this.frame)
      .multiply(new Quaternion().setFromAxisAngle(Z, -screenAngleDeg * DEG));
    return this.applied('sensor');
  }

  /** Feed an orientation from a non-sensor source (desktop drag, touch-drag fallback). */
  setCameraQuaternion(q: Quaternion): boolean {
    this.device.copy(q);
    this.frame.copy(q);
    return this.applied('manual');
  }

  /** Make the current heading map to `targetYaw` (now, or on the first sample if none yet). */
  recenter(targetYaw: number): void {
    if (!this.hasSample) {
      this.pendingRecenter = targetYaw;
      return;
    }
    this.offset = recenterOffset(this.device, targetYaw);
    yawQuaternion(this.offset, this.offsetQ);
    this.pendingRecenter = null;
  }

  /** Camera orientation in the world frame (after recenter). */
  get quaternion(): Quaternion {
    return this.cam.copy(this.offsetQ).multiply(this.device);
  }

  /** Device frame → world (after recenter); rotates devicemotion vectors into the world. */
  get deviceFrame(): Quaternion {
    return this.frameOut.copy(this.offsetQ).multiply(this.frame);
  }

  /** Orientation before recenter (what manual drag input should build on). */
  get rawQuaternion(): Quaternion {
    return this.device;
  }

  get yawOffset(): number {
    return this.offset;
  }

  private applied(source: 'sensor' | 'manual'): boolean {
    this.hasSample = true;
    this.source = source;
    if (this.pendingRecenter !== null) this.recenter(this.pendingRecenter);
    return true;
  }
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

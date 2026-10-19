// Joystick walk for the phone camera (pure math, no DOM).
//
// A browser has no positional tracking, so the left-thumb joystick walks the camera: stick y =
// forward / back and x = strafe, along the camera's current heading (yaw only, so walking stays
// level whatever the tilt). A dead zone plus a response curve gives fine control near the centre,
// and the velocity eases toward the stick's target so starts and stops are never instant. A
// separate rise input (the height slider) moves the camera up / down, clamped to ±maxRise.
//
// The result is `offset` (metres, world frame) relative to the attached camera; it goes out in
// every PhonePose and the phone's own view adds it too: position = anchor + offset + nudge.
import { Quaternion, Vector3 } from 'three';
import type { Quat, Vec3 } from '@shared/schema';

export interface WalkInput {
  /** Stick, -1..1 each (unit disk): x = strafe right, y = forward (stick pushed up). */
  x: number;
  y: number;
  /** Height rate, -1..1 (+ = up). */
  rise: number;
}

export const NO_WALK: WalkInput = { x: 0, y: 0, rise: 0 };

export interface WalkOptions {
  /** Top walking speed (m/s) at full stick. */
  maxSpeed?: number;
  /** Fraction of the stick radius that does nothing. */
  deadZone?: number;
  /** Response exponent past the dead zone (> 1 = finer control near the centre). */
  curve?: number;
  /** Top vertical speed (m/s) at full slider. */
  riseSpeed?: number;
  /** Height limit (m) above / below the attached camera. */
  maxRise?: number;
  /** Time constant (s) for speeding up toward the stick's target. */
  accelTau?: number;
  /** Time constant (s) for slowing down (stick released or pulled back). */
  stopTau?: number;
}

export interface RiseLimits {
  /** How far (m, ≥ 0) the camera may go below the attached camera. */
  down: number;
  /** How far (m, ≥ 0) it may go above. */
  up: number;
}

const FORWARD = new Vector3(0, 0, -1);
const UP = new Vector3(0, 1, 0);

/** Below this horizontal length of the view direction (≈ 72° up / down) the frame top blends in. */
const STEEP = 0.3;

/**
 * Heading (rad, rotation about +Y, 0 = facing −Z, CCW from above positive) that the camera walks
 * along: its view direction projected onto the floor, whatever the pitch and roll. Pointing almost
 * straight down (or up) the top edge of the frame takes over smoothly, so the heading never flips
 * or goes undefined.
 */
export function headingOf(q: Quaternion | Quat): number {
  const qq = Array.isArray(q) ? new Quaternion(q[0], q[1], q[2], q[3]) : q;
  const f = FORWARD.clone().applyQuaternion(qq);
  const u = UP.clone().applyQuaternion(qq);
  const w = Math.max(0, 1 - Math.hypot(f.x, f.z) / STEEP);
  // looking down, the top of the frame points the way you face; looking up, it points back
  const k = (f.y < 0 ? 1 : -1) * w * w;
  return Math.atan2(-(f.x + k * u.x), -(f.z + k * u.z));
}

/** Pointer displacement (px, screen y down) → stick vector in the unit disk (y up = forward). */
export function stickVector(dx: number, dy: number, radiusPx: number): { x: number; y: number } {
  const r = Math.max(1, radiusPx);
  let x = dx / r;
  let y = -dy / r;
  const m = Math.hypot(x, y);
  if (m > 1) {
    x /= m;
    y /= m;
  }
  return { x: x || 0, y: y || 0 };
}

/** Applies the dead zone + response curve to one magnitude in 0..1. */
export function shapeMagnitude(m: number, deadZone: number, curve: number): number {
  const a = Math.min(1, Math.max(0, m));
  if (a <= deadZone) return 0;
  return Math.pow((a - deadZone) / (1 - deadZone), curve);
}

export class Walker {
  readonly maxSpeed: number;
  readonly deadZone: number;
  readonly curve: number;
  readonly riseSpeed: number;
  readonly maxRise: number;
  readonly accelTau: number;
  readonly stopTau: number;
  private readonly pos = new Vector3();
  private readonly vel = new Vector3();

  constructor(opts: WalkOptions = {}) {
    this.maxSpeed = opts.maxSpeed ?? 1.5;
    this.deadZone = opts.deadZone ?? 0.12;
    this.curve = opts.curve ?? 1.6;
    this.riseSpeed = opts.riseSpeed ?? 0.5;
    this.maxRise = opts.maxRise ?? 2;
    this.accelTau = opts.accelTau ?? 0.2;
    this.stopTau = opts.stopTau ?? 0.12;
  }

  /** Target velocity (m/s, world frame) for a stick input at a given heading. */
  targetVelocity(input: WalkInput, heading: number): Vec3 {
    const x = Number.isFinite(input.x) ? input.x : 0;
    const y = Number.isFinite(input.y) ? input.y : 0;
    // keys can push (1, 1): anything outside the unit disk counts as full stick
    const raw = Math.hypot(x, y);
    const m = Math.min(1, raw);
    const speed = raw > 0 ? (this.maxSpeed * shapeMagnitude(m, this.deadZone, this.curve)) / raw : 0;
    // forward (heading ψ) = (−sin ψ, 0, −cos ψ); right = (cos ψ, 0, −sin ψ)
    const s = Math.sin(heading);
    const c = Math.cos(heading);
    const fwd = y * speed;
    const side = x * speed;
    const rise = Number.isFinite(input.rise) ? Math.max(-1, Math.min(1, input.rise)) : 0;
    const vr = this.riseSpeed * shapeMagnitude(Math.abs(rise), this.deadZone, 1) * Math.sign(rise);
    return [-s * fwd + c * side, vr, -c * fwd - s * side];
  }

  /**
   * Advance by `dt` seconds with the current stick / slider input and camera heading. `limits`
   * narrows the height range (e.g. keep the camera above the floor); both default to maxRise.
   */
  update(input: WalkInput, heading: number, dt: number, limits?: Partial<RiseLimits>): Vec3 {
    dt = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1);
    if (dt === 0) return this.offset;
    const [tx, ty, tz] = this.targetVelocity(input, heading);

    // horizontal: ease the velocity vector toward the target (faster when slowing down)
    const speedingUp = Math.hypot(tx, tz) >= Math.hypot(this.vel.x, this.vel.z);
    const kh = 1 - Math.exp(-dt / (speedingUp ? this.accelTau : this.stopTau));
    this.vel.x += (tx - this.vel.x) * kh;
    this.vel.z += (tz - this.vel.z) * kh;
    const kv = 1 - Math.exp(-dt / (Math.abs(ty) >= Math.abs(this.vel.y) ? this.accelTau : this.stopTau));
    this.vel.y += (ty - this.vel.y) * kv;
    // settle exactly at rest so a released stick stops sending new poses
    if (tx === 0 && tz === 0 && Math.hypot(this.vel.x, this.vel.z) < 1e-3) this.vel.x = this.vel.z = 0;
    if (ty === 0 && Math.abs(this.vel.y) < 1e-3) this.vel.y = 0;

    this.pos.addScaledVector(this.vel, dt);
    const down = Math.min(this.maxRise, Math.max(0, limits?.down ?? this.maxRise));
    const up = Math.min(this.maxRise, Math.max(0, limits?.up ?? this.maxRise));
    if (this.pos.y > up) {
      this.pos.y = up;
      if (this.vel.y > 0) this.vel.y = 0;
    } else if (this.pos.y < -down) {
      this.pos.y = -down;
      if (this.vel.y < 0) this.vel.y = 0;
    }
    return this.offset;
  }

  get offset(): Vec3 {
    return [this.pos.x, this.pos.y, this.pos.z];
  }

  /** Current speed (m/s), horizontal and vertical combined. */
  get speed(): number {
    return this.vel.length();
  }

  /** Back to the attached camera, standing still. */
  reset(): void {
    this.pos.set(0, 0, 0);
    this.vel.set(0, 0, 0);
  }
}

/** Where the phone camera is: anchor + walk offset + handheld nudge (the laptop adds the same). */
export function cameraPosition(pose: { position: Vec3; offset: Vec3; nudge: Vec3 }): Vec3 {
  const { position: p, offset: o, nudge: n } = pose;
  return [p[0] + o[0] + n[0], p[1] + o[1] + n[1], p[2] + o[2] + n[2]];
}

// Handheld sway from `devicemotion` (pure math, no DOM).
//
// acceleration (gravity-free, device frame, m/s²) → world frame via the current device→world
// quaternion → high-pass (subtract a slow EMA so sensor bias never integrates) → damped
// spring-mass integration toward 0 → clamp to ±maxOffset. Result: subtle sway, never drift.
import { Quaternion, Vector3 } from 'three';
import type { Vec3 } from '@shared/schema';

export interface NudgeOptions {
  /** Velocity multiplier per 1/60 s (0.9 ⇒ c ≈ 6.3 /s). */
  damping?: number;
  /** Spring constant (1/s²) pulling the offset back to 0; ≈ critically damped at 10. */
  stiffness?: number;
  /** Time constant (s) of the EMA that estimates and removes the DC component. */
  dcTau?: number;
  /** Per-axis noise floor (m/s²) below which high-passed acceleration is ignored. */
  deadband?: number;
  /** Clamp per axis (m). */
  maxOffset?: number;
  /** Multiplies the input acceleration (1 = physical). */
  gain?: number;
}

const AXES = ['x', 'y', 'z'] as const;

export class HandheldNudge {
  readonly damping: number;
  readonly stiffness: number;
  readonly dcTau: number;
  readonly deadband: number;
  readonly maxOffset: number;
  gain: number;
  private readonly dc = new Vector3();
  private readonly vel = new Vector3();
  private readonly pos = new Vector3();
  private readonly tmp = new Vector3();

  constructor(opts: NudgeOptions = {}) {
    this.damping = opts.damping ?? 0.9;
    this.stiffness = opts.stiffness ?? 10;
    this.dcTau = opts.dcTau ?? 1.0;
    this.deadband = opts.deadband ?? 0.03;
    this.maxOffset = opts.maxOffset ?? 0.3;
    this.gain = opts.gain ?? 1;
  }

  /**
   * Advance by `dt` seconds. `accDevice` is DeviceMotionEvent.acceleration (null ⇒ no data, the
   * offset just springs back). `deviceToWorld` maps device-frame vectors into the world.
   */
  update(accDevice: Vec3 | null, deviceToWorld: Quaternion, dt: number): Vec3 {
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (dt === 0) return this.offset;

    const a = this.tmp.set(0, 0, 0);
    if (accDevice && accDevice.every(Number.isFinite)) {
      a.set(accDevice[0], accDevice[1], accDevice[2]).applyQuaternion(deviceToWorld);
      a.multiplyScalar(this.gain);
      // DC starts at 0 rather than the first sample: if the phone is moving when the stream
      // starts, priming would bake that motion into the baseline and cause a long excursion.
      this.dc.lerp(a, 1 - Math.exp(-dt / this.dcTau));
      a.sub(this.dc);
      for (const k of AXES) {
        const v = a[k];
        a[k] = Math.abs(v) <= this.deadband ? 0 : v - Math.sign(v) * this.deadband;
      }
    }

    // Semi-implicit Euler: v += (a − k·p)·dt; v *= damping^(dt·60); p += v·dt.
    this.vel.addScaledVector(a, dt).addScaledVector(this.pos, -this.stiffness * dt);
    this.vel.multiplyScalar(Math.pow(this.damping, dt * 60));
    this.pos.addScaledVector(this.vel, dt);

    for (const k of AXES) {
      if (Math.abs(this.pos[k]) > this.maxOffset) {
        this.pos[k] = Math.sign(this.pos[k]) * this.maxOffset;
        if (Math.sign(this.vel[k]) === Math.sign(this.pos[k])) this.vel[k] = 0;
      }
    }
    return this.offset;
  }

  get offset(): Vec3 {
    return [this.pos.x, this.pos.y, this.pos.z];
  }

  reset(): void {
    this.dc.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.pos.set(0, 0, 0);
  }
}

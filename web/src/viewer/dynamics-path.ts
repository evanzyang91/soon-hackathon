// Time → position along a DynamicElement path. Pure (three's curve math only, no DOM/GL).
//
// Timeline per cycle: travel the whole path at `speed` (arc-length parameterised so speed is
// constant in m/s), then hold at the end for `pauseSeconds`, then restart. A path whose last point
// repeats its first is treated as a closed loop (no jump back to the start).
//
// Parked: one point, or speed 0 (a static prop: an imported / generated model, a parked car)
// stands at path[0] facing path[1] when there is one, else −Z; nothing is integrated, so no NaN
// can come out of a degenerate curve.
import * as THREE from 'three';
import type { Vec3 } from '@shared/schema';

export interface PathOptions {
  speed: number;
  loop: boolean;
  pauseSeconds: number;
}

export interface PathSample {
  position: Vec3;
  /** Yaw about +Y so a prop whose forward is -Z faces the direction of travel. */
  heading: number;
  /** Metres travelled since the start of the current cycle. */
  distance: number;
  phase: 'moving' | 'paused' | 'done';
}

const CLOSE_EPS = 0.01;

/** Yaw that rotates forward (-Z) onto the horizontal direction (dx, dz). */
export function headingFor(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

export class PathSampler {
  readonly length: number;
  readonly travelSeconds: number;
  readonly cycleSeconds: number;
  readonly closed: boolean;
  /** One point or speed 0: always path[0], facing path[1] (−Z with one point). */
  readonly parked: boolean;
  private readonly curve: THREE.CatmullRomCurve3;
  private readonly opts: PathOptions;
  private readonly tmp = new THREE.Vector3();
  private lastHeading = 0;

  constructor(points: Vec3[], opts: PathOptions) {
    if (points.length < 1) throw new Error('path needs at least one point');
    const vs = points.map((p) => new THREE.Vector3(...p));
    const first = vs[0]!;
    const last = vs[vs.length - 1]!;
    this.parked = vs.length === 1 || !(opts.speed > 0);
    const second = vs[1];
    const parkedHeading =
      second && Math.hypot(second.x - first.x, second.z - first.z) > 1e-4 ? headingFor(second.x - first.x, second.z - first.z) : 0;
    this.closed = vs.length >= 4 && first.distanceTo(last) < CLOSE_EPS;
    if (this.closed) vs.pop();
    if (vs.length === 1) vs.push(first.clone());
    this.curve = new THREE.CatmullRomCurve3(vs, this.closed, 'centripetal');
    this.curve.arcLengthDivisions = Math.max(200, vs.length * 50);
    this.length = this.curve.getLength();
    this.opts = opts;
    this.travelSeconds = !this.parked && opts.speed > 0 ? this.length / opts.speed : 0;
    this.cycleSeconds = this.travelSeconds + (this.closed ? 0 : Math.max(0, opts.pauseSeconds));
    this.lastHeading = this.parked ? parkedHeading : this.headingAt(0);
    this.start = [first.x, first.y, first.z];
  }

  private readonly start: Vec3;

  sample(t: number): PathSample {
    const time = Math.max(0, Number.isFinite(t) ? t : 0);
    if (this.parked) return { position: [...this.start], heading: this.lastHeading, distance: 0, phase: 'done' };
    if (this.length < 1e-6 || this.travelSeconds <= 0) {
      return { position: this.point(0), heading: this.lastHeading, distance: 0, phase: 'done' };
    }
    let local: number;
    if (this.opts.loop && this.cycleSeconds > 0) local = time % this.cycleSeconds;
    else local = time;

    if (local >= this.travelSeconds) {
      const done = !this.opts.loop;
      const u = this.closed ? 0 : 1;
      return {
        position: this.point(u),
        heading: this.headingAt(this.closed ? 0 : 1),
        distance: this.length,
        phase: done ? 'done' : 'paused',
      };
    }
    const u = local / this.travelSeconds;
    return {
      position: this.point(u),
      heading: this.headingAt(u),
      distance: u * this.length,
      phase: 'moving',
    };
  }

  private point(u: number): Vec3 {
    const p = this.curve.getPointAt(Math.min(1, Math.max(0, u)), this.tmp);
    return [p.x, p.y, p.z];
  }

  private headingAt(u: number): number {
    const d = this.curve.getTangentAt(Math.min(1, Math.max(0, u)), this.tmp);
    // vertical tangents (a bird climbing straight up) keep the previous heading
    if (Math.hypot(d.x, d.z) > 1e-4) this.lastHeading = headingFor(d.x, d.z);
    return this.lastHeading;
  }
}

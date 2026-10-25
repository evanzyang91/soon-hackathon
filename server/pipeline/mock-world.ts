// Builds fixtures/mock-world/<set>/: small synthetic splat "sets" used by MOCK=1 and
// MARBLE_DRY_RUN=1 so every scene has something real to load, render and grade without spending
// Marble credits, and a genre screenplay can be reviewed in a place that fits its headings
// (mock-set.ts picks the set). Generated, not downloaded: license-free, tiny (≤ 160 KB SPZ each),
// deterministic, and laid out for the pipeline's conventions:
//   - a flat floor at exactly y = 0 across the stage area (x −6…6, z −10…1, in fact the ground
//     field's whole default grid x −8…8, z −12…3 on the exterior sets), so actors' feet land on it;
//   - open floor where the planner stands actors (z −1.5…−4, |x| ≤ 2.5);
//   - a clear, flat lane across the view at z ≈ −10.5 where mock cars, buses and riders pass
//     (the shallow room keeps z ≈ −6 clear instead);
//   - a backdrop or sky so the start camera (0, 1.6, 0) looking down −Z never sees black;
//   - one readable palette per set, so the look presets have something to grade.
// Stored in Marble's OpenCV frame (Y down, +Z forward) so the viewer exercises the same 180° X
// flip as a real Marble world.
//
//   pnpm tsx server/pipeline/cli.ts make-mock-world [set|all]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Quat, Vec3 } from '../../shared/schema.ts';
import { DEFAULT_MOCK_SET, MOCK_SETS, type MockSet } from './mock-set.ts';
import { encodeSpz, type Splat } from './spz.ts';

export const MOCK_WORLD_DIR = new URL('../../fixtures/mock-world/', import.meta.url).pathname;
export const mockSetDir = (set: MockSet = DEFAULT_MOCK_SET) => join(MOCK_WORLD_DIR, set);
/** Budget per set: small enough for the repo and for SwiftShader in the e2e specs. */
export const MOCK_SPZ_MAX_BYTES = 160 * 1024;

export interface MockSetInfo {
  interior: boolean;
  /** z (m) of the lane kept clear and flat across the set for ground dynamics. */
  laneZ: number;
  /** One line for the fixture README and the CLI. */
  summary: string;
}

export const MOCK_SET_INFO: Record<MockSet, MockSetInfo> = {
  street: {
    interior: false,
    laneZ: -10.5,
    summary:
      'concrete checker floor, a road at z ≈ −10.5, brick backdrop with lit windows, sky card, crate and pillar',
  },
  forest: {
    interior: false,
    laneZ: -10.5,
    summary:
      'grass clearing with an earth path, mossy trunks, canopy, low mist, treeline and a pale sky',
  },
  hall: {
    interior: true,
    laneZ: -10.5,
    summary:
      'stone great hall: flagstones and a red runner, columns both sides, torches under tall windows, dais with a throne, banners and a rose window, dark beamed ceiling',
  },
  cave: {
    interior: true,
    laneZ: -10.5,
    summary:
      'rock floor under a rough vault, stalagmites and stalactites, a glowing teal pool at the back',
  },
  desert: {
    interior: false,
    laneZ: -10.5,
    summary:
      'rippled sand with a wheel track, dune ridges, distant mesas, a huge warm sky with a low sun',
  },
  station: {
    interior: true,
    laneZ: -10.5,
    summary:
      'sci-fi cargo deck: deck plates with hazard lanes, ribbed bulkheads, ceiling strip lights, cargo containers, a viewport onto stars and a planet',
  },
  shore: {
    interior: false,
    laneZ: -10.5,
    summary:
      'sand and pebbles, wet sand and foam, the sea to the horizon with wave streaks, cliffs on the left, cloudy sky',
  },
  village: {
    interior: false,
    laneZ: -10.5,
    summary:
      'dirt main street between timber storefronts with signs, porches and posts, a cross street at z ≈ −10.5, hills and sky',
  },
  room: {
    interior: true,
    laneZ: -6,
    summary:
      'cosy room: plank floor and rug, three walls with wainscoting, a bright window, fireplace, armchair, a table and two chairs',
  },
  field: {
    interior: false,
    laneZ: -10.5,
    summary:
      'open grass with a farm track, a fence line, golden crops, a red barn, treeline and a big sky',
  },
};

// ---------------------------------------------------------------------------
// Small deterministic helpers

type Color = Vec3;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mul = (c: Color, k: number | Color): Color =>
  typeof k === 'number' ? [c[0] * k, c[1] * k, c[2] * k] : [c[0] * k[0], c[1] * k[1], c[2] * k[2]];
const add = (a: Color, b: Color, k = 1): Color => [
  a[0] + b[0] * k,
  a[1] + b[1] * k,
  a[2] + b[2] * k,
];

function hash3(x: number, y: number, s: number): number {
  let h =
    (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1)) >>>
    0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1. */
function noise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash3(xi, yi, seed);
  const b = hash3(xi + 1, yi, seed);
  const c = hash3(xi, yi + 1, seed);
  const d = hash3(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Three octaves of value noise in 0..1: stone, bark, grass and cloud texture. */
function fbm(x: number, y: number, seed = 0): number {
  return (
    (4 * noise2(x, y, seed) +
      2 * noise2(x * 2.03, y * 2.03, seed + 17) +
      noise2(x * 4.1, y * 4.1, seed + 34)) /
    7
  );
}

/** Calls fn at a, a + step, … ≤ b by index, so long ranges never drift by float accumulation. */
function each(a: number, b: number, step: number, fn: (v: number, i: number) => void) {
  const n = Math.floor((b - a) / step + 1e-6);
  for (let i = 0; i <= n; i++) fn(a + i * step, i);
}

/** Index of v on a lattice of `step` through 0 (pattern periods are whole numbers of steps). */
const lat = (v: number, step: number) => Math.round(v / step);
const mod = (a: number, n: number) => ((a % n) + n) % n;

const THIN = 0.012;
/** Turn about +Y: a plate's +Z normal becomes (sin yaw, 0, cos yaw). */
const yawQuat = (yaw: number): Quat => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

type Paint2 = (u: number, v: number) => Color | null;

/** Accumulates splats in the Y-up world frame (metres, camera at the origin looking down −Z). */
class SetBuilder {
  readonly splats: Splat[] = [];
  readonly rand: () => number;
  /** Per-splat colour jitter: texture without a pattern. */
  jitterAmount = 0.04;

  constructor(seed: number) {
    this.rand = prng(seed);
  }

  jitter(c: Color, amount = this.jitterAmount): Color {
    return c.map((v) => Math.min(1, Math.max(0, v + (this.rand() - 0.5) * amount))) as Vec3;
  }

  /** An axis-aligned plate; the street set's original helper, kept byte for byte. */
  flat(position: Vec3, rgb: Color, normal: 'x' | 'y' | 'z', size: number, opacity = 0.95) {
    const scale: Vec3 =
      normal === 'y'
        ? [size, THIN, size]
        : normal === 'z'
          ? [size, size, THIN]
          : [THIN, size, size];
    this.splats.push({ position, rgb: this.jitter(rgb), scale, opacity });
  }

  /** A round or ellipsoidal splat (foliage, rock, mist, glow); never lies flat enough to be ground. */
  blob(
    position: Vec3,
    rgb: Color,
    scale: number | Vec3,
    opacity = 0.95,
    jitter = this.jitterAmount,
  ) {
    const s: Vec3 = typeof scale === 'number' ? [scale, scale, scale] : scale;
    this.splats.push({ position, rgb: this.jitter(rgb, jitter), scale: s, opacity });
  }

  /** A vertical plate w wide and h tall facing (sin yaw, 0, cos yaw). */
  panel(position: Vec3, rgb: Color, yaw: number, w: number, h: number, opacity = 0.95) {
    this.splats.push({
      position,
      rgb: this.jitter(rgb),
      scale: [w, h, THIN],
      opacity,
      rotation: yawQuat(yaw),
    });
  }

  /** Horizontal plates on a lattice at height y (floors, ceilings, roofs). */
  ground(
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    step: number,
    paint: Paint2,
    y = 0,
    size = step * 0.8,
  ) {
    each(x0, x1, step, (x) =>
      each(z0, z1, step, (z) => {
        const c = paint(x, z);
        if (c) this.flat([x, y, z], c, 'y', size);
      }),
    );
  }

  /** A wall facing ±Z at depth z; paint(x, y) null leaves a hole. */
  wallZ(
    z: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    step: number,
    paint: Paint2,
    size = step * 0.8,
    opacity = 0.95,
  ) {
    each(x0, x1, step, (x) =>
      each(y0, y1, step, (y) => {
        const c = paint(x, y);
        if (c) this.flat([x, y, z], c, 'z', size, opacity);
      }),
    );
  }

  /** A wall facing ±X at x; paint(z, y). */
  wallX(
    x: number,
    z0: number,
    z1: number,
    y0: number,
    y1: number,
    step: number,
    paint: Paint2,
    size = step * 0.8,
  ) {
    each(z0, z1, step, (z) =>
      each(y0, y1, step, (y) => {
        const c = paint(z, y);
        if (c) this.flat([x, y, z], c, 'x', size);
      }),
    );
  }

  /** A solid box standing on y0: four sides and a lit top. */
  box(cx: number, cz: number, w: number, d: number, h: number, rgb: Color, step = 0.1, y0 = 0) {
    const s = step * 0.8;
    const side = mul(rgb, 0.8);
    each(-w / 2, w / 2, step, (u) =>
      each(0, h, step, (v) => {
        this.flat([cx + u, y0 + v, cz + d / 2], rgb, 'z', s);
        this.flat([cx + u, y0 + v, cz - d / 2], rgb, 'z', s);
      }),
    );
    each(-d / 2, d / 2, step, (u) =>
      each(0, h, step, (v) => {
        this.flat([cx + w / 2, y0 + v, cz + u], side, 'x', s);
        this.flat([cx - w / 2, y0 + v, cz + u], side, 'x', s);
      }),
    );
    const top = mix(rgb, [1, 1, 1], 0.12);
    each(-w / 2, w / 2, step, (u) =>
      each(-d / 2, d / 2, step, (v) => this.flat([cx + u, y0 + h, cz + v], top, 'y', s)),
    );
  }

  /** A round column (trunk, pillar, cone) of plates facing outwards; paint(angle, y). */
  column(
    cx: number,
    cz: number,
    radius: (y: number) => number,
    y0: number,
    y1: number,
    step: number,
    paint: (a: number, y: number) => Color | null,
    opacity = 0.95,
  ) {
    each(y0, y1, step, (y, row) => {
      const r = Math.max(0.02, radius(y));
      const n = Math.max(5, Math.round((2 * Math.PI * r) / step));
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * (k + (row % 2) * 0.5)) / n;
        const c = paint(a, y);
        if (c)
          this.panel(
            [cx + r * Math.sin(a), y, cz + r * Math.cos(a)],
            c,
            a,
            ((2 * Math.PI * r) / n) * 0.75,
            step * 0.8,
            opacity,
          );
      }
    });
  }

  /**
   * Ground beyond the fine lattice: rings around the camera whose spacing grows with distance, so
   * ground out to the horizon costs a few thousand splats yet still covers the view (both spacing
   * and splat size scale with the distance, so they overlap the same at every range).
   */
  ring(
    rho0: number,
    rho1: number,
    o: {
      paint: Paint2;
      skip?: (x: number, z: number) => boolean;
      height?: (x: number, z: number) => number;
      rel?: number;
      maxAngle?: number;
    },
  ) {
    const rel = o.rel ?? 0.07;
    const maxA = o.maxAngle ?? Math.PI * 0.56;
    for (let rho = rho0; rho <= rho1; rho *= 1 + rel) {
      const ds = rho * rel;
      const n = Math.ceil((2 * maxA * rho) / ds);
      for (let k = 0; k <= n; k++) {
        const a = -maxA + (2 * maxA * k) / n;
        const x = rho * Math.sin(a);
        const z = -rho * Math.cos(a);
        if (o.skip?.(x, z)) continue;
        const c = o.paint(x, z);
        if (!c) continue;
        this.splats.push({
          position: [x, o.height?.(x, z) ?? 0, z],
          rgb: this.jitter(c),
          scale: [ds * 0.8, THIN, ds * 0.8],
          opacity: 0.95,
        });
      }
    }
  }

  /** A sky: a big back card plus side cards, so turning the camera does not find black. */
  sky(
    z: number,
    halfWidth: number,
    y0: number,
    y1: number,
    step: number,
    paint: Paint2,
    sides = true,
  ) {
    const j = this.jitterAmount;
    this.jitterAmount = 0.015; // smooth gradients: big splats show every bit of noise
    this.wallZ(z, -halfWidth, halfWidth, y0, y1, step, paint, step * 0.85, 0.95);
    const sideStep = step * 1.4;
    if (sides)
      for (const sx of [-halfWidth, halfWidth])
        this.wallX(sx, z, -z * 0.25, y0, y1, sideStep, (_z, y) => paint(sx, y), sideStep * 0.85);
    this.jitterAmount = j;
  }
}

/** Exterior sets share this fine floor lattice (the ground field's default grid and then some). */
const FINE = 0.14;
const FINE_X = 8.54; // 61 steps
const FINE_Z0 = -12.6; // 90 steps
const FINE_Z1 = 2.38; // 17 steps
const inFine = (x: number, z: number) =>
  Math.abs(x) <= FINE_X + 0.05 && z >= FINE_Z0 - 0.05 && z <= FINE_Z1 + 0.05;

/** Lambert-ish falloff of a point light: 1 at the source, ~0 beyond `reach` metres. */
const glow = (p: Vec3, at: Vec3, reach: number) =>
  Math.exp(-((p[0] - at[0]) ** 2 + (p[1] - at[1]) ** 2 + (p[2] - at[2]) ** 2) / (reach * reach));

// ---------------------------------------------------------------------------
// The sets (Y-up world frame)

/** Today's original stage (unchanged since it was the only mock world). */
function street(): Splat[] {
  const b = new SetBuilder(42);
  const flat = b.flat.bind(b);

  // Floor: 1 m concrete checker, with a road band and a dashed centre line.
  const step = 0.14;
  for (let x = -10; x <= 10; x += step) {
    for (let z = -18; z <= 2; z += step) {
      let c: Vec3 =
        (Math.floor(x) + Math.floor(z)) % 2 === 0 ? [0.56, 0.54, 0.5] : [0.44, 0.43, 0.41];
      if (z > -12.75 && z < -8.25) {
        c = [0.17, 0.17, 0.19];
        if (Math.abs(z + 10.5) < 0.09 && ((x % 3) + 3) % 3 < 1.6) c = [0.93, 0.78, 0.2];
      } else if (z > -13.4 && z < -7.6) {
        c = [0.66, 0.64, 0.6]; // kerb
      }
      flat([x, 0, z], c, 'y', step * 0.8);
    }
  }

  // Backdrop wall with lit windows.
  for (let x = -10; x <= 10; x += step) {
    for (let y = 0; y <= 7; y += step) {
      let c = mix([0.5, 0.27, 0.2], [0.74, 0.55, 0.42], y / 7);
      const wx = ((x % 2.5) + 2.5) % 2.5;
      const wy = y % 2.4;
      if (y > 1 && wx > 0.7 && wx < 1.8 && wy > 0.6 && wy < 1.8) c = [0.98, 0.86, 0.55];
      flat([x, y, -18], c, 'z', step * 0.8);
    }
  }

  // Sky card far behind, horizon-warm to zenith-blue.
  for (let x = -30; x <= 30; x += 0.6) {
    for (let y = 0; y <= 25; y += 0.6) {
      flat([x, y, -30], mix([0.96, 0.74, 0.52], [0.24, 0.34, 0.6], y / 25), 'z', 0.5, 0.9);
    }
  }

  // Props: a crate (1 m cube) and a pillar, so parallax is obvious when flying.
  const box = (cx: number, cz: number, w: number, d: number, h: number, rgb: Vec3) => {
    const s = 0.1;
    for (let u = -w / 2; u <= w / 2; u += s) {
      for (let v = 0; v <= h; v += s) {
        flat([cx + u, v, cz + d / 2], rgb, 'z', s * 0.8);
        flat([cx + u, v, cz - d / 2], rgb, 'z', s * 0.8);
      }
    }
    for (let u = -d / 2; u <= d / 2; u += s) {
      for (let v = 0; v <= h; v += s) {
        flat([cx + w / 2, v, cz + u], mix(rgb, [0, 0, 0], 0.2), 'x', s * 0.8);
        flat([cx - w / 2, v, cz + u], mix(rgb, [0, 0, 0], 0.2), 'x', s * 0.8);
      }
    }
    for (let u = -w / 2; u <= w / 2; u += s) {
      for (let v = -d / 2; v <= d / 2; v += s)
        flat([cx + u, h, cz + v], mix(rgb, [1, 1, 1], 0.15), 'y', s * 0.8);
    }
  };
  box(-2.6, -5, 1, 1, 1, [0.62, 0.45, 0.26]);
  box(3.2, -7, 0.5, 0.5, 2.5, [0.35, 0.5, 0.62]);
  return b.splats;
}

function forest(): Splat[] {
  const b = new SetBuilder(7);
  const grass = (x: number, z: number): Color => {
    let c = mix([0.19, 0.3, 0.11], [0.38, 0.5, 0.19], fbm(x * 0.35, z * 0.35, 1));
    const moss = fbm(x * 1.1 + 9, z * 1.1, 2);
    c = mix(c, [0.26, 0.42, 0.14], smooth(0.58, 0.72, moss));
    // a trodden earth path across the clearing, where ground dynamics pass
    if (Math.abs(z + 10.5) < 0.95 + 0.45 * noise2(x * 0.3, 3, 4))
      c = mix([0.42, 0.33, 0.21], [0.32, 0.25, 0.16], noise2(x * 2, z * 2, 5));
    else if (b.rand() < 0.03) c = [0.5, 0.4, 0.2]; // fallen leaves
    // the canopy gap lights the middle of the clearing; the ground under the trees is in shade
    const sun = Math.exp(-(x * x) / 45 - ((z + 6) * (z + 6)) / 70);
    return mul(c, 0.72 + 0.45 * sun);
  };
  b.ground(-FINE_X, FINE_X, FINE_Z0, FINE_Z1, FINE, grass);
  b.ring(8.5, 44, { paint: (x, z) => mul(grass(x, z), 0.85), skip: inFine, rel: 0.06 });

  // Trunks around the clearing, never in the clearing, on the lane or right beside the camera.
  const open = (x: number, z: number) =>
    (x / 7.4) ** 2 + ((z + 5.5) / 7.6) ** 2 < 1 ||
    (Math.abs(z + 10.6) < 2.7 && Math.abs(x) < 30) ||
    (z > -3 && Math.abs(x) < 13) || // no crown right over the camera
    Math.abs(x) < 3 + 0.3 * -z; // the far side of the clearing stays open to the treeline and the sky
  const trees: { x: number; z: number; r: number; h: number }[] = [];
  for (let tries = 0; trees.length < 26 && tries < 5000; tries++) {
    const x = (b.rand() - 0.5) * 46;
    const z = 3 - b.rand() * 36;
    if (open(x, z) || trees.some((t) => Math.hypot(t.x - x, t.z - z) < 3)) continue;
    trees.push({ x, z, r: 0.28 + b.rand() * 0.24, h: 9 + b.rand() * 5 });
  }
  for (const t of trees) {
    const lod = Math.max(1, Math.hypot(t.x, t.z) / 9);
    const bark = mix([0.25, 0.2, 0.14], [0.36, 0.29, 0.2], b.rand());
    b.column(
      t.x,
      t.z,
      (y) => t.r * (1 + 0.7 * Math.max(0, 1 - y / 0.8) ** 2),
      0,
      t.h,
      0.2 * lod,
      (a, y) => {
        let c = mix(mul(bark, 0.7), bark, noise2(a * 2.5, y * 0.8, 6));
        // moss climbs the low, shaded side
        const moss = Math.max(0, 1 - y / 3) * (0.5 + 0.5 * Math.cos(a - 2.4));
        c = mix(c, [0.25, 0.38, 0.13], Math.min(1, moss * 1.3));
        return mul(c, 0.8 + 0.25 * Math.cos(a + 0.6));
      },
    );
    // canopy: dark leaf masses around the crown, lighter where the sun reaches
    for (let k = 0; k < 18; k++) {
      const a = b.rand() * 2 * Math.PI;
      const rr = 0.4 + b.rand() * 2.8;
      const y = t.h - 3 + b.rand() * 4.5;
      const s = (0.6 + b.rand() * 0.6) * Math.min(1.8, Math.max(1, lod * 0.8));
      const c = mix(
        [0.09, 0.19, 0.08],
        [0.25, 0.39, 0.14],
        clamp01(b.rand() * 0.6 + (y - t.h + 3.5) / 10),
      );
      b.blob([t.x + rr * Math.sin(a), y, t.z + rr * Math.cos(a)], c, [s, s * 0.65, s], 0.92);
    }
    // ferns at the foot of the nearer trees (round: never mistaken for ground)
    if (lod < 2.2)
      for (let k = 0; k < 10; k++) {
        const a = b.rand() * 2 * Math.PI;
        const rr = t.r + 0.3 + b.rand() * 1.3;
        const p: Vec3 = [t.x + rr * Math.sin(a), 0.15 + b.rand() * 0.3, t.z + rr * Math.cos(a)];
        const c = mix([0.2, 0.34, 0.12], [0.33, 0.48, 0.18], b.rand());
        if (Math.abs(p[2] + 10.5) > 1.8) b.blob(p, c, [0.34, 0.24, 0.34]); // not on the lane
      }
  }
  // mossy boulders at the clearing's edge
  for (const [bx, bz, s] of [
    [-4.7, -7.4, 0.7],
    [5.3, -6.6, 0.55],
    [-3.6, -14.8, 0.9],
  ] as const) {
    for (let k = 0; k < 9; k++) {
      const a = b.rand() * 2 * Math.PI;
      const c = mix([0.36, 0.38, 0.33], [0.27, 0.4, 0.16], b.rand() * 0.8);
      b.blob(
        [bx + Math.sin(a) * s * 0.4, s * (0.25 + b.rand() * 0.45), bz + Math.cos(a) * s * 0.4],
        c,
        [s * 0.55, s * 0.45, s * 0.55],
      );
    }
  }
  // mist: faint drifting layers between the trees (transparent: the ground field skips them)
  for (let k = 0; k < 130; k++) {
    const s = 1.4 + b.rand() * 1.6;
    b.blob(
      [(b.rand() - 0.5) * 52, 0.3 + b.rand() * 1.8, -14 - b.rand() * 26],
      [0.8, 0.86, 0.8],
      [s * 1.6, s * 0.5, s],
      0.05 + b.rand() * 0.06,
      0.02,
    );
  }
  // treeline backdrop with mist pooling at its foot
  b.wallZ(-42, -54, 54, 0, 20, 0.72, (x, y) => {
    const top = 8 + 5 * fbm(x * 0.09, 0.5, 11) + 2.5 * noise2(x * 0.5, 0.5, 12);
    if (y > top) return null;
    let c = mix([0.12, 0.2, 0.14], [0.25, 0.34, 0.24], fbm(x * 0.4, y * 0.4, 14));
    if (noise2(x * 1.3, 0.5, 13) > 0.72 && y < top - 3) c = mul(c, 0.7); // trunks
    return mix(c, [0.64, 0.7, 0.66], 0.6 * Math.exp(-y / 3.5));
  });
  b.sky(-78, 98, -3, 62, 2.4, (_x, y) =>
    mix([0.87, 0.9, 0.85], [0.58, 0.71, 0.84], smooth(0, 62, y)),
  );
  return b.splats;
}

function hall(): Splat[] {
  const b = new SetBuilder(11);
  const W = 7.5; // side walls at x = ±W
  const BACK = -18.2;
  const CEIL = 9;
  const torches: Vec3[] = [];
  for (const sx of [-1, 1])
    for (const z of [-0.4, -4.3, -10.5, -16.4]) torches.push([sx * (W - 0.32), 2.75, z]);
  // warm torch light on top of a dim ambient: the hall reads as lit by fire
  const lit = (c: Color, p: Vec3, ambient = 0.62): Color => {
    let l = 0;
    for (const t of torches) l += glow(p, t, 3.2);
    return mul(c, [ambient + 1.1 * l, ambient * 0.97 + 0.8 * l, ambient * 0.95 + 0.45 * l]);
  };
  const stone = (i: number, j: number, seed: number): Color =>
    mix([0.38, 0.36, 0.33], [0.54, 0.51, 0.46], hash3(i, j, seed));

  // Flagstones (8 × 6 lattice steps, every other row offset) and a red runner to the dais.
  b.ground(-7.42, 7.42, FINE_Z0, FINE_Z1, FINE, (x, z) => flagstone(x, z));
  b.ground(
    -7.4,
    7.4,
    BACK + 0.1,
    FINE_Z0 - 0.2,
    0.2,
    (x, z) => (Math.abs(x) <= 4.1 && z < -14.75 ? null : flagstone(x, z)),
    0,
    0.17,
  );
  function flagstone(x: number, z: number): Color {
    const i = lat(x, FINE);
    const j = lat(z, FINE);
    const row = Math.floor(j / 6);
    const col = Math.floor((i + (mod(row, 2) ? 4 : 0)) / 8);
    let c: Color =
      mod(j, 6) === 0 || mod(i + (mod(row, 2) ? 4 : 0), 8) === 0
        ? [0.25, 0.23, 0.21]
        : mul(stone(col, row, 3), 0.85 + 0.3 * fbm(x * 0.8, z * 0.8, 4));
    if (Math.abs(x) <= 0.85 && z > -14.8 && z < -1.3)
      c =
        Math.abs(x) > 0.7
          ? [0.62, 0.47, 0.2]
          : mix([0.36, 0.07, 0.07], [0.48, 0.11, 0.1], fbm(x * 3, z * 3, 5));
    return lit(c, [x, 0, z]);
  }

  // Ashlar side walls with a tall pointed window above each torch.
  const ashlar = (z: number, y: number, seed: number, step: number): Color => {
    const r = Math.floor(y / 0.6);
    const off = mod(r, 2) ? 0.6 : 0;
    const c = Math.floor((z + off) / 1.2);
    const mortar = y - r * 0.6 < step * 0.55 || mod(z + off, 1.2) < step * 0.55;
    const base = mortar
      ? ([0.2, 0.18, 0.16] as Color)
      : mul(stone(c, r, seed), 0.8 + 0.25 * fbm(z * 0.6, y * 0.6, seed + 1));
    return mul(base, 1 - 0.45 * smooth(2, CEIL, y)); // the fire light does not reach the vault
  };
  const window = (z: number, y: number): boolean => {
    for (const t of torches) {
      const dz = Math.abs(z - t[2]);
      if (y > 4.6 && y < 7.2 && dz < 0.45) return true;
      if (y >= 7.2 && y < 7.9 && dz < 0.45 * Math.sqrt(Math.max(0, 1 - ((y - 7.2) / 0.7) ** 2)))
        return true;
    }
    return false;
  };
  for (const sx of [-1, 1]) {
    const x = sx * W;
    const paint = (step: number) => (z: number, y: number) =>
      window(z, y)
        ? mix([0.22, 0.27, 0.42], [0.33, 0.38, 0.55], (y - 4.6) / 3.3)
        : lit(ashlar(z, y, 7 + sx, step), [x, y, z]);
    b.wallX(x, BACK, 2.4, 0, 4.8, 0.22, paint(0.22));
    b.wallX(x, BACK, 2.4, 5.0, CEIL, 0.34, paint(0.34));
  }
  // Torches: an iron bracket, a bright flame and a soft halo.
  for (const t of torches) {
    const sx = Math.sign(t[0]);
    b.box(t[0] + sx * 0.12, t[2], 0.12, 0.1, 0.45, [0.12, 0.1, 0.09], 0.05, t[1] - 0.55);
    for (let k = 0; k < 7; k++)
      b.blob(
        [t[0] + (b.rand() - 0.5) * 0.1, t[1] + k * 0.045, t[2] + (b.rand() - 0.5) * 0.1],
        mix([1, 0.88, 0.5], [1, 0.5, 0.15], k / 7),
        [0.08, 0.13, 0.08],
        0.95,
        0.02,
      );
    for (const [s, o] of [
      [0.32, 0.4],
      [0.9, 0.14],
    ] as const)
      b.blob([t[0], t[1] + 0.1, t[2]], [1, 0.62, 0.28], s, o, 0.01);
  }
  // Columns both sides, clear of the actors, the lanes and the dais.
  for (const sx of [-1, 1])
    for (const cz of [-2.2, -6.4, -14.4]) {
      const cx = sx * 5;
      const c0: Color = [0.5, 0.47, 0.42];
      b.box(cx, cz, 1.1, 1.1, 0.5, lit(c0, [cx, 0.3, cz], 0.55), 0.18);
      b.column(
        cx,
        cz,
        () => 0.42,
        0.55,
        7.55,
        0.3,
        (a, y) =>
          lit(
            mul(c0, (0.82 + 0.2 * Math.cos(a + sx * 1.4)) * (1 - 0.4 * smooth(3, 8, y))),
            [cx + 0.42 * Math.sin(a), y, cz + 0.42 * Math.cos(a)],
            0.6,
          ),
      );
      b.box(cx, cz, 1.0, 1.0, 0.45, lit(mul(c0, 0.75), [cx, 7.6, cz], 0.5), 0.18, 7.6);
    }
  // Dais (two steps) with the runner going up, and a dark throne.
  const daisPaint = (x: number, z: number) =>
    lit(Math.abs(x) <= 0.85 ? [0.42, 0.09, 0.08] : mul(stone(lat(x, 0.6), lat(z, 0.6), 9), 0.8), [
      x,
      0.4,
      z,
    ]);
  b.ground(-4.1, 4.1, -15.4, -14.8, 0.16, daisPaint, 0.22);
  b.ground(-4.1, 4.1, BACK + 0.05, -15.45, 0.16, daisPaint, 0.45);
  b.wallZ(-14.8, -4.1, 4.1, 0, 0.22, 0.11, (x) => mul(daisPaint(x, -14.8), 0.8));
  b.wallZ(-15.42, -4.1, 4.1, 0.22, 0.45, 0.11, (x) => mul(daisPaint(x, -15.4), 0.8));
  for (const sx of [-4.1, 4.1])
    b.wallX(sx, BACK, -14.8, 0, 0.45, 0.14, (z) => mul(daisPaint(sx, z), 0.75));
  b.box(0, -17.2, 1.4, 0.9, 0.55, [0.16, 0.13, 0.15], 0.1, 0.45);
  b.box(0, -17.6, 1.5, 0.22, 2.6, [0.13, 0.11, 0.13], 0.1, 0.45);
  // Far wall: two red banners and a rose window above the throne.
  const farWall = (x: number, y: number, step: number): Color => {
    const bx = Math.abs(Math.abs(x) - 2.6);
    const tail = 3.0 + 0.5 * (1 - bx / 0.65);
    if (bx < 0.65 && y > tail && y < 7.6) {
      if (bx > 0.53 || y > 7.45) return lit([0.64, 0.5, 0.2], [x, y, BACK]);
      const e = Math.hypot(bx, y - 5.6); // a gold ring emblem
      return lit(e < 0.32 && e > 0.18 ? [0.7, 0.55, 0.22] : [0.45, 0.08, 0.09], [x, y, BACK]);
    }
    const r = Math.hypot(x, y - 7.1);
    if (r < 1.2) {
      const a = Math.atan2(y - 7.1, x);
      if (r > 1.08 || mod(a, Math.PI / 4) < 0.12 || Math.abs(r - 0.55) < 0.05)
        return [0.2, 0.18, 0.16];
      const pal: Color[] = [
        [0.2, 0.27, 0.62],
        [0.75, 0.52, 0.2],
        [0.6, 0.16, 0.18],
        [0.25, 0.48, 0.4],
      ];
      return pal[mod(Math.floor(a / (Math.PI / 4)) + (r < 0.55 ? 1 : 0), 4)]!;
    }
    return lit(ashlar(x, y, 13, step), [x, y, BACK]);
  };
  b.wallZ(BACK, -W, W, 0, 4.4, 0.18, (x, y) => farWall(x, y, 0.18));
  b.wallZ(BACK, -W, W, 4.6, CEIL, 0.26, (x, y) => farWall(x, y, 0.26));
  // Dark beamed ceiling.
  b.ground(
    -W,
    W,
    BACK,
    2.4,
    0.42,
    (x, z) => (mod(z, 2.1) < 0.45 ? [0.2, 0.14, 0.1] : [0.14, 0.11, 0.09]),
    CEIL,
    0.38,
  );
  return b.splats;
}

function cave(): Splat[] {
  const b = new SetBuilder(13);
  const pool: Vec3 = [-1.0, 0, -14.6];
  const poolD = (x: number, z: number) => Math.hypot((x - pool[0]) / 2.6, (z - pool[2]) / 1.5);
  const teal: Color = [0.1, 0.55, 0.55];
  // the pool lights the rock around it; a little cold light also comes in from behind the camera
  const lit = (c: Color, p: Vec3): Color =>
    add(
      mul(c, 0.8 + 0.35 * glow(p, [0, 1.6, 3], 9)),
      teal,
      0.9 * glow(p, [pool[0], 0.4, pool[2]], 4.2),
    );
  const rock = (u: number, v: number, seed: number): Color => {
    let c = mix([0.17, 0.15, 0.14], [0.34, 0.3, 0.26], fbm(u * 0.5, v * 0.5, seed));
    if (noise2(u * 3, v * 0.4, seed + 3) > 0.72) c = mul(c, [0.7, 0.75, 0.82]); // wet streaks
    return c;
  };
  const Wz = (z: number) => 9.0 + 1.6 * (fbm(z * 0.15, 0.5, 21) - 0.5);
  const Hz = (z: number) => 6.2 + 2.0 * (fbm(z * 0.13, 3.5, 22) - 0.5);

  // Rock floor, flat at 0, with the glowing pool at the back.
  const floor = (x: number, z: number): Color => {
    const d = poolD(x, z);
    if (d < 1) {
      const c = mix([0.55, 0.96, 0.9], [0.1, 0.42, 0.48], d ** 1.5);
      return mul(c, 1 + 0.1 * Math.sin(d * 22));
    }
    let c = rock(x, z, 31);
    if (b.rand() < 0.05) c = mul(c, 1.25); // gravel
    if (d < 1.3) c = mix([0.12, 0.2, 0.2], c, (d - 1) / 0.3); // wet rim
    return lit(c, [x, 0, z]);
  };
  b.ground(-FINE_X, FINE_X, FINE_Z0, FINE_Z1, FINE, floor);
  b.ground(-8.6, 8.6, -17.8, FINE_Z0 - 0.2, 0.2, floor, 0, 0.17);
  // A rough vault: blobs on an uneven half-ellipse, from the floor's edge over the top.
  each(-17.9, 2.6, 0.34, (z) => {
    const w = Wz(z);
    const h = Hz(z);
    const arc = Math.PI * Math.sqrt((w * w + h * h) / 2);
    const n = Math.round(arc / 0.34);
    for (let k = 0; k <= n; k++) {
      const phi = (Math.PI * k) / n;
      const bump = 1 + 0.16 * (fbm(phi * 3, z * 0.4, 23) - 0.5);
      const p: Vec3 = [
        w * bump * Math.cos(phi),
        Math.max(0, h * bump * Math.sin(phi)),
        z + (b.rand() - 0.5) * 0.12,
      ];
      const c = mul(rock(phi * 6, z, 24), 1 - 0.35 * smooth(2, 7, p[1]));
      b.blob(p, lit(c, p), 0.26 + b.rand() * 0.08);
    }
  });
  // The end of the cave, with a darker recess (a passage on).
  each(-8.8, 8.8, 0.38, (x) =>
    each(0, 7.2, 0.38, (y) => {
      const z = -17.9;
      if ((x / Wz(z)) ** 2 + (y / Hz(z)) ** 2 > 1.02) return;
      const recess = ((x - 2.6) / 1.1) ** 2 + (y / 2.4) ** 2 < 1;
      const p: Vec3 = [x, y, z - 0.6 * fbm(x * 0.3, y * 0.3, 25) - (recess ? 1.2 : 0)];
      const c = recess ? ([0.11, 0.1, 0.1] as Color) : mul(rock(x, y, 26), 0.85);
      b.blob(p, lit(c, p), 0.3);
    }),
  );
  // Rubble along the foot of the walls (round: not ground).
  for (let k = 0; k < 160; k++) {
    const z = 2 - b.rand() * 19.5;
    const sx = b.rand() < 0.5 ? -1 : 1;
    const p: Vec3 = [sx * (Wz(z) - 0.3 - b.rand() * 1.1), 0.12 + b.rand() * 0.25, z];
    b.blob(p, lit(rock(p[0], z, 27), p), [0.3, 0.2, 0.3]);
  }
  // Stalagmites (clear of the actors and the lane) and stalactites.
  const mites: [number, number, number, number][] = [
    [-5.4, -4.4, 0.45, 1.7],
    [-6.6, -7.6, 0.6, 2.6],
    [5.8, -6.9, 0.5, 2.1],
    [6.9, -2.8, 0.35, 1.2],
    [4.3, -13.9, 0.45, 1.8],
    [2.9, -16.2, 0.6, 2.8],
    [-5.9, -14.4, 0.55, 2.3],
    [7.2, -14.8, 0.4, 1.4],
    [-7.4, -1.2, 0.4, 1.5],
  ];
  const calcite = (a: number, y: number, x: number, z: number) =>
    lit(mul(mix([0.3, 0.27, 0.24], [0.48, 0.44, 0.38], y / 3), 0.8 + 0.25 * Math.cos(a + 0.5)), [
      x,
      y,
      z,
    ]);
  for (const [x, z, r, h] of mites)
    b.column(
      x,
      z,
      (y) => r * (1 - y / h) ** 0.9 + 0.03,
      0,
      h,
      0.14,
      (a, y) => calcite(a, y, x, z),
    );
  for (let k = 0; k < 12; k++) {
    const z = 1 - b.rand() * 17;
    const x = (b.rand() - 0.5) * 10;
    const top = Hz(z) * Math.sqrt(Math.max(0, 1 - (x / Wz(z)) ** 2)) * 0.97;
    const len = 0.6 + b.rand() * 1.5;
    const r = 0.18 + b.rand() * 0.2;
    if (top - len < 3.2) continue;
    b.column(
      x,
      z,
      (y) => r * ((y - (top - len)) / len) ** 0.9 + 0.02,
      top - len,
      top,
      0.14,
      (a) => mul(calcite(a, 0.5, x, z), 0.75),
    );
  }
  // The pool's glow haze and a few floating motes.
  for (let k = 0; k < 50; k++) {
    const a = b.rand() * 2 * Math.PI;
    const rr = Math.sqrt(b.rand());
    b.blob(
      [pool[0] + 2.3 * rr * Math.cos(a), 0.15 + b.rand() * 1.4, pool[2] + 1.3 * rr * Math.sin(a)],
      [0.4, 0.9, 0.85],
      0.5 + b.rand() * 0.7,
      0.08 + b.rand() * 0.07,
      0.02,
    );
  }
  for (let k = 0; k < 24; k++)
    b.blob(
      [pool[0] + (b.rand() - 0.5) * 5, 0.4 + b.rand() * 2.4, pool[2] + (b.rand() - 0.5) * 3],
      [0.7, 1, 0.95],
      0.03,
      0.95,
      0.02,
    );
  return b.splats;
}

function desert(): Splat[] {
  const b = new SetBuilder(17);
  const horizon: Color = [0.98, 0.85, 0.66];
  const dune = (x: number, z: number) => {
    const rho = Math.hypot(x, z);
    const rise = smooth(15, 34, rho) * (2.2 + 5 * smooth(40, 110, rho));
    const ph = x * 0.11 + z * 0.06 + 2.2 * fbm(x * 0.02, z * 0.02, 31);
    const ridge = (0.5 + 0.5 * Math.sin(ph * 2)) ** 2.2; // sharp crests, wide troughs
    return rise * ridge * (0.6 + 0.8 * fbm(x * 0.03 + 4, z * 0.03, 32));
  };
  const sand = (x: number, z: number): Color => {
    const rho = Math.hypot(x, z);
    let c = mix([0.82, 0.64, 0.43], [0.9, 0.75, 0.53], fbm(x * 0.15, z * 0.15, 33));
    c = mul(c, 1 + 0.035 * Math.sin((z + 0.4 * Math.sin(x * 0.7)) * 9)); // wind ripples
    // slopes facing the low sun (from the right) are lit, the lee sides in warm shade
    const dx = dune(x + 0.5, z) - dune(x - 0.5, z);
    const dz = dune(x, z + 0.5) - dune(x, z - 0.5);
    c = mul(c, Math.min(1.18, Math.max(0.55, 0.92 + 1.5 * dx - 0.3 * dz)));
    return mix(c, horizon, 0.55 * smooth(40, 170, rho));
  };
  b.ground(-FINE_X, FINE_X, FINE_Z0, FINE_Z1, FINE, (x, z) => {
    // a wheel track across the lane
    if (Math.abs(z + 9.8) < 0.08 || Math.abs(z + 11.2) < 0.08) return [0.68, 0.53, 0.36];
    if (z < -9.6 && z > -11.4) return mul(sand(x, z), 0.93);
    return sand(x, z);
  });
  b.ring(8.5, 175, { paint: sand, skip: inFine, height: dune, rel: 0.065 });
  // A few rocks half sunk in the sand.
  for (const [rx, rz, s] of [
    [-6.2, -6.5, 0.6],
    [7.4, -3.5, 0.4],
    [4.8, -16, 0.9],
    [-11, -19, 1.2],
  ] as const)
    for (let k = 0; k < 8; k++)
      b.blob(
        [rx + (b.rand() - 0.5) * s, s * (0.15 + b.rand() * 0.35), rz + (b.rand() - 0.5) * s],
        mix([0.55, 0.38, 0.26], [0.7, 0.52, 0.36], b.rand()),
        [s * 0.5, s * 0.35, s * 0.45],
      );
  // Distant flat-topped mesas with strata, fading into the haze.
  for (const [mx, mz, w, h] of [
    [-86, -128, 80, 26],
    [-20, -152, 52, 34],
    [42, -140, 70, 19],
    [104, -124, 58, 28],
  ] as const) {
    const haze = smooth(80, 170, -mz) * 0.55;
    b.wallZ(
      mz,
      mx - w / 2,
      mx + w / 2,
      0,
      h + 2,
      1.15,
      (x, y) => {
        const u = (x - mx) / (w / 2);
        // a flat cap rock over steep cliffs, then a talus slope out to the base
        const cliff = 0.62 + 0.38 * (1 - y / h) ** 2.5;
        if (Math.abs(u) > cliff || y > h * (1 - 0.05 * noise2(x * 0.3, 0, 34))) return null;
        let c = mix([0.62, 0.34, 0.22], [0.78, 0.5, 0.32], fbm(x * 0.1, y * 0.25, 35));
        c = mul(c, 0.9 + 0.12 * Math.sin(y * 1.6 + 2 * fbm(x * 0.05, y * 0.05, 36)));
        if (u > 0.3) c = mul(c, 0.78); // the face away from the sun
        return mix(c, horizon, haze);
      },
      1.0,
    );
  }
  b.sky(-182, 220, -6, 120, 4.4, (_x, y) => {
    const t = y / 120;
    return mix(
      mix(horizon, [0.94, 0.72, 0.55], smooth(0, 0.18, t)),
      [0.42, 0.6, 0.86],
      smooth(0.12, 1, t),
    );
  });
  // a low sun with its halo
  b.blob([58, 24, -178], [1, 0.96, 0.82], 5, 0.95, 0.01);
  b.blob([58, 24, -177], [1, 0.82, 0.55], 14, 0.3, 0.01);
  b.blob([58, 24, -176], [1, 0.78, 0.5], 30, 0.14, 0.01);
  return b.splats;
}

function station(): Splat[] {
  const b = new SetBuilder(19);
  const W = 7.2;
  const BACK = -16.6;
  const CEIL = 5;
  const strips = [-2.8, 2.8];
  // cold light under the ceiling strips, warmer pools from the side panels
  const lit = (c: Color, p: Vec3): Color => {
    let l = 0;
    for (const sx of strips) l += Math.exp(-((p[0] - sx) ** 2) / 4 - (p[1] - CEIL) ** 2 / 30);
    return mul(c, [0.7 + 0.35 * l, 0.72 + 0.42 * l, 0.78 + 0.5 * l]);
  };
  // Deck plates of 1.12 m (8 lattice steps) with dark seams, hazard bands either side of the lane.
  const deck = (x: number, z: number): Color => {
    const i = lat(x, FINE);
    const j = lat(z, FINE);
    if (Math.abs(z + 8.4) < 0.15 || Math.abs(z + 12.6) < 0.15)
      return mod(Math.floor((x + z) / 0.42), 2) ? [0.75, 0.6, 0.12] : [0.12, 0.12, 0.13];
    if (mod(i, 8) === 0 || mod(j, 8) === 0) return [0.14, 0.15, 0.17];
    let c = mul([0.36, 0.39, 0.43], 0.9 + 0.2 * hash3(Math.floor(i / 8), Math.floor(j / 8), 41));
    if (z < -8.4 && z > -12.6) c = mul(c, [0.88, 0.92, 1]); // the lane is a shade darker
    if (mod(i, 8) === 4 && mod(j, 8) === 4) c = [0.55, 0.58, 0.62]; // a bolt head per plate
    return lit(c, [x, 0, z]);
  };
  b.ground(-7.14, 7.14, FINE_Z0, FINE_Z1, FINE, deck);
  b.ground(-7.14, 7.14, -16.52, FINE_Z0 - 0.14, FINE, deck);
  // Bulkhead side walls: 1.2 × 1.0 m panels, a dark kick plate, a conduit band.
  const RIBS = [0, -4.8, -9.6, -14.4];
  const bulk = (z: number, y: number, x: number): Color => {
    let c: Color = [0.34, 0.37, 0.42];
    if (y < 0.6) c = [0.22, 0.24, 0.27];
    else if (y > 3.0 && y < 3.5)
      c = mod(Math.floor(z / 0.4), 3) === 0 ? [0.5, 0.36, 0.16] : [0.18, 0.2, 0.23];
    else if (mod(z, 1.2) < 0.13 || mod(y, 1.0) < 0.13) c = [0.2, 0.22, 0.25];
    else c = mul(c, 0.92 + 0.16 * hash3(Math.floor(z / 1.2), Math.floor(y), 42));
    return lit(c, [x, y, z]);
  };
  for (const sx of [-1, 1]) {
    b.wallX(sx * W, BACK, 2.4, 0, CEIL, 0.2, (z, y) => bulk(z, y, sx * W));
    // cyan floor-edge light strip on each wall
    each(BACK, 2.4, 0.2, (z) =>
      b.splats.push({
        position: [sx * (W - 0.02), 0.25, z],
        rgb: [0.35, 0.9, 1],
        scale: [THIN, 0.035, 0.12],
        opacity: 1,
      }),
    );
    for (const rz of RIBS) {
      b.box(sx * (W - 0.18), rz, 0.36, 0.5, CEIL, [0.48, 0.51, 0.56], 0.2);
      const leds: [number, Color][] = [
        [1.5, [1, 0.25, 0.2]],
        [1.7, [0.3, 1, 0.5]],
      ];
      for (const [y, c] of leds) b.blob([sx * (W - 0.38), y, rz + 0.12], c, 0.04, 1, 0);
    }
  }
  // Ceiling with ribs across it and two strip lights along it.
  b.ground(
    -W,
    W,
    BACK,
    2.4,
    0.3,
    (x, z) =>
      RIBS.some((rz) => Math.abs(z - rz) < 0.28)
        ? [0.4, 0.43, 0.48]
        : mod(lat(x, 0.3), 4) === 0
          ? [0.12, 0.13, 0.15]
          : [0.19, 0.21, 0.24],
    CEIL,
    0.26,
  );
  for (const sx of strips) {
    each(BACK + 0.3, 2.4, 0.24, (z) =>
      b.splats.push({
        position: [sx, CEIL - 0.03, z],
        rgb: [0.88, 0.97, 1],
        scale: [0.09, THIN, 0.15],
        opacity: 1,
      }),
    );
    each(BACK + 0.6, 2.4, 1.2, (z) =>
      b.blob([sx, CEIL - 0.15, z], [0.6, 0.85, 1], [0.55, 0.22, 0.6], 0.1, 0),
    );
  }
  // Far bulkhead with a framed viewport (a hole onto the space card behind it).
  const VIEW = { x0: -4.5, x1: 4.5, y0: 0.9, y1: 4.2 };
  const inView = (x: number, y: number) => x > VIEW.x0 && x < VIEW.x1 && y > VIEW.y0 && y < VIEW.y1;
  b.wallZ(BACK, -W, W, 0, CEIL, 0.16, (x, y) => {
    if (inView(x, y)) {
      if (
        Math.abs(x) < 0.14 ||
        x - VIEW.x0 < 0.16 ||
        VIEW.x1 - x < 0.16 ||
        y - VIEW.y0 < 0.16 ||
        VIEW.y1 - y < 0.16
      )
        return [0.52, 0.55, 0.6];
      return null;
    }
    return bulk(x, y, 0);
  });
  b.ground(VIEW.x0, VIEW.x1, BACK - 0.02, BACK + 0.3, 0.12, () => [0.42, 0.45, 0.5], VIEW.y0); // sill
  const SPACE = -62;
  const planet = { x: 13, y: -3, r: 13.5 };
  b.jitterAmount = 0.02;
  b.wallZ(
    SPACE,
    -26,
    26,
    -10,
    20,
    1.0,
    (x, y) => {
      const d = Math.hypot(x - planet.x, y - planet.y) / planet.r;
      if (d < 1) {
        const nz = Math.sqrt(1 - d * d);
        const light = clamp01(
          0.25 +
            0.85 *
              (((planet.x - x) / planet.r) * 0.5 + ((y - planet.y) / planet.r) * 0.55 + nz * 0.55),
        );
        let c = mix([0.1, 0.27, 0.5], [0.2, 0.48, 0.62], fbm(x * 0.15, y * 0.15, 43));
        if (fbm(x * 0.12 + 7, y * 0.35, 44) > 0.6) c = [0.85, 0.88, 0.92]; // cloud bands
        return mul(c, light);
      }
      const nebula = fbm(x * 0.05, y * 0.05, 45);
      return add(
        mix([0.05, 0.06, 0.15], [0.12, 0.07, 0.2], smooth(0.5, 0.8, nebula)),
        [0.25, 0.5, 0.95],
        0.5 * Math.exp(-(((d - 1) * 9) ** 2)),
      );
    },
    0.86,
  );
  b.jitterAmount = 0.04;
  for (let k = 0; k < 220; k++) {
    const p: Vec3 = [(b.rand() - 0.5) * 52, -10 + b.rand() * 30, SPACE + 0.4];
    if (Math.hypot(p[0] - planet.x, p[1] - planet.y) < planet.r + 0.5) continue;
    const t = b.rand();
    b.blob(
      p,
      t < 0.15 ? [1, 0.85, 0.6] : t < 0.4 ? [0.7, 0.8, 1] : [1, 1, 1],
      0.05 + 0.12 * b.rand() ** 3,
      1,
      0.02,
    );
  }
  // Cargo containers along the walls.
  b.box(-5.3, -3.4, 1.6, 2.4, 1.6, [0.36, 0.41, 0.28], 0.12);
  b.box(-5.3, -3.4, 1.5, 2.2, 1.1, [0.62, 0.36, 0.15], 0.12, 1.6);
  b.box(5.4, -6.4, 1.4, 1.4, 1.4, [0.3, 0.38, 0.5], 0.12);
  b.box(4.9, -14.5, 2.0, 1.6, 2.0, [0.5, 0.19, 0.16], 0.14);
  return b.splats;
}

function shore(): Splat[] {
  const b = new SetBuilder(23);
  const haze: Color = [0.72, 0.8, 0.85];
  const WATERLINE = -13.4;
  const cliffX = (z: number) => -9.6 - 0.22 * Math.max(0, -4 - z) - 1.2 * fbm(z * 0.08, 0.5, 51);
  const beach = (x: number, z: number): Color => {
    let c = mix([0.72, 0.66, 0.54], [0.8, 0.74, 0.61], fbm(x * 0.3, z * 0.3, 52));
    const r = b.rand();
    if (r < 0.08) c = mix([0.42, 0.4, 0.37], [0.6, 0.57, 0.53], b.rand()); // pebbles
    if (z < -11.8) c = mix(c, mul(c, [0.66, 0.68, 0.72]), smooth(-11.8, -12.8, z)); // wet sand
    return c;
  };
  const sea = (x: number, z: number): Color => {
    const rho = Math.hypot(x, z);
    if (z > WATERLINE - 0.35 && fbm(x * 0.6, 1.5, 53) > 0.35) return [0.88, 0.92, 0.92]; // foam
    let c = mix([0.17, 0.4, 0.43], [0.15, 0.29, 0.46], smooth(14, 90, rho));
    c = mul(
      c,
      1 + 0.08 * Math.sin(z * 0.9 + 6 * fbm(x * 0.05, z * 0.05, 54)) * (1 - smooth(30, 200, rho)),
    );
    return mix(c, haze, 0.85 * smooth(25, 300, rho) ** 1.4);
  };
  const ground = (x: number, z: number): Color | null =>
    x < cliffX(z) ? null : z > WATERLINE ? beach(x, z) : sea(x, z);
  b.ground(-FINE_X, FINE_X, FINE_Z0, FINE_Z1, FINE, ground);
  b.ring(8.5, 310, { paint: ground, skip: inFine, rel: 0.06, maxAngle: Math.PI * 0.6 });
  // breaking wave lines and whitecaps further out (just above the water, outside the ground grid)
  for (const lz of [-15.3, -17.9, -21.5]) {
    each(-60, 60, 0.35, (x) => {
      if (fbm(x * 0.2, lz, 55) < 0.45 || x < cliffX(lz)) return;
      b.splats.push({
        position: [x, 0.02, lz + 0.3 * Math.sin(x * 0.15)],
        rgb: b.jitter([0.86, 0.91, 0.92]),
        scale: [0.3, THIN, 0.09],
        opacity: 0.9,
      });
    });
  }
  for (let k = 0; k < 420; k++) {
    const rho = 22 + 160 * b.rand() ** 2;
    const a = (b.rand() - 0.5) * 1.9;
    const x = rho * Math.sin(a);
    const z = -rho * Math.cos(a);
    if (x < cliffX(z) + 2) continue;
    const s = rho * 0.025;
    b.splats.push({
      position: [x, 0.02, z],
      rgb: b.jitter(mix([0.86, 0.9, 0.92], haze, smooth(40, 200, rho))),
      scale: [s * 1.5, THIN, s * 0.22],
      opacity: 0.75,
    });
  }
  // Cliffs on the left: a rough rock face receding along the coast, grass on top.
  for (let z = 6; z > -150;) {
    const rho = Math.hypot(cliffX(z), z);
    const step = 0.32 * Math.max(1, rho / 11);
    const top = 9 + 10 * smooth(-4, -50, z) + 6 * fbm(z * 0.04, 2.5, 56);
    const x0 = cliffX(z);
    const dir = Math.atan2(0.22 * (z < -4 ? 1 : 0), 1); // the face turns as the base line bends
    each(0, top, step, (y) => {
      const out = 0.9 * (fbm(z * 0.3, y * 0.3, 57) - 0.5) - 0.25 * smooth(top - 3, top, y);
      let c = mix([0.42, 0.38, 0.33], [0.6, 0.54, 0.46], fbm(z * 0.2, y * 0.15, 58));
      c = mul(c, 0.9 + 0.1 * Math.sin(y * 2.2 + 3 * fbm(z * 0.1, y * 0.1, 59)));
      if (y < 1.4) c = mul(c, 0.68); // wet foot
      if (y > top - 0.9) c = [0.36, 0.47, 0.24];
      c = mix(c, haze, 0.8 * smooth(25, 160, rho) ** 1.3);
      b.panel([x0 + out, y, z], c, Math.PI / 2 + dir, step * 0.8, step * 0.8);
    });
    z -= step;
  }
  for (let k = 0; k < 70; k++) {
    const z = 4 - b.rand() ** 1.5 * 40;
    const s = 0.3 + b.rand() * 0.6;
    b.blob(
      [cliffX(z) + 0.4 + b.rand() * 1.4, s * 0.5, z],
      mix([0.36, 0.33, 0.3], [0.52, 0.48, 0.42], b.rand()),
      [s, s * 0.7, s],
    );
  }
  // a low headland far out on the right
  b.wallZ(
    -250,
    50,
    210,
    0,
    14,
    3,
    (x, y) =>
      y > 10 * Math.sin(((x - 50) / 160) * Math.PI) ** 0.6 * (0.7 + 0.5 * fbm(x * 0.05, 0.5, 60))
        ? null
        : mix([0.42, 0.5, 0.52], haze, 0.55),
    2.6,
  );
  b.sky(-330, 420, -14, 240, 9, (_x, y) =>
    mix([0.95, 0.94, 0.9], [0.42, 0.6, 0.85], smooth(0, 200, y) ** 0.8),
  );
  // cumulus clouds
  for (let k = 0; k < 40; k++) {
    const cx = (b.rand() - 0.5) * 600;
    const cy = 30 + b.rand() * 100;
    for (let m = 0; m < 6; m++) {
      const s = 7 + b.rand() * 9;
      b.blob(
        [cx + (b.rand() - 0.5) * 30, cy + (b.rand() - 0.5) * 8, -322],
        m < 2 ? [0.82, 0.84, 0.88] : [0.98, 0.98, 0.97],
        [s * 1.6, s, s],
        0.55,
        0.02,
      );
    }
  }
  return b.splats;
}

function village(): Splat[] {
  const b = new SetBuilder(29);
  const FRONT = 7.0; // façades at x = ±FRONT
  const GAP = [-12.8, -8.4] as const; // the cross street
  const inGap = (z: number) => z > GAP[0] && z < GAP[1];
  const road = (x: number, z: number, ruts = true): Color => {
    let c = mix([0.44, 0.35, 0.25], [0.56, 0.45, 0.32], fbm(x * 0.25, z * 0.25, 61));
    if (
      ruts &&
      (Math.abs(Math.abs(x) - 0.85) < 0.1 ||
        (inGap(z) && (Math.abs(z + 9.8) < 0.08 || Math.abs(z + 11.2) < 0.08)))
    )
      c = mul(c, 0.78);
    if (b.rand() < 0.04) c = mul(c, 0.85);
    return c;
  };
  const prairie = (x: number, z: number): Color =>
    mix([0.52, 0.48, 0.3], [0.62, 0.56, 0.36], fbm(x * 0.1, z * 0.1, 62));
  const floor = (x: number, z: number): Color | null => {
    if (Math.abs(x) > FRONT && !inGap(z) && z > -36) return null; // under the buildings
    // plank boardwalk along the storefronts
    if (Math.abs(x) >= 5.46 && Math.abs(x) <= FRONT && !inGap(z) && z < 1.6)
      return mod(lat(z, FINE), 2) ? [0.5, 0.38, 0.26] : [0.4, 0.3, 0.2];
    return Math.abs(x) < FRONT + 6 || z > -36 ? road(x, z) : prairie(x, z);
  };
  b.ground(-FINE_X, FINE_X, FINE_Z0, FINE_Z1, FINE, floor);
  b.ground(
    -FRONT,
    FRONT,
    -36,
    FINE_Z0 - 0.3,
    0.3,
    (x, z) => (Math.abs(x) >= 5.46 ? floor(x, z) : road(x, z, false)),
    0,
    0.25,
  );
  // the ruts carry on down the street (too thin for the coarse lattice)
  for (const rx of [-0.85, 0.85])
    each(-36, FINE_Z0 - 0.15, 0.3, (z) =>
      b.flat([rx, 0, z], mul(road(rx, z, false), 0.78), 'y', 0.12),
    );
  b.ring(8.5, 130, {
    paint: (x, z) =>
      Math.abs(x) < FRONT ? road(x, z) : z < -36 ? prairie(x, z) : inGap(z) ? road(x, z) : null,
    skip: (x, z) => inFine(x, z) || (Math.abs(x) < FRONT && z > -36),
    rel: 0.06,
  });
  // Storefronts: false fronts of different heights and paints, a door, a shop window, a sign.
  const paints: Color[] = [
    [0.52, 0.38, 0.25],
    [0.56, 0.27, 0.21],
    [0.7, 0.55, 0.3],
    [0.42, 0.47, 0.52],
    [0.46, 0.52, 0.4],
    [0.78, 0.74, 0.66],
  ];
  for (const sx of [-1, 1]) {
    const x = sx * FRONT;
    const shade = sx < 0 ? 1.05 : 0.82; // the sun is on the right: west fronts lit, east in shade
    for (const [z0, z1] of [
      [1.6, GAP[1]],
      [GAP[0], -36],
    ] as const) {
      let za: number = z0;
      while (za > z1 + 1e-6) {
        const rest = za - z1;
        const last = rest < 7;
        const w = last ? rest : 4.2 + b.rand() * 1.6;
        const zb = last ? z1 : za - w;
        const h = 5.4 + b.rand() * 2.8;
        const base = paints[Math.floor(b.rand() * paints.length)]!;
        const signDark = b.rand() < 0.5;
        const porch = b.rand() < 0.75;
        const step = za > -14 ? 0.2 : 0.3;
        const front = (z: number, y: number): Color | null => {
          const u = za - z; // 0 at the front's near end
          if (y > h) return null;
          let c = mul(base, 0.85 + 0.3 * fbm(z * 0.4, y * 0.4, 63));
          if (mod(y, 0.32) < 0.06) c = mul(c, 0.82); // clapboards
          if (u < 0.14 || w - u < 0.14 || y > h - 0.3) c = mul(base, 1.25); // trim
          const door = u > w * 0.62 && u < w * 0.62 + 1.1 && y < 2.2;
          if (door)
            c =
              u - w * 0.62 < 0.1 || w * 0.62 + 1.1 - u < 0.1 || y > 2.1
                ? [0.5, 0.38, 0.26]
                : [0.22, 0.15, 0.1];
          else if (u > 0.5 && u < Math.min(2.9, w * 0.55) && y > 0.75 && y < 2.25)
            c =
              Math.abs(u - (0.5 + Math.min(2.9, w * 0.55)) / 2) < 0.05 || Math.abs(y - 1.5) < 0.04
                ? [0.4, 0.3, 0.2]
                : mix([0.16, 0.18, 0.2], [0.55, 0.4, 0.22], fbm(z, y, 64) * 0.8);
          else if (y > 3.15 && y < 3.85 && u > 0.3 && u < w - 0.3) {
            const letter =
              y > 3.3 &&
              y < 3.7 &&
              u > 0.6 &&
              u < w - 0.6 &&
              hash3(Math.floor(u / 0.22), 1, Math.floor(za * 10)) > 0.35 &&
              mod(u, 0.22) < 0.16;
            const ground: Color = signDark ? [0.2, 0.16, 0.12] : [0.86, 0.8, 0.64];
            c = letter ? (signDark ? [0.9, 0.82, 0.6] : [0.25, 0.14, 0.1]) : ground;
          } else if (
            h > 5.8 &&
            y > 4.2 &&
            y < 5.3 &&
            (Math.abs(u - w * 0.25) < 0.45 || Math.abs(u - w * 0.72) < 0.45)
          )
            c = [0.15, 0.17, 0.2];
          return mul(c, shade * (1 - 0.15 * smooth(1.5, 0, y)));
        };
        b.wallX(x, zb, za, 0, h, step, front, step * 0.85);
        if (porch) {
          b.ground(
            Math.min(x, sx * 5.5),
            Math.max(x, sx * 5.5),
            zb + 0.1,
            za - 0.1,
            0.3,
            () => mul([0.36, 0.27, 0.18], shade),
            3.0,
            0.26,
          );
          for (const pz of [za - 0.2, zb + 0.2])
            each(0.1, 2.9, 0.2, (y) =>
              b.blob([sx * 5.55, y, pz], mul([0.42, 0.31, 0.2], shade), [0.07, 0.13, 0.07]),
            );
        }
        // the side walls of the buildings at the cross street and at the end of the street
        const ends = [za === z0 && z0 === GAP[0] ? za : null, last ? zb : null];
        for (const ez of ends)
          if (ez !== null)
            b.wallZ(
              ez,
              Math.min(x, sx * 13),
              Math.max(x, sx * 13),
              0,
              h - 0.6,
              ez < -30 ? 0.4 : 0.28,
              (xx, y) => mul(mul(base, 0.8 + 0.2 * fbm(xx * 0.3, y * 0.3, 65)), 0.8 * shade),
            );
        za = zb;
      }
    }
  }
  // Barrels, a trough and a hitching rail by the boardwalks.
  for (const [bx, bz] of [
    [-4.9, -2.4],
    [5.1, -5.6],
    [5.15, -6.35],
  ] as const)
    b.column(
      bx,
      bz,
      (y) => 0.3 + 0.04 * Math.sin((y / 0.9) * Math.PI),
      0,
      0.9,
      0.1,
      (a, y) =>
        mod(y, 0.3) < 0.06 ? [0.25, 0.22, 0.2] : mul([0.48, 0.33, 0.2], 0.8 + 0.2 * Math.cos(a)),
    );
  b.box(-4.8, -6.4, 0.55, 1.6, 0.6, [0.36, 0.26, 0.17], 0.1);
  for (const pz of [-3.0, -4.6])
    b.column(
      4.9,
      pz,
      () => 0.06,
      0,
      1.0,
      0.1,
      () => [0.4, 0.29, 0.19],
    );
  each(-4.6, -3.0, 0.08, (z) => b.blob([4.9, 0.95, z], [0.42, 0.31, 0.2], [0.05, 0.05, 0.06]));
  // Hills at the end of the street, then the sky.
  b.wallZ(
    -96,
    -130,
    130,
    0,
    24,
    2,
    (x, y) =>
      y > 7 + 9 * fbm(x * 0.02, 0.5, 66)
        ? null
        : mix([0.42, 0.44, 0.42], [0.72, 0.76, 0.8], 0.45 + 0.02 * y),
    1.7,
  );
  // (no side cards: the storefronts hide the sky to either side)
  b.sky(
    -130,
    150,
    -5,
    96,
    3.6,
    (_x, y) => mix([0.93, 0.88, 0.76], [0.5, 0.67, 0.88], smooth(0, 70, y)),
    false,
  );
  return b.splats;
}

function room(): Splat[] {
  const b = new SetBuilder(31);
  const W = 6.3;
  const BACK = -8.6;
  const CEIL = 3.1;
  const win = { x0: -3.6, x1: -0.8, y0: 0.95, y1: 2.55 };
  const fire: Vec3 = [-W + 0.3, 0.45, -4.2];
  // daylight from the window, fire glow by the hearth, a warm lamp: the room is never flat
  const lit = (c: Color, p: Vec3): Color => {
    const day = glow(p, [(win.x0 + win.x1) / 2, 1.5, BACK + 1.5], 4.2);
    const f = glow(p, fire, 2.6);
    const lamp = glow(p, [3.9, 1.8, -3.3], 3);
    return mul(c, [
      0.68 + 0.5 * day + 0.8 * f + 0.3 * lamp,
      0.66 + 0.5 * day + 0.45 * f + 0.22 * lamp,
      0.62 + 0.52 * day + 0.2 * f + 0.12 * lamp,
    ]);
  };
  // Plank floor along z (0.28 m planks, staggered joints) and a rug where actors stand.
  const floor = (x: number, z: number): Color => {
    const i = lat(x, FINE);
    const plank = Math.floor(i / 2);
    const joint = mod(lat(z, FINE) + plank * 5, 16) === 0;
    let c = mul(
      [0.56, 0.38, 0.23],
      0.85 + 0.3 * hash3(plank, Math.floor((lat(z, FINE) + plank * 5) / 16), 71),
    );
    if (mod(i, 2) === 0) c = mul(c, 0.86); // the seam side of each plank
    if (joint) c = mul(c, 0.6);
    c = mul(c, 0.94 + 0.12 * noise2(x * 8, z * 0.7, 72));
    const rx = Math.abs(x);
    const rz = Math.abs(z + 2.9);
    if (rx < 2.1 && rz < 1.7) {
      const edge = Math.min(2.1 - rx, 1.7 - rz);
      c =
        edge < 0.18
          ? [0.78, 0.68, 0.5]
          : edge < 0.32
            ? [0.25, 0.2, 0.32]
            : Math.hypot(x / 1.1, (z + 2.9) / 0.8) < 1
              ? [0.74, 0.58, 0.32]
              : [0.5, 0.15, 0.13];
    }
    return lit(c, [x, 0, z]);
  };
  b.ground(-6.16, 6.16, BACK + 0.05, FINE_Z1, FINE, floor);
  // Walls: plaster above wainscoting, a skirting board, darker in the corners.
  const wall = (u: number, y: number, edge: number, p: Vec3): Color => {
    let c: Color =
      y < 0.12
        ? [0.28, 0.19, 0.12]
        : y < 1.0
          ? mod(u, 0.6) < 0.07
            ? [0.34, 0.23, 0.15]
            : [0.46, 0.31, 0.2]
          : y < 1.08
            ? [0.6, 0.45, 0.3]
            : mix([0.8, 0.7, 0.56], [0.86, 0.77, 0.62], fbm(u * 0.8, y * 0.8, 73));
    c = mul(c, 1 - 0.25 * smooth(0.6, 0, edge) - 0.15 * smooth(2.4, CEIL, y));
    return lit(c, p);
  };
  b.wallZ(BACK, -W, W, 0, CEIL, 0.12, (x, y) => {
    if (x > win.x0 && x < win.x1 && y > win.y0 && y < win.y1) {
      const mid = (win.x0 + win.x1) / 2;
      if (
        Math.abs(x - mid) < 0.05 ||
        Math.abs(y - 1.75) < 0.04 ||
        x - win.x0 < 0.08 ||
        win.x1 - x < 0.08 ||
        y - win.y0 < 0.08 ||
        win.y1 - y < 0.08
      )
        return [0.62, 0.5, 0.36];
      return mix([0.98, 0.97, 0.9], [0.8, 0.88, 0.97], (y - win.y0) / (win.y1 - win.y0)); // daylight
    }
    // curtains either side of the window
    if (
      y > 0.6 &&
      y < 2.85 &&
      ((x > win.x0 - 0.55 && x <= win.x0) || (x >= win.x1 && x < win.x1 + 0.55))
    )
      return lit(mul([0.24, 0.38, 0.32], 0.8 + 0.25 * Math.sin(x * 40)), [x, y, BACK]);
    // a framed landscape on the right
    if (x > 1.4 && x < 2.8 && y > 1.45 && y < 2.35)
      return x < 1.5 || x > 2.7 || y < 1.55 || y > 2.25
        ? [0.4, 0.3, 0.12]
        : y < 1.8
          ? [0.35, 0.45, 0.25]
          : y < 1.95
            ? [0.42, 0.5, 0.6]
            : [0.7, 0.8, 0.9];
    return wall(x, y, Math.min(W - Math.abs(x), CEIL - y), [x, y, BACK]);
  });
  for (const sx of [-1, 1]) {
    b.wallX(sx * W, BACK, 2.4, 0, CEIL, 0.14, (z, y) => {
      if (sx < 0 && z > -5.0 && z < -3.4 && y < 1.5) {
        // the hearth: a stone surround, a dark firebox, embers
        if (y > 1.32) return [0.42, 0.3, 0.2]; // mantel
        if (z > -4.75 && z < -3.65 && y < 0.95)
          return y < 0.25 ? [1, 0.5, 0.15] : [0.16, 0.1, 0.08];
        return lit(
          mix([0.46, 0.42, 0.38], [0.6, 0.56, 0.5], hash3(lat(z, 0.28), lat(y, 0.2), 74)),
          [sx * W, y, z],
        );
      }
      if (sx > 0 && z > -2.4 && z < -1.3 && y < 2.15)
        return z < -2.3 || z > -1.4 || y > 2.05 ? [0.5, 0.36, 0.24] : [0.36, 0.24, 0.15]; // door
      return wall(z, y, Math.min(z - BACK, CEIL - y), [sx * W, y, z]);
    });
  }
  // fire glow in front of the hearth (round: not ground)
  for (let k = 0; k < 14; k++)
    b.blob(
      [fire[0] + 0.05 + b.rand() * 0.2, 0.15 + b.rand() * 0.45, fire[2] + (b.rand() - 0.5) * 0.9],
      mix([1, 0.8, 0.35], [1, 0.4, 0.1], b.rand()),
      [0.12, 0.16, 0.12],
      0.9,
      0.02,
    );
  b.blob([fire[0] + 0.4, 0.5, fire[2]], [1, 0.55, 0.2], 0.7, 0.14, 0.01);
  // Ceiling with dark beams.
  b.ground(
    -W,
    W,
    BACK,
    2.4,
    0.2,
    (x, z) => lit(mod(z, 1.5) < 0.22 ? [0.32, 0.22, 0.14] : [0.72, 0.64, 0.52], [x, CEIL, z]),
    CEIL,
    0.18,
  );
  // A round table with two chairs (beside the rug), a candle; an armchair by the fire.
  const wood: Color = [0.42, 0.27, 0.16];
  b.ground(
    3.3,
    4.5,
    -3.9,
    -2.7,
    0.08,
    (x, z) => (Math.hypot(x - 3.9, z + 3.3) < 0.56 ? lit(mul(wood, 1.15), [x, 0.76, z]) : null),
    0.76,
    0.07,
  );
  b.column(
    3.9,
    -3.3,
    (y) => (y < 0.1 ? 0.25 : 0.06),
    0,
    0.74,
    0.06,
    () => lit(mul(wood, 0.8), [3.9, 0.4, -3.3]),
  );
  b.blob([3.9, 0.84, -3.3], [0.92, 0.88, 0.78], [0.03, 0.08, 0.03]);
  b.blob([3.9, 0.95, -3.3], [1, 0.8, 0.4], 0.025, 1, 0);
  b.blob([3.9, 0.95, -3.3], [1, 0.75, 0.4], 0.3, 0.15, 0);
  for (const [cx, back] of [
    [2.95, -1],
    [4.85, 1],
  ] as const) {
    b.ground(
      cx - 0.22,
      cx + 0.22,
      -3.52,
      -3.08,
      0.07,
      (x, z) => lit(wood, [x, 0.46, z]),
      0.46,
      0.06,
    );
    b.wallX(
      cx + back * 0.22,
      -3.52,
      -3.08,
      0.47,
      1.0,
      0.07,
      (z, y) => lit(mul(wood, 0.9), [cx, y, z]),
      0.06,
    );
    for (const [lx, lz] of [
      [-0.19, -0.19],
      [0.19, -0.19],
      [-0.19, 0.19],
      [0.19, 0.19],
    ] as const)
      b.column(
        cx + lx,
        -3.3 + lz,
        () => 0.025,
        0,
        0.45,
        0.07,
        () => lit(mul(wood, 0.75), [cx, 0.2, -3.3]),
      );
  }
  b.box(-4.7, -3.5, 0.9, 0.9, 0.45, lit([0.45, 0.2, 0.16], [-4.7, 0.4, -3.5]), 0.08);
  b.box(-5.05, -3.5, 0.2, 0.9, 0.55, lit([0.4, 0.17, 0.14], [-5, 0.8, -3.5]), 0.08, 0.45);
  return b.splats;
}

function field(): Splat[] {
  const b = new SetBuilder(37);
  const FENCE = -13.6;
  const grass = (x: number, z: number): Color => {
    let c = mix([0.3, 0.44, 0.18], [0.42, 0.55, 0.24], fbm(x * 0.25, z * 0.25, 81));
    c = mul(c, 0.92 + 0.12 * noise2(x * 1.5, z * 1.5, 82));
    if (Math.abs(z + 9.8) < 0.1 || Math.abs(z + 11.2) < 0.1)
      c = [0.44, 0.38, 0.26]; // farm track ruts
    else if (z < -9.5 && z > -11.5) c = mix(c, [0.46, 0.42, 0.3], 0.45);
    else if (b.rand() < 0.02)
      c = [
        [0.9, 0.82, 0.3],
        [0.92, 0.92, 0.9],
        [0.6, 0.45, 0.7],
      ][Math.floor(b.rand() * 3)] as Color; // wildflowers
    return c;
  };
  const crop = (x: number, z: number): Color => {
    const row = mod(lat(x, 0.75), 2);
    let c = mix([0.66, 0.56, 0.27], [0.76, 0.64, 0.33], fbm(x * 0.2, z * 0.2, 83));
    if (row) c = mul(c, 0.86);
    return mix(c, [0.78, 0.8, 0.76], 0.5 * smooth(30, 70, Math.hypot(x, z)));
  };
  b.ground(-FINE_X, FINE_X, FINE_Z0, FINE_Z1, FINE, grass);
  b.ring(8.5, 72, {
    paint: (x, z) => (z > FENCE - 0.2 ? grass(x, z) : crop(x, z)),
    height: (x, z) => (z < FENCE - 0.6 ? 1.15 + 0.15 * noise2(x * 0.4, z * 0.4, 84) : 0),
    skip: inFine,
    rel: 0.06,
  });
  // the crop's near edge: a wall of stalks along the fence, rows standing as stripes on top
  each(-32, 32, 0.2, (x) =>
    each(0, 1.2, 0.2, (y) => {
      const top = 1.1 + 0.25 * noise2(x * 2, 0.5, 85);
      if (y > top) return;
      b.panel(
        [x, y, FENCE - 0.6 - 0.15 * noise2(x, y, 86)],
        mul(crop(x, FENCE - 1), 0.75 + 0.25 * (y / top)),
        0,
        0.17,
        0.17,
      );
    }),
  );
  each(-20, 20, 0.75, (x) =>
    each(-24, FENCE - 0.7, 0.42, (z) =>
      b.blob([x, 1.15 + 0.1 * b.rand(), z], crop(x, z), [0.24, 0.12, 0.3]),
    ),
  );
  // Fence posts and two rails, coarser with distance.
  each(-30, 30, 2.4, (x) =>
    b.column(
      x,
      FENCE,
      () => 0.07,
      0,
      1.3,
      0.1 * Math.max(1, Math.abs(x) / 10),
      () => [0.46, 0.36, 0.25],
    ),
  );
  for (const ry of [0.55, 1.05])
    each(-30, 30, 0.12, (x) => {
      if (Math.abs(x) > 12 && lat(x, 0.12) % 2) return;
      b.blob([x, ry, FENCE], [0.5, 0.39, 0.27], [Math.abs(x) > 12 ? 0.14 : 0.08, 0.05, 0.04]);
    });
  // A red barn across the crops on the left.
  const barn = { x: -22, z: -38, w: 9, d: 6, h: 5 };
  b.wallZ(
    barn.z + barn.d / 2,
    barn.x - barn.w / 2,
    barn.x + barn.w / 2,
    0,
    barn.h + 2.6,
    0.3,
    (x, y) => {
      const roof = barn.h + 2.6 * (1 - Math.abs(x - barn.x) / (barn.w / 2));
      if (y > roof) return null;
      if (y > roof - 0.35) return [0.35, 0.33, 0.32];
      if (Math.abs(x - barn.x) < 1.3 && y < 3.2)
        return Math.abs(Math.abs(x - barn.x) - 0.65) < 0.15 || y > 3.0
          ? [0.9, 0.88, 0.82]
          : [0.4, 0.12, 0.1];
      return mix([0.55, 0.16, 0.12], [0.62, 0.22, 0.16], fbm(x, y, 87));
    },
  );
  b.wallX(barn.x + barn.w / 2, barn.z - barn.d / 2, barn.z + barn.d / 2, 0, barn.h, 0.3, () => [
    0.45, 0.13, 0.1,
  ]);
  // Treeline backdrop and a big sky with clouds.
  b.wallZ(
    -70,
    -90,
    90,
    0,
    16,
    0.9,
    (x, y) => {
      const top = 7 + 4 * fbm(x * 0.06, 0.5, 88) + 2 * noise2(x * 0.4, 0.5, 89);
      if (y > top) return null;
      return mix(
        mix([0.16, 0.26, 0.13], [0.3, 0.4, 0.2], fbm(x * 0.3, y * 0.3, 90)),
        [0.7, 0.76, 0.78],
        0.35,
      );
    },
    0.8,
  );
  b.sky(-160, 200, -5, 110, 4.6, (_x, y) =>
    mix([0.88, 0.9, 0.88], [0.45, 0.62, 0.9], smooth(0, 90, y) ** 0.8),
  );
  for (let k = 0; k < 28; k++) {
    const cx = (b.rand() - 0.5) * 320;
    const cy = 25 + b.rand() * 60;
    for (let m = 0; m < 6; m++) {
      const s = 5 + b.rand() * 7;
      b.blob(
        [cx + (b.rand() - 0.5) * 22, cy + (b.rand() - 0.5) * 6, -156],
        m < 2 ? [0.82, 0.84, 0.88] : [0.98, 0.98, 0.97],
        [s * 1.6, s, s],
        0.6,
        0.02,
      );
    }
  }
  return b.splats;
}

const BUILDERS: Record<MockSet, () => Splat[]> = {
  street,
  forest,
  hall,
  cave,
  desert,
  station,
  shore,
  village,
  room,
  field,
};

/** A set's splats in the Y-up world frame (metres). */
export function mockSetSplatsYUp(set: MockSet = DEFAULT_MOCK_SET): Splat[] {
  return BUILDERS[set]();
}

/**
 * Rotate 180° about X (Y-up → Marble's OpenCV frame): positions (x, −y, −z), rotations
 * q → qx(π)·q = (w, −z, y, −x). An axis-aligned splat stays as it is (it is symmetric under the
 * flip), so the original street set is stored exactly as before.
 */
export function toOpenCv(s: Splat): Splat {
  const out: Splat = { ...s, position: [s.position[0], -s.position[1], -s.position[2]] };
  if (s.rotation) {
    const [x, y, z, w] = s.rotation;
    out.rotation = [w, -z, y, -x];
  }
  return out;
}

/** A set's splats in the OpenCV frame Marble uses (what the fixture stores). */
export function mockSetSplats(set: MockSet = DEFAULT_MOCK_SET): Splat[] {
  return mockSetSplatsYUp(set).map(toOpenCv);
}

/** The original single mock world, i.e. the street set (older callers use this name). */
export const mockWorldSplats = (): Splat[] => mockSetSplats('street');

// ---------------------------------------------------------------------------
// Offline preview: a small CPU gaussian splatter for the thumbnails and the view checks in tests.

export interface PreviewCamera {
  position: Vec3;
  /** Vertical field of view, degrees (the laptop viewer's camera: 60). */
  fovDeg: number;
}
/** The laptop viewer's start view: (0, 1.6, 0) looking down −Z, 60° vertical. */
export const START_CAMERA: PreviewCamera = { position: [0, 1.6, 0], fovDeg: 60 };

/**
 * Renders Y-up splats from a camera looking down −Z: each splat's 3D covariance is projected to a
 * 2D gaussian (the usual EWA approximation plus a 0.3 px² low-pass), sorted front to back and
 * alpha-composited over black. Returns RGB floats 0..1, row-major from the top-left.
 */
export function renderPreview(
  splats: readonly Splat[],
  width: number,
  height: number,
  cam: PreviewCamera = START_CAMERA,
): Float32Array {
  const f = height / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
  const [cx, cy, cz] = cam.position;
  type Item = {
    u: number;
    v: number;
    d: number;
    i00: number;
    i01: number;
    i11: number;
    r: number;
    s: Splat;
  };
  const items: Item[] = [];
  for (const s of splats) {
    const X = s.position[0] - cx;
    const Y = s.position[1] - cy;
    const D = cz - s.position[2]; // depth along −Z
    if (D < 0.15) continue;
    const [qx, qy, qz, qw] = s.rotation ?? [0, 0, 0, 1];
    const R = [
      [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
      [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
      [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ] as const;
    const s2 = s.scale.map((v) => v * v);
    const S = (i: 0 | 1 | 2, j: 0 | 1 | 2) =>
      R[i][0] * R[j][0] * s2[0]! + R[i][1] * R[j][1] * s2[1]! + R[i][2] * R[j][2] * s2[2]!;
    // Jacobian of (u, v) with respect to world (x, y, z)
    const J = [
      [f / D, 0, (f * X) / (D * D)],
      [0, -f / D, (-f * Y) / (D * D)],
    ] as const;
    const idx = [0, 1, 2] as const;
    const cov = (a: 0 | 1, b: 0 | 1) => {
      let sum = 0;
      for (const i of idx) for (const j of idx) sum += J[a][i] * S(i, j) * J[b][j];
      return sum;
    };
    const a = cov(0, 0) + 0.3;
    const b = cov(0, 1);
    const c = cov(1, 1) + 0.3;
    const det = a * c - b * b;
    if (det <= 0) continue;
    const lmax = (a + c) / 2 + Math.sqrt(((a - c) / 2) ** 2 + b * b);
    const r = Math.min(3 * Math.sqrt(lmax), 2 * Math.max(width, height));
    const u = width / 2 + (f * X) / D;
    const v = height / 2 - (f * Y) / D;
    if (u + r < 0 || u - r > width || v + r < 0 || v - r > height) continue;
    items.push({ u, v, d: D, i00: c / det, i01: -b / det, i11: a / det, r, s });
  }
  items.sort((p, q) => p.d - q.d);
  const rgb = new Float32Array(width * height * 3);
  const T = new Float32Array(width * height).fill(1);
  for (const it of items) {
    const x0 = Math.max(0, Math.floor(it.u - it.r));
    const x1 = Math.min(width - 1, Math.ceil(it.u + it.r));
    const y0 = Math.max(0, Math.floor(it.v - it.r));
    const y1 = Math.min(height - 1, Math.ceil(it.v + it.r));
    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - it.v;
      for (let px = x0; px <= x1; px++) {
        const p = py * width + px;
        const t = T[p]!;
        if (t < 0.004) continue;
        const dx = px + 0.5 - it.u;
        const power = -0.5 * (it.i00 * dx * dx + 2 * it.i01 * dx * dy + it.i11 * dy * dy);
        if (power > 0) continue;
        const alpha = Math.min(0.99, it.s.opacity * Math.exp(power));
        if (alpha < 1 / 255) continue;
        const w = t * alpha;
        rgb[3 * p] = rgb[3 * p]! + w * it.s.rgb[0];
        rgb[3 * p + 1] = rgb[3 * p + 1]! + w * it.s.rgb[1];
        rgb[3 * p + 2] = rgb[3 * p + 2]! + w * it.s.rgb[2];
        T[p] = t * (1 - alpha);
      }
    }
  }
  return rgb;
}

/** Minimal RGB PNG encoder (filter 0 rows, one IDAT). */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Vec3,
): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width * 3 + 1);
    rows[o] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      rows[o + 1 + x * 3] = Math.round(r * 255);
      rows[o + 2 + x * 3] = Math.round(g * 255);
      rows[o + 3 + x * 3] = Math.round(b * 255);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const THUMB_SIZE = { width: 192, height: 108 };

/** The set as the start camera sees it, rendered offline (the laptop's scene list thumbnail). */
export function mockThumbnail(
  set: MockSet = DEFAULT_MOCK_SET,
  splats = mockSetSplatsYUp(set),
): Buffer {
  const { width, height } = THUMB_SIZE;
  const px = renderPreview(splats, width, height);
  return encodePng(width, height, (x, y) => {
    const p = 3 * (y * width + x);
    return [clamp01(px[p]!), clamp01(px[p + 1]!), clamp01(px[p + 2]!)];
  });
}

export interface WrittenSet {
  set: MockSet;
  splats: number;
  spzBytes: number;
  dir: string;
}

/** Writes <dir>/world.spz + thumbnail.png for one set. */
export async function writeMockSet(set: MockSet, dir = mockSetDir(set)): Promise<WrittenSet> {
  await mkdir(dir, { recursive: true });
  const yUp = mockSetSplatsYUp(set);
  const spz = encodeSpz(yUp.map(toOpenCv));
  await writeFile(join(dir, 'world.spz'), spz);
  await writeFile(join(dir, 'thumbnail.png'), mockThumbnail(set, yUp));
  return { set, splats: yUp.length, spzBytes: spz.length, dir };
}

/** Rebuilds fixtures/mock-world/<set>/ for the given sets (default: all of them). */
export async function writeMockSets(sets: readonly MockSet[] = MOCK_SETS): Promise<WrittenSet[]> {
  const out: WrittenSet[] = [];
  for (const set of sets) out.push(await writeMockSet(set));
  return out;
}

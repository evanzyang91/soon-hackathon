// Builds fixtures/mock-world/: a small synthetic "stage" splat world used by MOCK=1 so every
// browser test has something real to load and render. Generated (not downloaded) so it is
// license-free, tiny, deterministic, and laid out for the pipeline's conventions: floor at y = 0,
// a road across the view at z ≈ -10.5 (where mock car/bus dynamics drive), a backdrop wall at
// z = -18, a sky card behind it, and two props. Stored in Marble's OpenCV frame (Y down,
// +Z forward) so the viewer exercises the same 180° X flip as a real Marble world.
//
//   pnpm tsx server/pipeline/cli.ts make-mock-world
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Vec3 } from '../../shared/schema.ts';
import { encodeSpz, type Splat } from './spz.ts';

export const MOCK_WORLD_DIR = new URL('../../fixtures/mock-world/', import.meta.url).pathname;

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

/** Splats in the Y-up world frame (meters). */
export function mockWorldSplatsYUp(): Splat[] {
  const rand = prng(42);
  const jitter = (c: Vec3, amount = 0.04): Vec3 =>
    c.map((v) => Math.min(1, Math.max(0, v + (rand() - 0.5) * amount))) as Vec3;
  const splats: Splat[] = [];
  const flat = (
    position: Vec3,
    rgb: Vec3,
    normal: 'x' | 'y' | 'z',
    size: number,
    opacity = 0.95,
  ) => {
    const thin = 0.012;
    const scale: Vec3 =
      normal === 'y'
        ? [size, thin, size]
        : normal === 'z'
          ? [size, size, thin]
          : [thin, size, size];
    splats.push({ position, rgb: jitter(rgb), scale, opacity });
  };

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
  return splats;
}

/** Same splats converted to the OpenCV frame Marble uses (rotate 180° about X). */
export function mockWorldSplats(): Splat[] {
  return mockWorldSplatsYUp().map((s) => ({
    ...s,
    position: [s.position[0], -s.position[1], -s.position[2]] as Vec3,
  }));
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

/** A rough painted thumbnail of the mock stage (sky / wall / road / floor bands). */
export function mockThumbnail(): Buffer {
  const w = 192;
  const h = 108;
  return encodePng(w, h, (x, y) => {
    const t = y / h;
    if (t < 0.3) return mix([0.24, 0.34, 0.6], [0.96, 0.74, 0.52], t / 0.3);
    if (t < 0.55) {
      const lit = x % 24 > 8 && x % 24 < 18 && (y - 33) % 12 > 3 && (y - 33) % 12 < 9;
      return lit ? [0.98, 0.86, 0.55] : mix([0.74, 0.55, 0.42], [0.5, 0.27, 0.2], (t - 0.3) / 0.25);
    }
    if (t < 0.62)
      return Math.abs(t - 0.585) < 0.006 && x % 16 < 8 ? [0.93, 0.78, 0.2] : [0.17, 0.17, 0.19];
    return (Math.floor(x / 16) + Math.floor(y / 10)) % 2 ? [0.56, 0.54, 0.5] : [0.44, 0.43, 0.41];
  });
}

export async function writeMockWorld(
  dir = MOCK_WORLD_DIR,
): Promise<{ spzBytes: number; splats: number }> {
  await mkdir(dir, { recursive: true });
  const splats = mockWorldSplats();
  const spz = encodeSpz(splats);
  await writeFile(join(dir, 'world.spz'), spz);
  await writeFile(join(dir, 'thumbnail.png'), mockThumbnail());
  return { spzBytes: spz.length, splats: splats.length };
}

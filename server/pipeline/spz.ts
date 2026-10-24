// Minimal SPZ (Niantic packed gaussians) support: enough to build the offline mock world and to
// sanity-check Marble downloads. Version 2 layout, all little-endian, then gzipped:
//   header (16 B): magic 'NGSP' u32 | version u32 | numPoints u32 | shDegree u8 |
//                  fractionalBits u8 | flags u8 | reserved u8
//   positions n×3×24-bit signed fixed point · alphas n×u8 (sigmoid(opacity)·255) ·
//   colors n×3×u8 (SH DC, scaled) · scales n×3×u8 ((ln s + 10)·16) ·
//   rotations n×3×u8 (quat xyz with w ≥ 0, ·127.5 + 127.5) · SH n×dim×3×u8
import { constants, gunzipSync, gzipSync } from 'node:zlib';
import type { Quat, Vec3 } from '../../shared/schema.ts';

export const SPZ_MAGIC = 0x5053474e; // 'NGSP'
const SH_C0 = 0.28209479177387814;
const COLOR_SCALE = 0.15;

export interface Splat {
  position: Vec3;
  /** Per-axis standard deviation in the same units as position. */
  scale: Vec3;
  /** Linear-ish display color 0..1. */
  rgb: Vec3;
  /** 0..1 */
  opacity: number;
  /** [x, y, z, w]; identity when omitted. */
  rotation?: Quat;
}

export interface SpzHeader {
  version: number;
  numPoints: number;
  shDegree: number;
  fractionalBits: number;
  flags: number;
}

const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

export function isGzip(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

export function encodeSpz(
  splats: readonly Splat[],
  opts: { fractionalBits?: number } = {},
): Buffer {
  const n = splats.length;
  const frac = opts.fractionalBits ?? 12;
  const out = Buffer.alloc(16 + n * (9 + 1 + 3 + 3 + 3));
  out.writeUInt32LE(SPZ_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(n, 8);
  out.writeUInt8(0, 12); // SH degree 0
  out.writeUInt8(frac, 13);
  out.writeUInt8(0, 14); // flags
  out.writeUInt8(0, 15);
  const limit = 2 ** 23 - 1;
  let o = 16;
  for (const s of splats) {
    for (const v of s.position) {
      const fixed = Math.max(-limit, Math.min(limit, Math.round(v * (1 << frac))));
      const t = fixed & 0xffffff;
      out[o++] = t & 0xff;
      out[o++] = (t >> 8) & 0xff;
      out[o++] = (t >> 16) & 0xff;
    }
  }
  for (const s of splats) out[o++] = u8(s.opacity * 255);
  for (const s of splats) {
    for (const c of s.rgb) out[o++] = u8(((c - 0.5) / SH_C0) * COLOR_SCALE * 255 + 127.5);
  }
  for (const s of splats) {
    for (const v of s.scale) out[o++] = u8((Math.log(Math.max(v, 1e-6)) + 10) * 16);
  }
  for (const s of splats) {
    let [x, y, z, w] = s.rotation ?? [0, 0, 0, 1];
    const len = Math.hypot(x, y, z, w) || 1;
    const sign = w < 0 ? -1 : 1;
    x = (x / len) * sign;
    y = (y / len) * sign;
    z = (z / len) * sign;
    w = (w / len) * sign;
    out[o++] = u8(x * 127.5 + 127.5);
    out[o++] = u8(y * 127.5 + 127.5);
    out[o++] = u8(z * 127.5 + 127.5);
  }
  return gzipSync(out, { level: 9 });
}

function parseHeader(raw: Uint8Array): SpzHeader {
  if (raw.length < 16) throw new Error('SPZ header truncated');
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (dv.getUint32(0, true) !== SPZ_MAGIC) throw new Error('not an SPZ (bad NGSP magic)');
  return {
    version: dv.getUint32(4, true),
    numPoints: dv.getUint32(8, true),
    shDegree: raw[12]!,
    fractionalBits: raw[13]!,
    flags: raw[14]!,
  };
}

/** Reads the header from the first bytes of a gzipped SPZ (a prefix of the file is enough). */
export function readSpzHeader(gz: Uint8Array): SpzHeader {
  if (!isGzip(gz)) throw new Error('SPZ is not gzip-compressed');
  const raw = gunzipSync(gz.subarray(0, Math.min(gz.length, 65536)), {
    finishFlush: constants.Z_SYNC_FLUSH,
  });
  return parseHeader(raw);
}

/** Full decode of positions/colors/opacities (tests and fixture checks; SH ignored). */
export function decodeSpz(gz: Uint8Array): { header: SpzHeader; splats: Splat[] } {
  const raw = gunzipSync(gz);
  const header = parseHeader(raw);
  const { numPoints: n, fractionalBits: frac, version } = header;
  const rotBytes = version >= 3 ? 4 : 3;
  const shDim = [0, 3, 8, 15][header.shDegree] ?? 0;
  const expected = 16 + n * (9 + 1 + 3 + 3 + rotBytes + shDim * 3);
  if (raw.length < expected) throw new Error(`SPZ truncated: ${raw.length} < ${expected} bytes`);
  const splats: Splat[] = [];
  const posOff = 16;
  const alphaOff = posOff + n * 9;
  const colorOff = alphaOff + n;
  const scaleOff = colorOff + n * 3;
  const rotOff = scaleOff + n * 3;
  for (let i = 0; i < n; i++) {
    const p: number[] = [];
    for (let k = 0; k < 3; k++) {
      const b = posOff + i * 9 + k * 3;
      let v = raw[b]! | (raw[b + 1]! << 8) | (raw[b + 2]! << 16);
      if (v & 0x800000) v -= 0x1000000;
      p.push(v / (1 << frac));
    }
    const rgb = [0, 1, 2].map(
      (k) => ((raw[colorOff + i * 3 + k]! - 127.5) / (COLOR_SCALE * 255)) * SH_C0 + 0.5,
    );
    const scale = [0, 1, 2].map((k) => Math.exp(raw[scaleOff + i * 3 + k]! / 16 - 10));
    let rotation: Quat = [0, 0, 0, 1];
    if (rotBytes === 3) {
      const xyz = [0, 1, 2].map((k) => raw[rotOff + i * 3 + k]! / 127.5 - 1);
      const w = Math.sqrt(Math.max(0, 1 - xyz[0]! ** 2 - xyz[1]! ** 2 - xyz[2]! ** 2));
      rotation = [xyz[0]!, xyz[1]!, xyz[2]!, w];
    }
    splats.push({
      position: p as Vec3,
      rgb: rgb as Vec3,
      scale: scale as Vec3,
      opacity: raw[alphaOff + i]! / 255,
      rotation,
    });
  }
  return { header, splats };
}

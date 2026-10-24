import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeMotionFrame, measurePly, parseGaussianPly, validateSequence, type MotionRecord } from './actor-sequence';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const hasNumpy = (() => {
  try {
    execFileSync('python3', ['-c', 'import numpy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const hex = (c: string) => c.repeat(64);

function ply(rows: number[][], props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) {
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${props.map((p) => `property float ${p}\n`).join('')}end_header\n`;
  return ab(Buffer.concat([Buffer.from(head), Buffer.from(new Float32Array(rows.flat()).buffer)]));
}
const splat = (x: number, y: number, z: number, opacity = 4) => [x, y, z, 0, 0, 0, opacity, -4, -4, -4, 1, 0, 0, 0];

describe('validateSequence', () => {
  const good = () => ({
    frames: ['frame_000.ply', 'frame_001.ply'],
    count: 2,
    fps: 12,
    frame_sha256: [hex('a'), hex('b')],
    loops: { idle: { start: 0, count: 1 }, talk: { start: 1, count: 1 } },
  });
  it('accepts a minimal Orbis-style sequence', () => {
    expect(validateSequence(good()).count).toBe(2);
  });
  it.each([
    ['count mismatch', { count: 3 }, /count/],
    ['duplicate frames', { frames: ['a.ply', 'a.ply'] }, /duplicate/],
    ['path escape', { frames: ['../x.ply', 'b.ply'] }, /local files/],
    ['bad hash', { frame_sha256: ['nope', hex('b')] }, /SHA-256/],
    ['loop out of range', { loops: { idle: { start: 1, count: 2 } } }, /loop idle/],
    ['zero fps', { fps: 0 }, /fps/],
  ])('rejects %s', (_, patch, re) => {
    expect(() => validateSequence({ ...good(), ...patch })).toThrow(re);
  });
  it('binds a motion track to the frame order and byte length', () => {
    const motion: MotionRecord = {
      schema: 'wander.person-motion/1',
      file: 'motion.u16',
      dtype: 'uint16',
      frames: 2,
      splats: 10,
      channels: ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3'],
      frameFiles: ['frame_000.ply', 'frame_001.ply'],
      base: { file: 'frame_000.ply', bytes: 1, sha256: hex('a') },
      bytes: 2 * 10 * 7 * 2,
      sha256: hex('c'),
      min: [0, 0, 0, 0, 0, 0, 0],
      scale: [1, 1, 1, 1, 1, 1, 1],
    };
    expect(() => validateSequence({ ...good(), motion })).not.toThrow();
    expect(() => validateSequence({ ...good(), motion: { ...motion, bytes: 5 } })).toThrow(/byte length/);
    expect(() => validateSequence({ ...good(), motion: { ...motion, frameFiles: ['frame_001.ply', 'frame_000.ply'] } })).toThrow(/order/);
  });
});

describe('gaussian PLY', () => {
  it('parses the packaged layout and rejects lookalikes', () => {
    const p = parseGaussianPly(ply([splat(0, 0, 0), splat(1, 2, 3)]));
    expect(p.n).toBe(2);
    expect(Array.from(p.data.slice(14, 17))).toEqual([1, 2, 3]);
    expect(() => parseGaussianPly(new TextEncoder().encode('<!doctype html>').buffer as ArrayBuffer)).toThrow(/not a PLY/);
    expect(() => parseGaussianPly(ply([[0, 0, 0]], ['x', 'y', 'z']))).toThrow(/gaussian properties/);
    expect(() => parseGaussianPly(ply([splat(0, 0, 0)]).slice(0, -4))).toThrow(/header promises/);
  });

  it('measures height from opaque splats only', () => {
    const rows = Array.from({ length: 200 }, (_, i) => splat(0.1, (1.7 * i) / 199, 0));
    rows.push(splat(0, 9, 0, -9), splat(0, -5, 0, -9)); // faint floaters far above/below
    const m = measurePly(parseGaussianPly(ply(rows)));
    expect(m.height).toBeCloseTo(1.7, 1);
    expect(m.feetY).toBeCloseTo(0, 1);
    expect(m.max[1]).toBe(9); // the raw bbox still sees them
    // an OpenCV (y-down) frame measured along -y gives the same stature
    const flipped = rows.map((r) => [r[0]!, -r[1]!, ...r.slice(2)]);
    expect(measurePly(parseGaussianPly(ply(flipped)), -1).height).toBeCloseTo(1.7, 1);
  });

  it('decodes uint16 and float32 motion frames', () => {
    const m = { frames: 2, splats: 1, dtype: 'uint16', min: [0, 1, 2, 0, 0, 0, 0], scale: [0.5, 0.5, 0.5, 1, 1, 1, 1] } as MotionRecord;
    const codes = new Uint16Array([0, 0, 0, 1, 0, 0, 0, 2, 4, 6, 1, 0, 0, 0]);
    expect(Array.from(decodeMotionFrame(codes.buffer, m, 1))).toEqual([1, 3, 5, 1, 0, 0, 0]);
    const f = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0.25, 0.5, 0.75, 1, 0, 0, 0]);
    expect(Array.from(decodeMotionFrame(f.buffer, { ...m, dtype: 'float32' }, 1))).toEqual([0.25, 0.5, 0.75, 1, 0, 0, 0]);
    expect(() => decodeMotionFrame(f.buffer, m, 2)).toThrow(RangeError);
  });
});

describe.skipIf(!hasNumpy)('Python packager -> TypeScript reader round trip', () => {
  it('reads what worker/lhm_stages/package_actor.py writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seq-'));
    try {
      execFileSync('python3', [join(REPO, 'worker/tests/make_synthetic_actor.py'), dir, '--frames', '6', '--talk', '3'], { stdio: 'pipe' });
      const seqDir = join(dir, 'sequence');
      const seq = validateSequence(JSON.parse(readFileSync(join(seqDir, 'sequence.json'), 'utf8')));
      expect(seq.count).toBe(9);
      expect(seq.loops).toEqual({ idle: { start: 0, count: 6 }, talk: { start: 6, count: 3 } });
      expect(seq.avatarFrame?.forward).toEqual([0, 0, -1]);
      const f0 = parseGaussianPly(ab(readFileSync(join(seqDir, seq.frames[0]!))));
      const m = measurePly(f0);
      expect(m.feetY).toBeCloseTo(0, 1);
      expect(m.height).toBeCloseTo(seq.nativeHeight!, 2);
      const track = ab(readFileSync(join(seqDir, seq.motion!.file)));
      expect(track.byteLength).toBe(seq.motion!.bytes);
      // the track's frame 0 equals frame_000.ply's centres within the recorded quantisation error
      const k = decodeMotionFrame(track, seq.motion!, 0);
      const np = f0.props.length;
      for (let i = 0; i < f0.n; i += 97) expect(Math.abs(k[i * 7 + 1]! - f0.data[i * np + 1]!)).toBeLessThan(1e-3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

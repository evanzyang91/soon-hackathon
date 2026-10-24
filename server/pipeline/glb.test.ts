import { describe, expect, it } from 'vitest';
import { encodeGlb, glbTriangles, GlbError, parseGlb } from './glb.ts';

const square = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);

describe('GLB reader', () => {
  it('reads an indexed triangle list back as a triangle soup', () => {
    const tris = glbTriangles(encodeGlb(square, Uint32Array.from([0, 1, 2, 0, 2, 3])));
    expect(Array.from(tris)).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1]);
  });

  it('reads non-indexed primitives', () => {
    const tris = glbTriangles(encodeGlb(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0])));
    expect(Array.from(tris)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('applies node transforms (TRS and matrix)', () => {
    const one = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // 90° about Y: (1,0,0) → (0,0,-1); then scale 2 and translate y + 5
    const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const t = glbTriangles(encodeGlb(one, undefined, { rotation: q, scale: [2, 2, 2], translation: [0, 5, 0] }));
    const close = (a: ArrayLike<number>, b: number[]) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 6));
    close(t, [0, 5, -2, 0, 7, 0, 2, 5, 0]);
    const m = glbTriangles(encodeGlb(one, undefined, { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1] }));
    close(m, [4, 0, 0, 3, 1, 0, 3, 0, 1]);
  });

  it('rejects files that are not GLB 2.0', () => {
    expect(() => parseGlb(new Uint8Array(40))).toThrow(GlbError);
    const bad = encodeGlb(square, Uint32Array.from([0, 1, 9]));
    expect(() => glbTriangles(bad)).toThrow(/out of range/);
  });
});

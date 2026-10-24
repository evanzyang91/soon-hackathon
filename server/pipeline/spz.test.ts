import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mockWorldSplats } from './mock-world.ts';
import { decodeSpz, encodeSpz, isGzip, readSpzHeader, type Splat } from './spz.ts';

describe('spz', () => {
  it('round-trips positions, colors, opacity and scale within quantization error', () => {
    const splats: Splat[] = [
      { position: [1.25, -0.5, 3], scale: [0.05, 0.01, 0.2], rgb: [0.9, 0.2, 0.4], opacity: 0.8 },
      {
        position: [-100, 20.125, -0.001],
        scale: [1, 1, 1],
        rgb: [0.5, 0.5, 0.5],
        opacity: 0.1,
        rotation: [0, 0.7071, 0, 0.7071],
      },
    ];
    const gz = encodeSpz(splats);
    expect(isGzip(gz)).toBe(true);
    expect(readSpzHeader(gz)).toEqual({
      version: 2,
      numPoints: 2,
      shDegree: 0,
      fractionalBits: 12,
      flags: 0,
    });
    const { splats: back } = decodeSpz(gz);
    for (let i = 0; i < splats.length; i++) {
      const a = splats[i]!;
      const b = back[i]!;
      for (let k = 0; k < 3; k++) {
        expect(b.position[k]).toBeCloseTo(a.position[k]!, 3);
        expect(b.rgb[k]).toBeCloseTo(a.rgb[k]!, 1);
        expect(b.scale[k]! / a.scale[k]!).toBeGreaterThan(0.95);
        expect(b.scale[k]! / a.scale[k]!).toBeLessThan(1.05);
      }
      expect(b.opacity).toBeCloseTo(a.opacity, 2);
    }
    expect(back[1]!.rotation![1]).toBeCloseTo(0.7071, 1);
  });

  it('rejects non-gzip and non-SPZ data', () => {
    expect(() => readSpzHeader(Buffer.from('plain text'))).toThrow(/gzip/);
  });

  it('ships a mock world fixture that matches the generator and sits in front of the start camera', () => {
    const gz = readFileSync(new URL('../../fixtures/mock-world/world.spz', import.meta.url));
    const { header, splats } = decodeSpz(gz);
    expect(header.numPoints).toBe(mockWorldSplats().length);
    expect(gz.length).toBeLessThan(10 * 1024 * 1024);
    // Stored in OpenCV frame: flip 180° about X to get Y-up world coordinates.
    const world = splats.map((s) => [s.position[0], -s.position[1], -s.position[2]] as const);
    const floor = world.filter(([, y]) => Math.abs(y) < 0.01);
    expect(floor.length).toBeGreaterThan(10000);
    expect(Math.min(...world.map(([, y]) => y))).toBeGreaterThan(-0.01); // nothing below the floor
    // Plenty of splats inside a 50° frustum from (0, 1.6, 0) looking down -Z.
    const visible = world.filter(
      ([x, y, z]) => z < -1 && Math.abs(x / -z) < 0.6 && Math.abs((y - 1.6) / -z) < 0.45,
    );
    expect(visible.length).toBeGreaterThan(5000);
  });
});

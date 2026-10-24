import { describe, expect, it } from 'vitest';
import { PathSampler, headingFor } from './dynamics-path';

const line = () =>
  new PathSampler(
    [
      [0, 0, 0],
      [10, 0, 0],
    ],
    { speed: 2, loop: true, pauseSeconds: 3 },
  );

describe('PathSampler', () => {
  it('moves at constant speed along a straight path', () => {
    const p = line();
    expect(p.length).toBeCloseTo(10, 3);
    expect(p.travelSeconds).toBeCloseTo(5, 3);
    expect(p.cycleSeconds).toBeCloseTo(8, 3);
    const s = p.sample(2.5);
    expect(s.phase).toBe('moving');
    expect(s.position[0]).toBeCloseTo(5, 2);
    expect(s.position[2]).toBeCloseTo(0, 6);
    expect(s.distance).toBeCloseTo(5, 2);
  });

  it('faces the direction of travel (forward = -Z)', () => {
    const s = line().sample(1);
    // travelling +X: forward (-Z) rotated by yaw must point at +X → yaw = -π/2
    expect(s.heading).toBeCloseTo(-Math.PI / 2, 5);
    expect(headingFor(0, -1)).toBeCloseTo(0);
    expect(Math.abs(headingFor(0, 1))).toBeCloseTo(Math.PI);
  });

  it('pauses at the end, then loops back to the start', () => {
    const p = line();
    const paused = p.sample(6);
    expect(paused.phase).toBe('paused');
    expect(paused.position[0]).toBeCloseTo(10, 3);
    const looped = p.sample(8 + 1);
    expect(looped.phase).toBe('moving');
    expect(looped.position[0]).toBeCloseTo(2, 2);
    expect(p.sample(8 * 7 + 2.5).position[0]).toBeCloseTo(5, 2);
  });

  it('stays at the end when loop is false', () => {
    const p = new PathSampler(
      [
        [0, 0, 0],
        [0, 0, -4],
      ],
      { speed: 1, loop: false, pauseSeconds: 2 },
    );
    expect(p.sample(100).phase).toBe('done');
    expect(p.sample(100).position[2]).toBeCloseTo(-4, 3);
    expect(p.sample(100).heading).toBeCloseTo(0, 5);
  });

  it('treats a path ending at its start as closed (no pause, no jump)', () => {
    const p = new PathSampler(
      [
        [0, 0, 0],
        [4, 0, 0],
        [4, 0, -4],
        [0, 0, -4],
        [0, 0, 0],
      ],
      { speed: 4, loop: true, pauseSeconds: 5 },
    );
    expect(p.closed).toBe(true);
    expect(p.cycleSeconds).toBeCloseTo(p.travelSeconds, 6);
    const a = p.sample(p.cycleSeconds - 1e-3).position;
    const b = p.sample(p.cycleSeconds + 1e-3).position;
    expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeLessThan(0.05);
  });

  it('follows a smooth curve through every control point', () => {
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [5, 0, -5],
      [10, 0, 0],
    ];
    const p = new PathSampler(pts, { speed: 1, loop: true, pauseSeconds: 0 });
    let best = Infinity;
    for (let t = 0; t <= p.travelSeconds; t += 0.01) {
      const q = p.sample(t).position;
      best = Math.min(best, Math.hypot(q[0] - 5, q[2] + 5));
    }
    expect(best).toBeLessThan(0.05);
  });

  it('is safe for degenerate input', () => {
    const p = new PathSampler([[1, 0, 1]], { speed: 1, loop: true, pauseSeconds: 1 });
    expect(p.sample(3)).toMatchObject({ position: [1, 0, 1], phase: 'done' });
    expect(line().sample(-5).position[0]).toBeCloseTo(0, 6);
    expect(line().sample(Number.NaN).position[0]).toBeCloseTo(0, 6);
  });
});

import { describe, expect, it } from 'vitest';
import { LEVELS, perfLabel, RenderGovernor } from './render-governor.ts';

/** Simulate `seconds` of a 20 ms timer whose gaps are `gap(t)` ms. */
function feed(g: RenderGovernor, startMs: number, seconds: number, gap: (t: number) => number) {
  let t = startMs;
  const end = startMs + seconds * 1000;
  while (t < end) {
    const d = gap(t);
    t += d;
    g.observeGap(t, d);
  }
  return t;
}

describe('RenderGovernor', () => {
  it('stays at full quality while the main thread is healthy', () => {
    const g = new RenderGovernor();
    feed(g, 0, 30, () => 20);
    expect(g.level).toBe(0);
    expect(g.shouldRender(0)).toBe(true);
  });

  it('ignores a single hiccup (scene load, GC)', () => {
    const g = new RenderGovernor();
    let t = feed(g, 0, 3, () => 20);
    t = feed(g, t, 1, (x) => (x < t + 30 ? 300 : 20));
    feed(g, t, 5, () => 20);
    expect(g.level).toBe(0);
  });

  it('steps down under sustained stalls, skipping levels when severe, down to 3D paused', () => {
    const changes: number[] = [];
    const g = new RenderGovernor();
    g.onChange = (l) => changes.push(l);
    feed(g, 0, 3, () => 150); // moderate: one level
    expect(g.level).toBe(1);
    feed(g, 3000, 8, () => 600); // severe (SwiftShader-like): two levels per decision
    expect(g.level).toBe(LEVELS.length - 1);
    expect(g.current.render3d).toBe(false);
    expect(g.shouldRender(1e9)).toBe(false);
    expect(changes[0]).toBe(1);
  });

  it('throttles frames by the level interval', () => {
    const g = new RenderGovernor();
    g.level = 2; // 100 ms
    g.rendered(1000);
    expect(g.shouldRender(1050)).toBe(false);
    expect(g.shouldRender(1100)).toBe(true);
  });

  it('recovers after clean windows, and waits longer to retry a level that failed', () => {
    const g = new RenderGovernor({ upAfterWindows: 5 });
    let t = feed(g, 0, 3, () => 150);
    expect(g.level).toBe(1);
    t = feed(g, t, 5.5, () => 20); // level 0 failed once → needs 10 clean windows now
    expect(g.level).toBe(1);
    t = feed(g, t, 6, () => 20);
    expect(g.level).toBe(0);
  });

  it('can be disabled (always renders at full quality)', () => {
    const g = new RenderGovernor({ enabled: false });
    feed(g, 0, 10, () => 800);
    expect(g.level).toBe(0);
    expect(g.shouldRender(5)).toBe(true);
  });
});

describe('perfLabel', () => {
  it('shows fps and the governor level while 3D renders, and why when it does not', () => {
    expect(perfLabel({ view: 'webgl', level: 0, fps: 47.6 })).toBe('48 fps · full');
    expect(perfLabel({ view: 'webgl', level: 2, fps: 9.8 })).toBe('10 fps · low');
    expect(perfLabel({ view: 'webgl', level: LEVELS.length - 1, fps: 0 })).toBe('3D paused');
    expect(perfLabel({ view: 'loading', level: 0, fps: 0 })).toBe('loading 3D…');
    expect(perfLabel({ view: 'waiting', level: 0, fps: 0 })).toBe('no scene yet');
    expect(perfLabel({ view: 'off', level: 0, fps: 0 })).toBe('2D viewfinder');
    expect(perfLabel({ view: 'unavailable', level: 0, fps: 0 })).toBe('3D unavailable');
  });
});

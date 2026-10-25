import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DynamicElementKind, type DynamicElement, type Vec3 } from '@shared/schema';
import { createProp, DEFAULT_COLOR, propColor, type Prop } from './props';
import { createDynamics } from './dynamics';

type Kind = DynamicElement['kind'];
type Range = [number, number];

/** Bounds at rest (metres): width = x, height = y, length = z (the direction of travel). */
const SIZES: Record<Kind, { w: Range; h: Range; l: Range }> = {
  car: { w: [1.6, 2.1], h: [1.3, 1.7], l: [4, 5] },
  bus: { w: [2.3, 2.8], h: [2.8, 3.3], l: [10, 12] },
  truck: { w: [2.3, 2.7], h: [2.8, 3.4], l: [6.5, 8] },
  motorcycle: { w: [0.5, 1], h: [1.3, 1.9], l: [1.8, 2.3] },
  bicycle: { w: [0.2, 0.6], h: [1.6, 1.9], l: [1.5, 2] },
  pedestrian: { w: [0.3, 0.6], h: [1.6, 1.9], l: [0.2, 0.6] },
  bird: { w: [0.4, 0.9], h: [0.1, 0.4], l: [0.3, 0.7] },
  dog: { w: [0.2, 0.45], h: [0.6, 1.0], l: [0.8, 1.3] },
  horse: { w: [0.4, 0.8], h: [2.0, 2.4], l: [2.2, 2.9] },
  wagon: { w: [1.5, 2.2], h: [2.3, 3.3], l: [5.5, 7] },
  boat: { w: [1.6, 2.4], h: [2, 3.2], l: [4.5, 5.5] },
  dragon: { w: [8, 12], h: [3, 6], l: [8, 13] },
  drone: { w: [0.4, 0.7], h: [0.1, 0.3], l: [0.4, 0.7] },
  spacecraft: { w: [6, 10], h: [1.5, 3], l: [6, 10] },
  generic: { w: [0.9, 1.1], h: [0.9, 1.1], l: [1.4, 1.6] },
};

const KINDS = DynamicElementKind.options;

function bounds(o: THREE.Object3D) {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o);
}

function triangles(o: THREE.Object3D) {
  let n = 0;
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      const g = c.geometry as THREE.BufferGeometry;
      n += (g.index ? g.index.count : g.attributes.position!.count) / 3;
    }
  });
  return n;
}

function colours(o: THREE.Object3D) {
  const out = new Set<string>();
  o.traverse((c) => {
    if (!(c instanceof THREE.Mesh)) return;
    for (const m of [c.material].flat() as THREE.MeshStandardMaterial[])
      if (m.color) out.add(`#${m.color.getHexString()}`);
  });
  return out;
}

/** Steps the prop the way the drivers do: position + heading first, then animate. */
function run(
  prop: Prop,
  seconds: number,
  at: (t: number) => { p: Vec3; yaw?: number; d?: number },
) {
  for (let i = 0; i <= Math.round(seconds * 30); i++) {
    const t = i / 30;
    const s = at(t);
    prop.object.position.set(...s.p);
    prop.object.rotation.y = s.yaw ?? 0;
    prop.animate(s.d ?? t * 5, t);
  }
}

function finite(o: THREE.Object3D) {
  let ok = true;
  o.updateMatrixWorld(true);
  o.traverse((c) => {
    if (!c.matrixWorld.elements.every(Number.isFinite)) ok = false;
  });
  return ok;
}

const element = (
  kind: Kind,
  path: Vec3[],
  extra: Partial<DynamicElement> = {},
): DynamicElement => ({
  id: `e-${kind}`,
  kind,
  label: '',
  path,
  speed: 10,
  loop: true,
  pauseSeconds: 0,
  scale: 1,
  ...extra,
});

describe('createProp', () => {
  for (const kind of KINDS) {
    it(`${kind}: builds at a believable size, under ~3k triangles`, () => {
      const prop = createProp(kind, '');
      prop.animate(0, 0);
      const size = bounds(prop.object).getSize(new THREE.Vector3());
      const want = SIZES[kind];
      expect(size.x, 'width').toBeGreaterThanOrEqual(want.w[0]);
      expect(size.x, 'width').toBeLessThanOrEqual(want.w[1]);
      expect(size.y, 'height').toBeGreaterThanOrEqual(want.h[0]);
      expect(size.y, 'height').toBeLessThanOrEqual(want.h[1]);
      expect(size.z, 'length').toBeGreaterThanOrEqual(want.l[0]);
      expect(size.z, 'length').toBeLessThanOrEqual(want.l[1]);
      expect(triangles(prop.object)).toBeLessThanOrEqual(3000);
      expect(prop.object.name).toBe(`prop:${kind}`);
      prop.dispose();
    });
  }

  it('every kind and label variant animates for a few seconds without throwing or NaNs', () => {
    const labels = ['', 'a rider gallops past', 'a stagecoach', 'a covered wagon', 'a sailboat'];
    for (const kind of KINDS) {
      for (const label of labels) {
        const prop = createProp(kind, label);
        // moving forward, turning and climbing, as a path would
        run(prop, 2, (t) => ({ p: [Math.sin(t) * 5, 3 + t, -t * 8], yaw: t * 0.4 }));
        expect(finite(prop.object), `${kind} "${label}"`).toBe(true);
        expect(triangles(prop.object), `${kind} "${label}"`).toBeLessThanOrEqual(3000);
        prop.dispose();
      }
    }
  });

  it('dispose() releases every geometry and material', () => {
    for (const kind of KINDS) {
      const prop = createProp(kind, kind === 'wagon' ? 'a covered wagon' : 'a rider');
      const pending = new Set<THREE.EventDispatcher<{ dispose: object }>>();
      prop.object.traverse((c) => {
        if (!(c instanceof THREE.Mesh)) return;
        for (const r of [c.geometry, ...[c.material].flat()] as THREE.EventDispatcher<{
          dispose: object;
        }>[]) {
          if (pending.has(r)) continue;
          pending.add(r);
          r.addEventListener('dispose', () => pending.delete(r));
        }
      });
      expect(pending.size).toBeGreaterThan(0);
      prop.dispose();
      expect(pending.size, kind).toBe(0);
    }
  });

  it('a horse carries a rider when the label says so', () => {
    const ridden = createProp('horse', 'a rider gallops past');
    const grazing = createProp('horse', 'a horse grazes');
    const riderless = createProp('horse', 'a riderless horse wanders off');
    expect(ridden.object.getObjectByName('rider')).toBeDefined();
    expect(grazing.object.getObjectByName('rider')).toBeUndefined();
    expect(riderless.object.getObjectByName('rider')).toBeUndefined();
    for (const label of ['a cowboy rides into town', 'cavalry on horseback', 'a mounted knight']) {
      expect(createProp('horse', label).object.getObjectByName('rider'), label).toBeDefined();
    }
    // the rider adds height: the hat sits above the horse's ears
    expect(bounds(ridden.object).max.y).toBeGreaterThan(bounds(grazing.object).max.y + 0.2);
  });

  it('a wagon is a closed coach, a covered wagon or an open bed, behind two horses', () => {
    const coach = createProp('wagon', 'a stagecoach rolls into town');
    const covered = createProp('wagon', 'a covered wagon creaks by');
    const open = createProp('wagon', 'a farm cart');
    expect(bounds(coach.object).max.y).toBeGreaterThan(2.9); // cabin roof + luggage
    expect(bounds(open.object).max.y).toBeLessThan(2.7); // the driver's hat is the top
    expect(colours(covered.object).has('#e6dcc3')).toBe(true); // canvas
    expect(colours(open.object).has('#e6dcc3')).toBe(false);
    for (const w of [coach, covered, open])
      expect(w.object.getObjectByName('driver')).toBeDefined();
    // the team takes the colour named before "horses"; the cart keeps its own
    const white = createProp('wagon', 'a black buggy pulled by two white horses');
    expect(colours(white.object).has(propColor('white', ''))).toBe(true);
    expect(colours(white.object).has(propColor('black', ''))).toBe(true);
  });

  it('takes the label colour, else the kind default', () => {
    for (const kind of [
      'truck',
      'motorcycle',
      'dog',
      'horse',
      'boat',
      'dragon',
      'drone',
      'spacecraft',
    ] as const) {
      expect(colours(createProp(kind, `a red ${kind}`).object).has('#c0392b'), kind).toBe(true);
      expect(colours(createProp(kind, `a ${kind}`).object).has(DEFAULT_COLOR[kind]), kind).toBe(
        true,
      );
    }
  });

  it('wheels roll and legs cycle with distance; wings, rotors, tails and hulls move with time', () => {
    const pose = (kind: Kind, label: string, d: number, t: number) => {
      const p = createProp(kind, label);
      p.animate(d, t);
      const out: number[] = [];
      p.object.traverse((c) => out.push(c.position.y, c.rotation.x, c.rotation.y, c.rotation.z));
      p.dispose();
      return out.join(',');
    };
    // distance-driven: same time, different distance
    for (const [kind, label] of [
      ['truck', ''],
      ['motorcycle', ''],
      ['dog', ''],
      ['horse', 'a horse walks'],
      ['wagon', 'a stagecoach'],
    ] as const) {
      expect(pose(kind, label, 0.4, 1), kind).not.toBe(pose(kind, label, 0, 1));
    }
    // time-driven: same distance, different time
    for (const kind of ['dog', 'boat', 'dragon', 'drone', 'spacecraft'] as const) {
      expect(pose(kind, '', 0, 0.37), kind).not.toBe(pose(kind, '', 0, 0));
    }
  });
});

describe('createDynamics with the genre kinds', () => {
  const step = (rt: ReturnType<typeof createDynamics>, seconds: number) => {
    for (let i = 0; i <= Math.round(seconds * 30); i++) rt.update(i / 30);
  };

  it('flyers keep the path height (nothing snaps them to y = 0) and pitch with the climb', () => {
    const up = createDynamics([
      element('dragon', [
        [0, 12, 0],
        [0, 20, -40],
      ]),
    ]);
    const down = createDynamics([
      element('spacecraft', [
        [0, 30, 0],
        [0, 22, -40],
      ]),
    ]);
    const level = createDynamics([
      element(
        'drone',
        [
          [0, 3, 0],
          [6, 3, 0],
        ],
        { speed: 2 },
      ),
    ]);
    step(up, 2);
    step(down, 2);
    step(level, 2);
    const dragon = up.items[0]!.object;
    expect(dragon.position.y).toBeGreaterThan(12);
    // its origin is under its feet: the whole body flies above the path (a climbing tail dips a little)
    expect(bounds(dragon).min.y).toBeGreaterThan(dragon.position.y - 0.4);
    expect(dragon.getObjectByName('attitude')!.rotation.x).toBeGreaterThan(0.08); // nose up
    const ship = down.items[0]!.object;
    expect(ship.position.y).toBeLessThan(30);
    expect(ship.position.y).toBeGreaterThan(22);
    expect(ship.getObjectByName('attitude')!.rotation.x).toBeLessThan(-0.08); // nose down
    const drone = level.items[0]!.object;
    expect(drone.position.y).toBeCloseTo(3, 5);
    expect(bounds(drone).min.y).toBeGreaterThan(2.95);
    // a quadcopter flying forward noses down a little
    expect(drone.getObjectByName('attitude')!.rotation.x).toBeLessThan(-0.02);
    for (const rt of [up, down, level]) rt.dispose();
  });

  it('a boat rides its water plane, below y = 0 if that is where the water is', () => {
    const rt = createDynamics([
      element(
        'boat',
        [
          [0, -0.6, 0],
          [20, -0.6, 0],
        ],
        { speed: 3 },
      ),
    ]);
    step(rt, 1);
    const o = rt.items[0]!.object;
    expect(o.position.y).toBeCloseTo(-0.6, 5);
    expect(bounds(o).min.y).toBeLessThan(-0.9); // the hull reaches below the waterline
    rt.dispose();
  });

  it('a motorcycle leans into a turn', () => {
    // clockwise seen from above (heading decreasing): a right turn, the bike leans right (-z roll)
    const ring: Vec3[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ring.push([15 * Math.cos(a), 0, 15 * Math.sin(a)]);
    }
    const rt = createDynamics([element('motorcycle', ring)]);
    step(rt, 2);
    expect(rt.items[0]!.object.getObjectByName('lean')!.rotation.z).toBeLessThan(-0.2);
    rt.dispose();
  });

  it('the older kinds still move along their paths, facing the direction of travel', () => {
    const kinds: Kind[] = ['car', 'bus', 'bicycle', 'pedestrian', 'bird', 'generic'];
    const rt = createDynamics(
      kinds.map((k) =>
        element(
          k,
          [
            [0, k === 'bird' ? 4 : 0, 0],
            [20, k === 'bird' ? 4 : 0, 0],
          ],
          { id: k, speed: 4 },
        ),
      ),
    );
    const before = rt.positions();
    rt.update(1);
    const after = rt.positions();
    for (let i = 0; i < kinds.length; i++) {
      expect(after[i]!.position[0] - before[i]!.position[0], kinds[i]).toBeCloseTo(4, 1);
      expect(after[i]!.position[1], kinds[i]).toBeCloseTo(kinds[i] === 'bird' ? 4 : 0, 5);
      // heading toward +x: yaw = atan2(-1, 0) = -π/2
      expect(rt.items[i]!.object.rotation.y, kinds[i]).toBeCloseTo(-Math.PI / 2, 3);
    }
    rt.dispose();
  });
});

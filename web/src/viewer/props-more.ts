// Label-driven bodies for the aircraft and the animals / monsters (DynamicElementKind airplane,
// helicopter, creature), built like props.ts from three.js primitives, sized in metres and facing
// -Z. Origins: an airplane's is under its wheels (or floats) at rest and a helicopter's under its
// skids, so a path at y = 0 parks them on the ground and a path at height h flies them there; a
// creature's is on the ground under its feet.
//
//   airplane   airliner (default, ~31 m) · jet / fighter (~16 m) · biplane (~8 m) · propeller /
//              light aircraft (~9 m) · seaplane (floats). Pitches with the climb, banks into turns,
//              gear down only near the ground, props spin, a fighter's afterburner pulses.
//   helicopter cabin, tail boom, main + tail rotor, skids (~12 m with the rotor). Bobs while it
//              hovers (speed 0), noses down to fly, banks into turns. police / news / rescue /
//              military recolour it.
//   creature   the label names the species (dinosaur, t-rex, raptor, elephant, bear, wolf, deer,
//              lion, cow, sheep, cat, giraffe, triceratops, troll …): a quadruped (body, neck, head,
//              tail, four legs), a biped (a dinosaur's big tail and short arms; a kangaroo hops, an
//              ostrich runs) or an upright giant (troll, ogre, yeti). huge / giant / massive 2×,
//              small / little 0.5×; a herd / pack is three of them. Legs cycle with distance; the
//              tail, head and breathing move with time, also when it stands (speed 0).
//
// Every body stays under ~3k triangles (a herd of three small animals included).
import * as THREE from 'three';
import {
  Builder,
  MotionProbe,
  flatPolygon,
  gaitPose,
  leg,
  propColor,
  shade,
  type Gait,
  type LegRig,
  type Prop,
  type V3,
} from './props';

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** The colour the label names, or undefined (propColor's own words). */
const labelColor = (label: string) => propColor(label, '') || undefined;

/** A swept / straight flying surface: `points` [x, z] in the wing plane, `depth` m thick, below y = 0. */
function slab(points: [number, number][], depth: number) {
  const geo = new THREE.ExtrudeGeometry(
    new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z))),
    { depth, bevelEnabled: false },
  );
  geo.rotateX(Math.PI / 2); // shape y → scene z; the extrusion becomes the thickness (downwards)
  geo.translate(0, depth / 2, 0);
  return geo;
}

/** A vertical fin: `points` [z, y] in the plane x = 0, `depth` m thick. */
function fin(points: [number, number][], depth: number) {
  const geo = new THREE.ExtrudeGeometry(
    new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y))),
    { depth, bevelEnabled: false },
  );
  geo.rotateY(-Math.PI / 2); // shape x → scene z; the extrusion runs along -x
  geo.translate(depth / 2, 0, 0);
  return geo;
}

/** A cylinder lying along Z (radiusFront at -Z). */
function tube(rFront: number, rBack: number, len: number, seg = 12, open = false) {
  const geo = new THREE.CylinderGeometry(rBack, rFront, len, seg, 1, open);
  geo.rotateX(Math.PI / 2); // top (+Y, radiusTop = rBack) → +Z
  return geo;
}

// ---- airplane ------------------------------------------------------------------------------------

type PlaneType = 'airliner' | 'jet' | 'biplane' | 'prop' | 'seaplane';

export function planeType(label: string): PlaneType {
  const l = label.toLowerCase();
  if (/\b(sea-?planes?|float-?planes?|flying boats?|amphibians?)\b/.test(l)) return 'seaplane';
  if (/\b(bi-?planes?|tri-?planes?|crop-?dust\w*|barnstorm\w*)\b/.test(l)) return 'biplane';
  if (
    /\b(airliners?|jetliners?|passenger|jumbo|commercial|cargo|transport|747|737|a3\d\d|boeing|airbus|bombers?)\b/.test(
      l,
    )
  )
    return 'airliner';
  if (/\b(fighters?|warplanes?|jets?|interceptors?|f-\d+\w*|mig-?\d*|stealth)\b/.test(l))
    return 'jet';
  if (
    /\b(propellers?|prop|props|light aircraft|cessnas?|pipers?|bush planes?|small planes?|single-engine|two-seaters?|trainers?|spotter planes?)\b/.test(
      l,
    )
  )
    return 'prop';
  return 'airliner';
}

/** A gear strut from `top` down to its wheels, in the gear group's ground frame; hidden in flight. */
function gearLeg(
  b: Builder,
  parent: THREE.Object3D,
  x: number,
  z: number,
  top: number,
  wheelR: number,
  pairs = 1,
) {
  const metal = b.mat('#9aa0a8', { metalness: 0.6, roughness: 0.4 });
  const tyre = b.mat('#1b1b1b', { roughness: 0.9 });
  b.rod([x, top, z], [x, wheelR, z], Math.max(0.05, wheelR * 0.18), metal, parent, 6);
  for (let k = 0; k < pairs; k++) {
    for (const s of [-1, 1]) {
      const w = b.add(
        new THREE.CylinderGeometry(wheelR, wheelR, wheelR * 0.6, 10),
        tyre,
        [x + s * wheelR * 0.5, wheelR, z + (k - (pairs - 1) / 2) * wheelR * 2.3],
        parent,
      );
      w.rotation.z = Math.PI / 2;
    }
  }
}

export function airplane(_color: string, label: string): Prop {
  const type = planeType(label);
  const named = labelColor(label);
  const military =
    /\b(military|army|air force|bombers?|warplanes?|fighters?|stealth|camo\w*)\b/i.test(label);
  const b = new Builder();
  const gear = new THREE.Group();
  gear.name = 'gear';
  const glass = b.mat('#1a2633', { metalness: 0.5, roughness: 0.2 });
  const dark = b.mat('#2a2d33', { metalness: 0.4, roughness: 0.5 });
  const red = b.mat('#ff4a4a', { emissive: '#ff2020', emissiveIntensity: 1.6 });
  const green = b.mat('#7dff9a', { emissive: '#20ff50', emissiveIntensity: 1.6 });
  const strobe = b.own(
    new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0 }),
  );
  const spinning: { node: THREE.Object3D; rate: number }[] = [];
  let glowMat: THREE.MeshStandardMaterial | null = null;
  let plume: THREE.Mesh | null = null;
  let cy: number; // fuselage axis height at rest (the attitude pivot)
  let att: THREE.Group;

  const propeller = (parent: THREE.Object3D, pos: V3, radius: number) => {
    const hub = b.pivot(pos, parent);
    b.add(
      new THREE.ConeGeometry(radius * 0.14, radius * 0.35, 8),
      dark,
      [0, 0, -radius * 0.12],
      hub,
    ).rotation.x = -Math.PI / 2;
    b.add(new THREE.BoxGeometry(radius * 2, radius * 0.12, 0.05), dark, [0, 0, 0], hub); // two blades
    const disc = b.add(
      new THREE.CircleGeometry(radius, 20),
      b.mat('#c8ccd2', { opacity: 0.18, doubleSided: true }),
      [0, 0, -0.02],
      hub,
    );
    disc.rotation.y = Math.PI;
    spinning.push({ node: hub, rate: 42 });
  };

  if (type === 'airliner') {
    const body = b.mat(named ?? (military ? '#7d848c' : '#e9edf1'), {
      metalness: 0.35,
      roughness: 0.45,
    });
    const accent = b.mat(named ? shade(named, -0.35) : military ? '#5b6168' : '#2e5aa8', {
      roughness: 0.5,
    });
    const r = 1.9;
    cy = 4.1;
    att = b.pivot([0, cy, 0]);
    const parts = att;
    b.add(tube(r, r, 18, 16), body, [0, 0, -1], parts);
    const nose = b.add(
      new THREE.SphereGeometry(r, 16, 10, 0, TAU, 0, Math.PI / 2),
      body,
      [0, 0, -10],
      parts,
    );
    nose.rotation.x = -Math.PI / 2; // the dome's pole (its local +Y) faces -Z
    nose.scale.set(1, 1.9, 1);
    const cone = tube(r, 0.35, 9, 16);
    // the tail cone sweeps up to the fin: each ring rises with its distance from the cabin
    const cp = cone.attributes.position!;
    for (let i = 0; i < cp.count; i++) cp.setY(i, cp.getY(i) + ((cp.getZ(i) + 4.5) / 9) * 1.1);
    cone.computeVertexNormals();
    b.add(cone, body, [0, 0, 12.5], parts);
    b.add(new THREE.BoxGeometry(1.4, 0.3, 0.9), glass, [0, 1.35, -11.8], parts).rotation.x = 0.5; // cockpit
    for (const s of [-1, 1]) {
      b.add(new THREE.BoxGeometry(0.05, 0.28, 17), glass, [s * r * 0.97, 0.55, -1], parts); // windows
      b.add(new THREE.BoxGeometry(0.05, 0.16, 20.5), accent, [s * r * 0.99, 0.05, -1.5], parts); // cheatline
    }
    const wing = slab(
      [
        [1, -3.2],
        [15, 4.6],
        [15, 6.3],
        [1, 3.6],
      ],
      0.4,
    );
    const stab = slab(
      [
        [0.3, 12.8],
        [6.2, 15.6],
        [6.2, 16.9],
        [0.3, 16.3],
      ],
      0.22,
    );
    for (const s of [-1, 1]) {
      const w = b.add(wing, body, [0, -r * 0.55, 0], parts);
      w.scale.x = s;
      w.rotation.z = s * 0.08; // dihedral
      const h = b.add(stab, body, [0, 0.8, 0], parts);
      h.scale.x = s;
      // engines under the wings, slung forward on pylons
      const ex = s * 5.6;
      b.add(tube(0.95, 0.8, 4.2, 14), accent, [ex, -r * 0.55 - 1.15, -1.8], parts);
      const intake = b.add(
        new THREE.CircleGeometry(0.8, 14),
        dark,
        [ex, -r * 0.55 - 1.15, -3.92],
        parts,
      );
      intake.rotation.y = Math.PI;
      b.add(new THREE.BoxGeometry(0.3, 0.9, 2.2), body, [ex, -r * 0.55 - 0.3, -1.2], parts); // pylon
      b.add(
        new THREE.SphereGeometry(0.12, 6, 4),
        s > 0 ? green : red,
        [s * 15, -r * 0.55 + 1.2, 5.5],
        parts,
      ); // wingtip light
    }
    b.add(
      fin(
        [
          [9.5, 1.2],
          [16.6, 1.2],
          [17.4, 8.2],
          [14.6, 8.2],
        ],
        0.35,
      ),
      accent,
      [0, 0, 0],
      parts,
    );
    b.add(new THREE.SphereGeometry(0.15, 6, 4), strobe, [0, 8.2, 17.2], parts);
    b.add(new THREE.SphereGeometry(0.16, 6, 4), red, [0, -r, 0], parts); // belly beacon
    parts.add(gear);
    gearLeg(b, gear, 0, -10.5, cy - r * 0.8, 0.45);
    for (const s of [-1, 1]) gearLeg(b, gear, s * 2.6, 1.2, cy - r * 0.6, 0.6, 2);
    gear.position.y = -cy;
  } else if (type === 'jet') {
    const body = b.mat(named ?? '#7d848c', { metalness: 0.45, roughness: 0.4 });
    const under = b.mat(shade(named ?? '#7d848c', 0.25), { metalness: 0.4, roughness: 0.45 });
    cy = 2.1;
    att = b.pivot([0, cy, 0]);
    b.add(tube(0.85, 0.95, 9.5, 12), body, [0, 0, 0.2], att);
    b.add(tube(0.01, 0.85, 4.6, 12), body, [0, -0.05, -6.85], att); // pointed nose
    b.add(tube(0.95, 0.7, 2.2, 12), dark, [0, 0, 6.05], att); // nozzle
    const canopy = b.add(
      new THREE.SphereGeometry(0.6, 12, 8, 0, TAU, 0, Math.PI / 2),
      glass,
      [0, 0.62, -3.8],
      att,
    );
    canopy.scale.set(0.95, 0.85, 2.4);
    glowMat = b.own(
      new THREE.MeshStandardMaterial({
        color: '#ffd9a0',
        emissive: '#ff8a2a',
        emissiveIntensity: 2,
      }),
    );
    const glow = b.add(new THREE.CircleGeometry(0.62, 14), glowMat, [0, 0, 7.12], att);
    glow.rotation.y = 0; // faces +Z, out of the nozzle
    plume = b.add(
      new THREE.ConeGeometry(0.55, 3, 12, 1, true),
      b.own(
        new THREE.MeshBasicMaterial({
          color: '#ffb060',
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      ),
      [0, 0, 8.6],
      att,
    );
    plume.rotation.x = Math.PI / 2;
    const wing = slab(
      [
        [0.7, -2.2],
        [6.2, 3.4],
        [6.2, 4.4],
        [0.7, 4.8],
      ],
      0.22,
    );
    const tail = slab(
      [
        [0.6, 4.6],
        [3.6, 6.3],
        [3.6, 7.0],
        [0.6, 7.1],
      ],
      0.15,
    );
    for (const s of [-1, 1]) {
      const w = b.add(wing, under, [0, -0.15, 0], att);
      w.scale.x = s;
      const t = b.add(tail, under, [0, -0.1, 0], att);
      t.scale.x = s;
      b.add(new THREE.BoxGeometry(0.62, 0.95, 3.4), body, [s * 1.05, -0.2, -1.2], att); // intakes
      const f = b.add(
        fin(
          [
            [3.8, 0.4],
            [6.6, 0.4],
            [7.1, 3.4],
            [5.9, 3.4],
          ],
          0.14,
        ),
        body,
        [s * 0.75, 0, 0],
        att,
      );
      f.rotation.z = -s * 0.32; // canted twin fins
      b.add(new THREE.SphereGeometry(0.08, 6, 4), s > 0 ? green : red, [s * 6.2, -0.15, 3.9], att);
    }
    att.add(gear);
    gearLeg(b, gear, 0, -4.2, cy - 0.6, 0.3);
    for (const s of [-1, 1]) gearLeg(b, gear, s * 1.5, 1.4, cy - 0.6, 0.38);
    gear.position.y = -cy;
  } else if (type === 'biplane') {
    const paint = named ?? '#d9a530';
    const body = b.mat(paint, { roughness: 0.6 });
    const wingM = b.mat(shade(paint, 0.15), { roughness: 0.65 });
    const wood = b.mat('#3b2a1c', { roughness: 0.7 });
    cy = 1.55;
    att = b.pivot([0, cy, 0]);
    b.add(tube(0.55, 0.22, 6.2, 8), body, [0, 0, 0.6], att);
    b.add(tube(0.62, 0.58, 0.9, 12), dark, [0, 0, -2.9], att); // engine cowling
    b.add(new THREE.BoxGeometry(9.8, 0.12, 1.5), wingM, [0, -0.5, -1.2], att);
    b.add(new THREE.BoxGeometry(9.8, 0.12, 1.5), wingM, [0, 1.15, -1.55], att);
    for (const s of [-1, 1]) {
      for (const dz of [-0.55, 0.45])
        b.rod([s * 3.3, -0.45, -1.2 + dz], [s * 3.3, 1.1, -1.55 + dz], 0.035, wood, att, 4);
      b.rod([s * 0.4, 0.4, -1.6], [s * 0.6, 1.1, -1.6], 0.03, wood, att, 4); // cabane
      b.add(new THREE.SphereGeometry(0.07, 6, 4), s > 0 ? green : red, [s * 4.9, 1.15, -1.55], att);
    }
    b.add(new THREE.BoxGeometry(3.2, 0.08, 0.9), wingM, [0, 0.1, 3.4], att); // stabiliser
    b.add(
      fin(
        [
          [2.9, 0.1],
          [3.9, 0.1],
          [3.9, 1.3],
          [3.4, 1.3],
        ],
        0.08,
      ),
      body,
      [0, 0, 0],
      att,
    );
    b.add(new THREE.BoxGeometry(0.62, 0.1, 0.9), b.mat('#111111'), [0, 0.5, 0.3], att); // open cockpit
    b.add(
      new THREE.SphereGeometry(0.16, 8, 6),
      b.mat('#5a3d26', { roughness: 0.6 }),
      [0, 0.75, 0.4],
      att,
    ); // pilot's leather helmet
    propeller(att, [0, 0, -3.4], 1.25);
    att.add(gear);
    for (const s of [-1, 1]) {
      gearLeg(b, gear, s * 0.85, -1.6, cy - 0.35, 0.36);
      b.rod([s * 0.85, cy - 0.35, -1.6], [s * 0.3, cy - 0.45, -1.1], 0.03, wood, gear, 4);
    }
    gear.position.y = -cy;
  } else {
    // a high-wing light aircraft; a seaplane rides on two floats instead of wheels
    const paint = named ?? '#e8e8e8';
    const body = b.mat(paint, { roughness: 0.5, metalness: 0.2 });
    const stripe = b.mat(named ? shade(named, -0.4) : '#c0392b', { roughness: 0.5 });
    const floats = type === 'seaplane';
    cy = floats ? 2.0 : 1.45;
    att = b.pivot([0, cy, 0]);
    b.add(tube(0.62, 0.25, 6.6, 10), body, [0, 0, 1.0], att);
    b.add(tube(0.5, 0.62, 1.2, 10), body, [0, 0, -2.75], att); // cowling
    b.add(new THREE.BoxGeometry(1.12, 0.5, 1.6), glass, [0, 0.42, -1.2], att); // cabin windows
    b.add(new THREE.BoxGeometry(11, 0.16, 1.55), body, [0, 0.82, -0.9], att);
    for (const s of [-1, 1]) {
      b.rod([s * 0.55, -0.3, -0.9], [s * 2.6, 0.75, -0.9], 0.04, body, att, 4); // wing strut
      b.add(new THREE.BoxGeometry(0.06, 0.1, 1.5), stripe, [s * 5.5, 0.82, -0.9], att);
      b.add(new THREE.SphereGeometry(0.07, 6, 4), s > 0 ? green : red, [s * 5.52, 0.82, -0.5], att);
    }
    b.add(new THREE.BoxGeometry(0.05, 0.18, 5.4), stripe, [0.62, -0.05, 0.6], att);
    b.add(new THREE.BoxGeometry(0.05, 0.18, 5.4), stripe, [-0.62, -0.05, 0.6], att);
    b.add(new THREE.BoxGeometry(3.4, 0.08, 1.0), body, [0, 0.12, 4.0], att);
    b.add(
      fin(
        [
          [3.4, 0.15],
          [4.5, 0.15],
          [4.5, 1.6],
          [3.9, 1.6],
        ],
        0.08,
      ),
      stripe,
      [0, 0, 0],
      att,
    );
    propeller(att, [0, 0, -3.45], 1.0);
    att.add(gear);
    gear.position.y = -cy;
    if (floats) {
      const fm = b.mat('#d8dce0', { roughness: 0.4, metalness: 0.3 });
      for (const s of [-1, 1]) {
        const f = b.add(new THREE.CapsuleGeometry(0.32, 5.2, 2, 8), fm, [s * 1.3, 0.32, -0.5], att);
        f.rotation.x = Math.PI / 2;
        f.position.y = 0.32 - cy;
        for (const dz of [-1.8, 0.8])
          b.rod([s * 1.3, 0.55 - cy, dz], [s * 0.4, -0.4, dz], 0.04, fm, att, 4);
      }
    } else {
      gearLeg(b, gear, 0, -2.2, cy - 0.4, 0.28);
      for (const s of [-1, 1]) gearLeg(b, gear, s * 1.2, -0.2, cy - 0.4, 0.32);
    }
  }
  const probe = new MotionProbe(b.group, 0.32, 0.6);
  return {
    object: b.group,
    animate: (_d, t) => {
      for (const s of spinning) s.node.rotation.z = t * s.rate;
      probe.update(t);
      att.rotation.x = probe.pitch;
      att.rotation.z = probe.bank;
      // gear down only near the ground (taxiing, landing, parked); a seaplane keeps its floats
      gear.visible = b.group.position.y < 8;
      strobe.emissiveIntensity = (t * 1.1) % 1 < 0.08 ? 3 : 0;
      if (glowMat && plume) {
        const pulse = 0.8 + 0.15 * Math.sin(t * 13) + 0.05 * Math.sin(t * 31);
        glowMat.emissiveIntensity = 1.6 + 1.4 * pulse;
        plume.scale.y = 0.75 + 0.4 * pulse;
        plume.position.z = 7.1 + 1.5 * plume.scale.y;
      }
    },
    dispose: () => b.dispose(),
  };
}

// ---- helicopter ----------------------------------------------------------------------------------

const HELI_LIVERY: [RegExp, string, string][] = [
  [/\bpolice|cops?|law enforcement|sheriff\b/i, '#1f3a7a', '#e8e8e8'],
  [/\b(news|tv|television|traffic|media)\b/i, '#e8e8e8', '#c0392b'],
  [
    /\b(rescue|medical|medevac|air ambulance|ambulance|coast ?guard|hospital|search and rescue)\b/i,
    '#c0392b',
    '#f2f2f2',
  ],
  [/\b(black hawks?|stealth)\b/i, '#2a2d30', '#3a3d42'],
  [/\b(military|army|gunships?|apache|chinook|huey|marines?|navy)\b/i, '#3f4a3a', '#2c3329'],
];

export function helicopter(color: string, label: string): Prop {
  const named = labelColor(label);
  const livery = HELI_LIVERY.find(([re]) => re.test(label));
  const paint = named ?? livery?.[1] ?? color;
  const trim = livery?.[2] ?? shade(paint, -0.45);
  const b = new Builder();
  const att = b.pivot([0, 1.6, 0]);
  att.name = 'attitude';
  const body = b.mat(paint, { metalness: 0.3, roughness: 0.45 });
  const trimM = b.mat(trim, { roughness: 0.5 });
  const glass = b.mat('#18242f', { metalness: 0.5, roughness: 0.15 });
  const dark = b.mat('#25282d', { metalness: 0.5, roughness: 0.5 });
  const cabin = b.add(new THREE.SphereGeometry(1.3, 16, 10), body, [0, 0, -0.4], att);
  cabin.scale.set(0.88, 0.82, 1.6);
  const nose = b.add(
    new THREE.SphereGeometry(1.0, 12, 8, 0, TAU, 0, Math.PI / 2),
    glass,
    [0, 0.1, -1.55],
    att,
  );
  nose.rotation.x = -Math.PI / 2;
  nose.scale.set(0.95, 0.85, 0.9);
  b.add(new THREE.BoxGeometry(2.33, 0.18, 3.2), trimM, [0, -0.2, -0.2], att); // livery band
  b.add(new THREE.BoxGeometry(1.1, 0.62, 2.3), body, [0, 1.05, 0.3], att); // engine housing
  b.add(tube(0.45, 0.2, 6.4, 8), body, [0, 0.38, 4.4], att); // tail boom
  b.add(
    fin(
      [
        [7.0, 0.25],
        [8.1, 0.3],
        [8.3, 2.1],
        [7.6, 2.1],
      ],
      0.12,
    ),
    trimM,
    [0, 0, 0],
    att,
  );
  b.add(new THREE.BoxGeometry(2.1, 0.07, 0.55), body, [0, 0.45, 6.4], att); // stabiliser
  b.rod([0, 1.35, 0.1], [0, 1.95, 0.1], 0.12, dark, att, 8); // mast
  const rotor = b.pivot([0, 2.0, 0.1], att);
  for (let i = 0; i < 4; i++) {
    const arm = b.pivot([0, 0, 0], rotor);
    arm.rotation.y = (i * Math.PI) / 2;
    b.add(new THREE.BoxGeometry(5.4, 0.06, 0.34), dark, [2.75, 0, 0], arm);
  }
  b.add(new THREE.CylinderGeometry(0.22, 0.22, 0.2, 10), dark, [0, 0, 0], rotor);
  b.add(
    new THREE.CylinderGeometry(5.5, 5.5, 0.02, 28),
    b.mat('#aab1ba', { opacity: 0.16, doubleSided: true }),
    [0, 0.02, 0],
    rotor,
  );
  const tailRotor = b.pivot([0.22, 1.55, 7.85], att);
  for (let i = 0; i < 2; i++)
    b.add(new THREE.BoxGeometry(0.05, 1.6, 0.16), dark, [0, 0, 0], tailRotor).rotation.x =
      (i * Math.PI) / 2;
  const tdisc = b.add(
    new THREE.CircleGeometry(0.82, 14),
    b.mat('#aab1ba', { opacity: 0.2, doubleSided: true }),
    [0.03, 0, 0],
    tailRotor,
  );
  tdisc.rotation.y = Math.PI / 2;
  // skids and their cross tubes
  for (const s of [-1, 1]) {
    b.rod([s * 1.15, -1.52, -2.1], [s * 1.15, -1.52, 1.7], 0.07, dark, att, 6);
    b.rod([s * 1.15, -1.52, -2.1], [s * 1.15, -1.3, -2.45], 0.07, dark, att, 6);
    for (const z of [-1.2, 0.9])
      b.rod([s * 1.15, -1.52, z], [s * 0.7, -0.75, z], 0.06, dark, att, 6);
  }
  const beacon = b.own(
    new THREE.MeshStandardMaterial({ color: '#ff5a5a', emissive: '#ff1a1a', emissiveIntensity: 0 }),
  );
  b.add(new THREE.SphereGeometry(0.1, 6, 4), beacon, [0, 2.1, 7.4], att);
  b.add(new THREE.SphereGeometry(0.1, 6, 4), beacon, [0, -1.1, -0.2], att);
  const probe = new MotionProbe(b.group, 0.2, 0.4);
  return {
    object: b.group,
    animate: (_d, t) => {
      rotor.rotation.y = -t * 26;
      tailRotor.rotation.x = t * 80;
      beacon.emissiveIntensity = (t * 0.9) % 1 < 0.12 ? 2.4 : 0;
      probe.update(t);
      const airborne = b.group.position.y > 0.5;
      const hovering = airborne && probe.speed < 1;
      // a hover is never still: a slow bob and sway; forward flight noses down and banks
      att.position.y =
        1.6 + (hovering ? 0.28 * Math.sin(t * 1.25) : airborne ? 0.06 * Math.sin(t * 2) : 0);
      att.rotation.x = airborne
        ? -clamp(probe.speed * 0.012, 0, 0.2) +
          probe.pitch +
          (hovering ? 0.025 * Math.sin(t * 0.7) : 0)
        : 0;
      att.rotation.z = airborne ? probe.bank + (hovering ? 0.035 * Math.sin(t * 0.9 + 1) : 0) : 0;
    },
    dispose: () => b.dispose(),
  };
}

// ---- creature ------------------------------------------------------------------------------------

type Body = 'quad' | 'theropod' | 'kangaroo' | 'ostrich' | 'upright';
type Feature =
  | 'trunk'
  | 'tusks'
  | 'horns'
  | 'brow-horns'
  | 'antlers'
  | 'palmate'
  | 'mane'
  | 'frill'
  | 'plates'
  | 'spikes'
  | 'stripes'
  | 'spots'
  | 'hump'
  | 'wool'
  | 'long-ears'
  | 'crest'
  | 'fur'
  | 'one-eye'
  | 'long-tail'
  | 'low';

interface Species {
  name: string;
  re: RegExp;
  body: Body;
  /** quad: height at the shoulder; theropod: nose to tail; the others: standing height (m). */
  size: number;
  color: string;
  /** quad proportions in shoulder heights: barrel length, barrel radius, neck length, head length, tail length. */
  len?: number;
  girth?: number;
  neck?: number;
  /** Neck angle above the horizontal (rad). */
  neckUp?: number;
  head?: number;
  /** Head width in shoulder heights, for big heads (elephant, hippo, triceratops). */
  headW?: number;
  tail?: number;
  features?: Feature[];
  /** Small animals trot; hoofed and big ones walk. */
  gait?: 'walk' | 'trot';
  /** Under-side / muzzle colour. */
  belly?: string;
}

// order matters: the first species whose words appear wins ("a t-rex" before "dinosaur")
const SPECIES: Species[] = [
  {
    name: 't-rex',
    re: /\b(t-?rex|tyrannosaur\w*|allosaur\w*|carnotaur\w*|giganotosaur\w*)\b/,
    body: 'theropod',
    size: 6,
    color: '#5d5a3c',
    belly: '#8f8a66',
  },
  {
    name: 'raptor',
    re: /\b(raptors?|velociraptors?|deinonych\w*|utahraptors?|dilophosaur\w*|compys?|compsognath\w*)\b/,
    body: 'theropod',
    size: 3,
    color: '#7a6640',
    belly: '#b9a57a',
    features: ['crest'],
  },
  {
    name: 'triceratops',
    re: /\b(triceratops|torosaur\w*|styracosaur\w*|ceratopsians?)\b/,
    body: 'quad',
    size: 2.6,
    color: '#7a6a50',
    len: 1.25,
    girth: 0.36,
    neck: 0.15,
    neckUp: 0.2,
    head: 0.75,
    headW: 0.3,
    tail: 0.9,
    features: ['brow-horns', 'frill', 'long-tail'],
  },
  {
    name: 'stegosaurus',
    re: /\b(stegosaur\w*|ankylosaur\w*|kentrosaur\w*)\b/,
    body: 'quad',
    size: 2.6,
    color: '#5d6b45',
    len: 1.4,
    girth: 0.34,
    neck: 0.25,
    neckUp: -0.15,
    head: 0.3,
    tail: 1.5,
    features: ['plates', 'long-tail'],
  },
  {
    name: 'sauropod',
    re: /\b(brachiosaur\w*|brontosaur\w*|diplodoc\w*|apatosaur\w*|sauropods?|argentinosaur\w*)\b/,
    body: 'quad',
    size: 5,
    color: '#7d8a6a',
    len: 0.9,
    girth: 0.25,
    neck: 1.6,
    neckUp: 1.0,
    head: 0.18,
    tail: 1.8,
    features: ['long-tail'],
  },
  {
    name: 'dinosaur',
    re: /\b(dinosaurs?|dinos?|theropods?|saurians?|kaijus?|godzilla|lizard monsters?)\b/,
    body: 'theropod',
    size: 5,
    color: '#5f6b3a',
    belly: '#9aa070',
  },
  {
    name: 'mammoth',
    re: /\b(mammoths?|mastodons?)\b/,
    body: 'quad',
    size: 3.2,
    color: '#6b4a2e',
    len: 0.85,
    girth: 0.32,
    neck: 0.12,
    neckUp: 0.1,
    head: 0.3,
    headW: 0.34,
    tail: 0.25,
    features: ['trunk', 'tusks', 'fur', 'hump'],
    gait: 'walk',
  },
  {
    name: 'elephant',
    re: /\b(elephants?|pachyderms?)\b/,
    body: 'quad',
    size: 3,
    color: '#8a8580',
    len: 0.8,
    girth: 0.3,
    neck: 0.1,
    neckUp: 0.1,
    head: 0.3,
    headW: 0.34,
    tail: 0.35,
    features: ['trunk', 'tusks'],
  },
  {
    name: 'giraffe',
    re: /\b(giraffes?)\b/,
    body: 'quad',
    size: 3.2,
    color: '#d9a54a',
    len: 0.42,
    girth: 0.12,
    neck: 0.75,
    neckUp: 1.1,
    head: 0.14,
    tail: 0.3,
    features: ['spots'],
    belly: '#f0dcb0',
  },
  {
    name: 'rhino',
    re: /\b(rhinos?|rhinoceros(es)?)\b/,
    body: 'quad',
    size: 1.7,
    color: '#8a8580',
    len: 1.1,
    girth: 0.33,
    neck: 0.15,
    neckUp: 0.0,
    head: 0.42,
    headW: 0.22,
    tail: 0.25,
    features: ['horns'],
  },
  {
    name: 'hippo',
    re: /\b(hippos?|hippopotam\w*)\b/,
    body: 'quad',
    size: 1.5,
    color: '#7a6a70',
    len: 1.4,
    girth: 0.4,
    neck: 0.1,
    neckUp: 0.1,
    head: 0.45,
    headW: 0.3,
    tail: 0.15,
    features: ['low'],
  },
  {
    name: 'bison',
    re: /\b(bison|buffalo(es)?|yaks?|wildebeests?|gnus?)\b/,
    body: 'quad',
    size: 1.7,
    color: '#4a3524',
    len: 1.0,
    girth: 0.3,
    neck: 0.15,
    neckUp: 0.1,
    head: 0.3,
    headW: 0.2,
    tail: 0.3,
    features: ['hump', 'horns', 'fur'],
  },
  {
    name: 'moose',
    re: /\b(moose|elks?|reindeer|caribou|wapiti)\b/,
    body: 'quad',
    size: 1.9,
    color: '#4a3524',
    len: 0.95,
    girth: 0.2,
    neck: 0.3,
    neckUp: 0.7,
    head: 0.3,
    tail: 0.1,
    features: ['palmate'],
  },
  {
    name: 'deer',
    re: /\b(deer|stags?|bucks?|fawns?|antelopes?|gazelles?|impalas?)\b/,
    body: 'quad',
    size: 1.4,
    color: '#8b5a2b',
    len: 0.85,
    girth: 0.17,
    neck: 0.38,
    neckUp: 0.95,
    head: 0.25,
    tail: 0.12,
    features: ['antlers'],
    belly: '#d9c4a0',
  },
  {
    name: 'camel',
    re: /\b(camels?|dromedar(y|ies)|llamas?|alpacas?)\b/,
    body: 'quad',
    size: 1.9,
    color: '#c8a670',
    len: 0.8,
    girth: 0.2,
    neck: 0.5,
    neckUp: 0.75,
    head: 0.25,
    tail: 0.25,
    features: ['hump'],
  },
  {
    name: 'zebra',
    re: /\b(zebras?)\b/,
    body: 'quad',
    size: 1.35,
    color: '#eeeeee',
    len: 1.0,
    girth: 0.22,
    neck: 0.45,
    neckUp: 0.8,
    head: 0.38,
    tail: 0.35,
    features: ['stripes', 'mane'],
  },
  {
    name: 'bull',
    re: /\b(bulls?|ox|oxen|steers?|longhorns?)\b/,
    body: 'quad',
    size: 1.55,
    color: '#3a2a20',
    len: 1.1,
    girth: 0.3,
    neck: 0.18,
    neckUp: 0.2,
    head: 0.33,
    tail: 0.5,
    features: ['horns'],
  },
  {
    name: 'cow',
    re: /\b(cows?|cattle|calf|calves|heifers?)\b/,
    body: 'quad',
    size: 1.5,
    color: '#e8e2d6',
    len: 1.1,
    girth: 0.28,
    neck: 0.2,
    neckUp: 0.3,
    head: 0.35,
    tail: 0.55,
    features: ['spots'],
    belly: '#d9a0a0',
  },
  {
    name: 'bear',
    re: /\b(bears?|grizzl(y|ies)|kodiaks?)\b/,
    body: 'quad',
    size: 1.5,
    color: '#5a3d26',
    len: 0.85,
    girth: 0.32,
    neck: 0.18,
    neckUp: 0.15,
    head: 0.3,
    headW: 0.18,
    tail: 0.08,
    features: ['fur'],
    gait: 'walk',
  },
  {
    name: 'tiger',
    re: /\b(tigers?|tigress(es)?)\b/,
    body: 'quad',
    size: 1.05,
    color: '#d47a2a',
    len: 1.45,
    girth: 0.24,
    neck: 0.18,
    neckUp: 0.3,
    head: 0.3,
    tail: 1.0,
    features: ['stripes'],
    belly: '#f2e6d0',
  },
  {
    name: 'lion',
    re: /\b(lions?|lioness(es)?|cougars?|pumas?|mountain lions?|panthers?|leopards?|jaguars?|cheetahs?|big cats?|sabre-?tooth\w*|saber-?tooth\w*)\b/,
    body: 'quad',
    size: 1.1,
    color: '#c49a54',
    len: 1.4,
    girth: 0.24,
    neck: 0.18,
    neckUp: 0.3,
    head: 0.3,
    tail: 0.95,
    features: ['mane'],
  },
  {
    name: 'wolf',
    re: /\b(wolf|wolves|werewol(f|ves)|coyotes?|jackals?|hyenas?|dingos?)\b/,
    body: 'quad',
    size: 0.8,
    color: '#7a7a78',
    len: 1.2,
    girth: 0.2,
    neck: 0.25,
    neckUp: 0.5,
    head: 0.35,
    tail: 0.6,
    gait: 'trot',
    belly: '#cfcac0',
  },
  {
    name: 'fox',
    re: /\b(fox|foxes|vixens?)\b/,
    body: 'quad',
    size: 0.4,
    color: '#c8642a',
    len: 1.4,
    girth: 0.22,
    neck: 0.25,
    neckUp: 0.5,
    head: 0.4,
    tail: 1.1,
    gait: 'trot',
    belly: '#f0e6dc',
  },
  {
    name: 'boar',
    re: /\b(boars?|pigs?|hogs?|warthogs?|swine|piglets?)\b/,
    body: 'quad',
    size: 0.9,
    color: '#e8a9a0',
    len: 1.1,
    girth: 0.32,
    neck: 0.1,
    neckUp: 0.1,
    head: 0.35,
    tail: 0.2,
    gait: 'trot',
  },
  {
    name: 'goat',
    re: /\b(goats?|ibex(es)?|rams?)\b/,
    body: 'quad',
    size: 0.8,
    color: '#cfc6b4',
    len: 1.0,
    girth: 0.25,
    neck: 0.3,
    neckUp: 0.7,
    head: 0.3,
    tail: 0.15,
    features: ['horns'],
    gait: 'trot',
  },
  {
    name: 'sheep',
    re: /\b(sheep|lambs?|ewes?|flock of sheep)\b/,
    body: 'quad',
    size: 0.9,
    color: '#ece8de',
    len: 0.95,
    girth: 0.32,
    neck: 0.18,
    neckUp: 0.5,
    head: 0.3,
    tail: 0.12,
    features: ['wool'],
    gait: 'trot',
  },
  {
    name: 'cat',
    re: /\b(cats?|kittens?|kitty|kitties|tomcats?|lynx(es)?|bobcats?)\b/,
    body: 'quad',
    size: 0.3,
    color: '#d08a3a',
    len: 1.5,
    girth: 0.22,
    neck: 0.25,
    neckUp: 0.6,
    head: 0.35,
    tail: 1.2,
    gait: 'trot',
  },
  {
    name: 'rabbit',
    re: /\b(rabbits?|bunn(y|ies)|hares?)\b/,
    body: 'quad',
    size: 0.3,
    color: '#b8a890',
    len: 1.0,
    girth: 0.32,
    neck: 0.15,
    neckUp: 0.8,
    head: 0.35,
    tail: 0.1,
    features: ['long-ears'],
    gait: 'trot',
  },
  {
    name: 'crocodile',
    re: /\b(crocodiles?|alligators?|crocs?|gators?|komodo dragons?|lizards?|iguanas?)\b/,
    body: 'quad',
    size: 0.6,
    color: '#4a5a3a',
    len: 2.8,
    girth: 0.4,
    neck: 0.2,
    neckUp: -0.1,
    head: 0.9,
    tail: 3.2,
    features: ['low', 'long-tail', 'spikes'],
    gait: 'trot',
  },
  {
    name: 'kangaroo',
    re: /\b(kangaroos?|wallab(y|ies)|roos?)\b/,
    body: 'kangaroo',
    size: 1.6,
    color: '#b07a4a',
    belly: '#e0c8a8',
  },
  {
    name: 'ostrich',
    re: /\b(ostrich(es)?|emus?|cassowar(y|ies)|rheas?|moas?|terror birds?)\b/,
    body: 'ostrich',
    size: 2.3,
    color: '#2f2a28',
    belly: '#e0b8a8',
  },
  {
    name: 'yeti',
    re: /\b(yetis?|bigfoot|sasquatch(es)?|abominable snowm[ae]n)\b/,
    body: 'upright',
    size: 2.6,
    color: '#e8eef2',
    features: ['fur'],
  },
  {
    name: 'gorilla',
    re: /\b(gorillas?|apes?|king kong|chimpanzees?|chimps?|orangutans?)\b/,
    body: 'upright',
    size: 1.7,
    color: '#2a2a2a',
    features: ['fur'],
  },
  {
    name: 'cyclops',
    re: /\b(cyclops(es)?|cyclopes)\b/,
    body: 'upright',
    size: 5,
    color: '#b08a6a',
    features: ['one-eye'],
  },
  {
    name: 'minotaur',
    re: /\b(minotaurs?)\b/,
    body: 'upright',
    size: 2.8,
    color: '#4a3524',
    features: ['horns', 'fur'],
  },
  {
    name: 'troll',
    re: /\b(trolls?|ogres?|orcs?|goblins?|golems?|ents?|treants?)\b/,
    body: 'upright',
    size: 3,
    color: '#6a7a5a',
    features: ['tusks'],
  },
  {
    name: 'giant',
    re: /\b(giants?|titans?|colossus|behemoths?|leviathans?)\b/,
    body: 'upright',
    size: 6,
    color: '#b08a6a',
  },
  {
    name: 'monster',
    re: /\b(monsters?|beasts?|creatures?|chimera|manticores?|hellhounds?|demons?|wargs?|wendigos?|abominations?|things?)\b/,
    body: 'quad',
    size: 2,
    color: '#3a3a44',
    len: 1.1,
    girth: 0.3,
    neck: 0.25,
    neckUp: 0.3,
    head: 0.4,
    tail: 0.9,
    features: ['spikes', 'horns'],
    gait: 'walk',
  },
];
const DEFAULT_SPECIES: Species = {
  name: 'animal',
  re: /$^/,
  body: 'quad',
  size: 1.2,
  color: '#7a6248',
  len: 1.1,
  girth: 0.26,
  neck: 0.3,
  neckUp: 0.5,
  head: 0.32,
  tail: 0.5,
};

const GIANT_WORDS =
  /\b(huge|giant|gigantic|massive|enormous|colossal|towering|monstrous|titanic|immense|mammoth)\b/;
const BIG_WORDS = /\b(big|large|great|hulking|bulky)\b/;
const SMALL_WORDS = /\b(small|little|tiny|baby|young|juvenile|miniature|dwarf|pygmy|cub|cubs)\b/;
const RUN_RE =
  /\b(run\w*|ran|charg\w*|gallop\w*|sprint\w*|bound\w*|chas\w*|stampede\w*|rac(e|es|ing)|flee\w*|fled|dash\w*|bolt\w*|lunges?)\b/;
const GROUP_RE =
  /\b(herds?|packs?|flocks?|prides?|troops?|droves?|groups? of|family of|several|three|a few)\b/;

export interface CreatureSpec {
  species: Species;
  /** Size multiplier from the label (huge 2×, small 0.5×). */
  sizeK: number;
  count: number;
  run: boolean;
  features: Set<Feature>;
  color: string;
}

/** What the label says about the animal: species, size, how many, running, extra features. */
export function creatureSpec(label: string): CreatureSpec {
  const l = label.toLowerCase();
  // the animal named first is the one that moves ("a bear chases a deer" is a bear); "a giant
  // bear" is a big bear, "a giant lumbers past" a giant; "a monster bear" a bear
  const hits = SPECIES.map((sp, order) => ({ sp, order, m: sp.re.exec(l) }))
    .filter((h): h is { sp: Species; order: number; m: RegExpExecArray } => !!h.m)
    .sort((a, b) => a.m.index - b.m.index || a.order - b.order);
  const specific = hits.filter((h) => h.sp.name !== 'giant' && h.sp.name !== 'monster');
  const hit = specific[0] ?? hits[0];
  let species = hit?.sp ?? DEFAULT_SPECIES;
  const rest = hit ? l.slice(0, hit.m.index) + l.slice(hit.m.index + hit.m[0].length) : l;
  const sizeK = GIANT_WORDS.test(rest)
    ? 2
    : SMALL_WORDS.test(rest)
      ? 0.5
      : BIG_WORDS.test(rest)
        ? 1.3
        : 1;
  const features = new Set<Feature>(species.features ?? []);
  if (/\b(plated|plates)\b/.test(l)) features.add('plates');
  if (/\bcrest\w*/.test(l)) features.add('crest');
  if (/\b(horned|horns?)\b/.test(l)) features.add('horns');
  if (/\b(spiked|spiky|spikes|spined|spiny)\b/.test(l)) features.add('spikes');
  if (/\b(striped|stripes|stripy)\b/.test(l)) features.add('stripes');
  if (/\b(spotted|spots|dappled)\b/.test(l)) features.add('spots');
  if (/\b(woolly|wooly|furry|shaggy|hairy)\b/.test(l)) features.add('fur');
  if (/\bone[- ]eyed\b/.test(l)) features.add('one-eye');
  if (species === DEFAULT_SPECIES && /\b(reptil\w*|scal(y|ed))\b/.test(l))
    species = SPECIES.find((s) => s.name === 'monster')!;
  // a herd / pack (or a plural: "wolves circle the camp") is three, "two" / "a pair" two
  const word = hit?.m[0] ?? '';
  const plural =
    /(?<!s)s$|^(wolves|oxen|cattle|geese|calves|werewolves)$/.test(word) &&
    !/(ss|us|ops|ros|is)$/.test(word);
  const count = GROUP_RE.test(l) || plural ? 3 : /\b(two|pair of|couple of)\b/.test(l) ? 2 : 1;
  const polar = /\bpolar\b/.test(l) && species.name === 'bear';
  return {
    species,
    sizeK,
    count: /\b(two|pair of|couple of)\b/.test(l) ? 2 : count,
    run: RUN_RE.test(l),
    features,
    color: propColor(label, polar ? '#ece8dc' : species.color),
  };
}

/** A gait scaled to a leg `L` m long (props.ts gaits are tuned to a horse's 0.98 m). */
function scaledGait(g: Gait, L: number, offsets: Gait['offsets'] = g.offsets): Gait {
  const k = L / 0.98;
  return { ...g, stride: g.stride * k, bob: g.bob * k, offsets };
}
const Q_WALK: Gait = {
  stride: 1.9,
  offsets: [0.25, 0.75, 0, 0.5],
  swing: 0.42,
  knee: 0.65,
  bob: 0.025,
  bobs: 2,
  rock: 0,
};
const Q_TROT: Gait = {
  stride: 1.7,
  offsets: [0, 0.5, 0.5, 0],
  swing: 0.5,
  knee: 0.8,
  bob: 0.03,
  bobs: 2,
  rock: 0,
};
const Q_RUN: Gait = {
  stride: 3.6,
  offsets: [0.5, 0.62, 0, 0.12],
  swing: 0.7,
  knee: 1.1,
  bob: 0.08,
  bobs: 1,
  rock: 0.06,
};

interface Rig {
  root: THREE.Group;
  animate(distance: number, time: number): void;
}

/** Deterministic pseudo-random in [0, 1) for spots and herd offsets. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function quadRig(
  b: Builder,
  parent: THREE.Object3D,
  pos: V3,
  sp: Species,
  f: Set<Feature>,
  h: number,
  color: string,
  run: boolean,
  seed: number,
): Rig {
  const root = b.pivot(pos, parent);
  const body = b.pivot([0, 0, 0], root);
  const coat = b.mat(color, { roughness: 0.8 });
  const darkHex = shade(color, -0.55);
  const dark = b.mat(darkHex, { roughness: 0.8 });
  const bellyM = b.mat(sp.belly ?? shade(color, 0.25), { roughness: 0.8 });
  const hoof = b.mat('#1d1813', { roughness: 0.6 });
  const ivory = b.mat('#e8dfc8', { roughness: 0.45 });
  const len = (sp.len ?? 1.1) * h;
  const r = (sp.girth ?? 0.26) * h;
  const low = f.has('low');
  const cy = low ? r * 1.25 : h - r;
  const legTop = cy - r * 0.45;
  // the barrel; wool is a cluster of puffs, fur a bulkier shaggy one
  if (f.has('wool')) {
    for (let i = 0; i < 6; i++) {
      const puff = b.add(
        new THREE.SphereGeometry(r * 0.75, 8, 6),
        coat,
        [((i % 2) - 0.5) * r * 0.6, cy + (i % 3 === 0 ? r * 0.2 : 0), -len / 2 + (i / 5) * len],
        body,
      );
      puff.scale.set(1, 0.95, 1.1);
    }
  } else {
    const barrel = b.add(new THREE.CapsuleGeometry(r, len, 2, 9), coat, [0, cy, 0], body);
    barrel.rotation.x = Math.PI / 2;
    barrel.scale.set(f.has('fur') ? 0.95 : 0.85, 1, 1);
    const under = b.add(
      new THREE.CapsuleGeometry(r * 0.8, len * 0.85, 2, 8),
      bellyM,
      [0, cy - r * 0.25, 0],
      body,
    );
    under.rotation.x = Math.PI / 2;
    under.scale.set(0.78, 1, 0.8);
  }
  if (f.has('hump'))
    b.add(
      new THREE.SphereGeometry(r * 0.6, 8, 6),
      coat,
      [0, cy + r * 0.75, -len * 0.2],
      body,
    ).scale.set(0.8, 1, 1.1);
  if (f.has('stripes'))
    for (let i = 0; i < 6; i++) {
      const ring = b.add(
        new THREE.TorusGeometry(r * 1.0, r * 0.06, 3, 12),
        b.mat(color === '#eeeeee' ? '#1e1e1e' : '#2a1d12'),
        [0, cy, -len / 2 + ((i + 0.5) / 6) * len],
        body,
      );
      ring.scale.set(0.86, 1, 1);
    }
  if (f.has('spots'))
    for (let i = 0; i < 9; i++) {
      const a = (hash(seed + i) - 0.5) * 2.4;
      const z = -len / 2 + hash(seed + i * 7) * len;
      const spot = b.add(
        new THREE.SphereGeometry(r * 0.32, 6, 4),
        dark,
        [Math.sin(a) * r * 0.82, cy + Math.cos(a) * r * 0.95, z],
        body,
      );
      spot.scale.set(1, 0.25, 1.2);
      spot.rotation.z = -a; // its flat side on the barrel's surface
    }
  const spine = (count: number, z0: number, z1: number, size: number, flat: boolean) => {
    for (let i = 0; i < count; i++) {
      const z = z0 + ((i + 0.5) / count) * (z1 - z0);
      const k = 1 - Math.abs((i + 0.5) / count - 0.45) * 1.2;
      const c = b.add(
        new THREE.ConeGeometry(size * (flat ? 0.6 : 0.3), size * (0.6 + k), 4),
        flat ? b.mat(shade(color, -0.25)) : ivory,
        [0, cy + r * 0.92, z],
        body,
      );
      if (flat) c.scale.set(0.18, 1, 1);
    }
  };
  if (f.has('plates')) spine(7, -len * 0.45, len * 0.6, r * 0.9, true);
  else if (f.has('spikes')) spine(6, -len * 0.45, len * 0.5, r * 0.45, false);
  if (f.has('mane') && sp.name !== 'zebra' && sp.name !== 'horse') {
    const mane = b.add(
      new THREE.SphereGeometry(r * 1.05, 9, 7),
      b.mat(shade(color, -0.35), { roughness: 0.9 }),
      [0, cy + r * 0.25, -len / 2 - r * 0.3],
      body,
    );
    mane.scale.set(1.05, 1.1, 0.9);
  }
  // neck from the chest, head held near level at its tip
  const neckLen = (sp.neck ?? 0.3) * h;
  const up = sp.neckUp ?? 0.5;
  const tilt = -(Math.PI / 2 - up);
  const neck = b.pivot([0, cy + r * 0.25, -len / 2 - r * 0.45], body);
  neck.rotation.x = tilt;
  const neckR = Math.min(r * 0.55, Math.max(r * 0.3, neckLen * 0.35));
  b.add(
    new THREE.CapsuleGeometry(neckR, Math.max(0.01, neckLen), 2, 7),
    coat,
    [0, neckLen / 2, 0],
    neck,
  );
  if (f.has('mane') && (sp.name === 'zebra' || sp.name === 'horse'))
    b.add(
      new THREE.BoxGeometry(neckR * 0.4, neckLen * 1.05, neckR * 0.8),
      dark,
      [0, neckLen / 2, neckR * 0.85],
      neck,
    );
  const head = b.pivot([0, neckLen + neckR * 0.4, 0], neck);
  head.rotation.x = -tilt - 0.2;
  const hl = (sp.head ?? 0.32) * h;
  const hw = Math.max(neckR * 1.4, hl * 0.42, (sp.headW ?? 0) * h);
  b.add(new THREE.BoxGeometry(hw, hw * 0.95, hl * 0.6), coat, [0, 0, -hl * 0.22], head);
  b.add(
    new THREE.BoxGeometry(hw * 0.72, hw * 0.62, hl * 0.48),
    bellyM,
    [0, -hw * 0.12, -hl * 0.7],
    head,
  ); // muzzle
  b.add(
    new THREE.BoxGeometry(hw * 0.4, hw * 0.12, hw * 0.08),
    b.mat('#111111'),
    [0, hw * 0.05, -hl * 0.95],
    head,
  ); // nose
  for (const s of [-1, 1]) {
    b.add(
      new THREE.SphereGeometry(hw * 0.07, 5, 4),
      b.mat('#0d0d0d', { roughness: 0.2 }),
      [s * hw * 0.42, hw * 0.18, -hl * 0.38],
      head,
    );
    const longEars = f.has('long-ears');
    if (sp.name === 'elephant' || sp.name === 'mammoth') {
      // big flat ears
      const ear = b.add(
        new THREE.SphereGeometry(hw * 0.62, 8, 6),
        coat,
        [s * hw * 0.62, hw * 0.05, hl * 0.12],
        head,
      );
      ear.scale.set(0.12, 1, 0.85);
      ear.rotation.y = s * 0.35;
    } else {
      const ear = b.add(
        new THREE.ConeGeometry(hw * (longEars ? 0.14 : 0.16), hw * (longEars ? 1.3 : 0.45), 4),
        dark,
        [s * hw * 0.38, hw * (longEars ? 0.95 : 0.6), 0],
        head,
      );
      ear.rotation.z = -s * 0.25;
    }
    if (f.has('horns') && !f.has('brow-horns')) {
      const horn = b.add(
        new THREE.ConeGeometry(hw * 0.1, hw * (sp.name === 'bull' ? 0.9 : 0.6), 5),
        ivory,
        [s * hw * 0.42, hw * 0.55, -hl * 0.05],
        head,
      );
      horn.rotation.z = -s * (sp.name === 'goat' ? 0.3 : 1.0);
      horn.rotation.x = sp.name === 'goat' ? 0.6 : -0.2;
    }
    if (f.has('brow-horns')) {
      const horn = b.add(
        new THREE.ConeGeometry(hw * 0.09, hl * 0.75, 6),
        ivory,
        [s * hw * 0.3, hw * 0.55, -hl * 0.45],
        head,
      );
      horn.rotation.x = -1.15;
    }
    if (f.has('antlers') || f.has('palmate')) {
      const base = b.pivot([s * hw * 0.25, hw * 0.5, -hl * 0.05], head);
      base.rotation.z = -s * 0.45;
      const al = hl * (f.has('palmate') ? 1.2 : 1.5);
      b.rod([0, 0, 0], [0, al, al * 0.2], hw * 0.05, ivory, base, 4);
      if (f.has('palmate'))
        b.add(
          new THREE.BoxGeometry(al * 0.9, al * 0.08, al * 0.55),
          ivory,
          [s * al * 0.25, al * 0.9, al * 0.15],
          base,
        ).rotation.z = s * 0.3;
      else
        for (const k of [0.4, 0.7])
          b.rod(
            [0, al * k, al * 0.2 * k],
            [0, al * (k + 0.25), -al * 0.25],
            hw * 0.04,
            ivory,
            base,
            4,
          );
    }
    if (f.has('tusks')) {
      const tusk = b.add(
        new THREE.ConeGeometry(hw * 0.07, hl * (sp.name === 'mammoth' ? 1.4 : 0.8), 6),
        ivory,
        [s * hw * 0.28, -hw * 0.35, -hl * 0.75],
        head,
      );
      tusk.rotation.x = -1.9;
      tusk.rotation.z = s * 0.15;
    }
  }
  if (f.has('horns') && sp.name === 'rhino') {
    const horn = b.add(
      new THREE.ConeGeometry(hw * 0.14, hl * 0.5, 6),
      ivory,
      [0, hw * 0.3, -hl * 0.85],
      head,
    );
    horn.rotation.x = -0.35;
  }
  if (f.has('frill')) {
    const frill = b.add(
      new THREE.CircleGeometry(hw * 1.25, 14, 0, Math.PI),
      b.mat(shade(color, -0.2), { doubleSided: true }),
      [0, hw * 0.2, hl * 0.1],
      head,
    );
    frill.rotation.x = -0.75;
    const nh = b.add(
      new THREE.ConeGeometry(hw * 0.08, hl * 0.25, 5),
      ivory,
      [0, hw * 0.35, -hl * 0.85],
      head,
    );
    nh.rotation.x = -0.4;
  }
  let trunk: THREE.Group | null = null;
  if (f.has('trunk')) {
    trunk = b.pivot([0, -hw * 0.1, -hl * 0.85], head);
    let j: THREE.Object3D = trunk;
    const seg = hl * 0.55;
    for (let i = 0; i < 4; i++) {
      const rr = hw * (0.16 - i * 0.028);
      b.add(new THREE.CylinderGeometry(rr * 0.85, rr, seg, 7), coat, [0, -seg / 2, 0], j);
      const next = b.pivot([0, -seg, 0], j);
      next.rotation.x = 0.18;
      j = next;
    }
    trunk.rotation.x = -0.15;
  }
  // tail: mammals hang theirs from the rump; reptiles carry a long tapering one behind
  const tailLen = (sp.tail ?? 0.5) * h;
  const tailRoot = b.pivot([0, cy + r * 0.2, len / 2 + r * 0.7], body);
  const tailJoints: THREE.Group[] = [];
  if (f.has('long-tail')) {
    let j: THREE.Object3D = tailRoot;
    const n = 4;
    for (let i = 0; i < n; i++) {
      const p = b.pivot(i === 0 ? [0, 0, 0] : [0, 0, tailLen / n], j);
      p.rotation.x = i === 0 ? (low ? 0.05 : 0.18) : -0.03;
      const r0 = r * 0.6 * (1 - i / n) + r * 0.08;
      const segGeo = new THREE.CylinderGeometry(r0 * 0.7, r0, tailLen / n, 7);
      segGeo.rotateX(Math.PI / 2);
      b.add(segGeo, coat, [0, 0, tailLen / n / 2], p);
      tailJoints.push(p);
      j = p;
    }
  } else {
    tailRoot.rotation.x = sp.gait === 'trot' || f.has('mane') ? -0.6 : -0.25;
    const tr = Math.max(0.012, Math.min(r * 0.12, tailLen * 0.1));
    b.add(
      new THREE.CapsuleGeometry(tr, Math.max(0.01, tailLen), 1, 5),
      sp.name === 'fox' ? coat : dark,
      [0, -tailLen / 2, 0],
      tailRoot,
    );
    tailJoints.push(tailRoot);
  }
  // four legs on the barrel's corners
  const L = legTop;
  const legR = Math.max(
    0.02,
    Math.min(
      r * (sp.name === 'elephant' || sp.name === 'mammoth' || sp.name === 'sauropod' ? 0.42 : 0.3),
      L * 0.16,
    ),
  );
  const dims = { upper: L * 0.5, lower: L * 0.42, r: legR, foot: L * 0.08 };
  const mats = {
    coat,
    foot:
      sp.name === 'cat' || sp.name === 'wolf' || sp.name === 'fox' || sp.name === 'bear'
        ? dark
        : hoof,
  };
  const base = run ? Q_RUN : sp.gait === 'trot' ? Q_TROT : Q_WALK;
  const g = scaledGait(base, L);
  const fz = -len / 2 + r * 0.15;
  const hz = len / 2 - r * 0.15;
  const hx = r * 0.55;
  const legs: LegRig[] = [
    leg(b, body, [hx, legTop, fz], dims, mats, true, g.offsets[0]),
    leg(b, body, [-hx, legTop, fz], dims, mats, true, g.offsets[1]),
    leg(b, body, [hx, legTop, hz], dims, mats, false, g.offsets[2]),
    leg(b, body, [-hx, legTop, hz], dims, mats, false, g.offsets[3]),
  ];
  const neckRest = neck.rotation.x;
  return {
    root,
    animate(distance, time) {
      const { rise, rock } = gaitPose(legs, g, distance, hash(seed) * 0.3);
      const cyc = distance / g.stride;
      body.position.y = rise;
      body.rotation.x = rock;
      // breathing, a head that bobs with the walk and looks about when it stands
      body.scale.y = 1 + 0.01 * Math.sin(time * 1.6 + seed);
      neck.rotation.x =
        neckRest + 0.05 * Math.sin(TAU * cyc * 2) + 0.04 * Math.sin(time * 0.5 + seed);
      neck.rotation.y = 0.18 * Math.sin(time * 0.31 + seed * 2);
      if (trunk) trunk.rotation.x = -0.15 + 0.2 * Math.sin(time * 0.9 + seed);
      tailJoints.forEach((p, i) => {
        p.rotation.y =
          0.12 * Math.sin(time * 1.5 - i * 0.7 + seed) + (run ? 0.1 * Math.sin(TAU * cyc) : 0);
      });
    },
  };
}

/** A two-legged dinosaur (`len` m nose to tail): a big head, short arms, a long counterweight tail. */
function theropodRig(
  b: Builder,
  parent: THREE.Object3D,
  pos: V3,
  sp: Species,
  f: Set<Feature>,
  len: number,
  color: string,
  run: boolean,
  seed: number,
): Rig {
  const L = len / 1.05;
  const raptor = sp.name === 'raptor';
  const root = b.pivot(pos, parent);
  const body = b.pivot([0, 0, 0], root);
  const skin = b.mat(color, { roughness: 0.7 });
  const bellyM = b.mat(sp.belly ?? shade(color, 0.3), { roughness: 0.75 });
  const dark = b.mat(shade(color, -0.45), { roughness: 0.7 });
  const claw = b.mat('#e0d6bc', { roughness: 0.5 });
  const hip = L * (raptor ? 0.3 : 0.34);
  const tr = L * (raptor ? 0.07 : 0.1);
  const ty = hip + L * 0.04;
  const torso = b.add(
    new THREE.CapsuleGeometry(tr, L * 0.22, 2, 9),
    skin,
    [0, ty, -L * 0.08],
    body,
  );
  torso.rotation.x = Math.PI / 2 - 0.12;
  torso.scale.set(0.8, 1, 1);
  const belly = b.add(
    new THREE.CapsuleGeometry(tr * 0.8, L * 0.2, 2, 8),
    bellyM,
    [0, ty - tr * 0.3, -L * 0.1],
    body,
  );
  belly.rotation.x = Math.PI / 2 - 0.12;
  belly.scale.set(0.7, 1, 0.8);
  // neck up and forward, head level
  const neck = b.pivot([0, ty + tr * 0.3, -L * 0.22], body);
  neck.rotation.x = -0.8;
  const nl = L * (raptor ? 0.12 : 0.1);
  b.add(new THREE.CapsuleGeometry(tr * 0.62, nl, 2, 7), skin, [0, nl / 2, 0], neck);
  const head = b.pivot([0, nl + tr * 0.3, 0], neck);
  head.rotation.x = 0.7;
  const hs = raptor ? 0.6 : 1;
  const hw = L * 0.1 * hs;
  b.add(new THREE.BoxGeometry(hw, hw * 1.05, L * 0.12 * hs), skin, [0, 0, -L * 0.04 * hs], head);
  b.add(
    new THREE.BoxGeometry(hw * 0.78, hw * 0.62, L * 0.12 * hs),
    skin,
    [0, -hw * 0.08, -L * 0.15 * hs],
    head,
  ); // snout
  const jaw = b.pivot([0, -hw * 0.45, -L * 0.02 * hs], head);
  b.add(
    new THREE.BoxGeometry(hw * 0.72, hw * 0.25, L * 0.2 * hs),
    bellyM,
    [0, -hw * 0.08, -L * 0.1 * hs],
    jaw,
  );
  for (const s of [-1, 1]) {
    b.add(
      new THREE.SphereGeometry(hw * 0.09, 5, 4),
      b.mat('#d8b020', { emissive: '#604800', emissiveIntensity: 0.5 }),
      [s * hw * 0.48, hw * 0.25, -L * 0.06 * hs],
      head,
    );
    // short arms (a raptor's are longer, with claws)
    const arm = b.pivot([s * tr * 0.7, ty - tr * 0.35, -L * 0.24], body);
    arm.rotation.x = 0.9;
    const al = L * (raptor ? 0.11 : 0.065);
    b.add(new THREE.CapsuleGeometry(L * 0.014, al, 1, 5), skin, [0, -al / 2, 0], arm);
    b.add(
      new THREE.ConeGeometry(L * 0.012, L * 0.03, 4),
      claw,
      [0, -al - L * 0.01, -L * 0.005],
      arm,
    ).rotation.x = Math.PI;
  }
  if (f.has('crest'))
    b.add(
      new THREE.BoxGeometry(hw * 0.12, hw * 0.55, L * 0.12 * hs),
      b.mat(shade(color, -0.3)),
      [0, hw * 0.7, -L * 0.05 * hs],
      head,
    );
  // tail: tapering segments carried level, swaying in a travelling wave
  const tail: THREE.Group[] = [];
  let tj: THREE.Object3D = b.pivot([0, ty + tr * 0.1, L * 0.06], body);
  const segs = [0.12, 0.11, 0.1, 0.09, 0.08];
  segs.forEach((sl, i) => {
    const p = b.pivot(i === 0 ? [0, 0, 0] : [0, 0, segs[i - 1]! * L], tj);
    p.rotation.x = i === 0 ? 0.12 : -0.025;
    const r0 = tr * (0.85 - i * 0.16);
    const g = new THREE.CylinderGeometry(Math.max(L * 0.006, r0 * 0.78), r0, sl * L, 7);
    g.rotateX(Math.PI / 2);
    b.add(g, skin, [0, 0, (sl * L) / 2], p);
    tail.push(p);
    tj = p;
  });
  if (f.has('plates') || f.has('spikes'))
    for (let i = 0; i < 6; i++) {
      const c = b.add(
        new THREE.ConeGeometry(tr * 0.35, tr * 0.8, 4),
        f.has('plates') ? dark : claw,
        [0, ty + tr * 0.95, -L * 0.18 + i * L * 0.06],
        body,
      );
      if (f.has('plates')) c.scale.set(0.2, 1, 1.4);
    }
  // two dog-legged hind legs
  const gait: Gait = run
    ? {
        stride: hip * 3.4,
        offsets: [0, 0.5, 0, 0.5],
        swing: 0.65,
        knee: 0.95,
        bob: hip * 0.05,
        bobs: 2,
        rock: 0,
      }
    : {
        stride: hip * 2.3,
        offsets: [0, 0.5, 0, 0.5],
        swing: 0.42,
        knee: 0.6,
        bob: hip * 0.022,
        bobs: 2,
        rock: 0,
      };
  const dims = { upper: hip * 0.48, lower: hip * 0.44, r: L * 0.05, foot: hip * 0.08 };
  const mats = { coat: skin, foot: dark };
  const legs = [-1, 1].map((s, i) =>
    leg(b, body, [s * tr * 0.7, hip, 0.0], dims, mats, false, gait.offsets[i]!),
  );
  return {
    root,
    animate(distance, time) {
      const { rise } = gaitPose(legs, gait, distance, hash(seed) * 0.5);
      const cyc = distance / gait.stride + hash(seed) * 0.5;
      body.position.y = rise;
      body.rotation.z = 0.025 * Math.sin(TAU * cyc);
      body.scale.y = 1 + 0.012 * Math.sin(time * 1.3 + seed);
      neck.rotation.y = 0.2 * Math.sin(time * 0.35 + seed);
      neck.rotation.x = -0.8 + 0.04 * Math.sin(TAU * cyc * 2) + 0.05 * Math.sin(time * 0.6);
      jaw.rotation.x = Math.max(0, Math.sin(time * 0.45 + seed)) ** 6 * 0.45; // now and then a roar
      tail.forEach((p, i) => {
        p.rotation.y =
          0.07 * Math.sin(time * 1.2 - i * 0.6 + seed) - 0.06 * Math.sin(TAU * cyc + i * 0.4);
      });
    },
  };
}

/** A kangaroo (hops on both feet) or an ostrich (long neck, long legs, runs). */
function birdOrRooRig(
  b: Builder,
  parent: THREE.Object3D,
  pos: V3,
  sp: Species,
  H: number,
  color: string,
  run: boolean,
  seed: number,
): Rig {
  const roo = sp.body === 'kangaroo';
  const root = b.pivot(pos, parent);
  const body = b.pivot([0, 0, 0], root);
  const coat = b.mat(color, { roughness: 0.8 });
  const bellyM = b.mat(sp.belly ?? shade(color, 0.3), { roughness: 0.8 });
  const dark = b.mat(shade(color, -0.45), { roughness: 0.8 });
  const hip = H * (roo ? 0.32 : 0.48);
  const tr = H * (roo ? 0.13 : 0.16);
  const ty = hip + tr * 0.6;
  const torso = b.add(new THREE.SphereGeometry(tr, 10, 8), coat, [0, ty, 0], body);
  torso.scale.set(roo ? 0.85 : 0.9, roo ? 1.7 : 0.85, roo ? 0.9 : 1.35);
  torso.rotation.x = roo ? -0.45 : 0;
  const neck = b.pivot([0, ty + tr * (roo ? 1.25 : 0.4), roo ? -tr * 0.55 : -tr * 1.0], body);
  neck.rotation.x = roo ? -0.3 : -0.12;
  const nl = H * (roo ? 0.1 : 0.42);
  b.add(
    new THREE.CapsuleGeometry(roo ? tr * 0.4 : H * 0.022, nl, 2, 6),
    roo ? coat : bellyM,
    [0, nl / 2, 0],
    neck,
  );
  const head = b.pivot([0, nl + H * 0.02, 0], neck);
  head.rotation.x = roo ? 0.2 : 0.1;
  const hs = H * (roo ? 0.1 : 0.06);
  b.add(new THREE.BoxGeometry(hs, hs, hs * 1.6), coat, [0, 0, -hs * 0.5], head);
  if (roo) {
    for (const s of [-1, 1])
      b.add(
        new THREE.ConeGeometry(hs * 0.18, hs * 1.2, 4),
        coat,
        [s * hs * 0.3, hs * 0.9, 0],
        head,
      ).rotation.z = -s * 0.2;
    b.add(
      new THREE.BoxGeometry(hs * 0.25, hs * 0.15, hs * 0.1),
      b.mat('#111111'),
      [0, hs * 0.1, -hs * 1.3],
      head,
    );
  } else {
    const beak = b.add(
      new THREE.ConeGeometry(hs * 0.3, hs * 1.1, 5),
      b.mat('#d8b890'),
      [0, -hs * 0.1, -hs * 1.6],
      head,
    );
    beak.rotation.x = -Math.PI / 2;
    for (const s of [-1, 1]) {
      const wing = b.add(
        new THREE.SphereGeometry(tr * 0.7, 7, 5),
        dark,
        [s * tr * 0.75, ty + tr * 0.1, tr * 0.2],
        body,
      );
      wing.scale.set(0.25, 0.7, 1.2);
    }
    const plume = b.add(
      new THREE.SphereGeometry(tr * 0.55, 7, 5),
      b.mat('#f2f0ea'),
      [0, ty + tr * 0.2, tr * 1.2],
      body,
    );
    plume.scale.set(0.9, 0.8, 0.6);
  }
  for (const s of [-1, 1])
    b.add(
      new THREE.SphereGeometry(hs * 0.1, 5, 4),
      b.mat('#0d0d0d'),
      [s * hs * 0.45, hs * 0.18, -hs * 0.6],
      head,
    );
  const tail: THREE.Group[] = [];
  if (roo) {
    for (const s of [-1, 1]) {
      const arm = b.pivot([s * tr * 0.55, ty + tr * 0.6, -tr * 0.7], body);
      arm.rotation.x = 0.8;
      b.add(new THREE.CapsuleGeometry(H * 0.018, H * 0.13, 1, 5), coat, [0, -H * 0.07, 0], arm);
    }
    let tj: THREE.Object3D = b.pivot([0, ty - tr * 0.9, tr * 0.6], body);
    for (let i = 0; i < 3; i++) {
      const p = b.pivot(i === 0 ? [0, 0, 0] : [0, 0, H * 0.2], tj);
      p.rotation.x = i === 0 ? 0.55 : 0.1;
      const g = new THREE.CylinderGeometry(
        tr * (0.35 - i * 0.1),
        tr * (0.45 - i * 0.1),
        H * 0.2,
        6,
      );
      g.rotateX(Math.PI / 2);
      b.add(g, coat, [0, 0, H * 0.1], p);
      tail.push(p);
      tj = p;
    }
  }
  const gait: Gait = roo
    ? {
        stride: H * 1.6,
        offsets: [0, 0, 0, 0],
        swing: 0.5,
        knee: 0.9,
        bob: H * 0.22,
        bobs: 1,
        rock: 0.15,
      }
    : run
      ? {
          stride: hip * 3.5,
          offsets: [0, 0.5, 0, 0],
          swing: 0.7,
          knee: 1.0,
          bob: hip * 0.05,
          bobs: 2,
          rock: 0,
        }
      : {
          stride: hip * 2.3,
          offsets: [0, 0.5, 0, 0],
          swing: 0.45,
          knee: 0.6,
          bob: hip * 0.02,
          bobs: 2,
          rock: 0,
        };
  const dims = {
    upper: hip * 0.48,
    lower: hip * 0.44,
    r: roo ? H * 0.05 : H * 0.022,
    foot: hip * 0.08,
  };
  const legs = [-1, 1].map((s, i) =>
    leg(
      b,
      body,
      [s * tr * 0.45, hip, roo ? tr * 0.2 : 0],
      dims,
      { coat: roo ? coat : bellyM, foot: dark },
      false,
      gait.offsets[i]!,
    ),
  );
  return {
    root,
    animate(distance, time) {
      const { rise, rock } = gaitPose(legs, gait, distance, hash(seed) * 0.4);
      body.position.y = rise;
      body.rotation.x = roo ? -rock : 0;
      neck.rotation.y = 0.25 * Math.sin(time * 0.4 + seed);
      neck.rotation.x =
        (roo ? -0.3 : -0.12) +
        0.06 * Math.sin(time * 0.8 + seed) +
        (roo ? 0 : 0.08 * Math.sin(((TAU * distance) / gait.stride) * 2));
      tail.forEach((p, i) => {
        p.rotation.y = 0.06 * Math.sin(time * 1.1 - i * 0.6);
      });
    },
  };
}

/** A humanoid giant H m tall: troll, ogre, yeti, cyclops, minotaur … (hunched, long arms swinging). */
function uprightRig(
  b: Builder,
  parent: THREE.Object3D,
  pos: V3,
  sp: Species,
  f: Set<Feature>,
  H: number,
  color: string,
  run: boolean,
  seed: number,
): Rig {
  const root = b.pivot(pos, parent);
  const body = b.pivot([0, 0, 0], root);
  const skin = b.mat(color, { roughness: 0.85 });
  const cloth = b.mat(f.has('fur') ? color : shade(color, -0.5), { roughness: 0.9 });
  const dark = b.mat(shade(color, -0.5), { roughness: 0.85 });
  const ivory = b.mat('#e8dfc8', { roughness: 0.5 });
  const hip = H * 0.45;
  const shoulderW = H * (f.has('fur') ? 0.2 : 0.18);
  b.add(new THREE.BoxGeometry(shoulderW * 1.4, H * 0.1, H * 0.16), cloth, [0, hip, 0], body); // hips
  const chest = b.pivot([0, hip + H * 0.04, 0], body);
  chest.rotation.x = -0.3; // hunched forward
  const torso = b.add(
    new THREE.CapsuleGeometry(shoulderW * 0.8, H * 0.18, 2, 8),
    skin,
    [0, H * 0.16, 0],
    chest,
  );
  torso.scale.set(1.25, 1, 0.85);
  const headP = b.pivot([0, H * 0.33, -H * 0.03], chest);
  headP.rotation.x = 0.3;
  const hs = H * 0.11;
  b.add(new THREE.BoxGeometry(hs, hs * 1.1, hs), skin, [0, hs * 0.45, -hs * 0.1], headP);
  b.add(
    new THREE.BoxGeometry(hs * 0.8, hs * 0.35, hs * 0.5),
    skin,
    [0, hs * 0.05, -hs * 0.5],
    headP,
  ); // jaw
  const eye = b.mat('#f2d23a', { emissive: '#6b5200', emissiveIntensity: 0.6 });
  if (f.has('one-eye'))
    b.add(new THREE.SphereGeometry(hs * 0.16, 6, 5), eye, [0, hs * 0.65, -hs * 0.6], headP);
  else
    for (const s of [-1, 1])
      b.add(
        new THREE.SphereGeometry(hs * 0.08, 5, 4),
        eye,
        [s * hs * 0.22, hs * 0.6, -hs * 0.6],
        headP,
      );
  for (const s of [-1, 1]) {
    if (f.has('horns')) {
      const horn = b.add(
        new THREE.ConeGeometry(hs * 0.1, hs * 0.8, 5),
        ivory,
        [s * hs * 0.5, hs * 0.95, -hs * 0.1],
        headP,
      );
      horn.rotation.z = -s * 0.9;
    }
    if (f.has('tusks')) {
      const tusk = b.add(
        new THREE.ConeGeometry(hs * 0.05, hs * 0.3, 4),
        ivory,
        [s * hs * 0.25, hs * 0.3, -hs * 0.7],
        headP,
      );
      tusk.rotation.x = 0.2;
    }
  }
  const arms: THREE.Group[] = [];
  const armL = H * (sp.name === 'gorilla' || sp.name === 'troll' ? 0.46 : 0.4);
  for (const s of [-1, 1]) {
    const arm = b.pivot([s * shoulderW * 1.2, H * 0.27, 0], chest);
    arm.rotation.z = s * 0.12;
    b.add(new THREE.CapsuleGeometry(H * 0.045, armL * 0.5, 1, 6), skin, [0, -armL * 0.28, 0], arm);
    b.add(
      new THREE.CapsuleGeometry(H * 0.04, armL * 0.45, 1, 6),
      skin,
      [0, -armL * 0.75, -H * 0.02],
      arm,
    );
    b.add(new THREE.SphereGeometry(H * 0.055, 6, 5), dark, [0, -armL, -H * 0.03], arm); // fist
    arms.push(arm);
  }
  const gait: Gait = run
    ? {
        stride: hip * 3.2,
        offsets: [0, 0.5, 0, 0],
        swing: 0.65,
        knee: 0.9,
        bob: hip * 0.05,
        bobs: 2,
        rock: 0,
      }
    : {
        stride: hip * 2.1,
        offsets: [0, 0.5, 0, 0],
        swing: 0.38,
        knee: 0.55,
        bob: hip * 0.025,
        bobs: 2,
        rock: 0,
      };
  const dims = { upper: hip * 0.5, lower: hip * 0.42, r: H * 0.055, foot: hip * 0.08 };
  const legs = [-1, 1].map((s, i) =>
    leg(
      b,
      body,
      [s * shoulderW * 0.55, hip, 0],
      dims,
      { coat: f.has('fur') ? skin : cloth, foot: dark },
      true,
      gait.offsets[i]!,
    ),
  );
  return {
    root,
    animate(distance, time) {
      const { rise } = gaitPose(legs, gait, distance, hash(seed) * 0.4);
      const a = TAU * (distance / gait.stride);
      body.position.y = rise;
      body.rotation.y = 0.05 * Math.sin(a);
      arms.forEach((arm, i) => {
        arm.rotation.x =
          (i ? 1 : -1) * gait.swing * 0.8 * Math.sin(a) + 0.04 * Math.sin(time * 0.9 + i);
      });
      chest.rotation.x = -0.3 + 0.02 * Math.sin(time * 1.2 + seed);
      headP.rotation.y = 0.25 * Math.sin(time * 0.3 + seed);
    },
  };
}

/** Any animal or monster, from its label (see the file header). */
export function creature(_color: string, label: string): Prop {
  const spec = creatureSpec(label);
  const { species: sp, features: f, sizeK, count, run } = spec;
  const b = new Builder();
  const size = sp.size * sizeK;
  // a herd walks loosely together: the others beside and behind the lead, each in its own step
  const footprint =
    sp.body === 'quad'
      ? size * ((sp.len ?? 1.1) + 0.6)
      : sp.body === 'theropod'
        ? size
        : size * 0.6;
  const rigs: Rig[] = [];
  for (let i = 0; i < count; i++) {
    const pos: V3 =
      i === 0
        ? [0, 0, 0]
        : [(i % 2 ? 1 : -1) * footprint * (0.6 + 0.2 * hash(i)), 0, footprint * (0.5 + 0.35 * i)];
    const k = i === 0 ? 1 : 0.85 + 0.2 * hash(i + 3);
    const color = i === 0 ? spec.color : shade(spec.color, (hash(i + 5) - 0.5) * 0.3);
    const seed = i * 1.7 + 0.3;
    if (sp.body === 'quad') rigs.push(quadRig(b, b.group, pos, sp, f, size * k, color, run, seed));
    else if (sp.body === 'theropod')
      rigs.push(theropodRig(b, b.group, pos, sp, f, size * k, color, run, seed));
    else if (sp.body === 'upright')
      rigs.push(uprightRig(b, b.group, pos, sp, f, size * k, color, run, seed));
    else rigs.push(birdOrRooRig(b, b.group, pos, sp, size * k, color, run, seed));
  }
  b.group.userData.species = sp.name;
  return {
    object: b.group,
    animate: (d, t) => {
      for (const r of rigs) r.animate(d, t);
    },
    dispose: () => b.dispose(),
  };
}

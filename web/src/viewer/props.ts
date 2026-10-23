// Bundled low-poly props built from three.js primitives (no external assets). Every prop has its
// origin on the ground, faces -Z, and is sized in metres.
import * as THREE from 'three';
import type { DynamicElement } from '@shared/schema';

export interface Prop {
  object: THREE.Group;
  /** distance = metres travelled (wheels), time = scene seconds (flapping, bobbing). */
  animate(distance: number, time: number): void;
  dispose(): void;
}

const COLOR_WORDS: Record<string, string> = {
  red: '#c0392b',
  blue: '#2e6bd6',
  green: '#2e8b57',
  yellow: '#e8c33a',
  white: '#e8e8e8',
  black: '#222222',
  silver: '#a9b0b8',
  grey: '#7d848c',
  gray: '#7d848c',
  orange: '#e67e22',
  purple: '#7d4bb3',
  brown: '#7a5232',
  pink: '#e58fb0',
};

/** Picks a body colour from the element label ("a red sedan drives past") or a kind default. */
export function propColor(label: string, fallback: string): string {
  const words = label.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const w of words) if (COLOR_WORDS[w]) return COLOR_WORDS[w]!;
  return fallback;
}

class Builder {
  readonly group = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats = new Map<string, THREE.MeshStandardMaterial>();

  mat(color: string, opts: { metalness?: number; roughness?: number } = {}) {
    const key = `${color}:${opts.metalness ?? 0}:${opts.roughness ?? 0.7}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color,
        metalness: opts.metalness ?? 0,
        roughness: opts.roughness ?? 0.7,
        flatShading: true,
      });
      this.mats.set(key, m);
    }
    return m;
  }

  add<G extends THREE.BufferGeometry>(
    geo: G,
    material: THREE.Material,
    pos: [number, number, number],
    parent: THREE.Object3D = this.group,
  ) {
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(...pos);
    mesh.castShadow = false;
    parent.add(mesh);
    return mesh;
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats.values()) m.dispose();
  }
}

function wheels(b: Builder, radius: number, width: number, axles: number[], halfTrack: number) {
  const tyre = b.mat('#1b1b1b', { roughness: 0.9 });
  const hub = b.mat('#b5b5b5', { metalness: 0.6, roughness: 0.4 });
  const list: THREE.Object3D[] = [];
  for (const z of axles) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * halfTrack, radius, z);
      b.group.add(pivot);
      const t = b.add(
        new THREE.CylinderGeometry(radius, radius, width, 14),
        tyre,
        [0, 0, 0],
        pivot,
      );
      t.rotation.z = Math.PI / 2;
      // an off-axis hub bar makes the wheel rotation visible
      b.add(
        new THREE.BoxGeometry(width * 1.05, radius * 0.9, radius * 0.25),
        hub,
        [0, 0, 0],
        pivot,
      );
      list.push(pivot);
    }
  }
  return (distance: number) => {
    for (const w of list) w.rotation.x = -distance / radius;
  };
}

function car(color: string): Prop {
  const b = new Builder();
  const body = b.mat(color, { metalness: 0.3, roughness: 0.45 });
  const glass = b.mat('#1d2a36', { metalness: 0.5, roughness: 0.2 });
  b.add(new THREE.BoxGeometry(1.8, 0.62, 4.3), body, [0, 0.62, 0]);
  b.add(new THREE.BoxGeometry(1.6, 0.52, 2.2), glass, [0, 1.18, 0.25]);
  b.add(new THREE.BoxGeometry(1.62, 0.06, 2.0), body, [0, 1.46, 0.3]);
  const lamp = b.mat('#fff4c2');
  b.add(new THREE.BoxGeometry(0.35, 0.12, 0.05), lamp, [-0.6, 0.7, -2.16]);
  b.add(new THREE.BoxGeometry(0.35, 0.12, 0.05), lamp, [0.6, 0.7, -2.16]);
  const red = b.mat('#a01010');
  b.add(new THREE.BoxGeometry(0.35, 0.12, 0.05), red, [-0.6, 0.72, 2.16]);
  b.add(new THREE.BoxGeometry(0.35, 0.12, 0.05), red, [0.6, 0.72, 2.16]);
  const spin = wheels(b, 0.33, 0.22, [-1.35, 1.35], 0.85);
  return { object: b.group, animate: (d) => spin(d), dispose: () => b.dispose() };
}

function bus(color: string): Prop {
  const b = new Builder();
  const body = b.mat(color, { roughness: 0.5 });
  const glass = b.mat('#1d2a36', { metalness: 0.5, roughness: 0.2 });
  b.add(new THREE.BoxGeometry(2.5, 2.6, 11), body, [0, 1.75, 0]);
  b.add(new THREE.BoxGeometry(2.54, 0.8, 9.6), glass, [0, 2.25, 0.3]);
  b.add(new THREE.BoxGeometry(2.3, 1.1, 0.06), glass, [0, 2.0, -5.51]);
  const spin = wheels(b, 0.5, 0.3, [-3.6, 3.4], 1.15);
  return { object: b.group, animate: (d) => spin(d), dispose: () => b.dispose() };
}

function bicycle(color: string): Prop {
  const b = new Builder();
  const frame = b.mat(color, { metalness: 0.4, roughness: 0.4 });
  const tyre = b.mat('#1b1b1b', { roughness: 0.9 });
  const r = 0.34;
  const wheelsList: THREE.Mesh[] = [];
  for (const z of [-0.52, 0.52]) {
    const w = b.add(new THREE.TorusGeometry(r, 0.025, 6, 20), tyre, [0, r, z]);
    w.rotation.y = Math.PI / 2;
    wheelsList.push(w);
  }
  const tube = (len: number, pos: [number, number, number], rx: number) => {
    const m = b.add(new THREE.CylinderGeometry(0.02, 0.02, len, 6), frame, pos);
    m.rotation.x = rx;
  };
  tube(1.0, [0, 0.62, 0], Math.PI / 2);
  tube(0.6, [0, 0.62, 0.25], -0.3);
  tube(0.65, [0, 0.62, -0.42], 0.35);
  // rider
  const shirt = b.mat('#3f6e9e');
  const skin = b.mat('#c99a76');
  const torso = b.add(new THREE.CapsuleGeometry(0.17, 0.45, 3, 8), shirt, [0, 1.25, 0.05]);
  torso.rotation.x = -0.35;
  b.add(new THREE.SphereGeometry(0.11, 10, 8), skin, [0, 1.65, -0.12]);
  const legs = b.mat('#2b2f3a');
  const legL = b.add(new THREE.CapsuleGeometry(0.06, 0.55, 3, 6), legs, [-0.12, 0.7, 0.05]);
  const legR = b.add(new THREE.CapsuleGeometry(0.06, 0.55, 3, 6), legs, [0.12, 0.7, 0.05]);
  return {
    object: b.group,
    animate: (d) => {
      for (const w of wheelsList) w.rotation.x = -d / r;
      const crank = d / 0.9;
      legL.rotation.x = Math.sin(crank) * 0.5;
      legR.rotation.x = -Math.sin(crank) * 0.5;
    },
    dispose: () => b.dispose(),
  };
}

function bird(color: string): Prop {
  const b = new Builder();
  const m = b.mat(color);
  const body = b.add(new THREE.SphereGeometry(0.12, 8, 6), m, [0, 0, 0]);
  body.scale.set(0.8, 0.7, 1.6);
  b.add(new THREE.SphereGeometry(0.07, 8, 6), m, [0, 0.06, -0.18]);
  const beak = b.add(new THREE.ConeGeometry(0.025, 0.08, 6), b.mat('#e0a030'), [0, 0.05, -0.27]);
  beak.rotation.x = -Math.PI / 2;
  const wing = () => {
    const pivot = new THREE.Group();
    b.group.add(pivot);
    const w = b.add(new THREE.BoxGeometry(0.34, 0.015, 0.14), m, [0.17, 0, 0], pivot);
    return { pivot, w };
  };
  const l = wing();
  const r = wing();
  r.pivot.scale.x = -1;
  return {
    object: b.group,
    animate: (_d, t) => {
      const flap = Math.sin(t * 18) * 0.7;
      l.pivot.rotation.z = flap;
      r.pivot.rotation.z = flap;
    },
    dispose: () => b.dispose(),
  };
}

function pedestrian(color: string): Prop {
  const b = new Builder();
  const shirt = b.mat(color);
  const skin = b.mat('#c99a76');
  const legsMat = b.mat('#2b2f3a');
  const torso = b.add(new THREE.CapsuleGeometry(0.2, 0.55, 3, 10), shirt, [0, 1.2, 0]);
  const head = b.add(new THREE.SphereGeometry(0.12, 12, 10), skin, [0, 1.68, 0]);
  const leg = (x: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.85, 0);
    b.group.add(pivot);
    b.add(new THREE.CapsuleGeometry(0.07, 0.65, 3, 6), legsMat, [0, -0.4, 0], pivot);
    return pivot;
  };
  const l = leg(-0.1);
  const r = leg(0.1);
  return {
    object: b.group,
    animate: (d) => {
      const s = d / 0.7;
      l.rotation.x = Math.sin(s * Math.PI) * 0.5;
      r.rotation.x = -Math.sin(s * Math.PI) * 0.5;
      const bob = Math.abs(Math.sin(s * Math.PI)) * 0.03;
      torso.position.y = 1.2 + bob;
      head.position.y = 1.68 + bob;
    },
    dispose: () => b.dispose(),
  };
}

function generic(color: string): Prop {
  const b = new Builder();
  const m = b.mat(color);
  b.add(new THREE.BoxGeometry(1, 1, 1), m, [0, 0.5, 0]);
  const nose = b.add(new THREE.ConeGeometry(0.25, 0.5, 8), b.mat('#f2f2f2'), [0, 0.5, -0.75]);
  nose.rotation.x = -Math.PI / 2;
  return { object: b.group, animate: () => {}, dispose: () => b.dispose() };
}

const DEFAULT_COLOR: Record<DynamicElement['kind'], string> = {
  car: '#c0392b',
  bus: '#e8c33a',
  truck: '#4f6d8f',
  motorcycle: '#2b2b2b',
  bicycle: '#2e6bd6',
  pedestrian: '#5c7d5a',
  bird: '#4a4a4a',
  dog: '#3b2a1a',
  horse: '#5a3a22',
  wagon: '#7a5a3a',
  boat: '#a0522d',
  dragon: '#3a4a3a',
  drone: '#8a8f99',
  spacecraft: '#c8ccd4',
  generic: '#9b59b6',
};

// Builders per kind. The genre kinds (truck … spacecraft) start as the generic marker until the
// props work package (docs/PLAN-v3.md) gives each its own procedural body.
const BUILDERS: Record<DynamicElement['kind'], (color: string) => Prop> = {
  car,
  bus,
  truck: generic,
  motorcycle: generic,
  bicycle,
  pedestrian,
  bird,
  dog: generic,
  horse: generic,
  wagon: generic,
  boat: generic,
  dragon: generic,
  drone: generic,
  spacecraft: generic,
  generic,
};

export function createProp(kind: DynamicElement['kind'], label = ''): Prop {
  const color = propColor(label, DEFAULT_COLOR[kind]);
  const prop = BUILDERS[kind](color);
  prop.object.name = `prop:${kind}`;
  return prop;
}

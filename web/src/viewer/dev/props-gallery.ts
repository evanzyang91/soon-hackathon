// Contact sheet of every procedural prop (web/src/viewer/props.ts, props-more.ts): one cell per kind and per
// label variant, each framed to its own bounds next to a 1.70 m figure for scale. Props animate in
// place (distance = speed × time), so wheels roll, legs cycle, wings beat and rotors spin without
// leaving their cell. Flying kinds hover at a small path height with a line down to the ground.
// ?t=<seconds> freezes the clock for a deterministic screenshot; ?cell=<i> shows one cell full size.
// Not part of the app.
import * as THREE from 'three';
import type { DynamicElementKind } from '@shared/schema';
import { createProp, type Prop } from '../props';

interface CellSpec {
  kind: DynamicElementKind;
  label: string;
  /** m/s for the in-place animation. */
  speed: number;
  /** Path height for the flyers. */
  lift?: number;
  water?: boolean;
}

const CELLS: CellSpec[] = [
  { kind: 'car', label: 'a red sedan drives past', speed: 9 },
  { kind: 'bus', label: 'a bus pulls in', speed: 6 },
  { kind: 'truck', label: 'a delivery truck rumbles by', speed: 7 },
  { kind: 'motorcycle', label: 'a motorcycle roars past', speed: 11 },
  { kind: 'bicycle', label: 'a cyclist rides by', speed: 4.5 },
  { kind: 'pedestrian', label: 'a jogger passes', speed: 1.6 },
  { kind: 'bird', label: 'a bird flies over', speed: 6, lift: 1.4 },
  { kind: 'dog', label: 'a dog trots along', speed: 2.2 },
  { kind: 'horse', label: 'a horse grazes', speed: 1.5 },
  { kind: 'horse', label: 'a rider gallops past', speed: 9 },
  { kind: 'wagon', label: 'a stagecoach rolls into town', speed: 3.5 },
  { kind: 'wagon', label: 'a covered wagon creaks by', speed: 2 },
  { kind: 'wagon', label: 'a farm wagon pulled by white horses', speed: 2 },
  { kind: 'boat', label: 'a fishing boat chugs past', speed: 2.5, water: true },
  { kind: 'boat', label: 'a white sailboat glides by', speed: 3, water: true },
  { kind: 'dragon', label: 'a dragon circles overhead', speed: 12, lift: 1.5 },
  { kind: 'drone', label: 'a maintenance drone hums along the rail', speed: 2, lift: 1.3 },
  { kind: 'spacecraft', label: 'a shuttle drifts past the viewport', speed: 14, lift: 1.4 },
  { kind: 'generic', label: 'something moves', speed: 1 },
  // props-more.ts: aircraft and creatures (label-driven bodies)
  { kind: 'airplane', label: 'a jet airliner flies low overhead', speed: 25, lift: 9 },
  { kind: 'airplane', label: 'a fighter jet screams past', speed: 40, lift: 9 },
  { kind: 'airplane', label: 'a red biplane buzzes the field', speed: 20, lift: 1.2 },
  { kind: 'airplane', label: 'a seaplane taxis across the bay', speed: 5, water: true },
  { kind: 'helicopter', label: 'a police helicopter hovers over the street', speed: 0, lift: 3 },
  { kind: 'creature', label: 'a dinosaur lumbers past', speed: 3 },
  { kind: 'creature', label: 'a raptor sprints across the clearing', speed: 7 },
  { kind: 'creature', label: 'a triceratops grazes', speed: 1 },
  { kind: 'creature', label: 'a brachiosaurus wanders by', speed: 2 },
  { kind: 'creature', label: 'an elephant ambles by', speed: 1.5 },
  { kind: 'creature', label: 'a giraffe walks past', speed: 1.5 },
  { kind: 'creature', label: 'a brown bear lumbers past', speed: 1.5 },
  { kind: 'creature', label: 'a wolf pack lopes past', speed: 3 },
  { kind: 'creature', label: 'a kangaroo hops by', speed: 4 },
  { kind: 'creature', label: 'a troll stomps through the village', speed: 2 },
];

const q = new URLSearchParams(location.search);
const frozen = q.has('t') ? Number(q.get('t')) : null;
const only = q.has('cell') ? CELLS[Number(q.get('cell'))] : undefined;
const SPECS = only ? [only] : CELLS;

const COLS = only ? 1 : 5;
const ROWS = only ? 1 : Math.ceil((CELLS.length + 1) / COLS);
const W = 1600;
const H = only ? 960 : ROWS * 240;
const CW = W / COLS;
const CH = H / ROWS;

const sheet = document.getElementById('sheet')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.setScissorTest(true);
sheet.appendChild(renderer.domElement);

/** A plain 1.70 m figure: the scale reference in every cell. */
function figure(): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: '#9aa3ad', roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 1.12, 3, 10), m);
  body.position.y = 0.73;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 8), m);
  head.position.y = 1.585;
  g.add(body, head);
  return g;
}

interface Cell {
  spec: CellSpec;
  prop: Prop;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  x: number;
  y: number;
  size: THREE.Vector3;
  tris: number;
}

function triangles(o: THREE.Object3D): number {
  let n = 0;
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      const g = c.geometry as THREE.BufferGeometry;
      n += (g.index ? g.index.count : g.attributes.position!.count) / 3;
    }
  });
  return n;
}

/**
 * Points the camera at the objects from the left, a little ahead and above (props face -Z, so a
 * side-on 3/4 view shows legs, wheels, wings and tails; ?az=<deg> turns it about the vertical) and moves it until the corners of
 * every mesh's bounds fill ~80% of the frame (tighter than one box around everything).
 */
function frame3q(camera: THREE.PerspectiveCamera, objects: THREE.Object3D[]) {
  const points: THREE.Vector3[] = [];
  const all = new THREE.Box3();
  for (const o of objects) {
    o.updateMatrixWorld(true);
    o.traverse((m) => {
      if (!(m instanceof THREE.Mesh)) return;
      const b = new THREE.Box3().setFromObject(m);
      all.union(b);
      for (let k = 0; k < 8; k++) {
        points.push(
          new THREE.Vector3(
            k & 1 ? b.max.x : b.min.x,
            k & 2 ? b.max.y : b.min.y,
            k & 4 ? b.max.z : b.min.z,
          ),
        );
      }
    });
  }
  const centre = all.getCenter(new THREE.Vector3());
  const az = THREE.MathUtils.degToRad(Number(q.get('az') ?? 0));
  const dir = new THREE.Vector3(-1, 0.45, -0.6)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), az)
    .normalize();
  let d = all.getSize(new THREE.Vector3()).length();
  for (let pass = 0; pass < 5; pass++) {
    camera.position.copy(centre).addScaledVector(dir, d);
    camera.lookAt(centre);
    camera.updateMatrixWorld(true);
    let extent = 0;
    for (const c of points) {
      const p = c.clone().project(camera);
      extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
    }
    d *= extent / 0.8;
  }
  camera.position.copy(centre).addScaledVector(dir, d);
  camera.lookAt(centre);
}

function makeCell(spec: CellSpec, i: number): Cell {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(spec.water ? '#1d2b36' : '#20242b');
  scene.add(new THREE.HemisphereLight('#f4f6ff', '#4a4036', 1.5));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.0);
  sun.position.set(-4, 8, -6);
  scene.add(sun);
  const prop = createProp(spec.kind, spec.label);
  prop.animate(0, 0);
  const lift = spec.lift ?? 0;
  prop.object.position.y = lift;
  scene.add(prop.object);
  prop.object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(prop.object);
  const size = box.getSize(new THREE.Vector3());
  // the scale figure stands just ahead of the prop's nose, on the far side of the camera's line
  const fig = figure();
  fig.position.set(Math.max(0.5, box.max.x * 0.6), 0, box.min.z - 0.6);
  scene.add(fig);
  const all = box.clone().union(new THREE.Box3().setFromObject(fig));
  all.min.y = Math.min(all.min.y, 0);
  const radius = all.getSize(new THREE.Vector3()).length() / 2;
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(Math.max(2, radius * 1.6), 40),
    new THREE.MeshStandardMaterial({
      color: spec.water ? '#2f5a73' : '#3a3d42',
      roughness: spec.water ? 0.3 : 0.95,
      metalness: spec.water ? 0.2 : 0,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.001;
  scene.add(ground);
  if (lift > 0) {
    // the path height: a thin line from the prop's origin down to the ground
    const line = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.01 * Math.max(1, radius / 3),
        0.01 * Math.max(1, radius / 3),
        lift,
        4,
      ),
      new THREE.MeshBasicMaterial({ color: '#ffcc66' }),
    );
    line.position.y = lift / 2;
    scene.add(line);
  }
  const camera = new THREE.PerspectiveCamera(30, CW / CH, 0.02, 400);
  frame3q(camera, [prop.object, fig]);
  const x = (i % COLS) * CW;
  const y = Math.floor(i / COLS) * CH;
  const el = document.createElement('div');
  el.className = 'cell';
  Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${CW}px`, height: `${CH}px` });
  const tris = triangles(prop.object);
  el.innerHTML = `<b>${spec.kind}</b> <span class="label">· “${spec.label}”</span>
    <div class="stats">${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} m · ${tris} tris</div>`;
  sheet.appendChild(el);
  return { spec, prop, scene, camera, x, y, size, tris };
}

const cells = SPECS.map(makeCell);
// the spare cell explains the sheet
if (!only) {
  const el = document.createElement('div');
  el.className = 'cell';
  const i = cells.length;
  Object.assign(el.style, {
    left: `${(i % COLS) * CW}px`,
    top: `${Math.floor(i / COLS) * CH}px`,
    width: `${CW}px`,
    height: `${CH}px`,
  });
  el.innerHTML = `<b>props.ts · props-more.ts</b><br><span class="label">width × height × length at rest; grey figure = 1.70 m;
    yellow line = path height of a flyer. Each prop faces −Z (its heading) and animates in place:
    wheels roll and legs cycle with distance, wings, rotors, tails and hulls with time.</span>`;
  sheet.appendChild(el);
}

const t0 = performance.now();
let frames = 0;
function frame() {
  const t = frozen ?? (performance.now() - t0) / 1000;
  for (const c of cells) {
    c.prop.animate(t * c.spec.speed, t);
    const yb = H - c.y - CH; // GL viewports count from the bottom
    renderer.setViewport(c.x, yb, CW, CH);
    renderer.setScissor(c.x, yb, CW, CH);
    renderer.render(c.scene, c.camera);
  }
  frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

Object.assign(window, {
  __gallery: {
    frames: () => frames,
    cells: () =>
      cells.map((c) => ({
        kind: c.spec.kind,
        label: c.spec.label,
        size: c.size.toArray(),
        tris: c.tris,
      })),
  },
});

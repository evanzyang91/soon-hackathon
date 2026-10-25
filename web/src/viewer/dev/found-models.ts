// Contact sheet of found models (web/src/viewer/found-model.ts): each cell draws the element's found
// model as the scene would (facing, scale, clips by intent, spinning parts), animated in place
// (distance = speed × time), with the procedural body it replaces beside it and an arrow along the
// direction of travel (−Z). ?cells=<url> lists the cells as JSON: [{ kind, label, file (a URL),
// speed, lift?, heightM?, license?, attribution?, clips? }]; ?t=<seconds> freezes the clock.
// window.__found.cells() reports each cell's FoundInfo. Not part of the app.
import * as THREE from 'three';
import type { DynamicElement, DynamicElementKind, PropModel } from '@shared/schema';
import type { FoundInfo } from '../found-model';
import { createElementProp } from '../model-prop';
import { createProp, type Prop } from '../props';

interface CellSpec {
  kind: DynamicElementKind;
  label: string;
  file: string;
  speed: number;
  lift?: number;
  heightM?: number;
  license?: string;
  attribution?: string;
  clips?: PropModel['clips'];
}

const q = new URLSearchParams(location.search);
const frozen = q.has('t') ? Number(q.get('t')) : null;
const all = (await (await fetch(q.get('cells') ?? '')).json()) as CellSpec[];
const one = q.has('cell') ? all[Number(q.get('cell'))] : undefined;
const specs = one ? [one] : all;
/** ?az=<deg> turns the camera about the vertical (0: from the front left; 90: from the left side). */
const AZ = THREE.MathUtils.degToRad(Number(q.get('az') ?? 0));

const COLS = Math.min(3, specs.length);
const ROWS = Math.ceil(specs.length / COLS);
const CW = one ? 1200 : 520;
const CH = one ? 800 : 360;
const W = COLS * CW;
const H = ROWS * CH;
const sheet = document.getElementById('sheet')!;
sheet.style.width = `${W}px`;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.setScissorTest(true);
sheet.appendChild(renderer.domElement);

interface Cell {
  spec: CellSpec;
  prop: Prop;
  plain: Prop;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  text: HTMLElement;
  framed: boolean;
}

function frame(cell: Cell) {
  const box = new THREE.Box3().setFromObject(cell.prop.object).union(new THREE.Box3().setFromObject(cell.plain.object));
  const centre = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() / 2;
  // one cell: a side view from the left (travel = screen left)
  const dir = (one ? new THREE.Vector3(-1, 0.3, -0.12) : new THREE.Vector3(-1, 0.55, -0.75)).applyAxisAngle(new THREE.Vector3(0, 1, 0), AZ).normalize();
  cell.camera.position.copy(centre).addScaledVector(dir, (r / Math.tan(THREE.MathUtils.degToRad(cell.camera.fov / 2))) * 0.95);
  cell.camera.lookAt(centre);
}

const cells: Cell[] = specs.map((spec, i) => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#20242b');
  scene.add(new THREE.HemisphereLight('#f4f6ff', '#4a4036', 1.6));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
  sun.position.set(-4, 8, -6);
  scene.add(sun);
  const el: DynamicElement = {
    id: `cell-${i}`,
    kind: spec.kind,
    label: spec.label,
    path: [
      [0, spec.lift ?? 0, 0],
      [0, spec.lift ?? 0, -10],
    ],
    speed: spec.speed,
    loop: true,
    pauseSeconds: 0,
    scale: 1,
    model: { file: spec.file, heightM: spec.heightM, license: spec.license, attribution: spec.attribution, clips: spec.clips },
  };
  const prop = createElementProp(el, (f) => new URL(f, location.href).href);
  prop.object.position.y = spec.lift ?? 0;
  scene.add(prop.object);
  const plain = createProp(spec.kind, spec.label);
  scene.add(plain.object);
  const camera = new THREE.PerspectiveCamera(35, CW / CH, 0.05, 5000);
  const text = document.createElement('div');
  text.className = 'cell';
  text.style.cssText = `left:${(i % COLS) * CW}px;top:${Math.floor(i / COLS) * CH}px;width:${CW}px;height:${CH}px`;
  sheet.appendChild(text);
  return { spec, prop, plain, scene, camera, text, framed: false };
});

function layout(cell: Cell) {
  // the procedural body stands to the found model's right (+X), a little apart
  const a = new THREE.Box3().setFromObject(cell.prop.object);
  const sizeA = a.getSize(new THREE.Vector3());
  cell.plain.object.position.set(Math.max(sizeA.x, 1) * 0.75 + 0.5, cell.spec.lift ?? 0, one ? Math.max(sizeA.z, 1) * 1.2 : 0);
  const span = Math.max(sizeA.x, sizeA.z, 1);
  const g = cell.scene.getObjectByName('ground');
  if (g) cell.scene.remove(g);
  const ground = new THREE.Group();
  ground.name = 'ground';
  const disc = new THREE.Mesh(new THREE.CircleGeometry(span * 2.2, 48), new THREE.MeshStandardMaterial({ color: '#3a3d42', roughness: 0.95 }));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.001;
  ground.add(disc);
  // the direction of travel
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0.01, 0), span * 1.1, 0xffcc66, span * 0.18, span * 0.09);
  ground.add(arrow);
  cell.scene.add(ground);
}

const t0 = performance.now();
let last = '';
function tick() {
  const t = frozen ?? (performance.now() - t0) / 1000;
  cells.forEach((cell, i) => {
    const d = cell.spec.speed * t;
    const motion = { phase: 'moving' as const, since: t, speed: cell.spec.speed };
    cell.prop.animate(d, t, motion);
    cell.plain.animate(d, t, motion);
    const f = cell.prop.object.userData.found as FoundInfo | undefined;
    if (f && f.status !== 'loading' && !cell.framed) {
      layout(cell);
      frame(cell);
      cell.framed = true;
    }
    if (!cell.framed) frame(cell);
    const x = (i % COLS) * CW;
    const y = H - (Math.floor(i / COLS) + 1) * CH;
    renderer.setViewport(x, y, CW, CH);
    renderer.setScissor(x, y, CW, CH);
    renderer.render(cell.scene, cell.camera);
    const line = `<b>${cell.spec.kind}</b> · ${cell.spec.label}<br><span class="muted">${f?.status ?? 'loading'} · ${f?.body ?? ''} · facing ${f?.facing ?? '…'}${f?.clip ? ` · clip ${f.clip}` : ''}${f?.loadMs ? ` · ${f.loadMs} ms` : ''}${f?.reason ? ` · ${f.reason}` : ''}</span><div class="foot">${cell.spec.attribution ?? ''}${cell.spec.license ? ` · ${cell.spec.license}` : ''} &nbsp; (right: the primitive)</div>`;
    if (cell.text.innerHTML !== line) cell.text.innerHTML = line;
  });
  const state = JSON.stringify(cells.map((c) => c.prop.object.userData.found));
  if (state !== last) last = state;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

Object.defineProperty(window, '__found', {
  value: { cells: () => cells.map((c) => ({ label: c.spec.label, ...(c.prop.object.userData.found as FoundInfo) })) },
});

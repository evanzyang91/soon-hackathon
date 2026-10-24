// Dev tool: one rigged LHM actor playing a forced motion-library clip on a grid, framed close, so
// clips/seeds can be reviewed for pops, foot sliding, intersections and odd gestures.
//   /src/viewer/actors/dev/motion-review.html?seq=<sequence dir>&clip=<name>&view=front|side|three
//   &lib=<alternate motion-library json in the same dir>&speak=1 (fake voice level -> jaw)
import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import { createSpark } from '../../spark';
import { loadSkinnedBody, type SkinnedBody } from '../skinned-actor';
import type { RigPointer } from '../rig';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 720);
const H = Number(q.get('h') ?? 720);
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(W, H);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#9aa3ad');
scene.add(new THREE.GridHelper(10, 40, 0x333333, 0x5a6168));
const camera = new THREE.PerspectiveCamera(Number(q.get('fov') ?? 32), W / H, 0.05, 100);
scene.add(camera, createSpark(renderer));
const views: Record<string, [number, number, number]> = { front: [0, 1.0, -4.4], side: [4.4, 1.0, 0], three: [3.1, 1.2, -3.1], back: [0, 1.0, 4.4] };
const lookY = Number(q.get('look') ?? 0.88);
const dist = Number(q.get('dist') ?? 1);
const setView = (v: string) => {
  camera.position.set(...(views[v] ?? views.front!)).multiplyScalar(dist);
  camera.position.y = (views[v] ?? views.front!)[1];
  camera.lookAt(0, lookY, 0);
};
setView(q.get('view') ?? 'front');

const errors: string[] = [];
let body: SkinnedBody | null = null;
let sceneTime = 0;
let speaking = q.get('speak') === '1';
const ready = (async () => {
  const dir = new URL(`/${q.get('seq')!.replace(/^\/+|\/+$/g, '')}/`, location.origin).href;
  const seq = await (await fetch(new URL('sequence.json', dir))).json();
  const pointer: RigPointer = { ...seq.rig };
  if (q.get('lib')) {
    pointer.clips = q.get('lib')!;
    delete pointer.clipsSha256;
  }
  body = await loadSkinnedBody({ kind: 'splat-sequence', characterId: q.get('id') ?? 'review', sequenceDir: '', fps: seq.fps, nativeHeight: seq.nativeHeight, heightMeters: 1.7 }, dir, pointer);
  if (q.get('pose')) body.setPose(q.get('pose') as 'standing');
  if (q.get('clip')) body.play(q.get('clip'));
  const holder = new THREE.Group();
  holder.add(body.root);
  scene.add(holder);
  return body.clipNames;
})();
ready.catch((e) => errors.push(String(e)));

let last = performance.now();
let paused = false;
function frame(now: number) {
  const dt = paused ? 0 : Math.min(0.1, (now - last) / 1000);
  last = now;
  sceneTime += dt;
  const level = speaking ? 0.5 + 0.5 * Math.sin(sceneTime * 17) * Math.sin(sceneTime * 3.1) : 0;
  body?.animate(dt, sceneTime, speaking, Math.max(0, level));
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

Object.assign(window, {
  __review: {
    ready: () => ready,
    play: (name: string | null) => body?.play(name),
    view: setView,
    pose: (p: 'standing' | 'sitting' | 'walking') => body?.setPose(p),
    speak: (on: boolean) => (speaking = on),
    pause: (on: boolean) => (paused = on),
    /** advance deterministically (paused rendering) by dt seconds */
    step(dt: number) {
      sceneTime += dt;
      body?.animate(dt, sceneTime, speaking, 0);
      renderer.render(scene, camera);
    },
    setSceneTime: (t: number) => (sceneTime = t),
    debug: () => body?.debug(),
    feet() {
      // world-space bounding box of the splats (feet y, height) for grounding checks
      const b = new THREE.Box3();
      body?.root.updateMatrixWorld(true);
      body?.root.traverse((c) => {
        if (c instanceof SplatMesh) b.union(c.getBoundingBox(true).clone().applyMatrix4(c.matrixWorld));
      });
      return { min: b.min.toArray(), max: b.max.toArray() };
    },
    errors,
  },
});

// Bare scene that mounts actors through the public createActor() contract, for the Playwright
// check in scripts/actor-browser-check.ts. ?splat=<sequenceDir> adds an LHM splat actor.
import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import type { ActorAsset, Character } from '@shared/schema';
import { createSpark } from '../../spark';
import { createActor, PROCEDURAL_GLB, type ActorHandle } from '../index';

const q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(800, 500);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#8d96a0');
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(2, 4, -3);
scene.add(sun, new THREE.GridHelper(10, 20, 0x333333, 0x666666));
// actors face -Z; the camera stands on -Z looking back at their faces
const camera = new THREE.PerspectiveCamera(40, 800 / 500, 0.05, 100);
camera.position.set(0, 1.25, -4.2);
camera.lookAt(0, 0.95, 0);
const listener = new THREE.AudioListener();
camera.add(listener);
scene.add(camera, createSpark(renderer));

const character = (id: string, name: string): Character => ({ id, name, description: '', voice: { id: 'alloy', gender: 'neutral' } });
const actors: Record<string, ActorHandle> = {};
const errors: string[] = [];

async function mount() {
  const fallback: ActorAsset = { kind: 'glb-humanoid', characterId: 'raj', glb: PROCEDURAL_GLB, clips: { idle: 'Idle', talk: 'Talk' }, tint: '#c8643c' };
  const list: [ActorAsset, Character, number][] = [[fallback, character('raj', 'RAJ'), -0.8]];
  const splat = q.get('splat');
  if (splat) {
    const seq = await (await fetch(`/${splat}/sequence.json`)).json();
    list.push([{ kind: 'splat-sequence', characterId: 'maya', sequenceDir: splat, fps: seq.fps, nativeHeight: seq.nativeHeight, heightMeters: 1.7 }, character('maya', 'MAYA'), 0.8]);
  }
  for (const [asset, c, x] of list) {
    const a = await createActor(asset, c, listener, `${location.origin}/`);
    a.object.position.set(x, 0, 0);
    a.object.rotation.y = 0; // yaw 0 = facing -Z, toward this camera
    scene.add(a.object);
    actors[c.id] = a;
  }
}

let last = performance.now();
let t = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  t += dt;
  for (const a of Object.values(actors)) a.update(dt, t);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

const ready = mount().then(() => requestAnimationFrame(frame));
ready.catch((e) => errors.push(String(e)));

Object.assign(window, {
  __harness: {
    ready: () => ready.then(() => Object.keys(actors)),
    async speak(id: string, url: string, seconds: number) {
      await listener.context.resume().catch(() => {});
      const t0 = performance.now();
      await actors[id]!.speak('line-1', url, seconds);
      return (performance.now() - t0) / 1000;
    },
    debug: (id: string) => ({ ...(actors[id]!.object.userData.debug ?? {}), kind: actors[id]!.object.userData.actorKind }),
    box(id: string) {
      // body only (labels are sprites): meshes + splat centres in world space
      const b = new THREE.Box3();
      const o = actors[id]!.object;
      o.updateMatrixWorld(true);
      o.traverse((c) => {
        if (c instanceof SplatMesh) b.union(c.getBoundingBox(true).clone().applyMatrix4(c.matrixWorld));
        else if (c instanceof THREE.Mesh) b.union(new THREE.Box3().setFromObject(c));
      });
      return { min: b.min.toArray(), max: b.max.toArray() };
    },
    audioState: () => listener.context.state,
    errors,
  },
});

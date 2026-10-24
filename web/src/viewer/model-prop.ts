// Props of kind 'model' (docs/PLAN-v4.md "Props by import or by prompt"): a glTF binary the
// director imported or had generated (DynamicElement.model, shared/schema.ts PropModel), drawn as
// is on the laptop and the phone alike.
//
//   load       GLTFLoader, one load per URL shared by every prop that draws it (reference counted:
//              the last dispose frees geometries, materials, textures and image bitmaps)
//   normalise  centred on x / z, lowest point on y = 0 (the prop's origin is the ground under
//              it), bounding-box height = PropModel.heightM (absent: 1 m), then turned by
//              yawOffset; the materials stay as authored (textures, vertex colours)
//   animate    the first animation clip, if any, plays on the scene clock (laptop and phone agree)
//   failure    a console warning and the generic marker in its place
//
// The prop's object is what dynamics.ts / edits/apply.ts drive (position, heading, scale); the
// model hangs inside it, so a transform edit or a drag never touches the normalisation.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { DynamicElement, PropModel } from '@shared/schema';
import { createProp, type Prop } from './props';

/** PropModel.heightM when absent (shared/schema.ts). */
export const DEFAULT_MODEL_HEIGHT = 1;

export type ModelStatus = 'loading' | 'ready' | 'failed';

interface Loaded {
  gltf: GLTF;
  /** The template's bounding box (computed once per URL). */
  box: THREE.Box3;
  skinned: boolean;
}

interface Entry {
  url: string;
  promise: Promise<Loaded>;
  loaded: Loaded | null;
  users: number;
}

const cache = new Map<string, Entry>();
let loader: GLTFLoader | null = null;

function acquire(url: string): Entry {
  let e = cache.get(url);
  if (!e) {
    const entry: Entry = { url, promise: Promise.resolve(null as unknown as Loaded), loaded: null, users: 0 };
    loader ??= new GLTFLoader();
    entry.promise = loader.loadAsync(url).then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      let skinned = false;
      gltf.scene.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
      });
      const loaded: Loaded = { gltf, box: new THREE.Box3().setFromObject(gltf.scene, true), skinned };
      entry.loaded = loaded;
      // every user let go while it was loading
      if (entry.users <= 0) scheduleFree(entry);
      return loaded;
    });
    // a failed load is retried by the next prop that asks (a model saved a moment later)
    entry.promise.catch(() => cache.get(url) === entry && cache.delete(url));
    cache.set(url, entry);
    e = entry;
  }
  e.users++;
  return e;
}

function release(e: Entry) {
  e.users--;
  if (e.users <= 0 && e.loaded) scheduleFree(e);
}

/** How long an unused model stays cached (an edited prop is rebuilt: dispose, then create). */
const KEEP_MS = 2000;

function scheduleFree(e: Entry) {
  setTimeout(() => {
    if (e.users <= 0) freeEntry(e);
  }, KEEP_MS);
}

function freeEntry(e: Entry) {
  if (cache.get(e.url) === e) cache.delete(e.url);
  const loaded = e.loaded;
  e.loaded = null;
  if (loaded) disposeTree(loaded.gltf.scene);
}

function disposeTree(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine) return;
    mesh.geometry?.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m) materials.add(m);
  });
  for (const m of materials) {
    for (const v of Object.values(m)) if ((v as THREE.Texture | null)?.isTexture) textures.add(v as THREE.Texture);
    m.dispose();
  }
  for (const t of textures) {
    const image = t.source?.data as { close?: () => void } | undefined;
    t.dispose();
    image?.close?.(); // ImageBitmap
  }
}

/** Resolves a PropModel.file (project-root relative) against the scene's manifest URL. */
export function projectFileResolver(manifestUrl: string): (file: string) => string {
  const manifest = new URL(manifestUrl, globalThis.location?.href ?? 'http://localhost/');
  const root = new URL('../', new URL('./', manifest));
  return (file) => new URL(file, root).href;
}

export interface ModelProp extends Prop {
  status(): ModelStatus;
  /** Resolves when the model (or its fallback marker) is in place. */
  ready: Promise<ModelStatus>;
}

/** A prop that draws `model` (fetched from `url`); the generic marker if it cannot be loaded. */
export function createModelProp(model: PropModel, url: string, label = ''): ModelProp {
  const object = new THREE.Group();
  object.name = 'prop:model';
  object.userData.modelUrl = url;
  object.userData.modelStatus = 'loading' satisfies ModelStatus;
  const turn = new THREE.Group();
  turn.name = 'model-yaw';
  turn.rotation.y = model.yawOffset ?? 0;
  object.add(turn);
  const entry = acquire(url);
  let status: ModelStatus = 'loading';
  let disposed = false;
  let root: THREE.Object3D | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  let fallback: Prop | null = null;
  const set = (s: ModelStatus) => {
    status = s;
    object.userData.modelStatus = s;
  };

  const ready = entry.promise.then(
    ({ gltf, box, skinned }) => {
      if (disposed) return status;
      root = skinned ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
      root.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false; // bones move it outside its bind box
      });
      const fit = new THREE.Group();
      fit.name = 'model-fit';
      const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
      const tall = size.y > 1e-6 ? size.y : Math.max(size.x, size.z, 1e-6);
      const s = (model.heightM ?? DEFAULT_MODEL_HEIGHT) / tall;
      const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
      fit.scale.setScalar(s);
      fit.position.set(-c.x * s, box.isEmpty() ? 0 : -box.min.y * s, -c.z * s);
      fit.add(root);
      turn.add(fit);
      const clip = gltf.animations[0];
      if (clip) {
        mixer = new THREE.AnimationMixer(root);
        mixer.clipAction(clip).play();
      }
      set('ready');
      return status;
    },
    (err: unknown) => {
      if (disposed) return status;
      console.warn(`[props] model ${url} could not be loaded; drawing a marker instead`, err);
      fallback = createProp('generic', label);
      object.add(fallback.object);
      set('failed');
      return status;
    },
  );

  return {
    object,
    ready,
    status: () => status,
    animate(distance, time) {
      // the scene clock decides the frame, so a scrub or the phone shows the same pose
      if (mixer) mixer.setTime(Math.max(0, time));
      fallback?.animate(distance, time);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (mixer && root) {
        mixer.stopAllAction();
        mixer.uncacheRoot(root);
      }
      fallback?.dispose();
      object.removeFromParent();
      // clones share the template's geometry / materials: the last user frees them
      release(entry);
    },
  };
}

/** The prop for a scene element: its own model for kind 'model', else the procedural kind. */
export function createElementProp(el: DynamicElement, resolve?: (file: string) => string): Prop {
  if (el.kind === 'model' && el.model && resolve) return createModelProp(el.model, resolve(el.model.file), el.label);
  return createProp(el.kind, el.label);
}

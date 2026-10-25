// Props of kind 'model' (docs/PLAN-v4.md "Props by import or by prompt"): a glTF binary the
// director imported or had generated (DynamicElement.model, shared/schema.ts PropModel), drawn as
// is on the laptop and the phone alike. Any other kind with a model is a found model
// (found-model.ts): createElementProp picks.
//
//   load       model-cache.ts: one load per URL shared by every prop that draws it (reference
//              counted: the last dispose frees geometries, materials, textures and image bitmaps)
//   normalise  centred on x / z, lowest point on y = 0 (the prop's origin is the ground under
//              it), bounding-box height = PropModel.heightM (absent: 1 m), then turned by
//              yawOffset; the materials stay as authored (textures, vertex colours)
//   animate    the first animation clip, if any, plays on the scene clock (laptop and phone agree)
//   failure    a console warning and the generic marker in its place
//
// The prop's object is what dynamics.ts / edits/apply.ts drive (position, heading, scale); the
// model hangs inside it, so a transform edit or a drag never touches the normalisation.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { DynamicElement, PropModel } from '@shared/schema';
import { createFoundProp } from './found-model';
import { acquireModel } from './model-cache';
import { createProp, type Prop } from './props';

/** PropModel.heightM when absent (shared/schema.ts). */
export const DEFAULT_MODEL_HEIGHT = 1;

export type ModelStatus = 'loading' | 'ready' | 'failed';

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
  const entry = acquireModel(url);
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
      entry.release();
    },
  };
}

/**
 * The model's own bounding-box height (glTF units are metres), loaded through the same cache the
 * prop will use; null when it cannot be loaded or is empty.
 */
export async function modelHeight(url: string): Promise<number | null> {
  const e = acquireModel(url);
  try {
    const { box } = await e.promise;
    return box.isEmpty() ? null : box.getSize(new THREE.Vector3()).y;
  } catch {
    return null;
  } finally {
    e.release();
  }
}

/**
 * The prop for a scene element: its own model for kind 'model'; for any other kind the procedural
 * body, replaced by its found model (`el.model`, found-model.ts) once that loads and suits it.
 */
export function createElementProp(el: DynamicElement, resolve?: (file: string) => string): Prop {
  if (el.kind === 'model' && el.model && resolve) return createModelProp(el.model, resolve(el.model.file), el.label);
  if (el.model && resolve) return createFoundProp(el, resolve(el.model.file));
  return createProp(el.kind, el.label);
}

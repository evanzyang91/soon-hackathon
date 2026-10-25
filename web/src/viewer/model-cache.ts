// One glTF load per URL, shared by every prop that draws it (kind 'model' props, found models):
// reference counted, so the last user frees geometries, materials, textures and image bitmaps a
// moment after it lets go (an edited prop is rebuilt: dispose, then create).
//
//   fetch      the bytes are fetched here, not by GLTFLoader, so a byte budget can refuse a model
//              before it is downloaded (Content-Length) or parsed (found models: ≤ 15 MB)
//   decode     GLTFLoader plus KHR_materials_pbrSpecularGlossiness (older Sketchfab / Objaverse
//              exports require it; three.js dropped it), read as a MeshStandardMaterial with the
//              diffuse colour and texture, so such a model keeps its look instead of going white
//   analysis   per-URL derived data (bounds, a found model's facing and clips) cached on the entry
import * as THREE from 'three';
import { GLTFLoader, type GLTF, type GLTFLoaderPlugin, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

/** A found model larger than this is not downloaded (docs/PLAN-v4.md "Found models"). */
export const FOUND_MODEL_MAX_BYTES = 15 * 1024 * 1024;

export class ModelBudgetError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`model is ${(bytes / 1e6).toFixed(1)} MB, over the ${(maxBytes / 1e6).toFixed(0)} MB budget`);
  }
}

export interface LoadedModel {
  gltf: GLTF;
  /** The template's bounding box in its own frame (computed once per URL, skinned pose included). */
  box: THREE.Box3;
  skinned: boolean;
  bytes: number;
  /** Fetch + decode time, ms. */
  ms: number;
  /** Derived data per consumer (found-model.ts keys its analysis by kind). */
  derived: Map<string, unknown>;
}

interface Entry {
  url: string;
  promise: Promise<LoadedModel>;
  loaded: LoadedModel | null;
  users: number;
}

const cache = new Map<string, Entry>();
let loader: GLTFLoader | null = null;

const SPEC_GLOSS = 'KHR_materials_pbrSpecularGlossiness';

interface SpecGlossDef {
  diffuseFactor?: number[];
  diffuseTexture?: { index: number; texCoord?: number };
  glossinessFactor?: number;
}

/** The spec / gloss workflow read as metal / rough: diffuse → base colour, gloss → 1 − roughness. */
class SpecularGlossinessPlugin implements GLTFLoaderPlugin {
  readonly name = SPEC_GLOSS;
  constructor(private readonly parser: GLTFParser) {}

  private def(materialIndex: number): SpecGlossDef | undefined {
    const m = (this.parser.json as { materials?: { extensions?: Record<string, unknown> }[] }).materials?.[materialIndex];
    return m?.extensions?.[SPEC_GLOSS] as SpecGlossDef | undefined;
  }

  getMaterialType(materialIndex: number) {
    return this.def(materialIndex) ? THREE.MeshStandardMaterial : null;
  }

  extendMaterialParams(materialIndex: number, params: Record<string, unknown>) {
    const ext = this.def(materialIndex);
    if (!ext) return Promise.resolve();
    const f = ext.diffuseFactor ?? [1, 1, 1, 1];
    params.color = new THREE.Color().setRGB(f[0] ?? 1, f[1] ?? 1, f[2] ?? 1, THREE.LinearSRGBColorSpace);
    params.opacity = f[3] ?? 1;
    params.metalness = 0;
    // a mirror-like gloss without its map reads as chrome under the scene's lights: keep it matte-ish
    params.roughness = THREE.MathUtils.clamp(1 - (ext.glossinessFactor ?? 0.5), 0.4, 1);
    const pending: Promise<unknown>[] = [];
    if (ext.diffuseTexture) pending.push(this.parser.assignTexture(params, 'map', ext.diffuseTexture, THREE.SRGBColorSpace));
    return Promise.all(pending);
  }
}

function gltfLoader(): GLTFLoader {
  loader ??= new GLTFLoader().register((parser) => new SpecularGlossinessPlugin(parser));
  return loader;
}

async function fetchModel(url: string, maxBytes: number | undefined): Promise<LoadedModel> {
  const t0 = performance.now();
  const abort = new AbortController();
  const res = await fetch(url, { signal: abort.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    abort.abort();
    throw new ModelBudgetError(declared, maxBytes);
  }
  const data = await res.arrayBuffer();
  if (maxBytes !== undefined && data.byteLength > maxBytes) throw new ModelBudgetError(data.byteLength, maxBytes);
  const gltf = await gltfLoader().parseAsync(data, new URL('./', url).href);
  gltf.scene.updateMatrixWorld(true);
  let skinned = false;
  gltf.scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
  });
  return {
    gltf,
    box: new THREE.Box3().setFromObject(gltf.scene, true),
    skinned,
    bytes: data.byteLength,
    ms: performance.now() - t0,
    derived: new Map(),
  };
}

export interface ModelHandle {
  readonly url: string;
  /** Rejects with the load error, or ModelBudgetError when the model is over `maxBytes`. */
  readonly promise: Promise<LoadedModel>;
  release(): void;
}

/**
 * The shared load of `url`. `maxBytes` refuses a larger model (also one an earlier user without a
 * budget already loaded); the caller must `release()` exactly once.
 */
export function acquireModel(url: string, maxBytes?: number): ModelHandle {
  let e = cache.get(url);
  if (!e) {
    const entry: Entry = { url, promise: Promise.resolve(null as unknown as LoadedModel), loaded: null, users: 0 };
    entry.promise = fetchModel(url, maxBytes).then((loaded) => {
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
  const entry = e;
  entry.users++;
  let released = false;
  return {
    url,
    promise: entry.promise.then((loaded) => {
      if (maxBytes !== undefined && loaded.bytes > maxBytes) throw new ModelBudgetError(loaded.bytes, maxBytes);
      return loaded;
    }),
    release() {
      if (released) return;
      released = true;
      entry.users--;
      if (entry.users <= 0 && entry.loaded) scheduleFree(entry);
    },
  };
}

/** How long an unused model stays cached. */
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

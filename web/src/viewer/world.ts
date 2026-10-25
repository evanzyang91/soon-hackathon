// SceneManifest → live three.js scene: Marble splat world (or a procedural placeholder), actors,
// moving props, lights, and the scene clock. Shared by the laptop director and the phone camera.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SparkRenderer } from '@sparkjsdev/spark';
import { SplatMesh } from '@sparkjsdev/spark';
import { SceneManifest, type ActorAsset, type Character, type DialogueLine } from '@shared/schema';
import type { GroundField } from '@shared/ground';
import { createActor, type ActorHandle } from './actors';
import { preloadAudio } from './actors/common';
import { createDynamics, type DynamicsRuntime } from './dynamics';
import { projectFileResolver } from './model-prop';
import { followGround, groundSampler, loadGroundField, markY, onGround, type GroundY } from './ground';
import { createPlaceholderWorld, disposeObject } from './placeholder';
import { gazeTargets } from './gaze';
import { colliderTriangles, correctPlacement, TriGrid, yawToward, type V2 } from './placement';
import { createSpark, type SparkOptions } from './spark';
import { worldTransform } from './transform';
import type { Look, SceneEdits } from '@shared/look';
import { SceneLook } from './look/scene-look';
import { SceneEditsRuntime } from './edits/apply';

export type SplatQuality = 'k100' | 'k500' | 'full';

export interface LoadSceneOptions {
  renderer: THREE.WebGLRenderer;
  /** Reuse one listener across scenes; it must be parented to the camera that hears the scene. */
  listener?: THREE.AudioListener;
  quality?: SplatQuality;
  /** SparkRenderer settings for this scene, over the Marble defaults in spark.ts. */
  spark?: SparkOptions;
  onStatus?: (message: string) => void;
}

export interface SceneRuntime {
  readonly manifest: SceneManifest;
  readonly manifestUrl: string;
  /** Absolute base URL that manifest asset paths resolve against (ends with '/'). */
  readonly assetBase: string;
  readonly scene: THREE.Scene;
  readonly spark: SparkRenderer;
  /** Holds the splat world + collider with the Marble → metric transform applied. */
  readonly worldRoot: THREE.Group;
  readonly splat: SplatMesh | null;
  /** True when the SPZ could not be loaded and the procedural stand-in is shown. */
  readonly placeholder: boolean;
  /**
   * The world's ground height field (WorldAsset.ground, loaded before the actors are placed); null
   * without one or when it failed to load (then every actor stands on y = 0, the median floor).
   */
  readonly ground: GroundField | null;
  /**
   * The y of the visible ground at scene (x, z) (viewer/ground.ts): where an actor's feet go.
   * Actor heights are stored relative to it (blocking y, actor transform y: 0 = on the ground).
   */
  groundY(x: number, z: number): number;
  readonly collider: THREE.Object3D | null;
  /**
   * Resolves once the collider GLB has loaded (null without one). Scene load never waits for it;
   * when it lands, actors standing inside geometry are moved to free floor (placement.ts), onto
   * the ground at their new spot, and `actor.object.userData.placement` records what happened.
   */
  readonly colliderReady: Promise<THREE.Object3D | null>;
  readonly grid: THREE.GridHelper;
  readonly actors: Map<string, ActorHandle>;
  readonly dynamics: DynamicsRuntime;
  readonly listener: THREE.AudioListener;
  readonly quality: SplatQuality;
  readonly time: number;
  readonly speakingLineId: string | null;
  playing: boolean;
  update(dt: number): void;
  setTime(t: number): void;
  /** Speaks one dialogue line (positional audio on the actor); resolves when it finishes. */
  playLine(lineId: string): Promise<void>;
  stopLines(): void;
  setQuality(quality: SplatQuality): Promise<boolean>;
  /**
   * Replaces the actors whose asset differs from the loaded manifest's (e.g. after a "High detail"
   * rebuild rewrote it) in place: same spot, facing, pose and placement; camera, clock and every
   * other actor untouched. Resolves with the swapped character ids.
   */
  swapActors(assets: ActorAsset[]): Promise<string[]>;
  /** Look development (viewer/look/scene-look.ts): grade, lens, lights, compare, per-view looks. */
  readonly look: SceneLook;
  /** The scene's look (applied at render time on every view of this scene). */
  setLook(look: Look): void;
  getLook(): Look;
  /** The scene's edits.json document (look + scene edits); null until loaded. WP G fills it. */
  edits: SceneEdits | null;
  /** Applies `edits` (regions, transforms, props) every frame it changes (viewer/edits/apply.ts). */
  readonly sceneEdits: SceneEditsRuntime | null;
  dispose(): void;
}

const SKY: Record<SceneManifest['plan']['timeOfDay'], string> = {
  dawn: '#d6a991',
  day: '#9cc3e6',
  dusk: '#b9796a',
  night: '#1b2438',
};

export function estimateLineSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.2, words / 2.6 + 0.4);
}

function baseHref(): string {
  return globalThis.location?.href ?? 'http://localhost/';
}

function looksLikeHtml(res: Response) {
  return (res.headers.get('content-type') ?? '').startsWith('text/html');
}

/** Fetches the first candidate URL that answers with real bytes (dev servers 200 + index.html). */
async function fetchFirst(urls: string[]): Promise<{ url: string; bytes: ArrayBuffer } | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok || looksLikeHtml(res)) continue;
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > 0) return { url, bytes };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function loadSplat(bytes: ArrayBuffer, url: string): Promise<SplatMesh | null> {
  try {
    const fileName = new URL(url).pathname.split('/').pop() || 'world.spz';
    const mesh = new SplatMesh({ fileBytes: new Uint8Array(bytes), fileName });
    await mesh.initialized;
    if (!mesh.numSplats) {
      mesh.dispose();
      return null;
    }
    return mesh;
  } catch (err) {
    console.warn(`splat world ${url} failed to load; using placeholder`, err);
    return null;
  }
}

function lightsFor(timeOfDay: SceneManifest['plan']['timeOfDay'], interior: boolean) {
  const group = new THREE.Group();
  group.name = 'lights';
  const night = timeOfDay === 'night';
  const hemi = new THREE.HemisphereLight(
    night ? '#8090c0' : '#e8f0ff',
    night ? '#202028' : '#5a5040',
    night ? 1.1 : 1.6,
  );
  const sun = new THREE.DirectionalLight(
    timeOfDay === 'dawn' || timeOfDay === 'dusk' ? '#ffc69a' : night ? '#a0b4ff' : '#ffffff',
    interior ? 1.2 : night ? 0.7 : 2.2,
  );
  sun.position.set(4, 8, 3);
  group.add(hemi, sun);
  return group;
}

const FALLBACK_CHARACTER = (id: string): Character => ({
  id,
  name: id.toUpperCase(),
  description: '',
  voice: { id: 'alloy', gender: 'neutral' },
});

class LoadedScene implements SceneRuntime {
  readonly scene = new THREE.Scene();
  readonly worldRoot = new THREE.Group();
  readonly actors = new Map<string, ActorHandle>();
  readonly grid: THREE.GridHelper;
  readonly spark: SparkRenderer;
  splat: SplatMesh | null = null;
  placeholder = false;
  ground: GroundField | null = null;
  private groundAt: GroundY = () => 0;
  collider: THREE.Object3D | null = null;
  colliderReady: Promise<THREE.Object3D | null> = Promise.resolve(null);
  dynamics!: DynamicsRuntime;
  readonly look: SceneLook;
  sceneEdits: SceneEditsRuntime | null = null;
  quality: SplatQuality;
  time = 0;
  playing = false;
  speakingLineId: string | null = null;
  private placeholderGroup: THREE.Group | null = null;
  /** dialogue line id → speaking character id */
  private readonly lineSpeaker: Map<string, string>;
  private lineToken = 0;
  private readonly cancelWaits = new Set<() => void>();
  private disposed = false;

  constructor(
    readonly manifest: SceneManifest,
    readonly manifestUrl: string,
    public assetBase: string,
    readonly listener: THREE.AudioListener,
    renderer: THREE.WebGLRenderer,
    quality: SplatQuality,
    sparkOptions: SparkOptions = {},
  ) {
    this.quality = quality;
    const { plan, world } = manifest;
    this.lineSpeaker = new Map(plan.dialogue.map((l) => [l.id, l.characterId]));
    this.scene.name = `scene:${plan.slug}`;
    this.scene.background = new THREE.Color(SKY[plan.timeOfDay]);
    this.spark = createSpark(renderer, sparkOptions);
    this.scene.add(this.spark);
    this.look = new SceneLook(this.scene, this.spark);

    const t = worldTransform(world);
    this.worldRoot.name = 'world';
    this.worldRoot.rotation.x = t.rotationX;
    this.worldRoot.scale.setScalar(t.scale);
    this.worldRoot.position.y = t.positionY;
    this.scene.add(this.worldRoot);

    this.grid = new THREE.GridHelper(30, 30, 0x8ab4d8, 0x56606b);
    const gm = this.grid.material as THREE.Material;
    gm.transparent = true;
    gm.opacity = 0.35;
    gm.depthWrite = false;
    this.grid.visible = false;
    this.scene.add(this.grid);
    this.scene.add(lightsFor(plan.timeOfDay, plan.interior));
  }

  resolve(path: string): string {
    return new URL(path, this.assetBase).href;
  }

  setGround(field: GroundField | null) {
    this.ground = field;
    this.groundAt = groundSampler(field, this.manifest.world);
  }

  groundY(x: number, z: number): number {
    return this.groundAt(x, z);
  }

  setLook(look: Look) {
    this.look.setLook(look);
  }

  getLook(): Look {
    return this.look.getLook();
  }

  get edits(): SceneEdits | null {
    return this.look.edits;
  }

  set edits(e: SceneEdits | null) {
    this.look.edits = e;
  }

  setWorld(mesh: SplatMesh | null) {
    if (this.splat) {
      this.worldRoot.remove(this.splat);
      this.splat.dispose();
    }
    this.splat = mesh;
    if (mesh) {
      mesh.name = 'splat-world';
      this.worldRoot.add(mesh);
    }
    this.placeholder = !mesh;
    if (!mesh && !this.placeholderGroup) {
      this.placeholderGroup = createPlaceholderWorld(
        `${this.manifest.projectId}/${this.manifest.plan.slug}`,
        this.manifest.plan.interior,
      );
      this.scene.add(this.placeholderGroup);
    } else if (mesh && this.placeholderGroup) {
      this.scene.remove(this.placeholderGroup);
      disposeObject(this.placeholderGroup);
      this.placeholderGroup = null;
    }
  }

  update(dt: number) {
    if (this.disposed) return;
    if (this.playing) this.time += dt;
    this.dynamics.update(this.time);
    this.aimHeads();
    for (const a of this.actors.values()) {
      a.update(dt, this.time);
      // a walking body off its mark (the skinned walk-in reports how far) stands on the ground
      // under it, not at the mark's height
      if (this.ground) {
        const behind = Number((a.object.userData.debug as { walkRemaining?: number } | undefined)?.walkRemaining ?? 0);
        followGround(a.object, behind, this.groundAt);
      }
    }
    this.sceneEdits?.update(this.time);
    this.look.update();
  }

  /** Heads turn toward whoever speaks, else toward the nearest partner (viewer/gaze.ts). */
  private aimHeads() {
    if (this.actors.size < 2) return;
    const speaker = this.speakingLineId ? (this.lineSpeaker.get(this.speakingLineId) ?? null) : null;
    const cast = [...this.actors.values()].map((a) => ({
      id: a.characterId,
      x: a.object.position.x,
      z: a.object.position.z,
    }));
    const targets = gazeTargets(cast, speaker);
    for (const a of this.actors.values()) {
      const t = targets.get(a.characterId);
      a.lookAt?.(t ? (this.actors.get(t)?.object.position ?? null) : null);
    }
  }

  setTime(t: number) {
    this.time = Math.max(0, Number.isFinite(t) ? t : 0);
    this.dynamics.update(this.time);
  }

  private wait(seconds: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(id);
        this.cancelWaits.delete(done);
        resolve();
      };
      const id = setTimeout(done, seconds * 1000);
      this.cancelWaits.add(done);
    });
  }

  async playLine(lineId: string) {
    const line: DialogueLine | undefined = this.manifest.plan.dialogue.find((l) => l.id === lineId);
    if (!line) throw new Error(`unknown line ${lineId}`);
    this.stopLines();
    const token = ++this.lineToken;
    const audio = this.manifest.audio.find((a) => a.lineId === lineId);
    const seconds = audio?.durationSeconds || estimateLineSeconds(line.text);
    const actor = this.actors.get(line.characterId);
    this.speakingLineId = lineId;
    try {
      if (actor && audio) {
        // never let a stuck actor stall the dialogue playlist
        await Promise.race([
          actor.speak(lineId, this.resolve(audio.url), seconds, line.text),
          this.wait(seconds + 3),
        ]);
      } else {
        await this.wait(seconds);
      }
    } finally {
      if (token === this.lineToken) this.speakingLineId = null;
    }
  }

  stopLines() {
    this.lineToken++;
    this.speakingLineId = null;
    for (const a of this.actors.values()) a.stopSpeaking();
    for (const cancel of [...this.cancelWaits]) cancel();
  }

  async setQuality(quality: SplatQuality): Promise<boolean> {
    const rel = this.manifest.world.spz[quality];
    if (!rel || quality === this.quality) return false;
    const got = await fetchFirst([this.resolve(rel)]);
    const mesh = got && (await loadSplat(got.bytes, got.url));
    if (!mesh || this.disposed) {
      mesh?.dispose();
      return false;
    }
    this.setWorld(mesh);
    this.quality = quality;
    return true;
  }

  async swapActors(assets: ActorAsset[]): Promise<string[]> {
    const swapped: string[] = [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const asset of assets) {
      const index = this.manifest.actors.findIndex((a) => a.characterId === asset.characterId);
      if (index >= 0 && same(this.manifest.actors[index], asset)) continue;
      const character =
        this.manifest.characters.find((c) => c.id === asset.characterId) ?? FALLBACK_CHARACTER(asset.characterId);
      const actor = await createActor(asset, character, this.listener, this.assetBase);
      if (this.disposed) {
        actor.dispose();
        break;
      }
      const old = this.actors.get(asset.characterId);
      const b = this.manifest.plan.blocking.find((x) => x.characterId === asset.characterId);
      if (old) {
        // the old body's spot before any edit (its mark or the collider's free floor, on the
        // ground there); the scene's actor transforms are applied to the new body again below
        const base = this.sceneEdits?.release(old.object);
        actor.object.position.copy(base?.position ?? old.object.position);
        if (!base) actor.object.position.y = markY(old.object);
        actor.object.rotation.y = base?.yaw ?? old.object.rotation.y;
        actor.object.userData.placement = old.object.userData.placement;
        old.stopSpeaking();
        this.scene.remove(old.object);
        old.dispose();
      } else if (b) {
        actor.object.position.set(...onGround(b.position, (x, z) => this.groundY(x, z)));
        actor.object.rotation.y = b.yaw;
      }
      actor.setPose(b?.pose ?? 'standing');
      this.scene.add(actor.object);
      this.actors.set(asset.characterId, actor);
      if (index >= 0) this.manifest.actors[index] = asset;
      else this.manifest.actors.push(asset);
      swapped.push(asset.characterId);
    }
    if (swapped.length) this.sceneEdits?.refresh();
    return swapped;
  }

  get isDisposed() {
    return this.disposed;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLines();
    for (const a of this.actors.values()) a.dispose();
    this.actors.clear();
    this.dynamics?.dispose();
    this.splat?.dispose();
    if (this.placeholderGroup) disposeObject(this.placeholderGroup);
    if (this.collider) disposeObject(this.collider);
    disposeObject(this.grid);
    this.sceneEdits?.dispose();
    this.look.dispose();
    this.spark.dispose();
    this.scene.clear();
  }
}

/**
 * Moves actors whose blocking puts them inside collider geometry (or off its floor) to free floor
 * (toward the start camera, ≥ 0.5 m from the others) and onto the ground there (its height above
 * the ground kept), turning a moved actor to face its nearest partner. Every actor gets
 * `userData.placement = { status, from, to }`.
 */
function correctActorPlacement(rt: LoadedScene, collider: THREE.Object3D) {
  const tris = colliderTriangles(collider);
  if (!tris.length) return;
  const grid = new TriGrid(tris);
  const poses = new Map(rt.manifest.plan.blocking.map((b) => [b.characterId, b.pose]));
  const start = rt.manifest.startCamera.position;
  const actors = [...rt.actors.values()];
  const xz = (o: THREE.Object3D): V2 => [o.position.x, o.position.z];
  for (const actor of actors) {
    const from = xz(actor.object);
    const others = actors.filter((a) => a !== actor).map((a) => xz(a.object));
    const r = correctPlacement(grid, from[0], from[1], {
      pose: poses.get(actor.characterId) ?? 'standing',
      toward: [start[0], start[2]],
      avoid: others,
    });
    actor.object.userData.placement = { status: r.status, from, to: [r.x, r.z] };
    if (r.status === 'stuck')
      console.warn(`[placement] ${actor.characterId}: misplaced, but no free floor within 3 m`);
    if (r.status !== 'moved') continue;
    // the new spot has never been measured: its own ground, not the mark's
    const lift = markY(actor.object) - rt.groundY(from[0], from[1]);
    actor.object.position.set(r.x, rt.groundY(r.x, r.z) + lift, r.z);
    const partner = others.sort(
      (a, b) => Math.hypot(a[0] - r.x, a[1] - r.z) - Math.hypot(b[0] - r.x, b[1] - r.z),
    )[0];
    if (partner) actor.object.rotation.y = yawToward([r.x, r.z], partner);
    console.info(
      `[placement] ${actor.characterId}: moved to free floor (${from.map((v) => v.toFixed(2))}) → (${r.x.toFixed(2)}, ${r.z.toFixed(2)})`,
    );
  }
}

/**
 * Loads a SceneManifest. Asset paths resolve against the project root (/projects/<id>/, per
 * shared/schema.ts); if the world SPZ is not found there but is next to the manifest, the
 * manifest's directory is used as the base for every asset instead.
 */
export async function loadScene(
  manifestUrl: string,
  opts: LoadSceneOptions,
): Promise<SceneRuntime> {
  const status = opts.onStatus ?? (() => {});
  const manifestHref = new URL(manifestUrl, baseHref()).href;
  status('loading manifest…');
  const res = await fetch(manifestHref);
  if (!res.ok) throw new Error(`manifest ${manifestUrl}: HTTP ${res.status}`);
  const manifest = SceneManifest.parse(await res.json());

  const manifestDir = new URL('./', manifestHref).href;
  const projectRoot = new URL('../', manifestDir).href;
  const quality: SplatQuality =
    opts.quality && manifest.world.spz[opts.quality] ? opts.quality : 'k500';
  const spzRel = manifest.world.spz[quality] ?? manifest.world.spz.k500;

  status('loading world…');
  // schema: asset paths are relative to the project root; also accept manifest-relative paths
  const bases = [projectRoot, manifestDir];
  const candidates = bases.map((b) => new URL(spzRel, b).href);
  const got = await fetchFirst([...new Set(candidates)]);
  const assetBase = got ? bases[candidates.indexOf(got.url)]! : projectRoot;

  const listener = opts.listener ?? new THREE.AudioListener();
  const rt = new LoadedScene(
    manifest,
    manifestUrl,
    assetBase,
    listener,
    opts.renderer,
    quality,
    opts.spark,
  );
  // the ground field (tens of kB) loads while the splats initialise; actors wait for it
  const groundFile = manifest.world.ground?.file;
  const groundLoad = groundFile ? loadGroundField(rt.resolve(groundFile)) : Promise.resolve(null);
  rt.setWorld(got ? await loadSplat(got.bytes, got.url) : null);
  rt.setGround(await groundLoad);

  // the collider (several MB for a real world) loads in the background; actors are corrected
  // against it when it arrives
  const colliderGlb = manifest.world.colliderGlb;
  const colliderLoad = colliderGlb
    ? new GLTFLoader().loadAsync(rt.resolve(colliderGlb)).catch((err) => {
        console.warn('collider GLB failed to load', err);
        return null;
      })
    : Promise.resolve(null);

  status('placing actors…');
  const blocking = new Map(manifest.plan.blocking.map((b) => [b.characterId, b]));
  let unblocked = 0;
  await Promise.all(
    manifest.actors.map(async (asset) => {
      const character =
        manifest.characters.find((c) => c.id === asset.characterId) ??
        FALLBACK_CHARACTER(asset.characterId);
      try {
        const actor = await createActor(asset, character, listener, rt.assetBase);
        const b = blocking.get(asset.characterId);
        const groundY = (x: number, z: number) => rt.groundY(x, z);
        if (b) {
          // blocking y is the height above the ground (the planner writes 0: standing on it)
          actor.object.position.set(...onGround(b.position, groundY));
          actor.object.rotation.y = b.yaw;
          actor.setPose(b.pose ?? 'standing');
        } else {
          // no blocking: line up facing the source camera, 3 m in front of it
          actor.object.position.set(...onGround([-1 + unblocked++ * 1.2, 0, -3], groundY));
          actor.object.rotation.y = Math.PI;
        }
        rt.scene.add(actor.object);
        rt.actors.set(asset.characterId, actor);
      } catch (err) {
        console.warn(`actor ${asset.characterId} failed to load`, err);
      }
    }),
  );

  // decode every voice clip in the background so the first cue does not wait on the network
  const speaker = new Map(manifest.plan.dialogue.map((l) => [l.id, l.characterId]));
  for (const a of manifest.audio) {
    if (rt.actors.has(speaker.get(a.lineId) ?? '')) void preloadAudio(rt.resolve(a.url));
  }

  rt.dynamics = createDynamics(manifest.plan.dynamics, projectFileResolver(manifestUrl));
  rt.scene.add(rt.dynamics.group);
  rt.colliderReady = colliderLoad.then((gltf) => {
    if (!gltf || rt.isDisposed) return null;
    const wire = new THREE.MeshBasicMaterial({
      color: '#7fd1ff',
      wireframe: true,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.material = wire;
    });
    gltf.scene.name = 'collider';
    gltf.scene.visible = false;
    rt.worldRoot.add(gltf.scene); // same Marble → metric transform as the splats
    rt.collider = gltf.scene;
    try {
      correctActorPlacement(rt, gltf.scene);
    } catch (err) {
      console.warn('actor placement correction failed', err);
    }
    return gltf.scene;
  });
  rt.sceneEdits = new SceneEditsRuntime(rt);
  status(rt.placeholder ? 'placeholder world (SPZ unavailable)' : 'ready');
  return rt;
}

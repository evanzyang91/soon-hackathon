// The look of one loaded scene (SceneRuntime.look): the current Look, the scene-edits slot, the
// splat + mesh lights, and the per-view hook the ViewportRenderer calls right before it renders a
// camera (lens → Spark DOF, post settings). Shared by laptop and phone.
//
// Plug-in points (WP G and the laptop):
//   setLook(look) / getLook()       the scene's look (the laptop's live look, edits.json's look)
//   edits                           the scene's SceneEdits document (null until one is loaded)
//   adoptEdits(doc)                 a document the server returned (GET, PUT, re-prompt): becomes
//                                   `edits` and its look the scene look; onEdits listeners (the
//                                   laptop's look session) pick up the new revision
//   viewLook = (camera) => Look     per-view override (e.g. a dropped camera's own lens)
//   compare = true                  ungraded frame (no grade, no lights, no DOF)
import * as THREE from 'three';
import type { SparkRenderer } from '@sparkjsdev/spark';
import { defaultLook, Look, type SceneEdits } from '@shared/look';
import { gradeParams, hasAtmosphere, isIdentityGrade, type GradeParams } from './grade';
import { sparkLens } from './lens';
import { MeshAtmosphere, MeshLights, SplatLights } from './lights';
import type { PostSettings } from './post';

export interface LookProvider {
  /**
   * Called right before a view renders from `camera`: sets that view's lens on `spark` (the
   * view's SparkRenderer; null = the scene's own) and returns its post settings, or null to render
   * straight to the canvas (identity look, compare).
   */
  prepare(camera: THREE.Camera, spark: SparkRenderer | null): PostSettings | null;
}

const PROVIDER_KEY = 'previzLook';
export const lookProviderOf = (scene: THREE.Object3D): LookProvider | null =>
  (scene.userData[PROVIDER_KEY] as LookProvider | undefined) ?? null;

/** What a device can afford (the phone turns bloom off when it renders too slowly). */
export interface LookQuality {
  bloom: boolean;
}

export class SceneLook implements LookProvider {
  /** The scene's SceneEdits (edits.json); WP G fills `edits`, the look panel keeps it in sync. */
  edits: SceneEdits | null = null;
  /** Per-view look (dropped-camera lens overrides); default: the scene look for every view. */
  viewLook: ((camera: THREE.Camera) => Look) | null = null;
  /** Hold-to-compare: render the ungraded frame. */
  compare = false;
  /** Always run the post pass, even for an identity look (parity checks). */
  forcePost = false;
  quality: LookQuality = { bloom: true };
  readonly splatLights = new SplatLights();
  readonly meshLights = new MeshLights();
  private readonly meshAtmosphere: MeshAtmosphere;
  /** Bumped on every setLook (UI / tests can watch it). */
  version = 0;
  private look: Look = defaultLook();
  private readonly params = new WeakMap<Look, GradeParams>();
  private lastAttach = -Infinity;
  private readonly listeners = new Set<(look: Look) => void>();
  private readonly editsListeners = new Set<(doc: SceneEdits) => void>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly spark: SparkRenderer,
  ) {
    scene.userData[PROVIDER_KEY] = this;
    scene.add(this.meshLights.group);
    this.meshAtmosphere = new MeshAtmosphere(scene);
  }

  getLook(): Look {
    return this.look;
  }

  /** Replaces the scene's look (validated; out-of-range values are clamped by the schema's rules or rejected). */
  setLook(look: Look): void {
    const parsed = Look.safeParse(look);
    if (!parsed.success) {
      console.warn('[look] invalid look ignored', parsed.error.issues[0]);
      return;
    }
    this.look = parsed.data;
    this.version++;
    this.applyLights();
    for (const fn of this.listeners) fn(this.look);
  }

  onChange(fn: (look: Look) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Takes a server document (edits.json) as the truth: `edits`, and its look as the scene look. */
  adoptEdits(doc: SceneEdits): void {
    this.edits = doc;
    this.setLook(doc.look);
    for (const fn of this.editsListeners) fn(doc);
  }

  onEdits(fn: (doc: SceneEdits) => void): () => void {
    this.editsListeners.add(fn);
    return () => this.editsListeners.delete(fn);
  }

  setCompare(on: boolean) {
    this.compare = on;
    this.applyLights();
  }

  /** Per frame: picks up splat meshes that appeared (actors swapped in, a new world quality). */
  update(now = performance.now()) {
    if (now - this.lastAttach > 500 && !this.splatLights.neutral) {
      this.lastAttach = now;
      this.splatLights.attachAll(this.scene);
    }
  }

  private applyLights() {
    const look = this.compare ? null : this.look;
    const active =
      !!look && (look.ambient !== 1 || look.lights.some((l) => l.enabled) || hasAtmosphere(look));
    // the modifier is only installed once a look really changes the splats (an untouched scene
    // keeps Spark's own generator); afterwards neutral uniforms switch it off
    if (active) this.splatLights.attachAll(this.scene);
    this.splatLights.set(look);
    this.meshLights.set(look?.lights ?? []);
    this.meshAtmosphere.set(look);
  }

  paramsFor(look: Look): GradeParams {
    let p = this.params.get(look);
    if (!p) this.params.set(look, (p = gradeParams(look)));
    return p;
  }

  prepare(camera: THREE.Camera, spark: SparkRenderer | null): PostSettings | null {
    const view = spark ?? this.spark;
    const look = this.compare ? null : (this.viewLook?.(camera) ?? this.look);
    const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 50;
    const lens = sparkLens(look?.dof, fov);
    view.focalDistance = lens.focalDistance;
    view.apertureAngle = lens.apertureAngle;
    if (!look) return this.forcePost ? { params: this.paramsFor(defaultLook()) } : null;
    if (isIdentityGrade(look) && !this.forcePost) return null;
    const params = this.paramsFor(look);
    return { params: !this.quality.bloom && params.bloom > 0 ? { ...params, bloom: 0 } : params };
  }

  dispose() {
    delete this.scene.userData[PROVIDER_KEY];
    this.meshAtmosphere.set(null);
    this.splatLights.dispose();
    this.meshLights.dispose();
    this.scene.remove(this.meshLights.group);
    this.listeners.clear();
    this.editsListeners.clear();
  }
}

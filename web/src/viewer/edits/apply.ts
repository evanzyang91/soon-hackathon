// Scene edits on a loaded scene (laptop and phone alike): every frame the runtime's `edits`
// document (SceneRuntime.edits, filled from edits.json) is compared with the last one applied, and
// when it changed the scene is rebuilt from it — idempotently, from the scene's base state:
//
//   splat-region → Spark SplatEdit + SplatEditSdf on the world mesh (model.ts regionSpecs):
//                  colour multiply / set_rgb (hue = luminance-keeping multiply), opacity (hide),
//                  displace (move), scale (displacement field of 5³ smoothly blended cells)
//   transform    → actor / prop transforms (lights live in the Look; cameras on the laptop). An
//                  actor's position[1] is its height ABOVE THE GROUND at (x, z) (viewer/ground.ts):
//                  0 stands it on the visible ground there, which is what every actor transform
//                  stored before the ground field (y = 0 on the old flat floor) keeps meaning
//   prop-add     → a procedural prop (parked or moving along its path on the scene clock)
//   prop-remove  → hides a screenplay or added prop
//   look         → nothing here: re-prompt looks are baked into SceneEdits.look on the server
//                  (the look op stays in `edits` as the record, with its "before" in history),
//                  and the look pipeline (viewer/look) renders SceneEdits.look.
//
// Disabled edits are skipped, so toggling `enabled` (or deleting the op) and saving the document
// is all it takes to switch an edit off live. A world mesh swapped by a quality change gets the
// region edits again on the next frame.
import * as THREE from 'three';
import { SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType, type SplatMesh } from '@sparkjsdev/spark';
import type { SceneEdits } from '@shared/look';
import type { DynamicElement } from '@shared/schema';
import { PathSampler } from '../dynamics-path';
import { markY, onGround } from '../ground';
import { createProp, type Prop } from '../props';
import type { SceneRuntime } from '../world';
import {
  effectiveProps,
  effectiveTransforms,
  isParked,
  regionSpecs,
  type RegionEdit,
  type SdfSpec,
  type SplatEditSpec,
  type TargetTransform,
} from './model';

/** What apply.ts needs from a SceneRuntime (tests and harnesses can fake it). */
export type EditsHost = Pick<SceneRuntime, 'scene' | 'splat' | 'actors' | 'dynamics' | 'colliderReady' | 'time'> &
  Partial<Pick<SceneRuntime, 'groundY'>> & {
    edits: SceneEdits | null;
  };

interface Base {
  position: THREE.Vector3;
  yaw: number;
  scale: THREE.Vector3;
}

interface AddedProp {
  element: DynamicElement;
  prop: Prop;
  sampler: PathSampler | null;
}

export interface EditsDebug {
  revision: number;
  regions: number;
  splatEdits: number;
  transforms: number;
  added: number;
  hidden: number;
  preview: boolean;
}

function sdfFor(spec: SdfSpec): SplatEditSdf {
  const sdf = new SplatEditSdf({
    type: spec.type === 'box' ? SplatEditSdfType.BOX : SplatEditSdfType.SPHERE,
    radius: spec.type === 'sphere' ? spec.radius : 0,
    displace: new THREE.Vector3(...spec.displace),
  });
  sdf.position.set(...spec.center);
  sdf.rotation.y = spec.yaw;
  // Spark reads a box's half-extents from the SDF object's scale
  if (spec.type === 'box') sdf.scale.set(...spec.halfExtents);
  sdf.updateMatrixWorld(true);
  return sdf;
}

/** A Spark SplatEdit for one spec. SDFs are listed explicitly (not children of the edit). */
export function splatEditFor(spec: SplatEditSpec, name: string): SplatEdit {
  const sdfs = spec.sdfs.map(sdfFor);
  for (const s of sdfs) {
    // colour + opacity are per SDF in Spark; raw display-referred values (no colour management)
    s.color.setRGB(spec.rgb[0], spec.rgb[1], spec.rgb[2], THREE.LinearSRGBColorSpace);
    s.opacity = spec.opacity;
  }
  return new SplatEdit({
    name,
    rgbaBlendMode: spec.blend === 'set_rgb' ? SplatEditRgbaBlendMode.SET_RGB : SplatEditRgbaBlendMode.MULTIPLY,
    softEdge: spec.softEdge,
    sdfSmooth: spec.sdfSmooth,
    sdfs,
  });
}

export class SceneEditsRuntime {
  private applied: SceneEdits | null | undefined = undefined;
  private mesh: SplatMesh | null = null;
  private regionEdits: SplatEdit[] = [];
  private previewEdits: SplatEdit[] = [];
  private readonly base = new WeakMap<THREE.Object3D, Base>();
  private readonly touched = new Set<THREE.Object3D>();
  private readonly hidden = new Set<THREE.Object3D>();
  private added: AddedProp[] = [];
  private readonly group = new THREE.Group();
  private transforms = new Map<string, TargetTransform>();
  private colliderSettled = false;
  private disposed = false;
  /** Bumped whenever the scene was rebuilt from a document (tests / UI). */
  version = 0;

  constructor(private readonly host: EditsHost) {
    this.group.name = 'edit-props';
    host.scene.add(this.group);
    // transforms wait for the collider: placement correction may still move actors before it
    void host.colliderReady.then(() => {
      this.colliderSettled = true;
      this.applied = undefined;
    });
  }

  /** Per frame (after the scene's own update): re-applies a changed document, moves added props. */
  update(time: number) {
    if (this.disposed) return;
    if (this.host.edits !== this.applied) this.apply(this.host.edits);
    if (this.host.splat !== this.mesh) this.attachRegions();
    for (const a of this.added) {
      if (!a.sampler) continue;
      const s = a.sampler.sample(time);
      a.prop.object.position.set(...s.position);
      a.prop.object.rotation.y = s.heading;
      a.prop.animate(s.distance, time);
    }
    this.followMovingProps();
  }

  /**
   * An object leaves the scene (world.ts swapActors replaces an actor's body): its spot before any
   * edit (null when no transform touched it), and it is no longer restored or transformed.
   */
  release(o: THREE.Object3D): { position: THREE.Vector3; yaw: number } | null {
    const b = this.base.get(o);
    this.base.delete(o);
    this.touched.delete(o);
    return b ? { position: b.position.clone(), yaw: b.yaw } : null;
  }

  /** Applies the document again on the next frame (e.g. to a swapped-in actor body). */
  refresh() {
    this.applied = undefined;
  }

  /** A live preview region (the edit panel while the director sizes a selection); null clears. */
  setPreview(region: RegionEdit | null) {
    this.previewEdits = region ? regionSpecs(region).map((s, i) => splatEditFor(s, `preview-${i}`)) : [];
    this.attachRegions(true);
  }

  debug(): EditsDebug {
    return {
      revision: this.applied?.revision ?? -1,
      regions: this.applied?.edits.filter((e) => e.kind === 'splat-region' && e.enabled).length ?? 0,
      splatEdits: this.regionEdits.length,
      transforms: this.touched.size,
      added: this.added.length,
      hidden: this.hidden.size,
      preview: this.previewEdits.length > 0,
    };
  }

  private apply(doc: SceneEdits | null) {
    this.applied = doc;
    const edits = doc?.edits ?? [];
    // ---- regions
    this.regionEdits = edits
      .filter((e): e is RegionEdit => e.kind === 'splat-region' && e.enabled)
      .flatMap((r) => regionSpecs(r).map((s) => splatEditFor(s, `${r.id}:${s.role}`)));
    this.attachRegions(true);
    // ---- props (an added prop is rebuilt only when its element changed)
    const { added, removed } = effectiveProps(edits);
    const wanted = new Map(added.map((el) => [el.id, el]));
    const kept: AddedProp[] = [];
    for (const a of this.added) {
      const el = wanted.get(a.element.id);
      if (el && JSON.stringify(el) === JSON.stringify(a.element)) kept.push(a);
      else {
        this.group.remove(a.prop.object);
        a.prop.dispose();
      }
    }
    this.added = kept;
    for (const el of added) {
      if (this.added.some((a) => a.element.id === el.id)) continue;
      const prop = createProp(el.kind, el.label);
      prop.object.scale.setScalar(el.scale ?? 1);
      prop.object.userData.dynamicId = el.id;
      prop.object.userData.editProp = true;
      let sampler: PathSampler | null = null;
      if (isParked(el)) {
        const [a, b] = el.path;
        prop.object.position.set(...a!);
        prop.object.rotation.y = Math.atan2(-(b![0] - a![0]), -(b![2] - a![2]));
      } else {
        sampler = new PathSampler(el.path, { speed: el.speed, loop: el.loop ?? true, pauseSeconds: el.pauseSeconds ?? 2 });
      }
      this.group.add(prop.object);
      this.added.push({ element: el, prop, sampler });
    }
    for (const o of this.hidden) o.visible = true;
    this.hidden.clear();
    for (const item of this.host.dynamics.items) {
      if (removed.has(item.element.id)) {
        item.object.visible = false;
        this.hidden.add(item.object);
      }
    }
    for (const a of this.added) a.prop.object.visible = !removed.has(a.element.id);
    // ---- transforms (after the collider settled actor placement)
    this.transforms = this.colliderSettled ? effectiveTransforms(edits) : new Map();
    for (const o of this.touched) this.restore(o);
    this.touched.clear();
    const groundY = this.host.groundY?.bind(this.host);
    for (const [key, t] of this.transforms) {
      const [type, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const obj =
        type === 'actor'
          ? this.host.actors.get(id)?.object
          : type === 'prop'
            ? (this.added.find((a) => a.element.id === id)?.prop.object ??
              this.host.dynamics.items.find((i) => i.element.id === id)?.object)
            : undefined;
      if (!obj) continue;
      const b = this.snapshot(obj);
      const moving = type === 'prop' && this.isMovingProp(id);
      if (t.position && !moving)
        obj.position.set(...(type === 'actor' && groundY ? onGround(t.position, groundY) : t.position));
      if (t.yaw !== undefined && !moving) obj.rotation.y = t.yaw;
      if (t.scale !== undefined) obj.scale.copy(b.scale).multiplyScalar(t.scale);
      this.touched.add(obj);
    }
    this.version++;
  }

  private isMovingProp(id: string): boolean {
    const added = this.added.find((a) => a.element.id === id);
    if (added) return !!added.sampler;
    const item = this.host.dynamics.items.find((i) => i.element.id === id);
    return !!item && !isParked(item.element);
  }

  /** Moving props follow their path every frame; a move shifts the whole path (offset). */
  private followMovingProps() {
    for (const [key, t] of this.transforms) {
      if (!key.startsWith('prop:') || !t.position) continue;
      const id = key.slice(5);
      if (!this.isMovingProp(id)) continue;
      const added = this.added.find((a) => a.element.id === id);
      const obj = added?.prop.object ?? this.host.dynamics.items.find((i) => i.element.id === id)?.object;
      const start = added?.element.path[0] ?? this.host.dynamics.items.find((i) => i.element.id === id)?.element.path[0];
      if (!obj || !start) continue;
      obj.position.x += t.position[0] - start[0];
      obj.position.z += t.position[2] - start[2];
    }
  }

  private snapshot(o: THREE.Object3D): Base {
    let b = this.base.get(o);
    if (!b) {
      // the mark's height, not a walking body's momentary ground difference (viewer/ground.ts)
      b = { position: o.position.clone().setY(markY(o)), yaw: o.rotation.y, scale: o.scale.clone() };
      this.base.set(o, b);
    }
    return b;
  }

  private restore(o: THREE.Object3D) {
    const b = this.base.get(o);
    if (!b) return;
    o.position.copy(b.position);
    o.rotation.y = b.yaw;
    o.scale.copy(b.scale);
  }

  private attachRegions(force = false) {
    const mesh = this.host.splat;
    if (this.mesh && this.mesh !== mesh) this.mesh.edits = null;
    this.mesh = mesh;
    if (!mesh) return;
    if (!force && mesh.edits) return;
    const all = [...this.regionEdits, ...this.previewEdits];
    // an explicit list: global SplatEdits in the scene would also edit the actors' splats
    mesh.edits = all;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const o of this.touched) this.restore(o);
    for (const o of this.hidden) o.visible = true;
    for (const a of this.added) a.prop.dispose();
    this.group.removeFromParent();
    if (this.mesh) this.mesh.edits = null;
  }
}

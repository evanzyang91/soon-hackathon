// Direct manipulation in the director's viewport (docs/PLAN-v2.md §3):
//
//   hover            outline around the actor / prop / light / camera under the pointer
//   click            select it: a ring on the floor, a rotate ring, a scale / radius knob, a focus
//                    point for a camera with depth of field, and a floating toolbar
//   drag             move on the floor plane (actors slide along walls: the collider decides,
//                    viewer/placement.ts, and stand on the visible ground wherever they go,
//                    viewer/ground.ts); Shift+drag raises / lowers; the ring turns (Shift snaps
//                    15°); the knob scales a prop or sets a light's radius; the focus point slides
//                    along the camera's view axis
//   arrows           nudge 5 cm (Shift 50 cm) along the world axis the view faces most
//   Delete           props, lights, cameras (actors: Reset to blocking instead)
//   Esc              cancel a drag / deselect
//   click the world  (nothing under the pointer) a splat region: a sphere at the hit with an auto
//                    radius (viewer/edits/select.ts), drag its outline to resize; toolbar: Recolour,
//                    Hide, Move (drag inside), Edit › (hands it to the Edit tab), Delete region
//
// Where changes go: actors and props → `transform` / `prop-remove` scene edits and regions →
// `splat-region` edits, previewed live in the runtime's edits document and saved to edits.json
// on release (viewer/edits/apply.ts applies them on laptop and phone); lights → the scene look
// (the look session saves and broadcasts it); cameras → the director's dropped cameras (the phone
// anchored to one follows live). Every change is one step on the host's undo stack.
//
// Left-drag on empty space stays a camera look (fly-controls asks `claims(e)` first); right-drag,
// wheel and WASD are untouched. Tools that own clicks (Look's pick focus, Alt+click, the Edit
// tab's select mode) run in the capture phase and stop the event before it gets here.
import * as THREE from 'three';
import { SceneEdit, emptySceneEdits, type Light, type Look, type SceneEdits } from '@shared/look';
import type { DropCamera } from '@shared/protocol';
import type { DynamicElement, Vec3 } from '@shared/schema';
import { effectiveProps, type RegionEdit } from '../edits/model';
import { raycastSplat, SelectionGizmo, sphereFromClick, type RegionSelection } from '../edits/select';
import { clampFocus } from '../look/lens';
import type { SceneRuntime } from '../world';
import {
  editById,
  manualRemovalId,
  manualTransformId,
  regionAt,
  resetTransforms,
  restoreEdits,
  sameRef,
  snapshotEdits,
  transformIdsFor,
  transformOf,
  withEdit,
  withoutEdit,
  withPropRemoved,
  withTransform,
  type TargetRef,
  type TransformFields,
} from './edits';
import { FloorGuard } from './floor';
import { ManipGizmos, type Part, type SelectionVisual } from './handles';
import {
  closestOnAxis,
  nudgeDelta,
  polylineDistance2D,
  rayPlaneY,
  ringDelta,
  rayVerticalPlane,
  rotateYaw,
  round3,
  roundV3,
  snapAngle,
  type Ray,
  type V2,
  type V3,
} from './math';
import { aboveGround, markY, onGround } from '../ground';
import { allTargets, pickTarget, targetInfo, toScreen, type TargetContext, type TargetInfo } from './targets';
import { Toolbar, type ToolbarModel, type ToolItem } from './toolbar';
import type { UndoStack } from './undo';

export type { TargetRef } from './edits';

/** The edits.json document as the manipulator sees it (laptop: laptop/edits-store.ts). */
export interface ManipEdits {
  /** The document applied right now (a live preview included); null until loaded. */
  current(): SceneEdits | null;
  /** The document before the live preview (what an undo snapshot is taken from). */
  base(): SceneEdits | null;
  /** Live, unsaved: applies on the next frame. Every call starts again from `base()`. */
  preview(fn: (d: SceneEdits) => SceneEdits): void;
  cancelPreview(): void;
  /** Saves (read-modify-write: `fn` runs again on a newer stored document after a 409). */
  commit(fn: (d: SceneEdits) => SceneEdits): Promise<boolean>;
}

export interface ManipHost {
  readonly canvas: HTMLCanvasElement;
  /** Holds the floating toolbar (the viewport's container). */
  readonly overlay: HTMLElement;
  /** Layer the director's camera sees and the phone / PiP do not. */
  readonly layer: number;
  runtime(): SceneRuntime | null;
  /** The camera the viewport shows; null switches manipulation off (viewing through the phone). */
  camera(): THREE.PerspectiveCamera | null;
  /** Another tool owns this press / click (pick focus, the Edit tab's select, the PiP corner). */
  blocked(e: { clientX: number; clientY: number }): boolean;
  /** character id → display name */
  names(): ReadonlyMap<string, string>;
  edits: ManipEdits;
  undo: UndoStack;
  /** The scene look (lights, depth of field). */
  look(): Look | null;
  /** Live look change; the same `coalesce` key = one look-undo step. */
  setLook(next: Look, coalesce: string | null): void;
  sealLook(): void;
  /** The depth of field a dropped camera renders with; `own` = its own lens (edited in the Look tab). */
  cameraLens(id: string): { dof: Look['dof']; own: boolean } | null;
  /** Sets a camera's own lens (when the Look tab gave it one); absent = the focus point is read-only then. */
  setCameraLens?(id: string, dof: Look['dof']): void;
  cameras(): readonly DropCamera[];
  activeCameraId(): string | null;
  /** `persist` = end of a change (saved with the cameras); live changes reach the phone too. */
  updateCamera(id: string, patch: Partial<Omit<DropCamera, 'id'>>, persist: boolean): void;
  removeCamera(id: string): void;
  restoreCamera(cam: DropCamera, index: number, active: boolean): void;
  setActiveCamera(id: string): void;
  lookThrough(cam: DropCamera): void;
  selectionChanged(ref: TargetRef | null): void;
  regionChanged(sel: RegionSelection | null): void;
  sendRegionToEdit(sel: RegionSelection): void;
  toast(text: string): void;
}

/** What a press landed on; a body hit carries the grabbed point (the drag plane goes through it). */
type Hit = { part: Part; ref: TargetRef; point?: V3 } | { part: 'region-edge' } | { part: 'region-body' };

interface Pointer {
  ray: Ray;
  px: V2;
  ndc: [number, number];
  width: number;
  height: number;
  camera: THREE.PerspectiveCamera;
}

interface Press {
  x: number;
  y: number;
  pointerId: number;
  hit: Hit | null;
}

interface RegionState {
  sel: RegionSelection;
  /** The scene edit this region drives (null: a fresh selection, nothing applied yet). */
  editId: string | null;
  label: string;
  /** "Move" toggled: dragging inside the region moves its splats. */
  moving: boolean;
}

type Before =
  | { type: 'edits'; snap: ReturnType<typeof snapshotEdits>; ids: string[] }
  | { type: 'light'; light: Light; index: number }
  | { type: 'camera'; cam: DropCamera }
  | { type: 'look'; dof: Look['dof'] }
  | { type: 'none' };

type Drag =
  | { kind: 'move'; ref: TargetRef; info: TargetInfo; raise: boolean; plane: V3; hit0: V3; start: V3; last: V3; before: Before; label: string; keyboard?: boolean }
  | { kind: 'rotate'; ref: TargetRef; info: TargetInfo; center: V3; hit0: V3; yaw0: number; last: number; before: Before; label: string }
  | { kind: 'scale'; ref: TargetRef; info: TargetInfo; center: V3; d0: number; s0: number; last: number; before: Before; label: string }
  | { kind: 'focus'; ref: TargetRef; info: TargetInfo; o: V3; d: V3; s0: number; f0: number; last: number; before: Before; label: string; own: string | null }
  | { kind: 'region-size'; c: V2; d0: number; size0: Vec3; before: Before }
  | { kind: 'region-move'; y: number; hit0: V3; d0: Vec3; last: Vec3; before: Before };

const DRAG_PX = 4;
const REGION_CLICK_MS = 260;
const NUDGE_IDLE_MS = 450;
const RING_PX = 9;
const KNOB_PX = 13;
const uid = () => Math.random().toString(36).slice(2, 10);
const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el?.tagName && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
};

export class Manipulator {
  selected: TargetRef | null = null;
  region: RegionState | null = null;
  private hover: TargetRef | null = null;
  private hot: Hit | null = null;
  private press: Press | null = null;
  private drag: Drag | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private rt: SceneRuntime | null = null;
  private readonly settled = new WeakSet<SceneRuntime>();
  private readonly gizmos: ManipGizmos;
  private readonly regionGizmo = new SelectionGizmo('#ffd34d');
  private readonly ghostGizmo = new SelectionGizmo('#7dffb1');
  private readonly toolbar: Toolbar;
  private readonly floor = new FloorGuard();
  private readonly raycaster = new THREE.Raycaster();
  private lastHitEvent: object | null = null;
  private lastHit: Hit | null = null;
  private hoverQueued: PointerEvent | null = null;
  /** A click on the world waits this long for a second click (double-click = mouselook). */
  private regionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly host: ManipHost) {
    this.gizmos = new ManipGizmos(host.layer);
    for (const g of [this.regionGizmo, this.ghostGizmo]) g.object.traverse((o) => o.layers.set(host.layer));
    this.toolbar = new Toolbar(host.overlay);
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      t.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener));
    };
    const c = host.canvas;
    on(c, 'pointerdown', (e) => this.onDown(e));
    on(c, 'pointermove', (e) => this.onMove(e));
    on(c, 'pointerup', (e) => this.onUp(e));
    on(c, 'pointercancel', () => this.endDrag(true));
    on(c, 'pointerleave', () => this.setHover(null, null));
    on(c, 'click', (e) => this.onClick(e));
    on(window, 'keydown', (e) => this.onKey(e));
  }

  // ---- public ------------------------------------------------------------------------------

  /** Fly-controls asks before a left press becomes a camera look: true = it is ours. */
  claims(e: PointerEvent | MouseEvent): boolean {
    if (!this.enabled(e)) return false;
    return this.hitAt(e) !== null;
  }

  select(ref: TargetRef | null) {
    this.finishNudge();
    if (sameRef(ref, this.selected) && (!ref || !this.region)) return;
    if (this.drag) this.endDrag(true);
    this.selected = ref;
    if (ref) this.setRegion(null);
    this.host.selectionChanged(ref);
  }

  /** Back to the blocking mark (the Scene tab's cast rows). */
  reset(ref: TargetRef) {
    const ctx = this.context();
    const info = ctx && targetInfo(ctx, ref);
    if (info?.resettable) this.resetActor(info);
  }

  /** Deletes a prop, light or camera (the Scene tab's outliner); undoable like ⌫. */
  remove(ref: TargetRef) {
    this.select(ref);
    this.deleteSelected();
  }

  /** Per frame, before the director renders: follows moving props, places the toolbar. */
  frame() {
    const rt = this.host.runtime();
    if (rt !== this.rt) this.attach(rt);
    if (this.hoverQueued) {
      const e = this.hoverQueued;
      this.hoverQueued = null;
      this.updateHover(e);
    }
    const cam = this.host.camera();
    const ctx = this.context();
    let toolbarAt: V2 | null = null;
    let toolbarBelow: number | null = null;
    if (ctx && this.selected) {
      const info = targetInfo(ctx, this.selected);
      if (!info) this.select(null);
      else {
        this.gizmos.setSelection(this.visualFor(info, cam));
        if (cam) {
          toolbarAt = this.screenAbove(new THREE.Vector3(info.anchor.x, info.box.max.y + 0.05, info.anchor.z), cam);
          toolbarBelow = this.screenAbove(new THREE.Vector3(info.anchor.x, info.box.min.y, info.anchor.z), cam)?.[1] ?? null;
        }
      }
    } else this.gizmos.setSelection(null);
    if (ctx && this.hover && !sameRef(this.hover, this.selected)) {
      const info = targetInfo(ctx, this.hover);
      this.gizmos.setHover(info?.box ?? null);
    } else this.gizmos.setHover(null);
    this.gizmos.setHot(this.hot && 'ref' in this.hot && this.hot.part !== 'body' ? this.hot.part : null);
    // region
    const reg = this.region;
    this.regionGizmo.set(reg?.sel ?? null);
    const edit = reg?.editId ? this.regionEdit() : null;
    const disp = edit?.displace;
    this.ghostGizmo.set(reg && disp && Math.hypot(...disp) > 0.01 ? { ...reg.sel, center: reg.sel.center.map((v, i) => v + disp[i]!) as Vec3 } : null);
    if (reg && cam) {
      const r = Math.max(...reg.sel.size);
      const c = new THREE.Vector3(...reg.sel.center);
      toolbarAt = this.screenAbove(c.clone().setY(c.y + r), cam);
      // the sphere's lowest point on screen: its centre plus the radius in screen-down terms
      const down = new THREE.Vector3(0, -1, 0).applyQuaternion(cam.quaternion).multiplyScalar(r);
      toolbarBelow = this.screenAbove(c.clone().add(down), cam)?.[1] ?? null;
    }
    this.toolbar.show(this.toolbarModel(ctx));
    this.toolbar.place(toolbarAt?.[0] ?? null, toolbarAt?.[1] ?? null, toolbarBelow);
  }

  /** Debug / e2e snapshot. */
  state() {
    const ctx = this.context();
    const info = ctx && this.selected ? targetInfo(ctx, this.selected) : null;
    return {
      selected: this.selected,
      hover: this.hover,
      dragging: this.drag?.kind ?? null,
      info: info && { label: info.label, kind: info.kind, anchor: v3(info.anchor), yaw: info.yaw, moving: info.moving },
      region: this.region && { ...this.region, sel: structuredClone(this.region.sel) },
      regionEdit: this.region?.editId ? this.regionEdit() : null,
    };
  }

  /** Client (page) pixels of a target's anchor, of a handle, or of the region (tests drive real pointer events with these). */
  screenOf(ref: TargetRef, part: 'anchor' | 'body' | 'ring' | 'scale' | 'focus' = 'body'): { x: number; y: number } | null {
    const ctx = this.context();
    const cam = this.host.camera();
    const info = ctx && cam ? targetInfo(ctx, ref) : null;
    if (!info || !cam) return null;
    let p: THREE.Vector3 | null = info.anchor.clone();
    if (part === 'body') p = info.box.getCenter(new THREE.Vector3());
    const vis = this.visualFor(info, cam);
    if (part === 'ring') p = vis.ring !== null ? vis.center.clone().add(this.ringDir(cam).multiplyScalar(vis.ring)) : null;
    if (part === 'scale') p = vis.knob?.clone() ?? null;
    if (part === 'focus') p = vis.focus?.to.clone() ?? null;
    if (!p) return null;
    return this.toClient(p, cam);
  }

  /** Debug: would an actor fit at (x, z)? (collider body probe, viewer/placement.ts) */
  floorFree(x: number, z: number, pose: 'standing' | 'sitting' | 'walking' = 'standing'): boolean {
    return this.floor.free(this.rt?.collider ?? null, x, z, pose);
  }

  /** Client pixels of the region's centre / outline (right side). */
  regionScreen(): { center: { x: number; y: number }; edge: { x: number; y: number }; r: number } | null {
    const cam = this.host.camera();
    if (!this.region || !cam) return null;
    const rect = this.host.canvas.getBoundingClientRect();
    this.regionGizmo.set(this.region.sel);
    const c = this.regionGizmo.screenCircle(cam, rect.width, rect.height);
    if (!c) return null;
    return { center: { x: rect.left + c.x, y: rect.top + c.y }, edge: { x: rect.left + c.x + c.r, y: rect.top + c.y }, r: c.r };
  }

  dispose() {
    for (const c of this.cleanup) c();
    this.gizmos.dispose();
    this.regionGizmo.dispose();
    this.ghostGizmo.dispose();
    this.toolbar.dispose();
  }

  // ---- context -----------------------------------------------------------------------------

  private attach(rt: SceneRuntime | null) {
    if (this.drag) this.endDrag(true);
    this.rt = rt;
    this.selected = null;
    this.hover = null;
    this.region = null;
    this.host.selectionChanged(null);
    this.host.regionChanged(null);
    for (const o of [this.gizmos.group, this.regionGizmo.object, this.ghostGizmo.object]) {
      o.removeFromParent();
      rt?.scene.add(o);
    }
    if (rt) void rt.colliderReady.then(() => this.settled.add(rt));
  }

  private context(): TargetContext | null {
    const rt = this.rt;
    if (!rt) return null;
    const doc = this.host.edits.current();
    const added = new Map<string, DynamicElement>();
    for (const el of doc ? effectiveProps(doc.edits).added : []) added.set(el.id, el);
    return {
      runtime: rt,
      lights: this.host.look()?.lights ?? [],
      cameras: this.host.cameras(),
      activeCameraId: this.host.activeCameraId(),
      names: this.host.names(),
      added,
    };
  }

  private enabled(e?: { clientX: number; clientY: number }): boolean {
    if (!this.rt || !this.host.camera() || document.pointerLockElement === this.host.canvas) return false;
    return !(e && this.host.blocked(e));
  }

  private pointer(e: { clientX: number; clientY: number }): Pointer | null {
    const camera = this.host.camera();
    if (!camera) return null;
    const r = this.host.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const px: V2 = [e.clientX - r.left, e.clientY - r.top];
    const ndc: [number, number] = [(px[0] / r.width) * 2 - 1, -((px[1] / r.height) * 2 - 1)];
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(...ndc), camera);
    const ray: Ray = { o: v3(this.raycaster.ray.origin), d: v3(this.raycaster.ray.direction) };
    return { ray, px, ndc, width: r.width, height: r.height, camera };
  }

  private toClient(p: THREE.Vector3, cam: THREE.Camera) {
    const r = this.host.canvas.getBoundingClientRect();
    const s = toScreen(p, cam, r.width, r.height);
    return s ? { x: r.left + s[0], y: r.top + s[1] } : null;
  }

  private screenAbove(p: THREE.Vector3, cam: THREE.Camera): V2 | null {
    const r = this.host.canvas.getBoundingClientRect();
    const o = this.host.overlay.getBoundingClientRect();
    const s = toScreen(p, cam, r.width, r.height);
    return s ? [s[0] + r.left - o.left, s[1] + r.top - o.top] : null;
  }

  /** Horizontal direction to the camera's right (where knobs sit, so they face the viewer). */
  private ringDir(cam: THREE.Camera): THREE.Vector3 {
    const f = cam.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3(-f.z, 0, f.x);
    return right.lengthSq() > 1e-6 ? right.normalize() : new THREE.Vector3(1, 0, 0);
  }

  private visualFor(info: TargetInfo, cam: THREE.Camera | null): SelectionVisual {
    const right = cam ? this.ringDir(cam) : new THREE.Vector3(1, 0, 0);
    const ring = info.rotatable ? info.footprint + (info.ref.type === 'actor' ? 0.3 : 0.25) : null;
    let knob: THREE.Vector3 | null = null;
    if (info.scalable && info.ref.type === 'prop') knob = info.anchor.clone().add(right.clone().multiplyScalar((ring ?? info.footprint + 0.25) + 0.12)).setY(info.anchor.y + 0.02);
    // a light's radius knob sits next to the light (its floor ring can be metres wide and off
    // screen); dragging it scales the radius by the change in distance, like a prop's scale
    if (info.scalable && info.light) knob = info.anchor.clone().add(right.clone().multiplyScalar(info.footprint + 0.35));
    let focus: SelectionVisual['focus'] = null;
    if (info.camera) {
      const lens = this.host.cameraLens(info.camera.id);
      if (lens?.dof.enabled) {
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...info.camera.quaternion));
        focus = { from: info.anchor.clone(), to: info.anchor.clone().addScaledVector(fwd, lens.dof.focusDistance), editable: !lens.own || !!this.host.setCameraLens };
      }
    }
    return { box: info.box, center: info.anchor, footprint: info.footprint, ring, knob, focus };
  }

  // ---- picking -----------------------------------------------------------------------------

  private hitAt(e: { clientX: number; clientY: number }): Hit | null {
    if (e === this.lastHitEvent) return this.lastHit;
    this.lastHitEvent = e;
    this.lastHit = this.computeHit(e);
    return this.lastHit;
  }

  private computeHit(e: { clientX: number; clientY: number }): Hit | null {
    const ptr = this.pointer(e);
    const ctx = this.context();
    if (!ptr || !ctx) return null;
    const { camera, px, width, height } = ptr;
    const screen = (p: THREE.Vector3) => toScreen(p, camera, width, height);
    const near = (p: THREE.Vector3 | null, tol: number) => {
      const s = p && screen(p);
      return !!s && Math.hypot(s[0] - px[0], s[1] - px[1]) <= tol;
    };
    // 1. handles of the selection
    if (this.selected) {
      const info = targetInfo(ctx, this.selected);
      if (info) {
        const vis = this.visualFor(info, camera);
        if (vis.focus?.editable && near(vis.focus.to, KNOB_PX)) return { part: 'focus', ref: info.ref };
        if (vis.knob && near(vis.knob, KNOB_PX)) return { part: 'scale', ref: info.ref };
        if (vis.ring !== null) {
          const pts: V2[] = [];
          for (let i = 0; i < 48; i++) {
            const a = (i / 48) * Math.PI * 2;
            const s = screen(new THREE.Vector3(vis.center.x + Math.cos(a) * vis.ring, vis.center.y + 0.02, vis.center.z + Math.sin(a) * vis.ring));
            if (s) pts.push(s);
          }
          if (pts.length > 8 && polylineDistance2D(px, pts) <= RING_PX) return { part: 'ring', ref: info.ref };
        }
      }
    }
    // 2. the region's outline (resize) and, in Move mode, its inside
    if (this.region) {
      this.regionGizmo.set(this.region.sel);
      const c = this.regionGizmo.screenCircle(camera, width, height);
      if (c) {
        const d = Math.hypot(px[0] - c.x, px[1] - c.y);
        if (Math.abs(d - c.r) <= Math.max(8, c.r * 0.12)) return { part: 'region-edge' };
        if (this.region.moving && d < c.r) return { part: 'region-body' };
      }
    }
    // 3. objects
    const hit = pickTarget(allTargets(ctx), { ray: ptr.ray, camera, px, width, height });
    if (!hit) return null;
    const t = hit.t;
    return { part: 'body', ref: hit.info.ref, point: [ptr.ray.o[0] + ptr.ray.d[0] * t, ptr.ray.o[1] + ptr.ray.d[1] * t, ptr.ray.o[2] + ptr.ray.d[2] * t] };
  }

  // ---- pointer -----------------------------------------------------------------------------

  private onDown(e: PointerEvent) {
    this.finishNudge();
    if (e.button !== 0 || e.altKey || !this.enabled(e)) {
      this.press = null;
      return;
    }
    const hit = this.hitAt(e);
    this.press = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, hit };
    if (!hit) return; // fly-controls looks (left-drag on empty space)
    e.preventDefault();
    try {
      this.host.canvas.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events without an active pointer
    }
    if (hit.part === 'body' && !sameRef(hit.ref, this.selected)) this.select(hit.ref);
  }

  private onMove(e: PointerEvent) {
    const p = this.press;
    if (p?.hit && !this.drag && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_PX) this.startDrag(p, e);
    if (this.drag) {
      this.updateDrag(e);
      return;
    }
    if (e.buttons === 0) this.hoverQueued = e;
  }

  private onUp(e: PointerEvent) {
    if (this.drag) this.endDrag(false);
    if (this.press && this.host.canvas.hasPointerCapture?.(e.pointerId)) this.host.canvas.releasePointerCapture(e.pointerId);
    this.updateHover(e);
  }

  private onClick(e: MouseEvent) {
    const p = this.press;
    this.press = null;
    if (this.regionTimer) clearTimeout(this.regionTimer);
    this.regionTimer = null;
    if (e.button !== 0 || e.altKey || e.detail > 1 || !p || p.hit || !this.enabled(e)) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_PX) return;
    // empty space: deselect the object first; otherwise pick a splat region
    if (this.selected) {
      this.select(null);
      return;
    }
    const at = { clientX: e.clientX, clientY: e.clientY };
    this.regionTimer = setTimeout(() => {
      this.regionTimer = null;
      if (this.enabled(at)) this.selectRegionAt(at);
    }, REGION_CLICK_MS);
  }

  private updateHover(e: { clientX: number; clientY: number }) {
    if (this.drag) return;
    const hit = this.enabled(e) ? this.computeHit(e) : null;
    this.setHover(hit && 'ref' in hit ? hit.ref : null, hit);
  }

  private setHover(ref: TargetRef | null, hit: Hit | null) {
    this.hover = ref;
    this.hot = hit;
    const cursor = !hit
      ? ''
      : hit.part === 'body'
        ? 'grab'
        : hit.part === 'ring'
          ? 'ew-resize'
          : hit.part === 'region-body'
            ? 'move'
            : hit.part === 'focus'
              ? 'ns-resize'
              : 'nwse-resize';
    this.host.canvas.style.cursor = cursor;
  }

  // ---- drags -------------------------------------------------------------------------------

  private startDrag(p: Press, e: PointerEvent) {
    const ctx = this.context();
    const ptr = this.pointer({ clientX: p.x, clientY: p.y });
    const hit = p.hit;
    if (!ctx || !ptr || !hit) return;
    this.host.canvas.style.cursor = 'grabbing';
    if (hit.part === 'region-edge' || hit.part === 'region-body') return this.startRegionDrag(hit.part, ptr);
    const info = targetInfo(ctx, hit.ref);
    if (!info) return;
    if ((info.ref.type === 'actor' || info.ref.type === 'prop') && !this.transformsReady()) {
      this.host.toast('Placing the actors on the set… try again in a moment');
      this.press = null;
      return;
    }
    const label = info.label;
    switch (hit.part) {
      case 'body': {
        const start = this.positionOf(info);
        // the floor-parallel plane through the grabbed point keeps it under the cursor; seen
        // edge-on (camera at that height) the object's base plane is steadier
        const grabY = hit.point?.[1] ?? info.anchor.y;
        const camY = ptr.camera.position.y;
        const onBody = info.ref.type === 'actor' || info.ref.type === 'prop';
        const planeY = !onBody ? start[1] : Math.abs(camY - grabY) > 0.25 ? grabY : info.anchor.y;
        const plane: V3 = [info.anchor.x, planeY, info.anchor.z];
        const raise = e.shiftKey;
        const hit0 = this.dragPoint(ptr, plane, raise);
        if (!hit0) return;
        this.drag = { kind: 'move', ref: info.ref, info, raise, plane, hit0, start, last: start, before: this.before(info), label: `Move ${label}` };
        return;
      }
      case 'ring': {
        const center = v3(info.anchor);
        const hit0 = rayPlaneY(ptr.ray, center[1] + 0.02);
        if (!hit0) return;
        this.drag = { kind: 'rotate', ref: info.ref, info, center, hit0, yaw0: info.yaw, last: info.yaw, before: this.before(info), label: `Turn ${label}` };
        return;
      }
      case 'scale': {
        const center: V3 = v3(info.anchor);
        const hit0 = rayPlaneY(ptr.ray, info.light ? center[1] : center[1] + 0.02);
        if (!hit0) return;
        const d0 = Math.max(0.05, Math.hypot(hit0[0] - center[0], hit0[2] - center[2]));
        const s0 = info.light ? info.light.radius : (transformOf(this.host.edits.current(), info.ref).scale ?? 1);
        this.drag = { kind: 'scale', ref: info.ref, info, center, d0, s0, last: s0, before: this.before(info), label: info.light ? `Radius of ${label}` : `Scale ${label}` };
        return;
      }
      case 'focus': {
        const cam = info.camera;
        const lens = cam && this.host.cameraLens(cam.id);
        if (!cam || !lens || (lens.own && !this.host.setCameraLens)) return;
        const o = cam.position as V3;
        const d = v3(new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...cam.quaternion)));
        const s0 = closestOnAxis(ptr.ray, o, d);
        if (s0 === null) return;
        this.drag = { kind: 'focus', ref: info.ref, info, o, d, s0, f0: lens.dof.focusDistance, last: lens.dof.focusDistance, before: { type: 'look', dof: structuredClone(lens.dof) }, label: `Focus ${label}`, own: lens.own ? cam.id : null };
        return;
      }
    }
  }

  /** Floor-plane point (or, raising, the vertical plane facing the camera) under the pointer. */
  private dragPoint(ptr: Pointer, through: V3, raise: boolean): V3 | null {
    if (!raise) return rayPlaneY(ptr.ray, through[1]);
    const n: V2 = [-ptr.ray.d[0], -ptr.ray.d[2]];
    const len = Math.hypot(...n);
    if (len < 1e-4) return null;
    return rayVerticalPlane(ptr.ray, through, [n[0] / len, n[1] / len]);
  }

  /** The position a move starts from (what the edit / look / camera stores for this target). */
  private positionOf(info: TargetInfo): V3 {
    if (info.light) return [...info.light.position];
    if (info.camera) return [...info.camera.position];
    if (info.ref.type === 'prop' && info.moving && info.element) {
      // a moving prop's transform shifts its path: the stored position is the moved path start
      return transformOf(this.host.edits.current(), info.ref).position ?? [...info.element.path[0]!];
    }
    const p = info.object ? ([info.object.position.x, markY(info.object), info.object.position.z] as V3) : v3(info.anchor);
    // an actor stores its height above the ground (viewer/ground.ts): a floor drag keeps it, so
    // the actor lands on the ground at every spot it passes (a kerb, a slope); Shift raises it
    return info.ref.type === 'actor' ? aboveGround(p, this.groundY) : p;
  }

  /** The visible ground's y at scene (x, z) (0 without a scene or a ground field). */
  private readonly groundY = (x: number, z: number) => this.rt?.groundY(x, z) ?? 0;

  private before(info: TargetInfo): Before {
    if (info.light) {
      const look = this.host.look();
      return { type: 'light', light: structuredClone(info.light), index: look?.lights.findIndex((l) => l.id === info.light!.id) ?? -1 };
    }
    if (info.camera) return { type: 'camera', cam: structuredClone(info.camera) };
    const ids = [manualTransformId(info.ref)];
    return { type: 'edits', ids, snap: snapshotEdits(this.host.edits.base() ?? emptySceneEdits(), ids) };
  }

  private updateDrag(e: PointerEvent | { clientX: number; clientY: number; shiftKey: boolean }) {
    const d = this.drag;
    const ptr = this.pointer(e);
    if (!d || !ptr) return;
    switch (d.kind) {
      case 'move': {
        if (d.keyboard) return;
        if (e.shiftKey !== d.raise) {
          // switching between floor and height mid-drag: continue from where it is now
          d.raise = e.shiftKey;
          d.start = d.last;
          d.plane = [d.last[0], d.info.ref.type === 'light' || d.info.ref.type === 'camera' ? d.last[1] : d.plane[1], d.last[2]];
          const h = this.dragPoint(ptr, d.last, d.raise);
          if (h) d.hit0 = h;
          return;
        }
        const h = this.dragPoint(ptr, d.raise ? d.last : d.plane, d.raise);
        if (!h) return;
        let next: V3 = d.raise
          ? [d.start[0], Math.max(-1, d.start[1] + (h[1] - d.hit0[1])), d.start[2]]
          : [d.start[0] + (h[0] - d.hit0[0]), d.start[1], d.start[2] + (h[2] - d.hit0[2])];
        // a dropped camera or a light can go anywhere above the floor
        if (d.info.ref.type === 'camera' || d.info.ref.type === 'light') next[1] = Math.max(0.05, next[1]);
        next = this.constrained(d.info, d.last, next);
        d.last = next;
        this.applyPosition(d.info, next, false);
        return;
      }
      case 'rotate': {
        const h = rayPlaneY(ptr.ray, d.center[1] + 0.02);
        if (!h) return;
        let yaw = d.yaw0 + ringDelta(d.center, d.hit0, h);
        if (e.shiftKey) yaw = snapAngle(yaw, Math.PI / 12);
        d.last = yaw;
        this.applyYaw(d.info, d.yaw0, yaw, false);
        return;
      }
      case 'scale': {
        const h = rayPlaneY(ptr.ray, d.info.light ? d.center[1] : d.center[1] + 0.02);
        if (!h) return;
        const k = Math.hypot(h[0] - d.center[0], h[2] - d.center[2]) / d.d0;
        const v = d.info.light ? Math.min(40, Math.max(0.5, d.s0 * k)) : Math.min(10, Math.max(0.1, d.s0 * k));
        d.last = round3(v);
        this.applyScale(d.info, d.last, false);
        return;
      }
      case 'focus': {
        const s = closestOnAxis(ptr.ray, d.o, d.d);
        if (s === null) return;
        d.last = clampFocus(d.f0 + (s - d.s0));
        this.applyFocus(d.last, false, undefined, undefined, d.own);
        return;
      }
      case 'region-size': {
        const reg = this.region;
        if (!reg) return;
        const dist = Math.hypot(ptr.px[0] - d.c[0], ptr.px[1] - d.c[1]);
        const k = Math.max(0.1, dist / d.d0);
        reg.sel = { ...reg.sel, size: d.size0.map((v) => round3(Math.min(3.6, Math.max(0.05, v * k)))) as Vec3 };
        if (reg.editId) this.host.edits.preview((doc) => withEdit(doc, this.regionEditFor(doc, {})));
        this.host.regionChanged(reg.sel);
        return;
      }
      case 'region-move': {
        const reg = this.region;
        const h = rayPlaneY(ptr.ray, d.y);
        if (!reg || !h) return;
        const disp: Vec3 = e.shiftKey ? [d.d0[0], d.d0[1] + (h[1] - d.hit0[1]), d.d0[2]] : [d.d0[0] + h[0] - d.hit0[0], d.d0[1], d.d0[2] + h[2] - d.hit0[2]];
        d.last = roundV3(disp);
        this.host.edits.preview((doc) => withEdit(doc, this.regionEditFor(doc, { displace: d.last })));
        return;
      }
    }
  }

  private constrained(info: TargetInfo, from: V3, to: V3): V3 {
    if (info.ref.type !== 'actor') return to;
    const xz = this.floor.constrain(this.rt?.collider ?? null, [from[0], from[2]], [to[0], to[2]], info.pose);
    return [xz[0], to[1], xz[1]];
  }

  private endDrag(cancel: boolean) {
    const d = this.drag;
    this.drag = null;
    this.press = null;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = null;
    if (!d) return;
    this.host.canvas.style.cursor = '';
    if (cancel) return this.revert(d);
    switch (d.kind) {
      case 'move':
        if (d.last.every((v, i) => Math.abs(v - d.start[i]!) < 1e-4) && !d.keyboard) return this.revert(d);
        this.applyPosition(d.info, d.last, true, d.before, d.label);
        return;
      case 'rotate':
        if (Math.abs(d.last - d.yaw0) < 1e-4) return this.revert(d);
        this.applyYaw(d.info, d.yaw0, d.last, true, d.before, d.label);
        return;
      case 'scale':
        if (Math.abs(d.last - d.s0) < 1e-4) return this.revert(d);
        this.applyScale(d.info, d.last, true, d.before, d.label);
        return;
      case 'focus':
        this.applyFocus(d.last, true, d.before, d.label, d.own);
        return;
      case 'region-size': {
        const reg = this.region;
        if (reg?.editId) this.regionChange('Resize region', (doc) => withEdit(doc, this.regionEditFor(doc, {})), d.before);
        return;
      }
      case 'region-move': {
        const reg = this.region;
        if (reg) this.regionChange('Move region', (doc) => withEdit(doc, this.regionEditFor(doc, { displace: d.last })), d.before);
        return;
      }
    }
  }

  private revert(d: Drag) {
    switch (d.before.type) {
      case 'edits':
        this.host.edits.cancelPreview();
        break;
      case 'light':
        this.setLight(d.before.light.id, () => d.before.type === 'light' ? d.before.light : null, null);
        this.host.sealLook();
        break;
      case 'camera':
        this.host.updateCamera(d.before.cam.id, d.before.cam, true);
        break;
      case 'look': {
        const look = this.host.look();
        if (look) this.host.setLook({ ...look, dof: d.before.dof }, null);
        this.host.sealLook();
        break;
      }
      case 'none':
        break;
    }
    if (d.kind === 'region-size' && this.region && d.before.type === 'edits') {
      this.region.sel = { ...this.region.sel, size: d.size0 };
      this.host.edits.cancelPreview();
    }
  }

  // ---- applying changes --------------------------------------------------------------------

  /**
   * One undoable change of the edits document: `fn` previews (live) or commits (final). Undo and
   * redo restore snapshots of the touched ids.
   */
  private editsChange(info: TargetInfo | null, fn: (d: SceneEdits) => SceneEdits, final: boolean, before?: Before, label?: string, ids?: string[]) {
    if (!final) {
      this.host.edits.preview(fn);
      return;
    }
    const base = this.host.edits.base() ?? emptySceneEdits();
    const touched = ids ?? (before?.type === 'edits' ? before.ids : info ? [manualTransformId(info.ref)] : []);
    const snapBefore = before?.type === 'edits' ? before.snap : snapshotEdits(base, touched);
    const snapAfter = snapshotEdits(fn(base), touched);
    void this.host.edits.commit(fn).then((ok) => !ok && this.host.toast('Saved locally only (edits.json is unreachable)'));
    const edits = this.host.edits;
    this.host.undo.push({
      label: label ?? 'Edit',
      undo: () => edits.commit((d) => restoreEdits(d, snapBefore)),
      redo: () => edits.commit((d) => restoreEdits(d, snapAfter)),
    });
  }

  private setLight(id: string, fn: (l: Light) => Light | null, coalesce: string | null) {
    const look = this.host.look();
    if (!look) return;
    const exists = look.lights.some((l) => l.id === id);
    const lights = exists ? look.lights.map((l) => (l.id === id ? fn(l) : l)).filter((l): l is Light => !!l) : look.lights;
    this.host.setLook({ ...look, lights }, coalesce);
  }

  private lightChange(id: string, fn: (l: Light) => Light, final: boolean, before?: Before, label?: string) {
    this.setLight(id, fn, `manip:light:${id}`);
    if (!final) return;
    this.host.sealLook();
    const after = this.host.look()?.lights.find((l) => l.id === id);
    if (before?.type !== 'light' || !after) return;
    const b = before.light;
    const a = structuredClone(after);
    const restore = (l: Light) => {
      const look = this.host.look();
      if (!look) return;
      const lights = look.lights.some((x) => x.id === l.id) ? look.lights.map((x) => (x.id === l.id ? l : x)) : [...look.lights.slice(0, Math.max(0, before.index)), l, ...look.lights.slice(Math.max(0, before.index))];
      this.host.setLook({ ...look, lights }, null);
      this.host.sealLook();
    };
    this.host.undo.push({ label: label ?? `Light ${b.name}`, undo: () => restore(b), redo: () => restore(a) });
  }

  private cameraChange(id: string, patch: Partial<DropCamera>, final: boolean, before?: Before, label?: string) {
    this.host.updateCamera(id, patch, final);
    if (!final || before?.type !== 'camera') return;
    const b = before.cam;
    const a = { ...b, ...structuredClone(patch) };
    this.host.undo.push({
      label: label ?? `Shot ${b.name}`,
      undo: () => this.host.updateCamera(id, b, true),
      redo: () => this.host.updateCamera(id, a, true),
    });
  }

  private transformChange(info: TargetInfo, fields: TransformFields, final: boolean, before?: Before, label?: string) {
    const rt = this.rt;
    // without WP G's applier (no sceneEdits runtime) the object is moved directly
    if (rt && !rt.sceneEdits && info.object) {
      if (fields.position)
        info.object.position.set(...(info.ref.type === 'actor' ? onGround(fields.position, this.groundY) : fields.position));
      if (fields.yaw !== undefined) info.object.rotation.y = fields.yaw;
      if (fields.scale !== undefined) info.object.scale.setScalar(fields.scale);
    }
    this.editsChange(info, (d) => withTransform(d, info.ref, fields), final, before, label);
  }

  private applyPosition(info: TargetInfo, p: V3, final: boolean, before?: Before, label?: string) {
    const pos = roundV3(p);
    if (info.light) return this.lightChange(info.light.id, (l) => ({ ...l, position: pos }), final, before, label);
    if (info.camera) return this.cameraChange(info.camera.id, { position: pos }, final, before, label);
    this.transformChange(info, { position: pos }, final, before, label);
  }

  private applyYaw(info: TargetInfo, yaw0: number, yaw: number, final: boolean, before?: Before, label?: string) {
    if (info.camera) {
      const q0 = before?.type === 'camera' ? before.cam.quaternion : info.camera.quaternion;
      const q = rotateYaw(q0, yaw - yaw0).map((v) => Math.round(v * 1e6) / 1e6) as DropCamera['quaternion'];
      return this.cameraChange(info.camera.id, { quaternion: q }, final, before, label);
    }
    if (info.light) {
      const l0 = before?.type === 'light' ? before.light : info.light;
      const p = l0.position;
      const t0 = l0.target ?? [p[0], 0, p[2]];
      const dyaw = yaw - yaw0;
      const c = Math.cos(dyaw);
      const s = Math.sin(dyaw);
      const dx = t0[0] - p[0];
      const dz = t0[2] - p[2];
      // rotation about +Y by dyaw: (x, z) → (c·x + s·z, −s·x + c·z)
      const target = roundV3([p[0] + c * dx + s * dz, t0[1], p[2] - s * dx + c * dz]);
      return this.lightChange(info.light.id, (l) => ({ ...l, target }), final, before, label);
    }
    this.transformChange(info, { yaw }, final, before, label);
  }

  private applyScale(info: TargetInfo, v: number, final: boolean, before?: Before, label?: string) {
    if (info.light) return this.lightChange(info.light.id, (l) => ({ ...l, radius: v }), final, before, label);
    this.transformChange(info, { scale: v }, final, before, label);
  }

  private applyFocus(distance: number, final: boolean, before?: Before, label?: string, own: string | null = null) {
    // a camera with its own lens (Look tab: "Own lens per camera"): the focus goes to that lens
    if (own && this.host.setCameraLens) {
      const setOwn = this.host.setCameraLens.bind(this.host);
      const cur = this.host.cameraLens(own)?.dof;
      if (!cur) return;
      const a = { ...cur, enabled: true, focusDistance: round3(distance) };
      setOwn(own, a);
      if (!final || before?.type !== 'look') return;
      const b = before.dof;
      this.host.undo.push({ label: label ?? 'Focus', undo: () => setOwn(own, b), redo: () => setOwn(own, a) });
      return;
    }
    const look = this.host.look();
    if (!look) return;
    this.host.setLook({ ...look, dof: { ...look.dof, enabled: true, focusDistance: round3(distance) } }, 'manip:focus');
    if (!final) return;
    this.host.sealLook();
    if (before?.type !== 'look') return;
    const b = before.dof;
    const a = { ...look.dof, enabled: true, focusDistance: round3(distance) };
    const set = (dof: Look['dof']) => {
      const l = this.host.look();
      if (l) this.host.setLook({ ...l, dof }, null);
      this.host.sealLook();
    };
    this.host.undo.push({ label: label ?? 'Focus', undo: () => set(b), redo: () => set(a) });
  }

  private transformsReady(): boolean {
    const rt = this.rt;
    return !rt || !rt.sceneEdits || this.settled.has(rt);
  }

  // ---- keyboard ----------------------------------------------------------------------------

  private onKey(e: KeyboardEvent) {
    if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (this.drag) this.endDrag(true);
      else if (this.selected) this.select(null);
      else if (this.region) this.setRegion(null);
      return;
    }
    if (!this.rt || !this.host.camera()) return;
    if (e.key.startsWith('Arrow') && this.selected) {
      e.preventDefault();
      this.nudge(e.key, e.shiftKey);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && (this.selected || this.region)) {
      e.preventDefault();
      if (this.selected) this.deleteSelected();
      else this.deleteRegion();
    }
  }

  private nudge(key: string, fast: boolean) {
    const ctx = this.context();
    const cam = this.host.camera();
    const info = ctx && this.selected && targetInfo(ctx, this.selected);
    if (!info || !cam) return;
    if ((info.ref.type === 'actor' || info.ref.type === 'prop') && !this.transformsReady()) return;
    const f = cam.getWorldDirection(new THREE.Vector3());
    const delta = nudgeDelta(key, [f.x, f.z], fast);
    if (!delta) return;
    let d = this.drag;
    if (!d || d.kind !== 'move' || !d.keyboard || !sameRef(d.ref, info.ref)) {
      if (d) this.endDrag(false);
      const start = this.positionOf(info);
      d = this.drag = { kind: 'move', ref: info.ref, info, raise: false, plane: start, hit0: start, start, last: start, before: this.before(info), label: `Nudge ${info.label}`, keyboard: true };
    }
    const next = this.constrained(info, d.last, [d.last[0] + delta[0], d.last[1], d.last[2] + delta[1]]);
    d.last = next;
    this.applyPosition(info, next, false);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this.finishNudge(), NUDGE_IDLE_MS);
  }

  private finishNudge() {
    if (this.drag?.kind === 'move' && this.drag.keyboard) this.endDrag(false);
  }

  private deleteSelected() {
    const ctx = this.context();
    const info = ctx && this.selected && targetInfo(ctx, this.selected);
    if (!info) return;
    if (info.ref.type === 'actor') {
      this.host.toast(`${info.label} can't be deleted — Reset to blocking puts them back on their mark`);
      return;
    }
    this.select(null);
    if (info.ref.type === 'prop') {
      const id = info.ref.id;
      this.editsChange(info, (d) => withPropRemoved(d, id), true, undefined, `Delete ${info.label}`, [manualRemovalId(id)]);
      this.host.toast(`Deleted ${info.label} (⌘Z brings it back)`);
    } else if (info.light) {
      const look = this.host.look();
      const index = look?.lights.findIndex((l) => l.id === info.light!.id) ?? -1;
      const light = structuredClone(info.light);
      this.setLight(light.id, () => null, null);
      this.host.sealLook();
      const restore = () => {
        const l = this.host.look();
        if (!l || l.lights.some((x) => x.id === light.id)) return;
        this.host.setLook({ ...l, lights: [...l.lights.slice(0, Math.max(0, index)), light, ...l.lights.slice(Math.max(0, index))] }, null);
        this.host.sealLook();
      };
      this.host.undo.push({ label: `Delete light ${light.name}`, undo: restore, redo: () => (this.setLight(light.id, () => null, null), this.host.sealLook()) });
      this.host.toast(`Deleted light ${light.name} (⌘Z brings it back)`);
    } else if (info.camera) {
      const cams = this.host.cameras();
      const index = cams.findIndex((c) => c.id === info.camera!.id);
      const cam = structuredClone(info.camera);
      const active = this.host.activeCameraId() === cam.id;
      this.host.removeCamera(cam.id);
      this.host.undo.push({ label: `Delete shot ${cam.name}`, undo: () => this.host.restoreCamera(cam, index, active), redo: () => this.host.removeCamera(cam.id) });
      this.host.toast(`Deleted shot ${cam.name} (⌘Z brings it back)`);
    }
  }

  private resetActor(info: TargetInfo) {
    const base = this.host.edits.base() ?? emptySceneEdits();
    const ids = transformIdsFor(base, info.ref);
    if (!ids.length) {
      this.host.toast(`${info.label} is already on the blocking mark`);
      return;
    }
    this.editsChange(info, (d) => resetTransforms(d, info.ref), true, undefined, `Reset ${info.label} to blocking`, ids);
  }

  // ---- regions -----------------------------------------------------------------------------

  private setRegion(r: RegionState | null) {
    if (this.region && !r) this.host.edits.cancelPreview();
    this.region = r;
    if (r) {
      if (this.selected) {
        this.selected = null;
        this.host.selectionChanged(null);
      }
    }
    this.host.regionChanged(r?.sel ?? null);
  }

  /** Click on the world: re-select the region edit there, or a new sphere around the hit. */
  selectRegionAt(e: { clientX: number; clientY: number }): RegionSelection | null {
    const ptr = this.pointer(e);
    const splat = this.rt?.splat;
    if (!ptr || !splat) return null;
    const hit = raycastSplat(splat, ptr.camera, ptr.ndc);
    if (!hit) {
      this.setRegion(null);
      return null;
    }
    const existing = regionAt(this.host.edits.current(), v3(hit.point));
    if (existing) {
      this.setRegion({ sel: { shape: existing.shape, center: [...existing.center], size: [...existing.size], yaw: existing.yaw ?? 0 }, editId: existing.id, label: existing.label, moving: false });
      return this.region!.sel;
    }
    const sel = sphereFromClick(splat, ptr.camera, ptr.ndc);
    if (!sel) {
      this.setRegion(null);
      return null;
    }
    this.setRegion({ sel, editId: null, label: 'selected region', moving: false });
    return sel;
  }

  private regionEdit(): RegionEdit | null {
    const id = this.region?.editId;
    const doc = this.host.edits.current();
    const e = id && doc ? editById(doc, id) : null;
    return e?.kind === 'splat-region' ? e : null;
  }

  /** The region's edit in `doc` (created when new) with the selection's placement and `patch`. */
  private regionEditFor(doc: SceneEdits, patch: Partial<RegionEdit>): RegionEdit {
    const reg = this.region!;
    reg.editId ??= `manip-region-${uid()}`;
    const prev = editById(doc, reg.editId);
    const base = prev?.kind === 'splat-region' ? prev : null;
    const s = reg.sel;
    return SceneEdit.parse({
      ...(base ?? { kind: 'splat-region', label: reg.label, softEdge: 0.15 }),
      id: reg.editId,
      shape: s.shape,
      center: s.center,
      size: s.size,
      yaw: s.yaw,
      ...patch,
      enabled: true,
    }) as RegionEdit;
  }

  private startRegionDrag(part: 'region-edge' | 'region-body', ptr: Pointer) {
    const reg = this.region;
    if (!reg) return;
    const before: Before = { type: 'edits', ids: reg.editId ? [reg.editId] : [], snap: snapshotEdits(this.host.edits.base() ?? emptySceneEdits(), reg.editId ? [reg.editId] : []) };
    if (part === 'region-edge') {
      this.regionGizmo.set(reg.sel);
      const c = this.regionGizmo.screenCircle(ptr.camera, ptr.width, ptr.height);
      if (!c) return;
      this.drag = { kind: 'region-size', c: [c.x, c.y], d0: Math.max(4, Math.hypot(ptr.px[0] - c.x, ptr.px[1] - c.y)), size0: [...reg.sel.size], before };
      return;
    }
    const edit = this.regionEdit();
    const d0: Vec3 = edit?.displace ? [...edit.displace] : [0, 0, 0];
    const y = reg.sel.center[1] + d0[1];
    const hit0 = rayPlaneY(ptr.ray, y);
    if (!hit0) return;
    this.drag = { kind: 'region-move', y, hit0, d0, last: d0, before };
  }

  /** One undoable region change (the region's edit id is assigned on the first one). */
  private regionChange(label: string, fn: (d: SceneEdits) => SceneEdits, before?: Before) {
    const reg = this.region;
    if (!reg) return;
    const base = this.host.edits.base() ?? emptySceneEdits();
    const after = fn(base); // assigns reg.editId when new
    const ids = [reg.editId!];
    const snapBefore = before?.type === 'edits' && before.ids.length ? before.snap : snapshotEdits(base, ids);
    const snapAfter = snapshotEdits(after, ids);
    void this.host.edits.commit(fn).then((ok) => !ok && this.host.toast('Saved locally only (edits.json is unreachable)'));
    const edits = this.host.edits;
    this.host.undo.push({ label, undo: () => edits.commit((d) => restoreEdits(d, snapBefore)), redo: () => edits.commit((d) => restoreEdits(d, snapAfter)) });
  }

  private recolour(hex: string, final: boolean) {
    if (!this.region) return;
    const fn = (d: SceneEdits) => withEdit(d, this.regionEditFor(d, { color: { mode: 'hue', value: hex, strength: 1 } }));
    if (final) this.regionChange('Recolour region', fn);
    else this.host.edits.preview(fn);
  }

  private toggleHide() {
    if (!this.region) return;
    const hidden = this.regionEdit()?.opacity === 0;
    this.regionChange(hidden ? 'Show region' : 'Hide region', (d) => withEdit(d, this.regionEditFor(d, { opacity: hidden ? undefined : 0 })));
  }

  private deleteRegion() {
    const reg = this.region;
    if (!reg) return;
    if (reg.editId && this.regionEdit()) {
      const id = reg.editId;
      this.regionChange('Delete region edit', (d) => withoutEdit(d, id));
      this.host.toast('Region edit removed (⌘Z brings it back)');
    }
    this.setRegion(null);
  }

  // ---- toolbar -----------------------------------------------------------------------------

  private toolbarModel(ctx: TargetContext | null): ToolbarModel | null {
    const close: ToolItem = { label: '×', title: 'Deselect (Esc)', testid: 'manip-close', onClick: () => (this.selected ? this.select(null) : this.setRegion(null)) };
    if (this.region) {
      const edit = this.regionEdit();
      const r = this.region;
      const hidden = edit?.opacity === 0;
      const size = r.sel.shape === 'sphere' ? `r ${r.sel.size[0].toFixed(2)} m` : r.sel.size.map((v) => (v * 2).toFixed(2)).join('×') + ' m';
      return {
        kind: 'region',
        title: `${edit ? edit.label : 'Region'} · ${size}`,
        hint: r.moving ? 'drag inside to move this part of the set · outline resizes' : 'drag the outline to resize',
        items: [
          { kind: 'color', value: edit?.color?.value ?? '#d94a3a', title: 'Recolour this part of the set (keeps its shading)', testid: 'region-recolour', onInput: (hex) => this.recolour(hex, false), onChange: (hex) => this.recolour(hex, true) },
          { label: hidden ? 'Show' : 'Hide', title: hidden ? 'Show this part of the set again' : 'Hide this part of the set', testid: 'region-hide', on: hidden, onClick: () => this.toggleHide() },
          { label: 'Move', title: 'Toggle: drag inside the region to move this part of the set (Shift: up / down)', testid: 'region-move', on: r.moving, onClick: () => (r.moving = !r.moving) },
          { label: 'Edit ›', title: 'Use this region as the selection for a prompt in Tools › Re-prompt', testid: 'region-to-edit', onClick: () => this.host.sendRegionToEdit(r.sel) },
          'sep',
          { label: 'Delete region', title: 'Remove this region and its edit (⌫)', testid: 'region-delete', danger: true, onClick: () => this.deleteRegion() },
          close,
        ],
      };
    }
    const info = ctx && this.selected ? targetInfo(ctx, this.selected) : null;
    if (!info) return null;
    const items: ToolItem[] = [];
    let hint = 'drag to move · Shift+drag raises · ring turns';
    switch (info.ref.type) {
      case 'actor':
        items.push({ label: 'Reset to blocking', title: "Back to the screenplay's blocking mark (drops your moves, switches re-prompt moves off)", testid: 'manip-reset', onClick: () => this.resetActor(info) });
        break;
      case 'prop': {
        const s = transformOf(this.host.edits.current(), info.ref).scale ?? 1;
        hint = info.moving ? `drag shifts its path · knob scales (×${s.toFixed(2)})` : `drag to move · ring turns · knob scales (×${s.toFixed(2)})`;
        items.push({ label: 'Delete', title: 'Remove this prop from the scene (⌫; ⌘Z brings it back)', testid: 'manip-delete', danger: true, onClick: () => this.deleteSelected() });
        break;
      }
      case 'light':
        hint = `drag to move · Shift raises${info.rotatable ? ' · ring aims' : ''}${info.scalable ? ` · knob = radius ${info.light!.radius.toFixed(1)} m` : ''}`;
        items.push({ label: 'Delete', title: 'Delete this light (⌫; ⌘Z brings it back)', testid: 'manip-delete', danger: true, onClick: () => this.deleteSelected() });
        break;
      case 'camera': {
        const cam = info.camera!;
        const lens = this.host.cameraLens(cam.id);
        hint = `drag to move · Shift raises · ring pans${lens?.dof.enabled ? ` · green point = focus ${lens.dof.focusDistance.toFixed(2)} m${lens.own ? (this.host.setCameraLens ? ' (this shot’s own lens)' : ' (own lens: Tools › Grade)') : ''}` : ''}`;
        items.push(
          { label: info.active ? 'On the phone' : 'Phone here', title: 'The phone attaches to this shot', testid: 'manip-activate', on: info.active, disabled: info.active, onClick: () => this.host.setActiveCamera(cam.id) },
          { label: 'Go to shot', title: 'Fly the view to this shot (selects it in the Shots panel)', testid: 'manip-look-through', onClick: () => this.host.lookThrough(cam) },
          { label: 'Delete', title: 'Delete this shot (⌫; ⌘Z brings it back)', testid: 'manip-delete', danger: true, onClick: () => this.deleteSelected() },
        );
        break;
      }
    }
    items.push(close);
    return { kind: info.ref.type, title: `${info.label}${info.ref.type === 'actor' ? '' : ` · ${info.kind}`}`, hint, items };
  }
}

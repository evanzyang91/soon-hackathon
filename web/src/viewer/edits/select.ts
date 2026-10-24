// Region resolution on the laptop (docs/PLAN-v2.md §2: the director's click/drag first, then the
// planner's vision boxes, never a silent guess):
//
//   click      → raycast the world SplatMesh → hit point + an auto radius from the splats around
//                it (model.ts autoRadius: 80th-percentile distance of the opaque splat centres in
//                a 0.6 m window, clamped 0.15–1.2 m) → a sphere
//   drag       → a screen rectangle → raycasts through its centre and corners (hit depth) → a box
//                aligned with the camera, sized from the rectangle's angular extent × depth
//   target     → the planner's normalised pixel box in the view it was given → raycast at the box
//                centre (a 3×3 grid of fallbacks inside it) from that view's camera → a box sized
//                from the box's angular extent × hit distance
//
// The selection shows as a translucent wireframe (SelectionGizmo) that can be resized by dragging
// its outline (edit-panel.ts).
import * as THREE from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';
import type { Quat, Vec3 } from '@shared/schema';
import { AUTO_RADIUS, autoRadius, boxRegionSize, imageToNdc, type NormBox } from './model';

export interface RegionSelection {
  shape: 'sphere' | 'box';
  center: Vec3;
  /** Sphere radius (repeated), or box half-extents. */
  size: Vec3;
  yaw: number;
}

export interface ViewPose {
  position: Vec3;
  quaternion: Quat;
  fovDeg: number;
  aspect: number;
}

const raycaster = new THREE.Raycaster();

/** Nearest splat hit along the ray through `ndc` (−1..1, y up) of `camera`, or null. */
export function raycastSplat(
  mesh: SplatMesh,
  camera: THREE.Camera,
  ndc: THREE.Vector2 | [number, number],
): { point: THREE.Vector3; distance: number; direction: THREE.Vector3 } | null {
  const v = Array.isArray(ndc) ? new THREE.Vector2(ndc[0], ndc[1]) : ndc;
  camera.updateMatrixWorld();
  raycaster.setFromCamera(v, camera);
  const hits: { distance: number; point: THREE.Vector3; object: THREE.Object3D }[] = [];
  mesh.raycast(raycaster, hits);
  hits.sort((a, b) => a.distance - b.distance);
  const h = hits[0];
  return h ? { point: h.point.clone(), distance: h.distance, direction: raycaster.ray.direction.clone() } : null;
}

/** World-space metres per mesh-local unit (the Marble → metric transform's uniform scale). */
function meshScale(mesh: SplatMesh): number {
  return new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld).x;
}

interface CenterCache {
  centers: Float32Array;
  n: number;
}
const centerCache = new WeakMap<SplatMesh, CenterCache>();

/** Mesh-local centres of the splats with opacity ≥ minOpacity (cached per mesh). */
function opaqueCenters(mesh: SplatMesh): CenterCache {
  let c = centerCache.get(mesh);
  if (c) return c;
  const total = mesh.numSplats ?? 0;
  const centers = new Float32Array(Math.max(1, total) * 3);
  let n = 0;
  mesh.forEachSplat((_i, center, _scales, _q, opacity) => {
    if (opacity < AUTO_RADIUS.minOpacity || n >= total) return;
    centers[n * 3] = center.x;
    centers[n * 3 + 1] = center.y;
    centers[n * 3 + 2] = center.z;
    n++;
  });
  c = { centers, n };
  centerCache.set(mesh, c);
  return c;
}

/** Distances (metres) from `point` to the opaque splat centres within the sampling window. */
export function splatDistancesAround(mesh: SplatMesh, point: THREE.Vector3, window = AUTO_RADIUS.window): number[] {
  mesh.updateMatrixWorld();
  const local = point.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
  const s = meshScale(mesh) || 1;
  const w = window / s;
  const { centers, n } = opaqueCenters(mesh);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const dx = centers[i * 3]! - local.x;
    if (dx > w || dx < -w) continue;
    const dy = centers[i * 3 + 1]! - local.y;
    if (dy > w || dy < -w) continue;
    const dz = centers[i * 3 + 2]! - local.z;
    if (dz > w || dz < -w) continue;
    out.push(Math.sqrt(dx * dx + dy * dy + dz * dz) * s);
  }
  return out;
}

const toVec3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const round = (v: number) => Math.round(v * 1000) / 1000;
const roundV = (v: Vec3): Vec3 => v.map(round) as Vec3;

/** Yaw (about +Y) that faces the camera's horizontal view direction. */
function cameraYaw(camera: THREE.Camera): number {
  const d = camera.getWorldDirection(new THREE.Vector3());
  return Math.atan2(-d.x, -d.z);
}

/** Click → sphere around the hit with the auto radius (null when the ray hits no splat). */
export function sphereFromClick(mesh: SplatMesh, camera: THREE.Camera, ndc: [number, number]): RegionSelection | null {
  const hit = raycastSplat(mesh, camera, ndc);
  if (!hit) return null;
  const r = autoRadius(splatDistancesAround(mesh, hit.point));
  return { shape: 'sphere', center: roundV(toVec3(hit.point)), size: [round(r), round(r), round(r)], yaw: 0 };
}

/** The median hit distance over a grid of rays inside an NDC rectangle (null when none hit). */
function rectHit(mesh: SplatMesh, camera: THREE.Camera, a: [number, number], b: [number, number]) {
  const ds: { distance: number; point: THREE.Vector3; at: [number, number] }[] = [];
  const centre: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
    const at: [number, number] = [a[0] + (b[0] - a[0]) * fx, a[1] + (b[1] - a[1]) * fy];
    const h = raycastSplat(mesh, camera, at);
    if (h) ds.push({ distance: h.distance, point: h.point, at });
    if (fx === 0.5 && fy === 0.5 && h) return { centreHit: h, distance: h.distance, centre };
  }
  if (!ds.length) return null;
  ds.sort((x, y) => x.distance - y.distance);
  const mid = ds[Math.floor(ds.length / 2)]!;
  return { centreHit: null, distance: mid.distance, centre };
}

/** The point at `distance` along the ray through `ndc`. */
function pointAt(camera: THREE.Camera, ndc: [number, number], distance: number): THREE.Vector3 {
  raycaster.setFromCamera(new THREE.Vector2(ndc[0], ndc[1]), camera);
  return raycaster.ray.at(distance, new THREE.Vector3());
}

/** Box from an NDC rectangle (corners a, b) at the depth the splats inside it are hit. */
export function boxFromRect(
  mesh: SplatMesh,
  camera: THREE.PerspectiveCamera,
  a: [number, number],
  b: [number, number],
): RegionSelection | null {
  const r = rectHit(mesh, camera, a, b);
  if (!r) return null;
  const centre = r.centreHit?.point ?? pointAt(camera, r.centre, r.distance);
  const box: NormBox = {
    x: (Math.min(a[0], b[0]) + 1) / 2,
    y: (1 - Math.max(a[1], b[1])) / 2,
    w: Math.abs(b[0] - a[0]) / 2,
    h: Math.abs(b[1] - a[1]) / 2,
  };
  const size = boxRegionSize(box, { fovDeg: camera.fov, aspect: camera.aspect }, r.distance);
  return { shape: 'box', center: roundV(toVec3(centre)), size: roundV(size.halfExtents), yaw: round(cameraYaw(camera)) };
}

/** A camera at a view pose (the one the planner's image was taken from). */
export function cameraFor(view: ViewPose): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(view.fovDeg, view.aspect, 0.05, 2000);
  cam.position.set(...view.position);
  cam.quaternion.set(...view.quaternion);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

/** Planner target (normalised pixel box in the view image) → a box region in the world. */
export function regionFromTarget(mesh: SplatMesh, view: ViewPose, box: NormBox): RegionSelection | null {
  const cam = cameraFor(view);
  const a = imageToNdc(box.x, box.y + box.h);
  const b = imageToNdc(box.x + box.w, box.y);
  return boxFromRect(mesh, cam, a, b);
}

/** The NDC rectangle of a normalised box (for overlays). */
export const boxToNdc = (box: NormBox) => ({ a: imageToNdc(box.x, box.y + box.h), b: imageToNdc(box.x + box.w, box.y) });

// ---------------------------------------------------------------------------------------------

/** Translucent wireframe of the current selection (sphere or yawed box), always on top. */
export class SelectionGizmo {
  readonly object = new THREE.Group();
  private readonly sphere: THREE.Mesh;
  private readonly box: THREE.LineSegments;
  private readonly fill: THREE.Mesh;
  private selection: RegionSelection | null = null;

  constructor(color = '#ffd34d') {
    this.object.name = 'edit-selection';
    this.object.renderOrder = 999;
    const wire = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), wire);
    const lines = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
    this.box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), lines);
    const fillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, depthTest: false, depthWrite: false });
    this.fill = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), fillMat);
    for (const m of [this.sphere, this.box, this.fill]) {
      m.renderOrder = 999;
      m.frustumCulled = false;
      this.object.add(m);
    }
    this.object.visible = false;
  }

  get current(): RegionSelection | null {
    return this.selection;
  }

  set(sel: RegionSelection | null) {
    this.selection = sel;
    this.object.visible = !!sel;
    if (!sel) return;
    this.object.position.set(...sel.center);
    this.object.rotation.set(0, sel.yaw, 0);
    const isBox = sel.shape === 'box';
    this.sphere.visible = !isBox;
    this.box.visible = isBox;
    this.fill.visible = isBox;
    if (isBox) {
      this.box.scale.set(...sel.size);
      this.fill.scale.set(...sel.size);
    } else this.sphere.scale.setScalar(sel.size[0]);
  }

  /** Scales the selection by `k` about its centre (drag-to-resize, +/−). */
  resize(k: number) {
    const s = this.selection;
    if (!s) return;
    const clamp = (v: number) => Math.min(AUTO_RADIUS.max * 3, Math.max(0.05, v));
    this.set({ ...s, size: s.size.map((v) => round(clamp(v * k))) as Vec3 });
  }

  /** Projected centre and radius in CSS pixels (for the drag-to-resize handle). */
  screenCircle(camera: THREE.Camera, width: number, height: number): { x: number; y: number; r: number } | null {
    const s = this.selection;
    if (!s) return null;
    const c = new THREE.Vector3(...s.center);
    const p = c.clone().project(camera);
    if (p.z > 1) return null;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const edge = c.clone().add(right.multiplyScalar(Math.max(...s.size))).project(camera);
    const x = ((p.x + 1) / 2) * width;
    const y = ((1 - p.y) / 2) * height;
    const ex = ((edge.x + 1) / 2) * width;
    const ey = ((1 - edge.y) / 2) * height;
    return { x, y, r: Math.hypot(ex - x, ey - y) };
  }

  dispose() {
    this.object.removeFromParent();
    for (const m of [this.sphere, this.box, this.fill]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}

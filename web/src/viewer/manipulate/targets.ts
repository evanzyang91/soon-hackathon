// What can be grabbed in the director's viewport, and where it is: actors (their body cylinder),
// props (screenplay dynamics and props added by edits; their bounding box), the look's lights (a
// small sphere at the light) and dropped cameras (their frustum lines, picked in screen space).
import * as THREE from 'three';
import type { Light } from '@shared/look';
import type { DropCamera } from '@shared/protocol';
import type { DynamicElement } from '@shared/schema';
import { isParked } from '../edits/model';
import type { SceneRuntime } from '../world';
import type { TargetRef } from './edits';
import { quatYaw, rayBox, rayCylinder, raySphere, segmentDistance2D, yawFromDir, type Ray, type V2, type V3 } from './math';

export const ACTOR_RADIUS = 0.35;
const ACTOR_HEIGHT = { standing: 1.8, walking: 1.8, sitting: 1.35 } as const;
/** Same frustum as the director's camera markers (laptop/gizmos.ts CameraMarkers). */
export const CAMERA_GIZMO_DEPTH = 0.35;
const CAMERA_ASPECT = 16 / 9;
const PICK_PX = 14;
const LINE_PICK_PX = 7;

export type Pose = keyof typeof ACTOR_HEIGHT;

export interface TargetInfo {
  ref: TargetRef;
  label: string;
  /** "actor", "car", "spot light", "camera" */
  kind: string;
  /** Actor / prop root (moved through scene edits). */
  object: THREE.Object3D | null;
  /** Feet / prop base / light / camera position. */
  anchor: THREE.Vector3;
  /** World bounds (hover outline, toolbar placement). */
  box: THREE.Box3;
  /** Radius on the floor around the anchor (selection ring). */
  footprint: number;
  yaw: number;
  rotatable: boolean;
  /** Props: uniform scale; point and spot lights: their radius. */
  scalable: boolean;
  deletable: boolean;
  /** Actors go back to their blocking instead of being deleted. */
  resettable: boolean;
  /** A prop driving along its path (moves shift the whole path; no turning). */
  moving: boolean;
  pose: Pose;
  element?: DynamicElement;
  light?: Light;
  camera?: DropCamera;
  active?: boolean;
}

export interface TargetContext {
  runtime: SceneRuntime;
  lights: readonly Light[];
  cameras: readonly DropCamera[];
  activeCameraId: string | null;
  /** character id → display name */
  names: ReadonlyMap<string, string>;
  /** Props added by scene edits (prop-add), by element id. */
  added: ReadonlyMap<string, DynamicElement>;
}

const v3 = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]);

function propObjects(rt: SceneRuntime, added: ReadonlyMap<string, DynamicElement>) {
  const out: { element: DynamicElement; object: THREE.Object3D }[] = [];
  for (const item of rt.dynamics.items) if (item.object.visible) out.push({ element: item.element, object: item.object });
  const group = rt.scene.getObjectByName('edit-props');
  for (const o of group?.children ?? []) {
    const id = o.userData.dynamicId as string | undefined;
    const el = id ? added.get(id) : undefined;
    if (el && o.visible) out.push({ element: el, object: o });
  }
  return out;
}

/** Frustum corner points of a dropped camera's marker (apex first). */
export function cameraFrustum(cam: Pick<DropCamera, 'position' | 'quaternion' | 'fovDeg'>, depth = CAMERA_GIZMO_DEPTH): THREE.Vector3[] {
  const hh = depth * Math.tan(THREE.MathUtils.degToRad(cam.fovDeg) / 2);
  const hw = hh * CAMERA_ASPECT;
  const q = new THREE.Quaternion(...cam.quaternion);
  const p = v3(cam.position);
  return [
    p.clone(),
    ...[
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([x, y]) => new THREE.Vector3(x, y, -depth).applyQuaternion(q).add(p)),
  ];
}

function info(partial: Omit<TargetInfo, 'rotatable' | 'scalable' | 'deletable' | 'resettable' | 'moving' | 'pose' | 'object'> & Partial<TargetInfo>): TargetInfo {
  return { rotatable: true, scalable: false, deletable: false, resettable: false, moving: false, pose: 'standing', object: null, ...partial };
}

export function targetInfo(ctx: TargetContext, ref: TargetRef): TargetInfo | null {
  const rt = ctx.runtime;
  switch (ref.type) {
    case 'actor': {
      const a = rt.actors.get(ref.id);
      if (!a) return null;
      const pose = (rt.manifest.plan.blocking.find((b) => b.characterId === ref.id)?.pose ?? 'standing') as Pose;
      const p = a.object.position.clone();
      // the boxes fit a 1.7 m actor; createActor records each actor's own height
      const tall = (a.object.userData.heightMeters as number | undefined) ?? 1.7;
      const h = ((ACTOR_HEIGHT[pose] ?? 1.8) * tall) / 1.7;
      return info({
        ref,
        label: ctx.names.get(ref.id) ?? ref.id,
        kind: 'actor',
        object: a.object,
        anchor: p,
        box: new THREE.Box3(new THREE.Vector3(p.x - ACTOR_RADIUS, p.y, p.z - ACTOR_RADIUS), new THREE.Vector3(p.x + ACTOR_RADIUS, p.y + h, p.z + ACTOR_RADIUS)),
        footprint: ACTOR_RADIUS,
        yaw: a.object.rotation.y,
        resettable: true,
        pose,
      });
    }
    case 'prop': {
      const found = propObjects(rt, ctx.added).find((x) => x.element.id === ref.id);
      if (!found) return null;
      const box = new THREE.Box3().setFromObject(found.object);
      if (box.isEmpty()) box.setFromCenterAndSize(found.object.position, new THREE.Vector3(1, 1, 1));
      const size = box.getSize(new THREE.Vector3());
      const moving = !isParked(found.element);
      return info({
        ref,
        label: found.element.label || found.element.kind,
        kind: found.element.kind,
        object: found.object,
        anchor: new THREE.Vector3(found.object.position.x, box.min.y, found.object.position.z),
        box,
        footprint: Math.max(0.3, Math.hypot(size.x, size.z) / 2),
        yaw: found.object.rotation.y,
        rotatable: !moving,
        scalable: true,
        deletable: true,
        moving,
        element: found.element,
      });
    }
    case 'light': {
      const l = ctx.lights.find((x) => x.id === ref.id);
      if (!l) return null;
      const p = v3(l.position);
      const t = l.target ? v3(l.target) : null;
      return info({
        ref,
        label: l.name,
        kind: `${l.kind} light`,
        anchor: p,
        box: new THREE.Box3().setFromCenterAndSize(p, new THREE.Vector3(0.3, 0.3, 0.3)),
        footprint: 0.22,
        yaw: t ? yawFromDir(t.x - p.x, t.z - p.z) : 0,
        rotatable: l.kind !== 'point',
        scalable: l.kind !== 'sun',
        deletable: true,
        light: l,
      });
    }
    case 'camera': {
      const c = ctx.cameras.find((x) => x.id === ref.id);
      if (!c) return null;
      const pts = cameraFrustum(c);
      return info({
        ref,
        label: c.name,
        kind: 'camera',
        anchor: v3(c.position),
        box: new THREE.Box3().setFromPoints(pts).expandByScalar(0.03),
        footprint: 0.3,
        yaw: quatYaw(c.quaternion),
        deletable: true,
        camera: c,
        active: c.id === ctx.activeCameraId,
      });
    }
  }
}

/** Every grabbable thing in the scene right now. */
export function allTargets(ctx: TargetContext): TargetInfo[] {
  const refs: TargetRef[] = [
    ...[...ctx.runtime.actors.keys()].map((id) => ({ type: 'actor' as const, id })),
    ...propObjects(ctx.runtime, ctx.added).map((p) => ({ type: 'prop' as const, id: p.element.id })),
    ...ctx.lights.map((l) => ({ type: 'light' as const, id: l.id })),
    ...ctx.cameras.map((c) => ({ type: 'camera' as const, id: c.id })),
  ];
  return refs.map((r) => targetInfo(ctx, r)).filter((x): x is TargetInfo => !!x);
}

/** World point → CSS pixels on the canvas (null behind the camera). */
export function toScreen(p: THREE.Vector3, camera: THREE.Camera, width: number, height: number): V2 | null {
  const v = p.clone().project(camera);
  if (v.z > 1 || v.z < -1) return null;
  return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height];
}

export interface PickInput {
  ray: Ray;
  camera: THREE.Camera;
  /** Pointer in CSS pixels on the canvas. */
  px: V2;
  width: number;
  height: number;
}

/** The nearest target under the pointer (null when nothing is). */
export function pickTarget(infos: readonly TargetInfo[], input: PickInput): { info: TargetInfo; t: number } | null {
  let best: { info: TargetInfo; t: number } | null = null;
  const keep = (i: TargetInfo, t: number | null) => {
    if (t !== null && t >= 0 && (!best || t < best.t)) best = { info: i, t };
  };
  const camPos = new THREE.Vector3().setFromMatrixPosition(input.camera.matrixWorld);
  for (const i of infos) {
    switch (i.ref.type) {
      case 'actor':
        keep(i, rayCylinder(input.ray, i.anchor.x, i.anchor.z, ACTOR_RADIUS, i.box.min.y, i.box.max.y));
        break;
      case 'prop':
        keep(i, rayBox(input.ray, i.box.min.toArray() as V3, i.box.max.toArray() as V3));
        break;
      case 'light': {
        const s = toScreen(i.anchor, input.camera, input.width, input.height);
        const near = s && Math.hypot(s[0] - input.px[0], s[1] - input.px[1]) <= PICK_PX;
        keep(i, near ? camPos.distanceTo(i.anchor) : raySphere(input.ray, i.anchor.toArray() as V3, 0.15));
        break;
      }
      case 'camera': {
        if (!i.camera) break;
        const pts = cameraFrustum(i.camera).map((p) => toScreen(p, input.camera, input.width, input.height));
        if (pts.some((p) => !p)) break;
        const [apex, ...corners] = pts as V2[];
        let d = Math.hypot(apex![0] - input.px[0], apex![1] - input.px[1]) - (PICK_PX - LINE_PICK_PX);
        for (let k = 0; k < 4; k++) {
          d = Math.min(d, segmentDistance2D(input.px, apex!, corners[k]!), segmentDistance2D(input.px, corners[k]!, corners[(k + 1) % 4]!));
        }
        if (d <= LINE_PICK_PX) keep(i, camPos.distanceTo(i.anchor));
        break;
      }
    }
  }
  return best;
}

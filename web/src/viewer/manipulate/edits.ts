// Pure SceneEdits helpers for direct manipulation (no three.js, no DOM). A drag in the viewport
// becomes ordinary scene edits in edits.json, which viewer/edits/apply.ts (WP G) applies on the
// laptop and the phone alike:
//
//   actor / prop moved, turned or scaled → one `transform` edit per target, id `manip:<type>:<id>`,
//     always kept last in the list so it wins over earlier (re-prompt) transforms of that target
//   prop deleted                         → a `prop-remove` edit, id `manip:remove:<elementId>`
//   splat region recoloured / hidden / moved → a `splat-region` edit, id `manip-region-<uid>`
//
// Every helper is idempotent (applying it to a document that already has the change gives the same
// document), so a save that hits a 409 can simply run again on the stored document. Undo restores
// a snapshot of the touched edit ids (`snapshotEdits` / `restoreEdits`).
import type { SceneEdit, SceneEdits } from '@shared/look';
import type { Vec3 } from '@shared/schema';
import { effectiveTransforms, targetKey, type RegionEdit, type TargetTransform, type TransformEdit } from '../edits/model';
import { round3, roundV3 } from './math';

export type TargetType = TransformEdit['target']['type'];
export interface TargetRef {
  type: TargetType;
  id: string;
}

export const sameRef = (a: TargetRef | null | undefined, b: TargetRef | null | undefined) =>
  !!a && !!b && a.type === b.type && a.id === b.id;

export const manualTransformId = (t: TargetRef) => `manip:${t.type}:${t.id}`;
export const manualRemovalId = (elementId: string) => `manip:remove:${elementId}`;
export const isManual = (id: string) => id.startsWith('manip:') || id.startsWith('manip-');

export interface TransformFields {
  position?: Vec3;
  yaw?: number;
  scale?: number;
}

export const editById = (doc: SceneEdits, id: string): SceneEdit | null => doc.edits.find((e) => e.id === id) ?? null;

/** `doc` with `edit` in place of the edit with its id (appended when new). */
export function withEdit(doc: SceneEdits, edit: SceneEdit): SceneEdits {
  const i = doc.edits.findIndex((e) => e.id === edit.id);
  const edits = [...doc.edits];
  if (i >= 0) edits[i] = edit;
  else edits.push(edit);
  return { ...doc, edits };
}

export function withoutEdit(doc: SceneEdits, id: string): SceneEdits {
  return doc.edits.some((e) => e.id === id) ? { ...doc, edits: doc.edits.filter((e) => e.id !== id) } : doc;
}

/**
 * The director's own transform of `target`, merged with `fields` and moved to the end of the list
 * (the latest enabled value per field wins in effectiveTransforms).
 */
export function withTransform(doc: SceneEdits, target: TargetRef, fields: TransformFields): SceneEdits {
  const id = manualTransformId(target);
  const prev = editById(doc, id);
  const base: TransformFields = prev?.kind === 'transform' ? { position: prev.position, yaw: prev.yaw, scale: prev.scale } : {};
  const next: TransformEdit = { kind: 'transform', id, target: { type: target.type, id: target.id }, enabled: true };
  const position = fields.position ?? base.position;
  const yaw = fields.yaw ?? base.yaw;
  const scale = fields.scale ?? base.scale;
  if (position) next.position = roundV3(position);
  if (yaw !== undefined) next.yaw = Math.round(yaw * 1e4) / 1e4;
  if (scale !== undefined) next.scale = Math.max(0.01, round3(scale));
  return { ...doc, edits: [...doc.edits.filter((e) => e.id !== id), next] };
}

/** The transform `target` gets from `doc` (latest enabled value per field), empty when none. */
export function transformOf(doc: SceneEdits | null, target: TargetRef): TargetTransform {
  if (!doc) return {};
  return effectiveTransforms(doc.edits).get(targetKey(target)) ?? {};
}

/** Ids of every transform edit aimed at `target` (re-prompt ones and the director's own). */
export const transformIdsFor = (doc: SceneEdits, target: TargetRef) =>
  doc.edits.filter((e) => e.kind === 'transform' && e.target.type === target.type && e.target.id === target.id).map((e) => e.id);

/**
 * Back to the pipeline's blocking: the director's own transform goes and every other transform of
 * the target is switched off (kept in the list, so the Edit tab can switch it on again).
 */
export function resetTransforms(doc: SceneEdits, target: TargetRef): SceneEdits {
  const id = manualTransformId(target);
  return {
    ...doc,
    edits: doc.edits
      .filter((e) => e.id !== id)
      .map((e) => (e.kind === 'transform' && e.enabled && e.target.type === target.type && e.target.id === target.id ? { ...e, enabled: false } : e)),
  };
}

/** A prop (screenplay or added) is removed by an enabled prop-remove. */
export const isPropRemoved = (doc: SceneEdits | null, elementId: string) =>
  !!doc?.edits.some((e) => e.kind === 'prop-remove' && e.enabled && e.elementId === elementId);

export function withPropRemoved(doc: SceneEdits, elementId: string): SceneEdits {
  if (isPropRemoved(doc, elementId)) return doc;
  return withEdit(doc, { kind: 'prop-remove', id: manualRemovalId(elementId), elementId, enabled: true });
}

// ---- undo snapshots ----------------------------------------------------------------------------

/** The current version (or absence) of each id: what an undo restores. */
export type EditSnapshot = [id: string, edit: SceneEdit | null, index: number][];

export function snapshotEdits(doc: SceneEdits, ids: readonly string[]): EditSnapshot {
  return [...new Set(ids)].map((id) => {
    const index = doc.edits.findIndex((e) => e.id === id);
    return [id, index >= 0 ? structuredClone(doc.edits[index]!) : null, index];
  });
}

/** Puts each snapshotted id back as it was (at its old place in the list when it is re-added). */
export function restoreEdits(doc: SceneEdits, snap: EditSnapshot): SceneEdits {
  const ids = new Set(snap.map(([id]) => id));
  const edits = doc.edits.filter((e) => !ids.has(e.id));
  // re-insert in ascending original index so earlier indices stay valid
  for (const [, edit, index] of [...snap].sort((a, b) => a[2] - b[2])) {
    if (!edit) continue;
    const at = index >= 0 ? Math.min(index, edits.length) : edits.length;
    edits.splice(at, 0, structuredClone(edit));
  }
  return { ...doc, edits };
}

// ---- regions -----------------------------------------------------------------------------------

/** Is a world point inside an (enabled) region edit? Spheres by radius, boxes in their yawed frame. */
export function regionContains(r: Pick<RegionEdit, 'shape' | 'center' | 'size' | 'yaw'>, p: Vec3): boolean {
  const dx = p[0] - r.center[0];
  const dy = p[1] - r.center[1];
  const dz = p[2] - r.center[2];
  if (r.shape === 'sphere') return Math.hypot(dx, dy, dz) <= Math.abs(r.size[0]);
  const c = Math.cos(r.yaw ?? 0);
  const s = Math.sin(r.yaw ?? 0);
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  return Math.abs(lx) <= Math.abs(r.size[0]) && Math.abs(dy) <= Math.abs(r.size[1]) && Math.abs(lz) <= Math.abs(r.size[2]);
}

/** The smallest enabled region edit containing `p` (to re-select an object already edited). */
export function regionAt(doc: SceneEdits | null, p: Vec3): RegionEdit | null {
  const hits = (doc?.edits ?? []).filter((e): e is RegionEdit => e.kind === 'splat-region' && e.enabled && regionContains(e, p));
  hits.sort((a, b) => Math.max(...a.size.map(Math.abs)) - Math.max(...b.size.map(Math.abs)));
  return hits[0] ?? null;
}

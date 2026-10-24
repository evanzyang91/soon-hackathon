import { describe, expect, it } from 'vitest';
import { emptySceneEdits, SceneEdit, type SceneEdits } from '@shared/look';
import { effectiveProps, effectiveTransforms } from '../edits/model';
import {
  editById,
  isPropRemoved,
  manualTransformId,
  regionAt,
  resetTransforms,
  restoreEdits,
  snapshotEdits,
  transformOf,
  withEdit,
  withoutEdit,
  withPropRemoved,
  withTransform,
} from './edits';

const maya = { type: 'actor' as const, id: 'maya' };
const doc = (edits: SceneEdit[] = []): SceneEdits => ({ ...emptySceneEdits(), revision: 3, edits });
const reprompt = SceneEdit.parse({ kind: 'transform', id: 'op-1', target: maya, position: [1, 0, -2] });

describe('director transforms', () => {
  it('keep one edit per target, last in the list, merging fields', () => {
    let d = withTransform(doc([reprompt]), maya, { position: [0.3, 0, -2.8] });
    d = withTransform(d, maya, { yaw: 1.23456 });
    expect(d.edits.map((e) => e.id)).toEqual(['op-1', manualTransformId(maya)]);
    expect(transformOf(d, maya)).toEqual({ position: [0.3, 0, -2.8], yaw: 1.2346 });
    // a later re-prompt transform wins until the director drags again
    const later = SceneEdit.parse({ kind: 'transform', id: 'op-2', target: maya, position: [2, 0, -1] });
    d = { ...d, edits: [...d.edits, later] };
    expect(transformOf(d, maya).position).toEqual([2, 0, -1]);
    d = withTransform(d, maya, { position: [0, 0, -3] });
    expect(transformOf(d, maya).position).toEqual([0, 0, -3]);
    expect(d.edits.at(-1)!.id).toBe(manualTransformId(maya));
  });

  it('is idempotent (a 409 retry runs the same change again)', () => {
    const once = withTransform(doc([reprompt]), maya, { position: [0.1234567, 0, 1] });
    expect(withTransform(once, maya, { position: [0.1234567, 0, 1] })).toEqual(once);
    expect(editById(once, manualTransformId(maya))).toMatchObject({ position: [0.123, 0, 1], enabled: true });
  });

  it('reset to blocking drops the director edit and switches the others off', () => {
    const d = resetTransforms(withTransform(doc([reprompt]), maya, { yaw: 2 }), maya);
    expect(d.edits).toHaveLength(1);
    expect(d.edits[0]).toMatchObject({ id: 'op-1', enabled: false });
    expect(effectiveTransforms(d.edits).size).toBe(0);
  });
});

describe('undo snapshots', () => {
  it('restore removed, changed and added edits in their old places', () => {
    const before = withTransform(doc([reprompt, SceneEdit.parse({ kind: 'prop-remove', id: 'x', elementId: 'car' })]), maya, { yaw: 1 });
    const snap = snapshotEdits(before, ['op-1', manualTransformId(maya), 'new']);
    let after = resetTransforms(before, maya);
    after = withEdit(after, SceneEdit.parse({ kind: 'prop-remove', id: 'new', elementId: 'bus' }));
    const back = restoreEdits(after, snap);
    expect(back.edits).toEqual(before.edits);
  });
});

describe('props', () => {
  it('delete as a prop-remove once; undo by removing it', () => {
    const d = withPropRemoved(withPropRemoved(doc(), 's1-car-1'), 's1-car-1');
    expect(d.edits).toHaveLength(1);
    expect(isPropRemoved(d, 's1-car-1')).toBe(true);
    expect(effectiveProps(d.edits).removed.has('s1-car-1')).toBe(true);
    expect(isPropRemoved(withoutEdit(d, d.edits[0]!.id), 's1-car-1')).toBe(false);
  });
});

describe('regions', () => {
  const sphere = SceneEdit.parse({ kind: 'splat-region', id: 'r1', label: 'bench', shape: 'sphere', center: [1, 0.5, -3], size: [0.5, 0.5, 0.5] });
  const box = SceneEdit.parse({ kind: 'splat-region', id: 'r2', label: 'sign', shape: 'box', center: [0, 1, -5], size: [1, 0.2, 0.1], yaw: Math.PI / 2 });
  it('finds the smallest enabled region under a point (yawed boxes in their own frame)', () => {
    const d = doc([sphere, box]);
    expect(regionAt(d, [1.2, 0.6, -3])?.id).toBe('r1');
    expect(regionAt(d, [0, 1, -5.9])?.id).toBe('r2'); // the box's long side runs along z after a 90° yaw
    expect(regionAt(d, [0.9, 1, -5])).toBeNull();
    expect(regionAt(doc([{ ...sphere, enabled: false }]), [1, 0.5, -3])).toBeNull();
  });
});

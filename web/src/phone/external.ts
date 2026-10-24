// External pose mode (`?pose=external`, pure math, no DOM): the native ARKit app (ios/) owns the
// relay socket and pushes its PhonePose into the page through `window.__previzPose`; the page only
// renders it. See "Web side contract" in ios/README.md.
//
// The pose is already in the world frame and already re-centred, so the page uses it as is:
// orientation = pose.q, position = anchor + pose.offset + pose.nudge (walk.ts `cameraPosition`, as
// for a browser pose), fov = pose.fovDeg (only clamped to a sane range, not the pinch lens's
// 24–90°). pose.aspect is ignored (it equals the page's own viewport).
import type { Quat, Vec3 } from '@shared/schema';

/** Native fov is trusted; this only stops a broken value from wrecking the projection. */
export const EXTERNAL_FOV_MIN = 10;
export const EXTERNAL_FOV_MAX = 120;

export const clampExternalFov = (fov: number) =>
  Math.min(EXTERNAL_FOV_MAX, Math.max(EXTERNAL_FOV_MIN, fov));

/** What the page renders from one native pose. */
export interface ExternalPose {
  /** World-frame camera orientation, verbatim from the app. */
  q: Quat;
  nudge: Vec3;
  /** ARKit translation from the anchor (m, world frame); [0, 0, 0] when absent. */
  offset: Vec3;
  /** Vertical fov (deg), clamped to [EXTERNAL_FOV_MIN, EXTERNAL_FOV_MAX]. */
  fovDeg: number;
  recording: boolean;
}

/** The quaternion may be off unit length by this much (rounding); anything else is garbage. */
const UNIT_TOLERANCE = 0.05;

function finiteTuple(v: unknown, n: number): v is number[] {
  if (!Array.isArray(v) || v.length !== n) return false;
  for (let i = 0; i < n; i++) if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return false;
  return true;
}

/**
 * Cheap shape guard for `__previzPose` (called up to 60 Hz, so no zod). Returns null for anything
 * the page cannot render: a missing / non-finite / non-unit `q`, a non-finite `fovDeg`, or a
 * malformed `nudge` / `offset` (both may be absent and then count as zero).
 */
export function parseExternalPose(raw: unknown): ExternalPose | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const { q, nudge, offset, fovDeg } = p;
  if (!finiteTuple(q, 4)) return null;
  if (Math.abs(Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) - 1) > UNIT_TOLERANCE) return null;
  if (typeof fovDeg !== 'number' || !Number.isFinite(fovDeg)) return null;
  if (nudge !== undefined && !finiteTuple(nudge, 3)) return null;
  if (offset !== undefined && !finiteTuple(offset, 3)) return null;
  return {
    q: [q[0]!, q[1]!, q[2]!, q[3]!],
    nudge: nudge ? [nudge[0]!, nudge[1]!, nudge[2]!] : [0, 0, 0],
    offset: offset ? [offset[0]!, offset[1]!, offset[2]!] : [0, 0, 0],
    fovDeg: clampExternalFov(fovDeg),
    recording: p.recording === true,
  };
}

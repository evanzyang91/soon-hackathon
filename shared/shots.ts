// The shot list of a scene (docs/PLAN-v4.md "Coverage"): the director's coverage, numbered, each
// shot with a camera, a lens, a frame grab and the lines it covers. Persisted per scene at
// scene-<n>/shots.json (server/pipeline/shots.ts) with GET / PUT at /api/projects/:id/scenes/:n/shots
// (revision-checked like edits.json). Owned by the lead; extend by proposal.
import { z } from 'zod';
import { Quat, Vec3 } from './schema';

export const ShotSource = z.enum(['suggested', 'director']);
export type ShotSource = z.infer<typeof ShotSource>;

export const Shot = z.object({
  id: z.string(),
  /** "Wide master", "Over Leo's shoulder on Maya"; ≤ 60 chars. */
  name: z.string().max(60),
  /** Camera placement in the world frame (metres; y up; floor at the ground field). */
  position: Vec3,
  quaternion: Quat,
  /** Vertical field of view; shared/lens.ts turns it into a lens in mm for the UI. */
  fovDeg: z.number().min(10).max(120),
  /** Camera height above the ground at its spot, metres (display only; position is the truth). */
  heightM: z.number().optional(),
  /** Director's note: "push in on the line", "handheld". ≤ 200 chars. */
  note: z.string().max(200).optional(),
  /**
   * Frame grab of this shot, project-root relative ("scene-0/shots/<id>.jpg"), uploaded with
   * PUT /api/projects/:id/scenes/:n/shots/:shotId/frame. Absent until grabbed.
   */
  frame: z.string().optional(),
  /** When the frame was grabbed (ISO), so a stale frame can be told from a fresh one. */
  frameAt: z.string().optional(),
  /** Dialogue line ids (ScenePlan.dialogue[].id) this shot covers; empty = unassigned. */
  lines: z.array(z.string()).default([]),
  /** Suggested coverage (derived from the marks; replaced when they move) or the director's own. */
  source: ShotSource.default('director'),
});
export type Shot = z.infer<typeof Shot>;

export const ShotList = z.object({
  version: z.literal(1),
  /** Bumps on every PUT; a PUT whose revision is not the stored one is refused with 409. */
  revision: z.number().int().nonnegative(),
  /** In shot-list order: shot 1A is shots[0] of scene 1 (letters follow the order). */
  shots: z.array(Shot),
});
export type ShotList = z.infer<typeof ShotList>;

export const emptyShotList = (): ShotList => ({ version: 1, revision: 0, shots: [] });

/** Shot number as a filmmaker writes it: scene 1, third shot → "1C"; past Z → "1AA". */
export function shotNumber(sceneIndex: number, order: number): string {
  let n = order;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${sceneIndex + 1}${letters}`;
}

/** Frame upload limit (JPEG bytes). */
export const SHOT_FRAME_MAX_BYTES = 600 * 1024;

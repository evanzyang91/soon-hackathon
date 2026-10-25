// A blocking's beats (shared/schema.ts Beat) → what the actor is doing at a scene time: where it
// stands, which way it faces, whether it stands, sits or walks, and how far it has walked (the
// walk cycle is locked to that distance so feet never slide). Pure and deterministic: scrubbing
// the scene clock back and forth gives the same performance at the same time.
import type { Beat, Blocking } from './schema';

/** Walking pace between marks (m/s): an unhurried step. */
export const WALK_SPEED = 1.2;
/** Pause before walking off from a seat (s): the actor stands up first. */
export const RISE_S = 0.8;
/** How long a beat's gesture clip plays when its length is not known (s). */
export const GESTURE_S = 3.5;

export type PerformancePose = 'standing' | 'sitting' | 'walking';

export interface Performance {
  x: number;
  z: number;
  /** Blocking.yaw convention (three.js rotation.y of a model facing −Z). */
  yaw: number;
  pose: PerformancePose;
  /** Metres walked since the scene start (monotonic in time). */
  walked: number;
  /** Index (into the time-sorted beats) of the latest beat that has started; −1 before any. */
  beat: number;
  /** A beat's gesture clip playing right now, `time` seconds into it (null: none). */
  gesture: { clip: string; time: number } | null;
}

/** Yaw that faces along (dx, dz), for a model whose front is −Z. */
export const yawAlong = (dx: number, dz: number) => Math.atan2(-dx, -dz);

const SIT =
  /\b(sit|sits|sitting|sat|seated|perch(es|ed)?|sinks? (onto|into|down)|slumps?|plops?)\b/i;
const STAND =
  /\b(stands?|standing|stood|rises?|rose|gets? up|jumps? up|springs? up|on (his|her|their) feet)\b/i;

/** Standing or sitting from a beat's action text; null when it says neither. */
export function poseFromAction(action: string): 'standing' | 'sitting' | null {
  // "stands up from the bench" is a stand even though it mentions where they sat
  if (STAND.test(action)) return 'standing';
  if (SIT.test(action)) return 'sitting';
  return null;
}

/** Beats sorted by start time (stable), so planner order mistakes do not break the timeline. */
export function sortedBeats(b: Pick<Blocking, 'beats'>): Beat[] {
  return (b.beats ?? [])
    .map((beat, i) => ({ beat, i }))
    .sort((a, c) => a.beat.t - c.beat.t || a.i - c.i)
    .map((x) => x.beat);
}

/**
 * The actor's performance at `time` (scene seconds). Without beats the actor holds its mark in
 * its blocking pose (a 'walking' blocking keeps meaning "walk in to the mark", which the body
 * animates itself). With beats, a 'walking' blocking starts standing on its mark.
 */
export function performanceAt(
  b: Pick<Blocking, 'position' | 'yaw' | 'pose' | 'beats'>,
  time: number,
  speed = WALK_SPEED,
  /** Length of a clip in seconds (gestures play once); GESTURE_S when unknown. */
  clipSeconds: (clip: string) => number | undefined = () => undefined,
): Performance {
  const beats = sortedBeats(b);
  const s: Performance = {
    x: b.position[0],
    z: b.position[2],
    yaw: b.yaw,
    pose: beats.length ? (b.pose === 'sitting' ? 'sitting' : 'standing') : b.pose,
    walked: 0,
    beat: -1,
    gesture: null,
  };
  /** When the previous beat finished (a walk takes time; the next beat waits for it). */
  let free = 0;
  /** The latest gesture since the last walk: its clip and when it started. */
  let g: { clip: string; start: number } | null = null;
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i]!;
    const start = Math.max(beat.t, free);
    if (time < start) break;
    s.beat = i;
    const after = beat.pose ?? poseFromAction(beat.action);
    if (beat.moveTo) {
      g = null; // walking off ends any gesture
      const dx = beat.moveTo[0] - s.x;
      const dz = beat.moveTo[2] - s.z;
      const dist = Math.hypot(dx, dz);
      const rise = s.pose === 'sitting' ? RISE_S : 0;
      const dur = rise + dist / speed;
      free = start + dur;
      if (time < start + rise) {
        s.pose = 'standing'; // getting up before the walk
        return s;
      }
      if (time < free && dist > 1e-6) {
        const k = ((time - start - rise) * speed) / dist;
        s.x += dx * k;
        s.z += dz * k;
        s.yaw = yawAlong(dx, dz);
        s.pose = 'walking';
        s.walked += dist * k;
        return s;
      }
      s.x = beat.moveTo[0];
      s.z = beat.moveTo[2];
      s.walked += dist;
      if (dist > 1e-6) s.yaw = yawAlong(dx, dz);
      s.pose = after ?? 'standing';
    } else {
      free = start;
      if (after) s.pose = after;
      if (beat.clip) g = { clip: beat.clip, start };
    }
    if (beat.yaw !== undefined) s.yaw = beat.yaw;
  }
  if (g && time - g.start < (clipSeconds(g.clip) ?? GESTURE_S))
    s.gesture = { clip: g.clip, time: time - g.start };
  return s;
}

/** When the last beat is done (s); 0 without beats. Lets the laptop show how long the action runs. */
export function beatsEnd(
  b: Pick<Blocking, 'position' | 'pose' | 'beats'>,
  speed = WALK_SPEED,
): number {
  const beats = sortedBeats(b);
  let x = b.position[0];
  let z = b.position[2];
  let sitting = b.pose === 'sitting';
  let free = 0;
  for (const beat of beats) {
    const start = Math.max(beat.t, free);
    free = start;
    if (beat.moveTo) {
      free += (sitting ? RISE_S : 0) + Math.hypot(beat.moveTo[0] - x, beat.moveTo[2] - z) / speed;
      x = beat.moveTo[0];
      z = beat.moveTo[2];
      sitting = false;
    }
    const after = beat.pose ?? poseFromAction(beat.action);
    if (after) sitting = after === 'sitting';
  }
  return free;
}

/**
 * The same choreography started from another mark: every walk target moves with it, so a
 * placement fix-up or a director's "move Leo closer" shifts the whole performance. `yaw` replaces
 * the starting facing only.
 */
export function shiftBlocking<B extends Pick<Blocking, 'position' | 'yaw' | 'beats'>>(
  b: B,
  to: readonly [number, number, number],
  yaw?: number,
): B {
  const dx = to[0] - b.position[0];
  const dz = to[2] - b.position[2];
  if (!dx && !dz && yaw === undefined) return b;
  return {
    ...b,
    position: [to[0], b.position[1], to[2]],
    yaw: yaw ?? b.yaw,
    beats: b.beats?.map((beat) =>
      beat.moveTo
        ? { ...beat, moveTo: [beat.moveTo[0] + dx, beat.moveTo[1], beat.moveTo[2] + dz] }
        : beat,
    ),
  };
}

/**
 * The same blocking with every walk target passed through `fix`, given the pose the actor arrives
 * in (the viewer moves marks that land inside collider geometry to free floor). Returns `b` itself
 * when no mark changes.
 */
export function fixMarks<B extends Pick<Blocking, 'beats'>>(
  b: B,
  fix: (x: number, z: number, pose: 'standing' | 'sitting') => readonly [number, number],
): B {
  let changed = false;
  const beats = b.beats?.map((beat) => {
    if (!beat.moveTo) return beat;
    const pose = beat.pose ?? poseFromAction(beat.action) ?? 'standing';
    const [x, z] = fix(beat.moveTo[0], beat.moveTo[2], pose);
    if (x === beat.moveTo[0] && z === beat.moveTo[2]) return beat;
    changed = true;
    return { ...beat, moveTo: [x, beat.moveTo[1], z] as [number, number, number] };
  });
  return changed ? { ...b, beats } : b;
}

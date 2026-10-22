// The visible ground under each actor (laptop and phone alike): the world's ground height field
// (WorldAsset.ground → ground.json, measured by server/pipeline/calibrate-ground.ts, format and
// sampler in shared/ground.ts) turned into the y an actor's feet go to at (x, z).
//
// Every actor position the viewer sets goes through `groundY`: placement at load, the collider
// nudge (world.ts), a drag (manipulate/), an actor `transform` edit (edits/apply.ts) and a body
// swap. Stored actor heights are relative to the ground: a blocking position's y and an actor
// transform's position[1] mean "this far above the ground at (x, z)", 0 = standing on it. That
// keeps every existing edits.json valid (actor transforms were written with y = 0 on the old
// flat floor) and makes a drag across a kerb follow the kerb.
import { feetY, validateGroundField, type GroundField } from '@shared/ground';
import type { Vec3, WorldAsset } from '@shared/schema';
import { calibrationFactor, floorOffset } from './transform';

/** Fetches and validates a ground.json; null (and a console warning) when it is unusable. */
export async function loadGroundField(url: string): Promise<GroundField | null> {
  try {
    const res = await fetch(url);
    const type = res.headers.get('content-type') ?? '';
    // a dev server answers a missing file with 200 + index.html
    if (!res.ok || type.startsWith('text/html')) throw new Error(`HTTP ${res.status} ${type}`);
    return validateGroundField(await res.json());
  } catch (err) {
    console.warn(`ground field ${url} unusable; actors stand on the median floor`, err);
    return null;
  }
}

export type GroundY = (x: number, z: number) => number;

/**
 * (x, z) in scene metres → the y the visible ground is rendered at there; 0 (the median floor the
 * world is raised to) without a field or where it has no ground within reach.
 */
export function groundSampler(
  field: GroundField | null,
  world: Pick<WorldAsset, 'scaleCalibration' | 'floorOffsetMeters'>,
): GroundY {
  if (!field) return () => 0;
  const frame = { factor: calibrationFactor(world), floorOffset: floorOffset(world) };
  // the field is at Marble's scale and the scene is scaled by the factor about the origin, so the
  // scene point (x, z) is the field point (x, z) / factor
  return (x, z) => {
    const y = feetY(field, frame, x / frame.factor, z / frame.factor);
    return Number.isFinite(y) ? y : 0;
  };
}

/** Where a stored actor position (y = height above the ground) is rendered. */
export function onGround(p: Readonly<Vec3>, groundY: GroundY): Vec3 {
  return [p[0], groundY(p[0], p[2]) + p[1], p[2]];
}

/** The stored form of a rendered actor position: y relative to the ground at (x, z). */
export function aboveGround(p: Readonly<Vec3>, groundY: GroundY): Vec3 {
  return [p[0], p[1] - groundY(p[0], p[2]), p[2]];
}

/** userData key of the ground difference world.ts adds while a walking body is off its mark. */
export const WALK_GROUND = 'walkGround';

interface Placed {
  position: { x: number; y: number; z: number };
  rotation: { y: number };
  userData: Record<string, unknown>;
}

/**
 * An actor object's y without the walk-in's ground difference: the y its mark puts it at. Read
 * this, not position.y, wherever an actor's spot is stored or carried over (edit snapshots, drags,
 * the collider nudge, body swaps). Whoever writes position.y again simply replaces the difference.
 */
export function markY(o: Placed): number {
  const w = o.userData[WALK_GROUND] as { y: number; dy: number } | undefined;
  return w && o.position.y === w.y ? w.y - w.dy : o.position.y;
}

/**
 * A `walking` actor's body starts `behind` metres behind its mark (along its local +Z: the
 * skinned walk-in, which waits there until the scene clock runs) and walks onto it. The actor
 * object is lifted by the ground difference between the body and the mark, so the body walks on
 * the ground it crosses (a kerb, a slope) instead of at the mark's height.
 */
export function followGround(o: Placed, behind: number, groundY: GroundY): void {
  const base = markY(o);
  let dy = 0;
  if (behind > 0.005) {
    const bx = o.position.x + Math.sin(o.rotation.y) * behind;
    const bz = o.position.z + Math.cos(o.rotation.y) * behind;
    dy = groundY(bx, bz) - groundY(o.position.x, o.position.z);
  }
  if (!dy && !o.userData[WALK_GROUND]) return;
  o.position.y = base + dy;
  o.userData[WALK_GROUND] = dy ? { y: o.position.y, dy } : undefined;
}

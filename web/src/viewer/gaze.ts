// Where each actor looks (pure, no three.js): at whoever is speaking, else (and the speaker
// itself) at its nearest scene partner. Bodies keep their blocking yaw; only heads turn.

export interface GazeActor {
  id: string;
  x: number;
  z: number;
}

/** actor id → id of the actor it looks at (null: nobody to look at). */
export function gazeTargets(actors: readonly GazeActor[], speakerId: string | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const speaker = speakerId ? actors.find((a) => a.id === speakerId) : undefined;
  for (const a of actors) {
    if (speaker && speaker.id !== a.id) {
      out.set(a.id, speaker.id);
      continue;
    }
    let best: GazeActor | null = null;
    let bestD = Infinity;
    for (const b of actors) {
      if (b.id === a.id) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    out.set(a.id, best?.id ?? null);
  }
  return out;
}

/**
 * Head yaw (rad, relative to the body; + = turn left, the three.js convention for a −Z-facing
 * body) that faces (tx, tz) from an actor at (x, z) whose body yaw is `bodyYaw`. Null when the
 * target is on top of the actor.
 */
export function headYawToward(x: number, z: number, bodyYaw: number, tx: number, tz: number): number | null {
  const dx = tx - x;
  const dz = tz - z;
  if (Math.hypot(dx, dz) < 0.05) return null;
  const a = Math.atan2(-dx, -dz) - bodyYaw;
  return Math.atan2(Math.sin(a), Math.cos(a));
}
